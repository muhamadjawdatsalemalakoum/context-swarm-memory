#!/usr/bin/env tsx
/**
 * JUDGE STEP of the two-process answer gate — GOLD SIDE, NEVER TOUCHES THE
 * RETRIEVAL BRIDGE.
 *
 * Reads `answers.jsonl` (written by `scripts/answer-arms.ts`, which never saw
 * gold), grades both arms against BEAM's rubric with the calibrated judge in
 * `src/eval/beamJudge.ts`, and reports the PAIRED delta against the
 * n-matched minimum detectable effect.
 *
 * Reporting rule, enforced in the output: a delta smaller than the MDE is NOT
 * an effect. At n=40 the official pipeline's own MDE is ~0.124 — an earlier
 * version of this gate looked for 0.02-0.05 effects at that n and unavoidably
 * found nothing.
 *
 *   npx tsx scripts/judge-arms.ts --run <runIdB> [--split 100k] [--jobs 8]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

import {
  categoryOf,
  judgeModeFor,
  orderingScoreFromPositions,
  rubricFractionScore,
  renderRubricJudgePrompt,
  renderOrderingExtractionPrompt,
  parseVerdicts,
  parseOrderingPositions,
  pairedDelta,
  minimumDetectableEffect,
  RUBRIC_JUDGE_SYSTEM,
  ORDERING_EXTRACT_SYSTEM,
  JUDGE_PROMPT_VERSION,
} from "../src/eval/beamJudge.js";
import { cacheGet, cacheSet, thinkingCacheTag } from "../src/eval/cache.js";

interface AnswerRow {
  queryId: string;
  category: string;
  answerA: string;
  answerB: string;
  runA: string;
  runB: string;
  split: string;
  model: string;
}

const SIDECAR = process.env.CSM_AGENT_BASE_URL ?? "http://127.0.0.1:8787";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : fallback;
}
const fmt = (n: number, d = 4): string => (Number.isFinite(n) ? n.toFixed(d) : "n/a");

/** GOLD: rubric items, read only here and only to score answers that already exist. */
function loadGold(split: string): Map<string, { query: string; rubric: string[] }> {
  const dir = resolve(process.cwd(), "data", "eval", "corpus-beam-slice", split);
  const gz = join(dir, "queries.json.gz");
  const plain = join(dir, "queries.json");
  const raw = existsSync(gz)
    ? JSON.parse(gunzipSync(readFileSync(gz)).toString("utf8"))
    : JSON.parse(readFileSync(plain, "utf8"));
  const out = new Map<string, { query: string; rubric: string[] }>();
  for (const q of raw as Array<{ id: string; query: string; meta?: { rubric?: string[] } }>) {
    out.set(q.id, { query: q.query, rubric: q.meta?.rubric ?? [] });
  }
  return out;
}

async function call(system: string, prompt: string, model: string, attempt = 0): Promise<string> {
  const keyInput = {
    model: `judge:${JUDGE_PROMPT_VERSION}:${model}${attempt > 0 ? `:r${attempt}` : ""}`,
    prompt,
    system,
    temperature: 0,
    maxOutputTokens: 2048,
    seed: 42,
    // See answer-arms: a judge run at a different thinking level must not
    // replay verdicts produced at the previous level.
    thinkingLevel: thinkingCacheTag(),
  };
  const hit = await cacheGet(keyInput);
  if (hit) return hit.response;
  const started = Date.now();
  const res = await fetch(`${SIDECAR}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system, prompt, model, jsonMode: true }),
  });
  const body = (await res.json()) as { text?: string; error?: string };
  if (!res.ok || body.error) throw new Error(`sidecar: ${body.error ?? res.status}`);
  const text = body.text ?? "";
  if (text.trim().length >= 5) {
    await cacheSet(keyInput, { response: text, latencyMs: Date.now() - started });
  }
  return text;
}

async function scoreFor(
  category: string,
  query: string,
  rubric: string[],
  answerText: string,
  model: string,
): Promise<number | null> {
  if (rubric.length === 0) return null;
  const ordering = judgeModeFor(category) === "ordering";
  const system = ordering ? ORDERING_EXTRACT_SYSTEM : RUBRIC_JUDGE_SYSTEM;
  const prompt = ordering
    ? renderOrderingExtractionPrompt(query, rubric, answerText)
    : renderRubricJudgePrompt(query, rubric, answerText);
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await call(system, prompt, model, attempt);
    if (ordering) {
      const p = parseOrderingPositions(raw, rubric.length);
      if (p.values) return orderingScoreFromPositions(p.values);
    } else {
      const p = parseVerdicts(raw, rubric.length);
      if (p.values) return rubricFractionScore(p.values);
    }
  }
  return null; // excluded and counted — never scored 0
}

async function main(): Promise<void> {
  const runId = arg("run");
  const split = arg("split", "100k")!;
  const model = arg("model", "claude-sonnet-5")!;
  const jobs = Math.max(1, Number.parseInt(arg("jobs", "8")!, 10));
  if (!runId) throw new Error("--run <runIdB> is required");

  const path = resolve(process.cwd(), "data", "eval", "runs", runId, "answers.jsonl");
  if (!existsSync(path)) throw new Error(`no answers.jsonl in run ${runId} — run answer-arms first`);
  const rows = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as AnswerRow);
  const gold = loadGold(split);

  console.log(
    `judge step: run=${runId} n=${rows.length} judge=${model} prompt=${JUDGE_PROMPT_VERSION} jobs=${jobs}`,
  );

  const results: Array<{ queryId: string; category: string; a: number; b: number }> = [];
  let excluded = 0;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= rows.length) return;
      const r = rows[i]!;
      const g = gold.get(r.queryId);
      if (!g || g.rubric.length === 0) {
        excluded++;
        continue;
      }
      const [a, b] = await Promise.all([
        scoreFor(r.category, g.query, g.rubric, r.answerA, model),
        scoreFor(r.category, g.query, g.rubric, r.answerB, model),
      ]);
      if (a === null || b === null) {
        excluded++;
        continue;
      }
      results.push({ queryId: r.queryId, category: r.category, a, b });
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, rows.length) }, () => worker()));

  const line = (name: string, rs: typeof results): string => {
    const a = rs.map((r) => r.a);
    const b = rs.map((r) => r.b);
    const pd = pairedDelta(a, b);
    const mde = minimumDetectableEffect(rs.map((r) => r.b - r.a));
    const verdict =
      Math.abs(pd.meanDelta) < mde
        ? "below MDE - NOT an effect"
        : pd.ci95[0] > 0
          ? "B WINS"
          : pd.ci95[1] < 0
            ? "A WINS"
            : "CI covers 0";
    return (
      `${name.padEnd(26)} ${String(rs.length).padStart(3)}  ` +
      `${fmt(a.reduce((s, v) => s + v, 0) / rs.length)}  ` +
      `${fmt(b.reduce((s, v) => s + v, 0) / rs.length)}  ` +
      `${(pd.meanDelta >= 0 ? "+" : "") + fmt(pd.meanDelta)}  ` +
      `[${fmt(pd.ci95[0])},${fmt(pd.ci95[1])}]  ${fmt(mde)}  ` +
      `${pd.wins}/${pd.losses}/${pd.ties}  ${verdict}`
    );
  };

  console.log(
    `\ncategory                     n   meanA   meanB    delta      CI95          MDE   W/L/T  verdict`,
  );
  for (const c of [...new Set(results.map((r) => r.category))].sort()) {
    console.log("  " + line(c, results.filter((r) => r.category === c)));
  }
  if (new Set(results.map((r) => r.category)).size > 1) {
    console.log("  " + line("ALL", results));
  }
  if (excluded > 0) console.log(`\n  excluded (no rubric / unparsable judge): ${excluded}`);

  const dest = resolve(process.cwd(), "data", "eval", "runs", runId, "answer-gate-v2.json");
  writeFileSync(
    dest,
    JSON.stringify(
      { runId, split, judgeModel: model, promptVersion: JUDGE_PROMPT_VERSION, excluded, results },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`\nwrote ${dest}`);
}

main().catch((err) => {
  console.error(`judge-arms failed: ${String((err as Error).message ?? err)}`);
  process.exit(1);
});
