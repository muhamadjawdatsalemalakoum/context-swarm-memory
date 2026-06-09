/**
 * BEAM retrieval scoring — EVAL-SIDE ONLY. THE GOLD-TOUCHING MODULE.
 *
 * This is the single module in the repo allowed to read BEAM gold
 * (gold_answers, rubric items, ordering_tested/time_points hints). It is a
 * deliberate LEAF: it imports node: builtins ONLY — no project modules, no
 * npm packages — so its import closure is disjoint from everything the
 * retrieval path imports. `tests/beamLeakageFirewall.test.ts` enforces that
 * statically; do not add imports here to "share code" — duplication inside
 * this file is the firewall working as designed.
 *
 * Information flow (one-way, file-mediated):
 *
 *   runner (scripts/run-beam-slice.ts, retrieval side)
 *     └─ writes  data/eval/runs/<id>/payloads.jsonl     (ids + telemetry)
 *   scorer (scripts/score-beam-slice.ts → this module, eval side)
 *     └─ reads   payloads.jsonl + raw BEAM queries/documents (gold)
 *     └─ writes  retrieval-scores.json / .md
 *
 * Nothing this module produces is ever read back by retrieval logic.
 *
 * ── Metric definitions ──────────────────────────────────────────────────
 *
 * BEAM queries carry NO sub-conversation evidence references: `gold_ids`
 * equals `[conversation_id]` on 400/400 rows of the 100k split (verified
 * 2026-06-10 against AMB 45fa38052; also hard-coded upstream in
 * `src/memory_bench/dataset/beam.py: gold_ids=[conv_id]`). Event/turn-level
 * recall against gold ids is therefore impossible, and doc-level recall is
 * degenerate (≡ 1.0 under user-scoped retrieval).
 *
 * The metric used instead is a documented PROXY — **gold-facet retrieval
 * coverage**:
 *
 *   facets(q)        = atomic gold facts for query q, in priority order:
 *                      rubric items (the judge's actual scoring units,
 *                      "LLM response should …: X" → X), plus
 *                      ordering_tested topics ("1st: X" → X) and
 *                      time_points for their categories; falling back to
 *                      gold_answers[0] sentences when no rubric exists.
 *   supports(e, f)   = event e's text lexically contains facet f:
 *                      ≥ 50% of f's distinctive terms match on word
 *                      boundaries, and at least min(2, |terms|) match.
 *   coverage@k(q)    = |{f : some e in top-k retrieved supports f}| / |facets|
 *   oracleCoverage(q)= the same over ALL events in q's unit — the lexical
 *                      ceiling of the proxy (paraphrase gap shows up here).
 *   normalized@k     = coverage@k / oracleCoverage (when oracle > 0) —
 *                      "fraction of lexically-achievable gold retrieved".
 *
 * Reported at k ∈ {10, 24, 32} over `returnedEventIds` (post-capsule bridge
 * output), plus the same coverage over `packedEventIds` (what CSM packed
 * into its own context — the T1 target) and `csmRetrievedEventIds`
 * (pipeline + augmentation order, pre-budget). Per-category means carry
 * seeded-bootstrap 95% CIs (mulberry32(42), 10k resamples — scorer.ts
 * conventions, re-implemented here because importing scorer.ts would breach
 * the firewall).
 *
 * Abstention queries are excluded by default: their rubric facet is "there
 * is no information about X", so retrieval coverage is not meaningful.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

// ─── Gold records ───────────────────────────────────────────────────────────

export interface BeamGoldRecord {
  queryId: string;
  category: string;
  userId: string;
  question: string;
  /** Atomic gold facts used for coverage (prefix-stripped). */
  facets: string[];
  /** Where the facets came from (auditing the proxy). */
  facetSources: Array<"rubric" | "ordering_tested" | "time_points" | "gold_answer">;
}

interface RawBeamQueryRow {
  id: string;
  query: string;
  user_id: string | number;
  gold_answers?: unknown;
  gold_ids?: unknown;
  meta?: Record<string, unknown>;
}

function readJsonMaybeGz(dir: string, base: string): unknown {
  const plain = join(dir, `${base}.json`);
  const gz = join(dir, `${base}.json.gz`);
  if (existsSync(plain)) return JSON.parse(readFileSync(plain, "utf8"));
  if (existsSync(gz)) {
    return JSON.parse(gunzipSync(readFileSync(gz)).toString("utf8"));
  }
  throw new Error(`retrievalScore: ${base}.json(.gz) not found under ${dir}`);
}

/** Strip AMB rubric/ordering prefixes down to the bare fact text. */
export function stripFacetPrefix(item: string): string {
  return item
    .replace(/^\s*LLM response should (?:contain|state|mention|include|list|say)\s*:?\s*/i, "")
    .replace(/^\s*\d+(?:st|nd|rd|th)\s*:\s*/i, "")
    .trim();
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

/** Split a reference answer into sentence-ish facets (fallback path). */
function sentenceFacets(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12);
}

/**
 * Load gold records for one split, keyed by query id. Reads the raw slice
 * files directly (`<sliceDir>/<split>/queries.json[.gz]`).
 */
export function loadBeamGold(
  split: string,
  opts: { sliceDir?: string } = {},
): Map<string, BeamGoldRecord> {
  const sliceDir =
    opts.sliceDir ?? resolve(process.cwd(), "data", "eval", "corpus-beam-slice");
  const raw = readJsonMaybeGz(join(sliceDir, split), "queries");
  if (!Array.isArray(raw)) {
    throw new Error(`retrievalScore: ${split}/queries is not a JSON array`);
  }

  const out = new Map<string, BeamGoldRecord>();
  for (const rowUnknown of raw) {
    const row = rowUnknown as RawBeamQueryRow;
    if (!row || typeof row.id !== "string" || typeof row.query !== "string") {
      continue;
    }
    const meta = row.meta ?? {};
    const category =
      typeof meta.question_category === "string"
        ? meta.question_category
        : (/^[^_]+_(.+)_\d+$/.exec(row.id)?.[1] ?? "unknown");

    const facets: string[] = [];
    const facetSources: BeamGoldRecord["facetSources"] = [];
    const push = (
      items: string[],
      source: BeamGoldRecord["facetSources"][number],
    ): void => {
      for (const item of items) {
        const stripped = stripFacetPrefix(item);
        if (stripped.length === 0) continue;
        if (facets.some((f) => f.toLowerCase() === stripped.toLowerCase())) continue;
        facets.push(stripped);
        facetSources.push(source);
      }
    };

    push(asStringList(meta.rubric), "rubric");
    push(asStringList(meta.ordering_tested), "ordering_tested");
    push(asStringList(meta.time_points), "time_points");
    if (facets.length === 0) {
      const answers = asStringList(row.gold_answers);
      if (answers.length > 0) {
        const sentences = sentenceFacets(answers[0]!);
        push(sentences.length > 0 ? sentences : [answers[0]!], "gold_answer");
      }
    }

    out.set(row.id, {
      queryId: row.id,
      category,
      userId: String(row.user_id),
      question: row.query,
      facets,
      facetSources,
    });
  }
  return out;
}

// ─── Event text index (duplicated bridge turn-splitting) ────────────────────

/**
 * Map of bridge event id → event text, built by re-reading the slice's
 * documents file with the SAME turn-splitting + id scheme as the bridge's
 * `documentToEvents` (scripts/amb-csm-retrieve.ts). The logic is duplicated
 * here on purpose — importing the bridge would breach the firewall.
 * `tests/retrievalScore.test.ts` cross-validates id-for-id equality against
 * the real `buildCorpus` on a fixture (tests may import both sides).
 */
export interface BeamEventIndex {
  textById: Map<string, string>;
  /** Event ids per unit (user) id, for oracle coverage. */
  idsByUnit: Map<string, string[]>;
}

export function buildBeamEventIndex(
  split: string,
  opts: { sliceDir?: string } = {},
): BeamEventIndex {
  const sliceDir =
    opts.sliceDir ?? resolve(process.cwd(), "data", "eval", "corpus-beam-slice");
  const raw = readJsonMaybeGz(join(sliceDir, split), "documents");
  if (!Array.isArray(raw)) {
    throw new Error(`retrievalScore: ${split}/documents is not a JSON array`);
  }

  const textById = new Map<string, string>();
  const idsByUnit = new Map<string, string[]>();
  raw.forEach((rowUnknown, index) => {
    const row = rowUnknown as {
      id?: string;
      content?: string;
      user_id?: string | number;
      context?: string | null;
    };
    const docId = row.id || `amb-doc-${index}`;
    const content = typeof row.content === "string" ? row.content : "";
    const unit = String(row.user_id ?? "");
    const chunks = splitTurnsLikeBridge(content);
    const sourceChunks = chunks.length > 0 ? chunks : [content];
    const contextPrefix = row.context ? `Context: ${row.context}\n\n` : "";
    sourceChunks.forEach((chunk, chunkIndex) => {
      const id = sourceChunks.length === 1 ? docId : `${docId}#turn-${chunkIndex}`;
      textById.set(id, `${contextPrefix}${chunk}`.trim());
      const bucket = idsByUnit.get(unit);
      if (bucket) bucket.push(id);
      else idsByUnit.set(unit, [id]);
    });
  });
  return { textById, idsByUnit };
}

/** Byte-for-byte duplicate of the bridge's `splitTurns`. */
function splitTurnsLikeBridge(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const matches = [
    ...normalized.matchAll(
      /(?:^|\n)\s*(?:\[[^\]\n]*?\s*\|\s*)?\[?Turn\s+\d+\]?\s+(?:User|Assistant):/g,
    ),
  ];
  if (matches.length <= 1) return [];
  const chunks: string[] = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i]!.index ?? 0;
    const end = matches[i + 1]?.index ?? normalized.length;
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}

// ─── Facet containment ──────────────────────────────────────────────────────

const FACET_STOP_WORDS = new Set([
  "about", "across", "after", "again", "also", "answer", "around", "based",
  "before", "being", "between", "both", "chat", "contain", "conversation",
  "could", "describe", "different", "discussed", "does", "each", "early",
  "every", "first", "followed", "from", "give", "have", "include", "info",
  "information", "into", "involve", "later", "list", "llm", "many",
  "mention", "mentioned", "mentions", "most", "much", "provide", "provided",
  "related", "response", "should", "specific", "state", "such", "that",
  "their", "them", "then", "there", "these", "this", "those", "through",
  "time", "topic", "topics", "user", "using", "well", "were", "what",
  "when", "where", "which", "while", "will", "with", "would",
]);

/**
 * Distinctive terms of a facet: lowercase tokens that are ≥4 chars (or
 * contain a digit — dates/versions/counts matter), minus stop words.
 * Capped at 24 terms. Deterministic.
 */
export function facetTerms(facet: string): string[] {
  const tokens = facet.toLowerCase().match(/[a-z0-9][a-z0-9_.\/-]*/g) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tokenRaw of tokens) {
    const token = tokenRaw.replace(/[.\/-]+$/, "");
    if (token.length === 0) continue;
    const hasDigit = /\d/.test(token);
    if (!hasDigit && token.length < 4) continue;
    if (FACET_STOP_WORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= 24) break;
  }
  return out;
}

/**
 * Does `text` lexically support a facet with terms `terms`?
 * Rule: ≥ 50% of terms match on word boundaries AND at least
 * min(2, |terms|) match. Deterministic, case-insensitive.
 */
export function textSupportsFacet(text: string, terms: string[]): boolean {
  if (terms.length === 0) return false;
  const low = text.toLowerCase();
  let matched = 0;
  for (const term of terms) {
    if (new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(low)) matched++;
  }
  return matched >= Math.min(2, terms.length) && matched / terms.length >= 0.5;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Payload rows (runner output → scorer input) ────────────────────────────

/** The subset of a payloads.jsonl row the scorer consumes. Validated
 *  structurally — the file on disk is the only interface with the runner. */
export interface PayloadRow {
  queryId: string;
  category: string;
  userId: string;
  questionSha256: string;
  requestedK: number;
  returnedEventIds: string[];
  packedEventIds: string[];
  csmRetrievedEventIds: string[];
  evidenceCapsule: boolean;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  probeCount: number | null;
  recallCount: number | null;
}

export function parsePayloadLine(line: string): PayloadRow | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let row: {
    harness?: Record<string, unknown>;
    raw_response?: Record<string, unknown>;
  };
  try {
    row = JSON.parse(trimmed) as typeof row;
  } catch {
    // Torn tail line from an interrupted run — the runner re-runs that
    // query on resume, so skipping here is correct.
    return null;
  }
  const harness = row.harness ?? {};
  const rawResponse = row.raw_response ?? {};
  const meta = (rawResponse.meta ?? {}) as Record<string, unknown>;
  const str = (v: unknown, fallback = ""): string =>
    typeof v === "string" ? v : fallback;
  const num = (v: unknown, fallback = 0): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  const ids = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  const queryId = str(harness.queryId);
  if (!queryId) return null;
  return {
    queryId,
    category: str(harness.category, "unknown"),
    userId: str(harness.userId),
    questionSha256: str(harness.questionSha256),
    requestedK: num(harness.requestedK, 0),
    returnedEventIds: ids(rawResponse.returnedEventIds),
    packedEventIds: ids(meta.packedEventIds),
    csmRetrievedEventIds: ids(meta.csmRetrievedEventIds),
    evidenceCapsule: rawResponse.evidenceCapsule === true,
    inputTokens: num(rawResponse.inputTokens),
    outputTokens: num(rawResponse.outputTokens),
    latencyMs: num(rawResponse.latencyMs),
    probeCount: typeof meta.probeCount === "number" ? meta.probeCount : null,
    recallCount: typeof meta.recallCount === "number" ? meta.recallCount : null,
  };
}

export function readPayloadRows(path: string): PayloadRow[] {
  const text = readFileSync(path, "utf8");
  const rows: PayloadRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const row = parsePayloadLine(line);
    if (row) rows.push(row);
  }
  return rows;
}

// ─── Per-query scoring ──────────────────────────────────────────────────────

export const DEFAULT_KS = [10, 24, 32] as const;

export interface RowScore {
  queryId: string;
  category: string;
  userId: string;
  facetCount: number;
  /** coverage@k over returnedEventIds prefixes, keyed `"@<k>"`. */
  coverageAtK: Record<string, number>;
  packedCoverage: number;
  retrievedCoverage: number;
  oracleCoverage: number;
  /** coverage@k / oracleCoverage (null when oracle is 0). */
  normalizedAtK: Record<string, number | null>;
  returnedCount: number;
  packedCount: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  evidenceCapsule: boolean;
  probeCount: number | null;
  recallCount: number | null;
}

export function scorePayloadRow(
  row: PayloadRow,
  gold: BeamGoldRecord,
  index: BeamEventIndex,
  ks: readonly number[] = DEFAULT_KS,
): RowScore | null {
  if (gold.facets.length === 0) return null;
  const termsPerFacet = gold.facets.map(facetTerms);

  const coverageOver = (ids: readonly string[]): number => {
    let covered = 0;
    for (const terms of termsPerFacet) {
      let hit = false;
      for (const id of ids) {
        const text = index.textById.get(id);
        if (text && textSupportsFacet(text, terms)) {
          hit = true;
          break;
        }
      }
      if (hit) covered++;
    }
    return covered / termsPerFacet.length;
  };

  const coverageAtK: Record<string, number> = {};
  for (const k of ks) {
    coverageAtK[`@${k}`] = coverageOver(row.returnedEventIds.slice(0, k));
  }
  const packedCoverage = coverageOver(row.packedEventIds);
  const retrievedCoverage = coverageOver(row.csmRetrievedEventIds);
  const oracleCoverage = coverageOver(index.idsByUnit.get(row.userId) ?? []);
  const normalizedAtK: Record<string, number | null> = {};
  for (const k of ks) {
    normalizedAtK[`@${k}`] =
      oracleCoverage > 0 ? coverageAtK[`@${k}`]! / oracleCoverage : null;
  }

  return {
    queryId: row.queryId,
    category: gold.category,
    userId: row.userId,
    facetCount: gold.facets.length,
    coverageAtK,
    packedCoverage,
    retrievedCoverage,
    oracleCoverage,
    normalizedAtK,
    returnedCount: row.returnedEventIds.length,
    packedCount: row.packedEventIds.length,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    latencyMs: row.latencyMs,
    evidenceCapsule: row.evidenceCapsule,
    probeCount: row.probeCount,
    recallCount: row.recallCount,
  };
}

// ─── Aggregation (seeded bootstrap, scorer.ts conventions) ──────────────────

export interface MetricAggregate {
  n: number;
  mean: number;
  /** Seeded bootstrap 95% CI, [lower, upper]. */
  ci95: [number, number];
}

export interface CategoryAggregate {
  category: string;
  n: number;
  coverageAtK: Record<string, MetricAggregate>;
  packedCoverage: MetricAggregate;
  retrievedCoverage: MetricAggregate;
  oracleCoverage: MetricAggregate;
  meanReturnedCount: number;
  meanPackedCount: number;
  meanInputTokens: number;
  meanOutputTokens: number;
  meanLatencyMs: number;
  meanProbeCount: number | null;
  meanRecallCount: number | null;
}

export interface AggregateOptions {
  bootstrapResamples?: number;
  seed?: number;
}

export function aggregateMetric(
  values: number[],
  opts: AggregateOptions = {},
): MetricAggregate {
  const n = values.length;
  if (n === 0) return { n: 0, mean: 0, ci95: [0, 0] };
  const resamples = opts.bootstrapResamples ?? 10_000;
  const rng = mulberry32(opts.seed ?? 42);
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sampled: number[] = new Array(resamples);
  for (let i = 0; i < resamples; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += values[Math.floor(rng() * n)]!;
    sampled[i] = sum / n;
  }
  sampled.sort((a, b) => a - b);
  return {
    n,
    mean,
    ci95: [
      sampled[Math.floor(0.025 * resamples)]!,
      sampled[Math.floor(0.975 * resamples)]!,
    ],
  };
}

export function aggregateByCategory(
  scores: RowScore[],
  ks: readonly number[] = DEFAULT_KS,
  opts: AggregateOptions = {},
): CategoryAggregate[] {
  const byCategory = new Map<string, RowScore[]>();
  for (const s of scores) {
    const bucket = byCategory.get(s.category);
    if (bucket) bucket.push(s);
    else byCategory.set(s.category, [s]);
  }

  const out: CategoryAggregate[] = [];
  for (const [category, rows] of [...byCategory.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const coverageAtK: Record<string, MetricAggregate> = {};
    for (const k of ks) {
      coverageAtK[`@${k}`] = aggregateMetric(
        rows.map((r) => r.coverageAtK[`@${k}`] ?? 0),
        opts,
      );
    }
    const meanOf = (xs: number[]): number =>
      xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
    const probeCounts = rows
      .map((r) => r.probeCount)
      .filter((v): v is number => v !== null);
    const recallCounts = rows
      .map((r) => r.recallCount)
      .filter((v): v is number => v !== null);
    out.push({
      category,
      n: rows.length,
      coverageAtK,
      packedCoverage: aggregateMetric(rows.map((r) => r.packedCoverage), opts),
      retrievedCoverage: aggregateMetric(
        rows.map((r) => r.retrievedCoverage),
        opts,
      ),
      oracleCoverage: aggregateMetric(rows.map((r) => r.oracleCoverage), opts),
      meanReturnedCount: meanOf(rows.map((r) => r.returnedCount)),
      meanPackedCount: meanOf(rows.map((r) => r.packedCount)),
      meanInputTokens: meanOf(rows.map((r) => r.inputTokens)),
      meanOutputTokens: meanOf(rows.map((r) => r.outputTokens)),
      meanLatencyMs: meanOf(rows.map((r) => r.latencyMs)),
      meanProbeCount: probeCounts.length > 0 ? meanOf(probeCounts) : null,
      meanRecallCount: recallCounts.length > 0 ? meanOf(recallCounts) : null,
    });
  }
  return out;
}

/** Mulberry32 — duplicated from scorer.ts (firewall: no shared imports). */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
