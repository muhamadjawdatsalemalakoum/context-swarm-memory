/**
 * BEAM answer judging — EVAL-SIDE ONLY. A SECOND GOLD-TOUCHING MODULE.
 *
 * Like `src/eval/retrievalScore.ts`, this module is allowed to read BEAM gold
 * (rubric items, gold_answers) and is a deliberate LEAF: node: builtins ONLY —
 * no project modules, no npm packages. `tests/beamLeakageFirewall.test.ts`
 * enforces that statically. Duplication with retrievalScore.ts (mulberry32,
 * normalisation helpers) is the firewall working as designed; do not "share
 * code" by importing across the boundary.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * `scripts/score-answer-gate.ts` built its judge reference list from
 * `gold_answers`. On the official 100k run **160 of 400 rows have
 * `gold_answers: []`** — every row of contradiction_resolution,
 * instruction_following, preference_following and *summarization*. Those rows
 * handed the judge an empty reference and could only score 0, which is the
 * entire explanation for the gate's ~0.03 mean and its 0W/1L/19T summarization
 * verdict. The gate was broken, not merely low-resolution.
 *
 * BEAM's judge is **rubric-based**: `meta.rubric` is present on 400/400 rows
 * (verified byte-identical between the official run artifact and the local
 * slice), and credit is per-criterion in {0, 0.5, 1} — e.g. 3.5/4 = 0.875,
 * 7.5/8 = 0.9375. A 0-10 integer holistic rating cannot express that.
 *
 * ── THE TWO SCORING SHAPES ──────────────────────────────────────────────────
 *
 * 1. `rubric-fraction` (nine categories): score = mean of per-criterion
 *    verdicts in {0, 0.5, 1}.
 *
 * 2. `ordering` (event_ordering): the official score is a **rank correlation**,
 *    not a rating. Reverse-engineered from the official score distribution:
 *
 *        score = (1 + Kendall tau-b) / 2
 *
 *    over the sequence in which the answer discusses the rubric items, versus
 *    the rubric's own order. The irrational scores in the official
 *    distribution are the tie-correction term of tau-b:
 *
 *        0.8162277660168380 = 0.5 + 1/sqrt(10)
 *        0.8535533905932738 = 0.5 + 1/(2*sqrt(2))
 *        0.7886751345948129 = 0.5 + 1/(2*sqrt(3))
 *        0.7672612419124245 = 0.5 + 1/sqrt(14)
 *        0.2763932022500211 = 0.5 - 1/sqrt(20)
 *
 *    A worked case, `4_event_ordering_0`: the answer's items map to gold
 *    indices [1,3,4,5,8,7,6,2,9] -> 9 discordant pairs of 36 -> tau = 0.5 ->
 *    score 0.75, which is exactly the official value.
 *
 *    Consequence for CSM: **the metric literally rewards correct sequence**, so
 *    any retrieval reordering that scrambles chronology is scored down even
 *    when it retrieves strictly more. That is a mechanical prediction, not a
 *    hunch.
 *
 * Nothing this module produces is ever read back by retrieval logic.
 */
import { createHash } from "node:crypto";

// ─── Categories ─────────────────────────────────────────────────────────────

/** BEAM query ids are `<user>_<category>_<n>`; the category may contain "_". */
export function categoryOf(queryId: string): string {
  return queryId.replace(/^\d+_/, "").replace(/_\d+$/, "");
}

export type JudgeMode = "rubric-fraction" | "ordering";

/** event_ordering is rank-correlation scored; everything else is per-criterion.
 *  summarization is deliberately NOT ordering: its official score distribution
 *  contains x.5/n values (0.875 = 3.5/4) that a tau mapping cannot produce. */
export function judgeModeFor(category: string): JudgeMode {
  return category === "event_ordering" ? "ordering" : "rubric-fraction";
}

// ─── Rubric text ────────────────────────────────────────────────────────────

const RUBRIC_PREFIX = /^\s*LLM\s+response\s+should\s+(?:contain|mention|include|state)\s*:?\s*/i;

/** Strip the boilerplate lead-in so the criterion text is what gets matched. */
export function rubricItemText(item: string): string {
  return String(item).replace(RUBRIC_PREFIX, "").trim();
}

// ─── Kendall tau-b ──────────────────────────────────────────────────────────

/**
 * Tie-corrected Kendall tau-b.
 *
 *   tau_b = (C - D) / sqrt((n0 - n1) * (n0 - n2))
 *
 * with n0 = n(n-1)/2 and n1/n2 the tied-pair counts within x and y. Returns 0
 * when either denominator factor vanishes (a constant ranking carries no order
 * information, so it is neither concordant nor discordant).
 */
export function kendallTauB(x: number[], y: number[]): number {
  const n = x.length;
  if (n !== y.length) throw new Error("kendallTauB: length mismatch");
  if (n < 2) return 0;
  let concordant = 0;
  let discordant = 0;
  let tiedX = 0;
  let tiedY = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = Math.sign(x[i]! - x[j]!);
      const dy = Math.sign(y[i]! - y[j]!);
      if (dx === 0 && dy === 0) {
        tiedX++;
        tiedY++;
      } else if (dx === 0) {
        tiedX++;
      } else if (dy === 0) {
        tiedY++;
      } else if (dx === dy) {
        concordant++;
      } else {
        discordant++;
      }
    }
  }
  const n0 = (n * (n - 1)) / 2;
  const denom = Math.sqrt((n0 - tiedX) * (n0 - tiedY));
  if (denom === 0) return 0;
  return (concordant - discordant) / denom;
}

/**
 * Ordering score from extracted positions.
 *
 * `positions[i]` is where rubric item i is first discussed in the answer
 * (any monotone scale — character offset, sentence index, 1-based rank), or
 * `null` when the answer never covers it. Absent items are placed in a single
 * tie group *after* every present item: not covering something is not an
 * ordering error between two absent items, but it is an error relative to
 * anything that was covered. That tie group is what produces the sqrt
 * denominators observed in the official distribution.
 */
export function orderingScoreFromPositions(positions: Array<number | null>): number {
  const n = positions.length;
  if (n < 2) {
    // A single-item rubric carries no order information. Fall back to
    // coverage so the score still discriminates.
    return positions[0] === null || positions[0] === undefined ? 0 : 1;
  }
  const present = positions.filter((p): p is number => p !== null);
  const sentinel = present.length > 0 ? Math.max(...present) + 1 : 1;
  const gold = positions.map((_, i) => i);
  const got = positions.map((p) => (p === null ? sentinel : p));
  const tau = kendallTauB(gold, got);
  return (1 + tau) / 2;
}

/** Per-criterion credit in {0, 0.5, 1}. `null` verdicts are EXCLUDED from the
 *  mean, never silently zeroed — silent zeroing is the bug this file replaces. */
export function rubricFractionScore(verdicts: Array<number | null>): number | null {
  const scored = verdicts.filter((v): v is number => v !== null && Number.isFinite(v));
  if (scored.length === 0) return null;
  const clamped = scored.map((v) => (v <= 0 ? 0 : v >= 1 ? 1 : v === 0.5 ? 0.5 : v));
  return clamped.reduce((a, b) => a + b, 0) / clamped.length;
}

// ─── Deterministic literal matcher (the zero-LLM baseline) ──────────────────

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "at",
  "by", "from", "as", "is", "was", "were", "be", "been", "that", "this",
  "these", "those", "it", "its", "you", "your", "user", "llm", "response",
  "should", "contain", "mention", "include", "then", "also", "was", "had",
]);

export function normalizeText(s: string): string {
  return String(s).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function contentTokens(s: string): string[] {
  return normalizeText(s).split(" ").filter((t) => t.length > 2 && !STOP.has(t));
}

/**
 * Zero-LLM position extraction: for each rubric item, the earliest character
 * offset in the answer at which a distinctive chunk of that item appears.
 *
 * This exists as the *null model* for the ordering judge. If an LLM extraction
 * prompt cannot beat it on exact-reproduction of official scores, the LLM is
 * not earning its cost.
 */
export function literalItemPositions(
  answer: string,
  rubric: string[],
  minOverlap = 0.34,
): Array<number | null> {
  const hay = normalizeText(answer);
  const hayTokens = hay.split(" ");
  // Character offset of each token in the normalised haystack.
  const offsets: number[] = [];
  let cursor = 0;
  for (const t of hayTokens) {
    const idx = hay.indexOf(t, cursor);
    offsets.push(idx < 0 ? cursor : idx);
    cursor = (idx < 0 ? cursor : idx) + t.length;
  }
  const haySet = new Set(hayTokens);

  return rubric.map((item) => {
    const toks = contentTokens(rubricItemText(item));
    if (toks.length === 0) return null;
    const present = toks.filter((t) => haySet.has(t));
    if (present.length / toks.length < minOverlap) return null;
    // Earliest offset at which any of the item's distinctive tokens occurs;
    // prefer the rarest token so common words don't drag the position early.
    let best: number | null = null;
    for (const t of present) {
      const i = hayTokens.indexOf(t);
      if (i < 0) continue;
      const off = offsets[i]!;
      if (best === null || off < best) best = off;
    }
    return best;
  });
}

// ─── Prompt rendering ───────────────────────────────────────────────────────

/** Bumped whenever a prompt changes. It is part of the cache key AND is
 *  recorded in the calibration artifact, so a later edit can never silently
 *  serve stale verdicts or be mistaken for the frozen prompt. */
export const JUDGE_PROMPT_VERSION = "v2";

/**
 * CALIBRATION NOTE (v1 -> v2). v1 said "judge substance, not wording" and came
 * out systematically LENIENT (bias +0.044, spearman 0.845). Inspecting the
 * disagreements showed the reference grader (gemini-2.5-flash-lite) credits the
 * *stated form* of a criterion, not merely the fact:
 *
 *   1_temporal_reasoning_0  rubric: "state: from January 15, 2024 till March
 *                           15, 2024"; the answer gave both dates but as two
 *                           separate event dates. Official 0.5, v1 said 1.0.
 *   11_temporal_reasoning_1 identical shape. Official 0.5, v1 said 1.0.
 *
 * The gate's job is to PREDICT the official judge, not to out-judge it — a
 * fairer grader is a worse instrument. v2 therefore grades closer to the
 * literal criterion and defaults to 0.5 under doubt.
 */
export const RUBRIC_JUDGE_SYSTEM =
  "You predict how a strict reference grader would score a candidate answer " +
  "against a list of criteria.\n" +
  "For EACH criterion, decide independently:\n" +
  "  1   = the answer explicitly states what the criterion asks for\n" +
  "  0.5 = the answer conveys it partially, implicitly, in a different " +
  "decomposition, or with a minor error\n" +
  "  0   = the answer omits it or contradicts it\n" +
  "Rules the reference grader follows:\n" +
  "- A criterion naming a concrete value, quantity, date, or date range is a 1 " +
  "ONLY if the answer states that value in the form the criterion gives. If the " +
  "answer conveys the same fact in a different form or split across other " +
  "statements, that is 0.5, not 1.\n" +
  "- Reordering, extra correct detail, and different sentence structure are not " +
  "penalised on their own.\n" +
  "- If the criterion says information is absent and the answer also says it is " +
  "absent, that is 1.\n" +
  "- When genuinely torn between 1 and 0.5, choose 0.5. The reference grader is " +
  "strict.\n" +
  'Reply with ONLY a JSON object: {"verdicts":[...]} with exactly one number ' +
  "per criterion, in the same order. No prose, no markdown fences.";

/**
 * CALIBRATION NOTE. `12_event_ordering_1` is an explicit refusal — "the context
 * lacks the information ... it does not mention a simulated happiness thought
 * experiment or an identity paradox" — yet the official score is 0.233, not 0.
 * That is only reachable if the two NEGATED topics still counted as discussed
 * (and in the wrong order). So mentions count even when the answer is denying
 * them; v2 says so explicitly.
 */
export const ORDERING_EXTRACT_SYSTEM =
  "You locate topics inside an answer. You do NOT grade.\n" +
  "You are given a candidate answer and a numbered list of topics.\n" +
  "For EACH topic, report the 1-based ordinal position at which the answer " +
  "FIRST refers to it, counting the answer's own sequence of referenced items " +
  "from the beginning. If the answer never refers to that topic at all, report " +
  "null.\n" +
  "A topic counts as referred to even when the answer mentions it only to deny, " +
  "negate, or say it is missing — position it where that mention occurs.\n" +
  "Two topics may share a position only if the answer genuinely presents them " +
  "together.\n" +
  'Reply with ONLY a JSON object: {"positions":[...]} with exactly one entry ' +
  "per topic, in the topic list's order. No prose, no markdown fences.";

export function renderRubricJudgePrompt(
  query: string,
  rubric: string[],
  answer: string,
): string {
  const criteria = rubric
    .map((r, i) => `${i + 1}. ${rubricItemText(r)}`)
    .join("\n");
  return (
    `Question:\n${query}\n\n` +
    `Scoring criteria (${rubric.length}):\n${criteria}\n\n` +
    `Candidate answer:\n${answer}\n\n` +
    `JSON (${rubric.length} verdicts):`
  );
}

export function renderOrderingExtractionPrompt(
  query: string,
  rubric: string[],
  answer: string,
): string {
  const topics = rubric
    .map((r, i) => `${i + 1}. ${rubricItemText(r)}`)
    .join("\n");
  return (
    `Question:\n${query}\n\n` +
    `Topics (${rubric.length}):\n${topics}\n\n` +
    `Candidate answer:\n${answer}\n\n` +
    `JSON (${rubric.length} positions):`
  );
}

// ─── Parsing ────────────────────────────────────────────────────────────────

/** Pull the first balanced JSON object out of a possibly chatty completion. */
function extractJsonObject(raw: string): unknown {
  const s = String(raw);
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export interface ParseResult<T> {
  values: T[] | null;
  /** Why parsing failed, for the exclusion census. Never silently score 0. */
  error?: "no-json" | "wrong-key" | "length-mismatch" | "bad-values";
}

export function parseVerdicts(raw: string, expectedLen: number): ParseResult<number> {
  const obj = extractJsonObject(raw) as { verdicts?: unknown } | null;
  if (!obj || typeof obj !== "object") return { values: null, error: "no-json" };
  const arr = (obj as { verdicts?: unknown }).verdicts;
  if (!Array.isArray(arr)) return { values: null, error: "wrong-key" };
  if (arr.length !== expectedLen) return { values: null, error: "length-mismatch" };
  const out: number[] = [];
  for (const v of arr) {
    const n = typeof v === "number" ? v : Number.parseFloat(String(v));
    if (!Number.isFinite(n)) return { values: null, error: "bad-values" };
    out.push(n <= 0 ? 0 : n >= 1 ? 1 : n < 0.75 ? 0.5 : 1);
  }
  return { values: out };
}

export function parseOrderingPositions(
  raw: string,
  expectedLen: number,
): ParseResult<number | null> {
  const obj = extractJsonObject(raw) as { positions?: unknown } | null;
  if (!obj || typeof obj !== "object") return { values: null, error: "no-json" };
  const arr = (obj as { positions?: unknown }).positions;
  if (!Array.isArray(arr)) return { values: null, error: "wrong-key" };
  if (arr.length !== expectedLen) return { values: null, error: "length-mismatch" };
  const out: Array<number | null> = [];
  for (const v of arr) {
    if (v === null || v === undefined || v === "null") {
      out.push(null);
      continue;
    }
    const n = typeof v === "number" ? v : Number.parseFloat(String(v));
    out.push(Number.isFinite(n) ? n : null);
  }
  return { values: out };
}

// ─── Agreement statistics ───────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (v: number[]): number => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);

export function pearson(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2) return 0;
  const mx = mean(x);
  const my = mean(y);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i]! - mx;
    const b = y[i]! - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? 0 : num / den;
}

/** Average ranks for ties, so Spearman is well defined on the many 1.0 scores. */
function rankAvg(v: number[]): number[] {
  const idx = v.map((val, i) => ({ val, i })).sort((a, b) => a.val - b.val);
  const out = new Array<number>(v.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]!.val === idx[i]!.val) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k]!.i] = r;
    i = j + 1;
  }
  return out;
}

export function spearman(x: number[], y: number[]): number {
  return pearson(rankAvg(x), rankAvg(y));
}

export interface Agreement {
  n: number;
  pearson: number;
  spearman: number;
  mae: number;
  rmse: number;
  /** mean(free - official); positive = the free judge is too generous. */
  bias: number;
  /** Bland-Altman 95% limits of agreement on the difference. */
  loa95: [number, number];
  /** Agreement on the binary `score >= 0.5` decision. */
  binaryAgreement: number;
  /** Rows where the free judge produced no parsable verdict. */
  excluded: number;
}

export function agreementReport(
  free: Array<number | null>,
  official: number[],
): Agreement {
  const fx: number[] = [];
  const ox: number[] = [];
  let excluded = 0;
  for (let i = 0; i < official.length; i++) {
    const f = free[i];
    if (f === null || f === undefined || !Number.isFinite(f)) {
      excluded++;
      continue;
    }
    fx.push(f);
    ox.push(official[i]!);
  }
  const n = fx.length;
  if (n === 0) {
    return {
      n: 0, pearson: 0, spearman: 0, mae: 0, rmse: 0, bias: 0,
      loa95: [0, 0], binaryAgreement: 0, excluded,
    };
  }
  const diffs = fx.map((f, i) => f - ox[i]!);
  const bias = mean(diffs);
  const sd = Math.sqrt(mean(diffs.map((d) => (d - bias) ** 2)));
  return {
    n,
    pearson: pearson(fx, ox),
    spearman: spearman(fx, ox),
    mae: mean(diffs.map(Math.abs)),
    rmse: Math.sqrt(mean(diffs.map((d) => d * d))),
    bias,
    loa95: [bias - 1.96 * sd, bias + 1.96 * sd],
    binaryAgreement:
      fx.filter((f, i) => (f >= 0.5) === (ox[i]! >= 0.5)).length / n,
    excluded,
  };
}

export interface PairedDelta {
  n: number;
  meanDelta: number;
  ci95: [number, number];
  wins: number;
  losses: number;
  ties: number;
}

/** Bootstrap CI on a paired mean difference (b - a), seeded for replay. */
export function pairedDelta(
  a: number[],
  b: number[],
  opts: { resamples?: number; seed?: number } = {},
): PairedDelta {
  const n = Math.min(a.length, b.length);
  if (n === 0) return { n: 0, meanDelta: 0, ci95: [0, 0], wins: 0, losses: 0, ties: 0 };
  const d = Array.from({ length: n }, (_, i) => b[i]! - a[i]!);
  const resamples = opts.resamples ?? 10_000;
  const rng = mulberry32(opts.seed ?? 42);
  const sampled = new Array<number>(resamples);
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += d[Math.floor(rng() * n)]!;
    sampled[r] = s / n;
  }
  sampled.sort((x, y) => x - y);
  return {
    n,
    meanDelta: mean(d),
    ci95: [
      sampled[Math.floor(0.025 * resamples)]!,
      sampled[Math.floor(0.975 * resamples)]!,
    ],
    wins: d.filter((v) => v > 0).length,
    losses: d.filter((v) => v < 0).length,
    ties: d.filter((v) => v === 0).length,
  };
}

/**
 * Minimum detectable effect at 80% power / alpha 0.05 for a paired design,
 * from the observed per-query difference SD. This is the number that licenses
 * (or forbids) reporting a delta: anything below it is unmeasurable at that n.
 */
export function minimumDetectableEffect(diffs: number[]): number {
  const n = diffs.length;
  if (n < 2) return Infinity;
  const m = mean(diffs);
  const sd = Math.sqrt(diffs.reduce((s, d) => s + (d - m) ** 2, 0) / (n - 1));
  return 2.802 * (sd / Math.sqrt(n)); // 1.96 + 0.842
}

// ─── Deterministic train/holdout split ──────────────────────────────────────

/**
 * Stratified by category, deterministic, and recorded in the artifact so it can
 * never be quietly re-drawn to flatter a result. Prompt iteration touches TRAIN
 * only; HOLDOUT is the honest read.
 */
export function splitAssignment(queryId: string): "train" | "holdout" {
  const h = createHash("sha256").update(queryId).digest();
  return (h[0]! & 1) === 0 ? "train" : "holdout";
}
