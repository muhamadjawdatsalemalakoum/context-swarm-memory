#!/usr/bin/env tsx
/**
 * JUDGE CALIBRATION — turn the free answer gate into a *validated* instrument.
 *
 * WHY: `scripts/score-answer-gate.ts` scored ~0.03 mean where BEAM's official
 * judge scores ~0.74 on comparable retrieval. That is not low resolution, it is
 * a bug: the gate built its reference list from `gold_answers`, which is EMPTY
 * on 160/400 official rows (all of contradiction_resolution,
 * instruction_following, preference_following and summarization). BEAM's judge
 * is rubric-based. See `src/eval/beamJudge.ts` for the full derivation.
 *
 * This script calibrates a free (Claude-sidecar) judge against 400 official
 * `(query, rubric, answer, official_score)` triples produced by the real Gemini
 * judge, so that any downstream free A/B has a known error bar.
 *
 * MODES
 *   audit      zero LLM calls. Verifies the rubric is available offline, prints
 *              the empty-gold census, the official score distribution, the
 *              v1-vs-v2 noise ceiling, and the zero-LLM Kendall-tau
 *              reproduction rate for event_ordering.
 *   judge      free judge over the OFFICIAL answers (answer model held fixed,
 *              so this isolates judge error). Reports agreement on train and,
 *              when asked, holdout.
 *   null-test  v1 vs v2 — same 400 queries, byte-identical retrieval context,
 *              different answer/judge roll. The official paired delta is
 *              ~0. A gate that manufactures a difference here is unusable.
 *
 * HOLDOUT DISCIPLINE: prompt iteration runs on `--split train`. Every holdout
 * evaluation appends to `data/eval/judge-calibration/holdout-peeks.jsonl`, so
 * the peek count is itself an auditable artifact.
 *
 *   npx tsx scripts/calibrate-judge.ts --mode audit
 *   npx tsx scripts/calibrate-judge.ts --mode judge --split train --limit 40
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { gunzipSync } from "node:zlib";

import {
  categoryOf,
  judgeModeFor,
  literalItemPositions,
  orderingScoreFromPositions,
  rubricFractionScore,
  renderRubricJudgePrompt,
  renderOrderingExtractionPrompt,
  parseVerdicts,
  parseOrderingPositions,
  agreementReport,
  pairedDelta,
  minimumDetectableEffect,
  splitAssignment,
  RUBRIC_JUDGE_SYSTEM,
  ORDERING_EXTRACT_SYSTEM,
  JUDGE_PROMPT_VERSION,
  type Agreement,
} from "../src/eval/beamJudge.js";
import { cacheGet, cacheSet, computeCacheKey } from "../src/eval/cache.js";

// ─── Official artifacts ─────────────────────────────────────────────────────

interface OfficialRow {
  query_id: string;
  query: string;
  answer: string;
  context: string;
  context_tokens?: number;
  gold_answers: string[];
  score: number;
  meta: { rubric?: string[] };
}

const OFFICIAL_V1 =
  "data/eval/runs/amb-beam-100k-official-v1/amb-outputs/beam/csm-official-rerun-100k/rag/100k.json";
const OFFICIAL_V2 =
  "data/eval/runs/amb-beam-100k-official-v2/amb-outputs/beam/amb-beam-100k-official-v2/rag/100k.json";
const SLICE_QUERIES = "data/eval/corpus-beam-slice/100k/queries.json.gz";
const OUT_DIR = "data/eval/judge-calibration";
const SIDECAR = process.env.CSM_AGENT_BASE_URL ?? "http://127.0.0.1:8787";

function loadOfficial(path: string): OfficialRow[] {
  const p = resolve(process.cwd(), path);
  if (!existsSync(p)) throw new Error(`missing official artifact: ${path}`);
  return (JSON.parse(readFileSync(p, "utf8")) as { results: OfficialRow[] }).results;
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : fallback;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const fmt = (n: number, d = 4): string => (Number.isFinite(n) ? n.toFixed(d) : "n/a");

// ─── Mode: audit (zero LLM) ─────────────────────────────────────────────────

function audit(): void {
  const v1 = loadOfficial(OFFICIAL_V1);
  console.log(`\n=== AUDIT (zero LLM calls) ===\n`);

  // 1. Rubric availability offline — the design's falsification criterion.
  const slicePath = resolve(process.cwd(), SLICE_QUERIES);
  if (existsSync(slicePath)) {
    const slice = JSON.parse(
      gunzipSync(readFileSync(slicePath)).toString("utf8"),
    ) as Array<{ id: string; query: string; meta?: { rubric?: string[] } }>;
    const byId = new Map(slice.map((q) => [q.id, q]));
    let identical = 0;
    let missing = 0;
    for (const r of v1) {
      const s = byId.get(r.query_id);
      const a = JSON.stringify(r.meta?.rubric ?? null);
      const b = JSON.stringify(s?.meta?.rubric ?? null);
      if (!s) missing++;
      else if (a === b) identical++;
    }
    console.log(`rubric available offline : ${identical}/${v1.length} byte-identical, ${missing} absent`);
    if (identical !== v1.length) {
      console.log("  !! FALSIFIED: the slice rubric does not match the official rubric. Stop.");
    }
  } else {
    console.log(`rubric slice not on disk (${SLICE_QUERIES}) — skipping identity check`);
  }

  // 2. Empty-gold census — the bug that broke the old gate.
  const cats = [...new Set(v1.map((r) => categoryOf(r.query_id)))].sort();
  console.log(`\ncategory                     n  emptyGold  hasRubric  officialMean`);
  for (const c of cats) {
    const rows = v1.filter((r) => categoryOf(r.query_id) === c);
    const empty = rows.filter((r) => !r.gold_answers || r.gold_answers.length === 0).length;
    const rub = rows.filter((r) => (r.meta?.rubric ?? []).length > 0).length;
    const m = rows.reduce((s, r) => s + r.score, 0) / rows.length;
    console.log(
      `${c.padEnd(26)} ${String(rows.length).padStart(3)}  ${String(empty).padStart(9)}  ` +
        `${String(rub).padStart(9)}  ${fmt(m)}`,
    );
  }
  const totalEmpty = v1.filter((r) => !r.gold_answers || r.gold_answers.length === 0).length;
  console.log(
    `\n  ${totalEmpty}/${v1.length} rows have NO gold_answers — the old gate scored every one of ` +
      `them 0 by construction.`,
  );

  // 3. Zero-LLM Kendall-tau reproduction for event_ordering.
  const eo = v1.filter((r) => categoryOf(r.query_id) === "event_ordering");
  let exact = 0;
  const errs: number[] = [];
  for (const r of eo) {
    const rub = r.meta?.rubric ?? [];
    const s = orderingScoreFromPositions(literalItemPositions(r.answer ?? "", rub));
    const e = Math.abs(s - r.score);
    errs.push(e);
    if (e < 1e-9) exact++;
  }
  errs.sort((a, b) => a - b);
  console.log(
    `\nevent_ordering, zero-LLM (1+tau_b)/2 with a literal matcher:\n` +
      `  exact reproductions : ${exact}/${eo.length}\n` +
      `  MAE                 : ${fmt(errs.reduce((a, b) => a + b, 0) / (errs.length || 1))}\n` +
      `  median |err|        : ${fmt(errs[Math.floor(errs.length / 2)] ?? NaN)}`,
  );
  console.log(
    `  (this is the NULL MODEL: an LLM extraction prompt must beat it to earn its cost)`,
  );

  // 4. The noise ceiling: v1 vs v2, same queries, byte-identical context.
  if (existsSync(resolve(process.cwd(), OFFICIAL_V2))) {
    const v2 = loadOfficial(OFFICIAL_V2);
    const m2 = new Map(v2.map((r) => [r.query_id, r]));
    const a: number[] = [];
    const b: number[] = [];
    let sameContext = 0;
    let sameAnswer = 0;
    for (const r of v1) {
      const o = m2.get(r.query_id);
      if (!o) continue;
      a.push(r.score);
      b.push(o.score);
      if (r.context === o.context) sameContext++;
      if (r.answer === o.answer) sameAnswer++;
    }
    const ag = agreementReport(b, a);
    const pd = pairedDelta(a, b);
    const diffs = a.map((x, i) => b[i]! - x);
    console.log(
      `\nofficial pipeline vs itself (v1 vs v2, n=${a.length}) — THE CEILING:\n` +
        `  byte-identical context : ${sameContext}/${a.length}   identical answer text: ${sameAnswer}/${a.length}\n` +
        `  pearson ${fmt(ag.pearson)}  spearman ${fmt(ag.spearman)}  MAE ${fmt(ag.mae)}  RMSE ${fmt(ag.rmse)}\n` +
        `  binary agreement ${fmt(ag.binaryAgreement)}\n` +
        `  paired delta ${fmt(pd.meanDelta)}  CI95 [${fmt(pd.ci95[0])}, ${fmt(pd.ci95[1])}]  ` +
        `${pd.wins}W/${pd.losses}L/${pd.ties}T`,
    );
    for (const n of [400, 200, 100, 40]) {
      console.log(
        `  MDE @80% power, n=${String(n).padStart(3)} : ` +
          `${fmt(minimumDetectableEffect(diffs.slice(0, n)))}`,
      );
    }
    console.log(
      `\n  No free judge can beat this agreement. Deltas below the n-matched MDE are\n` +
        `  not reportable as effects — by anyone, including the official pipeline.`,
    );
  } else {
    console.log(`\n(v2 artifact absent — cannot compute the noise ceiling)`);
  }

  // 5. Train/holdout split, recorded.
  const tr = v1.filter((r) => splitAssignment(r.query_id) === "train").length;
  console.log(
    `\nsplit: ${tr} train / ${v1.length - tr} holdout (sha256(query_id) & 1, deterministic)`,
  );
}

// ─── Free judge over the sidecar ────────────────────────────────────────────

async function callSidecar(
  system: string,
  prompt: string,
  model: string,
  attempt = 0,
): Promise<string> {
  const keyInput = {
    // `attempt` is part of the key so a retry cannot be served the same
    // unparsable response from cache.
    model: `judge:${JUDGE_PROMPT_VERSION}:${model}${attempt > 0 ? `:r${attempt}` : ""}`,
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
    body: JSON.stringify({ system, prompt, model, jsonMode: true }),
  });
  const body = (await res.json()) as { text?: string; error?: string };
  if (!res.ok || body.error) throw new Error(`sidecar: ${body.error ?? res.status}`);
  const text = body.text ?? "";
  // `cacheSet` refuses <5 trimmed chars so a timeout can never poison a replay.
  // Skip the write rather than let that throw and kill the pool.
  if (text.trim().length >= 5) {
    await cacheSet(keyInput, { response: text, latencyMs: Date.now() - started });
  }
  return text;
}

interface JudgeOutcome {
  queryId: string;
  category: string;
  official: number;
  free: number | null;
  error?: string;
}

async function judgeRow(r: OfficialRow, model: string, answer?: string): Promise<JudgeOutcome> {
  const category = categoryOf(r.query_id);
  const rubric = r.meta?.rubric ?? [];
  const text = answer ?? r.answer ?? "";
  const base = { queryId: r.query_id, category, official: r.score };
  if (rubric.length === 0) return { ...base, free: null, error: "no-rubric" };

  // Retry once on an unparsable/mis-shaped reply, then record the failure and
  // EXCLUDE the row. Never fall through to 0 — silent zeroing is precisely the
  // bug this module replaces.
  const ordering = judgeModeFor(category) === "ordering";
  const system = ordering ? ORDERING_EXTRACT_SYSTEM : RUBRIC_JUDGE_SYSTEM;
  const prompt = ordering
    ? renderOrderingExtractionPrompt(r.query, rubric, text)
    : renderRubricJudgePrompt(r.query, rubric, text);

  let lastError: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await callSidecar(system, prompt, model, attempt);
    if (ordering) {
      const parsed = parseOrderingPositions(raw, rubric.length);
      if (parsed.values) {
        return { ...base, free: orderingScoreFromPositions(parsed.values) };
      }
      lastError = parsed.error;
    } else {
      const parsed = parseVerdicts(raw, rubric.length);
      if (parsed.values) {
        return { ...base, free: rubricFractionScore(parsed.values) };
      }
      lastError = parsed.error;
    }
  }
  return { ...base, free: null, error: lastError };
}

async function runPool<T, R>(
  items: T[],
  jobs: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, () => worker()));
  return out;
}

function printAgreement(label: string, rows: JudgeOutcome[]): Agreement {
  const ag = agreementReport(
    rows.map((r) => r.free),
    rows.map((r) => r.official),
  );
  console.log(
    `\n${label}  n=${ag.n} (excluded ${ag.excluded})\n` +
      `  pearson ${fmt(ag.pearson)}  spearman ${fmt(ag.spearman)}  MAE ${fmt(ag.mae)}  ` +
      `RMSE ${fmt(ag.rmse)}  bias ${fmt(ag.bias)}\n` +
      `  binary agreement ${fmt(ag.binaryAgreement)}  LoA95 [${fmt(ag.loa95[0])}, ${fmt(ag.loa95[1])}]`,
  );
  console.log(`\n  category                     n   official     free      MAE`);
  for (const c of [...new Set(rows.map((r) => r.category))].sort()) {
    const sub = rows.filter((r) => r.category === c);
    const ok = sub.filter((r) => r.free !== null);
    const mo = sub.reduce((s, r) => s + r.official, 0) / (sub.length || 1);
    const mf = ok.reduce((s, r) => s + (r.free ?? 0), 0) / (ok.length || 1);
    const mae =
      ok.reduce((s, r) => s + Math.abs((r.free ?? 0) - r.official), 0) / (ok.length || 1);
    console.log(
      `  ${c.padEnd(26)} ${String(ok.length).padStart(3)}   ${fmt(mo)}   ${fmt(mf)}   ${fmt(mae)}`,
    );
  }
  const errs = rows.filter((r) => r.free === null);
  if (errs.length > 0) {
    const byErr: Record<string, number> = {};
    for (const e of errs) byErr[e.error ?? "?"] = (byErr[e.error ?? "?"] ?? 0) + 1;
    console.log(`\n  exclusions: ${JSON.stringify(byErr)}`);
  }
  return ag;
}

async function modeJudge(): Promise<void> {
  const model = arg("model", "claude-sonnet-5")!;
  const split = arg("split", "train")!;
  const jobs = Math.max(1, Number.parseInt(arg("jobs", "6")!, 10));
  const limit = Number.parseInt(arg("limit", "0")!, 10);
  const cats = arg("categories")?.split(",").map((s) => s.trim()).filter(Boolean);

  let rows = loadOfficial(OFFICIAL_V1);
  if (split !== "all") rows = rows.filter((r) => splitAssignment(r.query_id) === split);
  if (cats) rows = rows.filter((r) => cats.includes(categoryOf(r.query_id)));
  rows.sort((a, b) => a.query_id.localeCompare(b.query_id));
  if (limit > 0) rows = rows.slice(0, limit);

  if (split === "holdout") {
    mkdirSync(resolve(process.cwd(), OUT_DIR), { recursive: true });
    appendFileSync(
      resolve(process.cwd(), OUT_DIR, "holdout-peeks.jsonl"),
      JSON.stringify({
        promptVersion: JUDGE_PROMPT_VERSION,
        model,
        n: rows.length,
        at: new Date().toISOString(),
      }) + "\n",
      "utf8",
    );
    console.log("!! HOLDOUT PEEK recorded to holdout-peeks.jsonl — budget is 2.");
  }

  console.log(
    `judge-only calibration: model=${model} prompt=${JUDGE_PROMPT_VERSION} ` +
      `split=${split} n=${rows.length} jobs=${jobs}`,
  );
  const t0 = Date.now();
  const out = await runPool(rows, jobs, (r) => judgeRow(r, model));
  const ag = printAgreement(`AGREEMENT vs official judge [${split}]`, out);
  console.log(`\nwall ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const dir = resolve(process.cwd(), OUT_DIR);
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `judge-${JUDGE_PROMPT_VERSION}-${split}.json`);
  writeFileSync(
    path,
    JSON.stringify({ promptVersion: JUDGE_PROMPT_VERSION, model, split, agreement: ag, rows: out }, null, 2),
    "utf8",
  );
  console.log(`wrote ${path}`);

  // Pass bar from the plan, checked mechanically so it cannot be fudged later.
  const pass =
    ag.spearman >= 0.85 && ag.mae <= 0.1 && Math.abs(ag.bias) <= 0.05;
  console.log(
    `\nPASS BAR (spearman>=0.85, MAE<=0.10, |bias|<=0.05): ${pass ? "PASS" : "NOT MET"}`,
  );
}

async function modeNullTest(): Promise<void> {
  const model = arg("model", "claude-sonnet-5")!;
  const jobs = Math.max(1, Number.parseInt(arg("jobs", "6")!, 10));
  const limit = Number.parseInt(arg("limit", "0")!, 10);
  const v1 = loadOfficial(OFFICIAL_V1);
  const v2 = new Map(loadOfficial(OFFICIAL_V2).map((r) => [r.query_id, r]));
  let paired = v1.filter((r) => v2.has(r.query_id));
  paired.sort((a, b) => a.query_id.localeCompare(b.query_id));
  if (limit > 0) paired = paired.slice(0, limit);

  console.log(
    `NULL TEST: free judge on v1 vs v2 answers (official paired delta ~0). n=${paired.length}`,
  );
  const res = await runPool(paired, jobs, async (r) => {
    const other = v2.get(r.query_id)!;
    const [a, b] = await Promise.all([
      judgeRow(r, model),
      judgeRow(r, model, other.answer),
    ]);
    return { a: a.free, b: b.free, oa: r.score, ob: other.score };
  });
  const ok = res.filter((r) => r.a !== null && r.b !== null);
  const freeD = pairedDelta(ok.map((r) => r.a!), ok.map((r) => r.b!));
  const offD = pairedDelta(ok.map((r) => r.oa), ok.map((r) => r.ob));
  console.log(
    `\n  official delta : ${fmt(offD.meanDelta)}  CI95 [${fmt(offD.ci95[0])}, ${fmt(offD.ci95[1])}]\n` +
      `  free delta     : ${fmt(freeD.meanDelta)}  CI95 [${fmt(freeD.ci95[0])}, ${fmt(freeD.ci95[1])}]  ` +
      `${freeD.wins}W/${freeD.losses}L/${freeD.ties}T`,
  );
  const agrees =
    Math.abs(freeD.meanDelta - offD.meanDelta) <= 0.03 &&
    freeD.ci95[0] <= 0 &&
    freeD.ci95[1] >= 0;
  console.log(
    `\n  NULL TEST (|free-official| <= 0.03 AND free CI covers 0): ${agrees ? "PASS" : "FAIL"}`,
  );
}

// ─── Entry ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const mode = arg("mode", "audit")!;
  if (mode === "audit") return audit();
  if (mode === "judge") return modeJudge();
  if (mode === "null-test") return modeNullTest();
  throw new Error(`unknown --mode ${mode} (audit | judge | null-test)`);
}

main().catch((err) => {
  console.error(`calibrate-judge failed: ${String((err as Error).message ?? err)}`);
  process.exit(1);
});
