#!/usr/bin/env tsx
/**
 * CSM vs HINDSIGHT, APPLES TO APPLES ON ONE STACK — gold side, no bridge.
 *
 * The published BEAM comparison varies the memory system AND is read by a model
 * we no longer use. This holds the reader completely constant — same answer
 * model, same judge, same prompts, same queries — and varies ONLY the retrieved
 * context. That is the memory-system question stated precisely.
 *
 * Both arms are official artifacts, so neither system is re-implemented or
 * re-tuned by us:
 *   A = CSM       data/eval/runs/amb-beam-100k-official-v1/.../rag/100k.json
 *   B = Hindsight vectorize-io's published BEAM 100K artifact (sha-verified)
 *
 * Each row of both files carries `context` (what that system retrieved),
 * `meta.rubric` (the judge's scoring units) and the same `query_id`, so the
 * pairing is exact.
 *
 * Answering + judging run on the Claude sidecar with the judge calibrated in
 * docs/experiments/EXP-judge-calibration.md (holdout rho 0.864, MAE 0.077 vs
 * the official Gemini judge). No API keys.
 *
 * FIREWALL: reads gold (rubric) but never imports the retrieval bridge or
 * src/core — it consumes finished contexts from artifacts. Registered in
 * tests/beamLeakageFirewall.test.ts as a judge consumer.
 *
 *   npx tsx scripts/headtohead-arms.ts --limit 120 --jobs 6
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
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
import { cacheGet, cacheSet } from "../src/eval/cache.js";

interface Row {
  query_id: string;
  query: string;
  context: string;
  score: number;
  meta?: { rubric?: string[] };
}

const SIDECAR = process.env.CSM_AGENT_BASE_URL ?? "http://127.0.0.1:8787";
const ANSWER_PROMPT_VERSION = "v1";
const ANSWER_SYSTEM =
  "You answer questions using ONLY the provided memory excerpts. " +
  "If the excerpts do not contain the answer, say so plainly. " +
  "Be specific and complete: name the concrete items, values and dates the " +
  "excerpts support. When the question asks about a sequence, present the " +
  "items in the order the excerpts indicate. Do not speculate beyond the " +
  "excerpts.";

/** Default is the 100K official rerun; --csm points at the upper tiers, whose
 *  artifacts carry context + rubric too (500k/1m/10m, verified present). */
const DEFAULT_CSM_ARTIFACT =
  "data/eval/runs/amb-beam-100k-official-v1/amb-outputs/beam/csm-official-rerun-100k/rag/100k.json";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : fallback;
}
const fmt = (n: number, d = 4): string => (Number.isFinite(n) ? n.toFixed(d) : "n/a");

function load(path: string): Row[] {
  const p = resolve(process.cwd(), path);
  if (!existsSync(p)) throw new Error(`missing artifact: ${path}`);
  const buf = readFileSync(p);
  const text = path.endsWith(".gz") ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
  return (JSON.parse(text) as { results: Row[] }).results;
}

async function call(
  system: string,
  prompt: string,
  model: string,
  tag: string,
  attempt = 0,
): Promise<string> {
  const keyInput = {
    model: `${tag}:${model}${attempt > 0 ? `:r${attempt}` : ""}`,
    prompt,
    system,
    temperature: 0,
    maxOutputTokens: 2048,
    seed: 42,
  };
  const hit = await cacheGet(keyInput);
  if (hit) return hit.response;
  const started = Date.now();
  const res = await fetch(`${SIDECAR}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system, prompt, model, jsonMode: tag.startsWith("judge") }),
  });
  const body = (await res.json()) as { text?: string; error?: string };
  if (!res.ok || body.error) throw new Error(`sidecar: ${body.error ?? res.status}`);
  const text = body.text ?? "";
  if (text.trim().length >= 5) {
    await cacheSet(keyInput, { response: text, latencyMs: Date.now() - started });
  }
  return text;
}

/**
 * Score one arm ONCE. `rep` selects an independent answer+judge sample by
 * changing the cache key, so rep>0 is a genuinely fresh draw and not a replay
 * of the cached one.
 */
async function scoreArmOnce(
  category: string,
  query: string,
  rubric: string[],
  context: string,
  model: string,
  rep = 0,
): Promise<number | null> {
  const repTag = rep > 0 ? `:rep${rep}` : "";
  const answer = await call(
    ANSWER_SYSTEM,
    `Memory excerpts:\n\n${context.slice(0, 200_000)}\n\nQuestion: ${query}\n\nAnswer:`,
    model,
    `answer:${ANSWER_PROMPT_VERSION}${repTag}`,
  );
  const ordering = judgeModeFor(category) === "ordering";
  const system = ordering ? ORDERING_EXTRACT_SYSTEM : RUBRIC_JUDGE_SYSTEM;
  const prompt = ordering
    ? renderOrderingExtractionPrompt(query, rubric, answer)
    : renderRubricJudgePrompt(query, rubric, answer);
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await call(system, prompt, model, `judge:${JUDGE_PROMPT_VERSION}${repTag}`, attempt);
    if (ordering) {
      const p = parseOrderingPositions(raw, rubric.length);
      if (p.values) return orderingScoreFromPositions(p.values);
    } else {
      const p = parseVerdicts(raw, rubric.length);
      if (p.values) return rubricFractionScore(p.values);
    }
  }
  return null; // excluded and counted, never scored 0
}

/**
 * Mean of `repeats` INDEPENDENT answer+judge samples of the SAME context.
 *
 * WHY: the 2026-08-02 retraction showed that re-scoring identical contexts
 * moves an arm ~0.06 while its control moves 0.01 — the variance lives in the
 * answer/judge stage, not in retrieval. That noise is what sets the MDE, so at
 * n=70 (the entire category — there are no more queries to add) a real ~0.09
 * effect still reads "below MDE". Averaging k draws shrinks the stochastic
 * component by ~sqrt(k) and lowers the MDE without needing the paid instrument.
 *
 * This reduces MEASUREMENT noise only. It cannot shift the underlying
 * quantity, so it can certify a real effect and can never manufacture one.
 */
async function scoreArm(
  category: string,
  query: string,
  rubric: string[],
  context: string,
  model: string,
  repeats = 1,
): Promise<number | null> {
  const draws: number[] = [];
  for (let rep = 0; rep < Math.max(1, repeats); rep++) {
    const v = await scoreArmOnce(category, query, rubric, context, model, rep);
    if (v !== null) draws.push(v);
  }
  if (draws.length === 0) return null;
  return draws.reduce((a, b) => a + b, 0) / draws.length;
}

async function main(): Promise<void> {
  const hsPath = arg("hindsight")!;
  const model = arg("model", "claude-sonnet-5")!;
  const jobs = Math.max(1, Number.parseInt(arg("jobs", "6")!, 10));
  const perCat = Number.parseInt(arg("per-category", "0")!, 10);
  // Independent answer+judge draws averaged per query. Shrinks the stochastic
  // component of the MDE by ~sqrt(repeats); 1 keeps the original behaviour.
  const repeats = Math.max(1, Number.parseInt(arg("repeats", "1")!, 10));
  if (!hsPath) throw new Error("--hindsight <path to hindsight 100k.json[.gz]> is required");

  const csm = new Map(load(arg("csm", DEFAULT_CSM_ARTIFACT)!).map((r) => [r.query_id, r]));
  const hs = new Map(load(hsPath).map((r) => [r.query_id, r]));

  let ids = [...csm.keys()].filter((id) => hs.has(id));
  ids.sort();
  if (perCat > 0) {
    // Stratify so a truncated run stays balanced across all ten categories.
    const seen = new Map<string, number>();
    ids = ids.filter((id) => {
      const c = categoryOf(id);
      const n = seen.get(c) ?? 0;
      if (n >= perCat) return false;
      seen.set(c, n + 1);
      return true;
    });
  }
  if (ids.length === 0) throw new Error("no shared query ids between the two artifacts");

  console.log(
    `head-to-head: CSM vs Hindsight [${arg("tier", "100k")}] | reader=${model} judge=${JUDGE_PROMPT_VERSION} ` +
      `paired=${ids.length} jobs=${jobs} repeats=${repeats}`,
  );
  console.log(
    `  both arms are official artifacts; only the retrieved context differs.\n`,
  );

  const out: Array<{ id: string; category: string; a: number; b: number }> = [];
  let excluded = 0;
  let cursor = 0;
  const t0 = Date.now();
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= ids.length) return;
      const id = ids[i]!;
      const A = csm.get(id)!;
      const B = hs.get(id)!;
      const rubric = A.meta?.rubric ?? B.meta?.rubric ?? [];
      if (rubric.length === 0) {
        excluded++;
        continue;
      }
      try {
        const cat = categoryOf(id);
        const [a, b] = await Promise.all([
          scoreArm(cat, A.query, rubric, A.context, model, repeats),
          scoreArm(cat, B.query, rubric, B.context, model, repeats),
        ]);
        if (a === null || b === null) {
          excluded++;
          continue;
        }
        out.push({ id, category: cat, a, b });
        if (out.length % 20 === 0) {
          console.log(`  ...${out.length}/${ids.length}`);
        }
      } catch (err) {
        excluded++;
        console.log(`  ${id.padEnd(26)} ERROR ${String((err as Error).message).slice(0, 60)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, ids.length) }, () => worker()));

  const line = (name: string, rs: typeof out): string => {
    const a = rs.map((r) => r.a);
    const b = rs.map((r) => r.b);
    const pd = pairedDelta(a, b);
    const mde = minimumDetectableEffect(rs.map((r) => r.b - r.a));
    // Positive delta = Hindsight ahead. Report against the n-matched MDE so an
    // underpowered slice can never be read as a result.
    const verdict =
      Math.abs(pd.meanDelta) < mde
        ? "tie (below MDE)"
        : pd.ci95[1] < 0
          ? "CSM"
          : pd.ci95[0] > 0
            ? "Hindsight"
            : "tie (CI spans 0)";
    return (
      `${name.padEnd(26)} ${String(rs.length).padStart(3)}  ` +
      `${fmt(a.reduce((s, v) => s + v, 0) / rs.length)}  ` +
      `${fmt(b.reduce((s, v) => s + v, 0) / rs.length)}  ` +
      `${(pd.meanDelta >= 0 ? "+" : "") + fmt(pd.meanDelta)}  ` +
      `${fmt(mde)}  ${pd.wins}/${pd.losses}/${pd.ties}  ${verdict}`
    );
  };

  console.log(
    `\ncategory                     n     CSM     HS    delta     MDE  HS/CSM/tie  leader`,
  );
  for (const c of [...new Set(out.map((r) => r.category))].sort()) {
    console.log("  " + line(c, out.filter((r) => r.category === c)));
  }
  console.log("  " + line("ALL", out));
  if (excluded > 0) console.log(`\n  excluded: ${excluded}`);
  console.log(`  wall ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  const dir = resolve(process.cwd(), "data", "eval", "judge-calibration");
  mkdirSync(dir, { recursive: true });
  const dest = resolve(dir, `headtohead-csm-vs-hindsight-${arg("tier", "100k")}.json`);
  writeFileSync(
    dest,
    JSON.stringify(
      { reader: model, judgePromptVersion: JUDGE_PROMPT_VERSION, n: out.length, excluded, results: out },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`\nwrote ${dest}`);
}

main().catch((err) => {
  console.error(`headtohead-arms failed: ${String((err as Error).message ?? err)}`);
  process.exit(1);
});
