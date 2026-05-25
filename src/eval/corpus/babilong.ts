/**
 * BABILong loader — converts a single downloaded BABILong split file
 * (task × context-length) into the shared {@link BenchEvent} corpus
 * format plus a list of {@link FreeFormQuery} entries, ready for the
 * existing scorer + runner pipeline.
 *
 * Per-instance behaviour:
 *   - Each row of the BABILong split is one "instance" — a haystack +
 *     supporting facts + question + ground-truth answer.
 *   - The haystack text is split on sentence boundaries into one
 *     `BenchEvent` per sentence. Sentences that match a supporting-fact
 *     line are `isCore: true`; the rest are filler with `tier: 0` (because
 *     they are part of the instance, not synthetic-corpus filler tiers).
 *   - Each instance becomes its own shard — instances are independent
 *     samples and routing across them would leak retrieval across QA pairs.
 *     Shard id: `babilong-task<N>-instance<idx>`.
 *
 * Sub-sampling: deterministic via `seed` (default 42). Defaults to 30
 * instances per (task, contextLength). The full BABILong splits typically
 * ship with 100 samples per (task, length); we trim to keep the runner
 * matrix manageable. Document the seed in the methodology so the same 30
 * are picked on every replay.
 *
 * On-disk format:
 *   data/eval/corpus-babilong/raw/task<N>_<length>.<ext>
 *
 * Supported extensions:
 *   - `.jsonl` — one JSON object per line. Each row must have
 *     `input` (string), `target` (string), `question` (string),
 *     optionally `supporting_facts` (array of integers — 0-indexed line
 *     positions in `input`).
 *   - `.parquet` — only loadable if a parquet reader is wired in. The
 *     repo does not ship a parquet dependency by default; the loader
 *     throws a clear, actionable error pointing at the JSONL fallback
 *     described in `data/eval/corpus-babilong/README.md`.
 *
 * This file is the SOLE consumer of the raw downloads — it is the
 * boundary between "BABILong on disk" and "CSM benchmark corpus".
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import type { BenchEvent } from "../corpus.js";
import type { FreeFormQuery } from "../mcq.js";
import { estimateTokens } from "../../core/tokenBudget.js";

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

export type BabilongTaskId = 1 | 2 | 3;

/**
 * Context-length labels matching the directory naming written by
 * `scripts/fetch-babilong.ts`. The loader accepts either the label
 * (e.g. `"4K"`) or the equivalent token-count integer (e.g. `4096`)
 * via {@link contextLengthLabel}.
 */
export type BabilongContextLabel =
  | "0K"
  | "4K"
  | "8K"
  | "32K"
  | "128K"
  | "256K"
  | "1M";

const KNOWN_LENGTH_LABELS: readonly BabilongContextLabel[] = [
  "0K",
  "4K",
  "8K",
  "32K",
  "128K",
  "256K",
  "1M",
] as const;

const LENGTH_LABEL_TOKENS: Record<BabilongContextLabel, number> = {
  "0K": 0,
  "4K": 4_096,
  "8K": 8_192,
  "32K": 32_768,
  "128K": 131_072,
  "256K": 262_144,
  "1M": 1_048_576,
};

/**
 * Translate a numeric token-count target (the form `MODEL_CONTEXT_SWEEP`
 * uses) into the on-disk label string the fetch script writes. Throws if
 * the value isn't one of the supported BABILong lengths — we deliberately
 * do NOT interpolate. The published BABILong tables only exist at these
 * lengths and an interpolated context would have no overlay axis.
 */
export function contextLengthLabel(tokens: number): BabilongContextLabel {
  for (const label of KNOWN_LENGTH_LABELS) {
    if (LENGTH_LABEL_TOKENS[label] === tokens) return label;
  }
  throw new Error(
    `BABILong does not publish a ${tokens}-token split. Supported: ` +
      KNOWN_LENGTH_LABELS.map(
        (l) => `${LENGTH_LABEL_TOKENS[l]} (${l})`,
      ).join(", "),
  );
}

export interface LoadBabilongOptions {
  /**
   * Number of (instance, query) pairs to keep per (task, length). Defaults
   * to 30, matching the spec. Set to `Infinity` to keep everything in the
   * split (typically 100 upstream).
   */
  sampleSize?: number;
  /** Deterministic sub-sampling seed. Default 42. */
  seed?: number;
  /**
   * Override the project-root-relative raw directory. Tests use this.
   * Production callers leave it as the default.
   */
  rawDir?: string;
}

export interface LoadBabilongResult {
  /** Sentence-level events for every sampled instance, flat. */
  events: BenchEvent[];
  /** One query per sampled instance. */
  queries: FreeFormQuery[];
  /** Echo of `taskId` for traceability. */
  taskId: BabilongTaskId;
  /** Echo of the resolved context-length label. */
  contextLabel: BabilongContextLabel;
  /** Number of instances actually selected after sub-sampling. */
  sampledInstances: number;
  /** Sub-sampling seed actually used. */
  seed: number;
}

/**
 * Load one BABILong (task, contextLength) split, convert it to
 * `BenchEvent[]` + `FreeFormQuery[]`, and sub-sample deterministically to
 * the configured instance count.
 *
 * @param taskId          BABILong task id (1, 2, or 3 — the supporting-fact
 *                        tasks; we deliberately do NOT load qa4+).
 * @param contextLength   Either a label string (`"4K"`, `"1M"`, …) or the
 *                        equivalent token count (`4096`, `1_048_576`, …).
 *                        Token-count form throws if it doesn't match a
 *                        published BABILong length — no interpolation.
 * @param opts            See {@link LoadBabilongOptions}.
 */
export async function loadBabilongTask(
  taskId: BabilongTaskId,
  contextLength: number | BabilongContextLabel,
  opts: LoadBabilongOptions = {},
): Promise<LoadBabilongResult> {
  const label =
    typeof contextLength === "string"
      ? assertKnownLabel(contextLength)
      : contextLengthLabel(contextLength);
  const sampleSize = opts.sampleSize ?? 30;
  const seed = opts.seed ?? 42;
  const rawDir =
    opts.rawDir ??
    resolve(process.cwd(), "data", "eval", "corpus-babilong", "raw");

  const path = pickRawFile(rawDir, taskId, label);
  const rawInstances = await readInstances(path);

  if (rawInstances.length === 0) {
    throw new Error(
      `BABILong split ${path} is empty after parse. Expected ` +
        `>= 1 instance with { input, target, question } fields.`,
    );
  }

  const sampled = subsample(rawInstances, sampleSize, seed);

  const events: BenchEvent[] = [];
  const queries: FreeFormQuery[] = [];

  for (let i = 0; i < sampled.length; i++) {
    const inst = sampled[i]!;
    const { instanceEvents, relevantEventIds } = convertInstance(
      inst,
      taskId,
      i,
    );
    events.push(...instanceEvents);

    queries.push({
      kind: "free-form",
      id: `bq${taskId}-${zeroPadInstance(i)}`,
      question: inst.question,
      correctAnswer: normaliseGroundTruth(inst.target),
      relevantEventIds,
      category: `babilong-task${taskId}`,
      shardHints: [shardIdFor(taskId, i)],
    });
  }

  return {
    events,
    queries,
    taskId,
    contextLabel: label,
    sampledInstances: sampled.length,
    seed,
  };
}

// --------------------------------------------------------------------------
// File discovery
// --------------------------------------------------------------------------

/**
 * Probe for the raw file on disk. We prefer JSONL (cheap to parse without
 * extra deps) and fall back to parquet — but parquet support requires a
 * reader we don't ship by default. See top-of-file note + the README at
 * `data/eval/corpus-babilong/README.md`.
 */
function pickRawFile(
  rawDir: string,
  taskId: BabilongTaskId,
  label: BabilongContextLabel,
): string {
  const base = `task${taskId}_${label}`;
  const jsonlPath = resolve(rawDir, `${base}.jsonl`);
  const parquetPath = resolve(rawDir, `${base}.parquet`);

  if (existsSync(jsonlPath)) return jsonlPath;
  if (existsSync(parquetPath)) return parquetPath;

  throw new Error(
    `BABILong raw file not found for task${taskId} at ${label}. ` +
      `Looked for:\n  - ${jsonlPath}\n  - ${parquetPath}\n` +
      `Run \`npx tsx scripts/fetch-babilong.ts --tasks ${taskId} --lengths ${label}\` ` +
      `first, or place a manually-downloaded copy at one of the above paths. ` +
      `See data/eval/corpus-babilong/README.md for the expected schema.`,
  );
}

// --------------------------------------------------------------------------
// Raw instance schema + reader
// --------------------------------------------------------------------------

/**
 * Zod schema for one BABILong row as we expect it on disk (JSONL).
 *
 * Upstream parquet columns include extra fields (`task`, `context_length`,
 * `target_length`, `noise_id`, etc.) — we ignore them. The fields below
 * are the minimum the loader requires.
 */
const RawInstanceZ = z.object({
  /** The haystack — facts + filler concatenated. */
  input: z.string().min(1),
  /** Ground-truth short answer. */
  target: z.string().min(1),
  /** Question text. */
  question: z.string().min(1),
  /**
   * Zero-indexed line positions of the supporting facts in `input`,
   * after `input.split("\n")`. Upstream BABILong sometimes calls this
   * `supporting_lines` — we accept either via the `.transform` below.
   *
   * Optional only for legacy JSONL exports that drop it. When missing,
   * we fall back to lexical matching against a hard-coded bAbI fact
   * shape — see `inferSupportingLines`.
   */
  supporting_facts: z.array(z.number().int().nonnegative()).optional(),
  supporting_lines: z.array(z.number().int().nonnegative()).optional(),
});

type RawInstance = z.infer<typeof RawInstanceZ>;

async function readInstances(path: string): Promise<RawInstance[]> {
  if (path.endsWith(".parquet")) {
    throw new Error(
      `Parquet reader not wired in this build. ` +
        `BABILong publishes splits as parquet; either:\n` +
        `  (a) install a parquet library (e.g. \`npm i parquetjs\`) and wire ` +
        `it into src/eval/corpus/babilong.ts:readInstances, OR\n` +
        `  (b) convert the file at ${path} to JSONL (one row per line, fields ` +
        `{ input, target, question, supporting_facts? }) and save it at the ` +
        `same path with extension .jsonl.\n` +
        `See data/eval/corpus-babilong/README.md.`,
    );
  }

  const text = await readFile(path, "utf8");
  const out: RawInstance[] = [];
  let lineNo = 0;
  for (const line of text.split(/\r?\n/)) {
    lineNo++;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(
        `${path}:${lineNo}: invalid JSON. ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const inst = RawInstanceZ.parse(parsed);
    out.push(inst);
  }
  return out;
}

// --------------------------------------------------------------------------
// Sub-sampling
// --------------------------------------------------------------------------

/**
 * Deterministic Fisher–Yates over a fresh copy, then slice. Mirrors
 * `corpus.ts:sampleFromEvents` so the same seed produces a comparable
 * pattern of inclusion across BABILong and PaySwift sweeps.
 */
function subsample<T>(items: readonly T[], size: number, seed: number): T[] {
  if (items.length <= size) return [...items];
  const rng = mulberry32(seed);
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  return shuffled.slice(0, size);
}

/** Mulberry32 — copied from corpus.ts/scorer.ts so this module has zero deps. */
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

// --------------------------------------------------------------------------
// Per-instance conversion
// --------------------------------------------------------------------------

interface ConvertedInstance {
  instanceEvents: BenchEvent[];
  /** Event IDs of the supporting-fact sentences. Used as `relevantEventIds`. */
  relevantEventIds: string[];
}

/**
 * Convert one BABILong instance into events + the relevant-fact id list.
 *
 * Splits `input` on `\n` first (BABILong's haystack uses newline-separated
 * lines, one bAbI fact or one PG-19 sentence per line, mirroring the
 * upstream paper). The `supporting_facts` field, if present, indexes into
 * that line list. If absent, we fall back to lexical inference (cheap
 * fact-shape regex).
 */
function convertInstance(
  inst: RawInstance,
  taskId: BabilongTaskId,
  instanceIdx: number,
): ConvertedInstance {
  const shardId = shardIdFor(taskId, instanceIdx);
  const lines = inst.input.split(/\r?\n/);

  const supportingSet = new Set<number>(
    inst.supporting_facts ??
      inst.supporting_lines ??
      inferSupportingLines(lines, inst.target),
  );

  const instanceEvents: BenchEvent[] = [];
  const relevantEventIds: string[] = [];
  let sentenceIdx = 0;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const lineText = lines[lineIdx]!.trim();
    if (lineText.length === 0) continue;

    // Split each line into sentences. BABILong haystack lines mostly hold
    // one sentence already (bAbI facts) but PG-19 filler can pack several
    // per line, so we re-split. The `isCore` flag propagates to every
    // sentence emitted from a supporting-fact line — finer-grained
    // attribution would require per-sentence ground truth we don't have.
    const sentences = splitSentences(lineText);
    const lineIsCore = supportingSet.has(lineIdx);

    for (const sentence of sentences) {
      const id = `b${taskId}-${zeroPadInstance(instanceIdx)}-${zeroPadSentence(sentenceIdx)}`;
      const ev: BenchEvent = {
        id,
        shardId,
        content: sentence,
        tokenCount: estimateTokens(sentence),
        isCore: lineIsCore,
        tier: 0,
      };
      instanceEvents.push(ev);
      if (lineIsCore) relevantEventIds.push(id);
      sentenceIdx++;
    }
  }

  return { instanceEvents, relevantEventIds };
}

/**
 * Split a line on terminal punctuation followed by whitespace + capital
 * letter. Conservative — leaves abbreviations and edge cases as-is rather
 * than over-splitting. Matches the BABILong-integration spec's "period +
 * space + capital" heuristic.
 */
function splitSentences(line: string): string[] {
  const trimmed = line.trim();
  if (trimmed.length === 0) return [];
  const out: string[] = [];
  // Match end-of-sentence punctuation followed by whitespace + uppercase.
  // The lookahead keeps the capital letter in the next sentence.
  const parts = trimmed.split(/(?<=[.!?])\s+(?=[A-Z])/);
  for (const p of parts) {
    const t = p.trim();
    if (t.length > 0) out.push(t);
  }
  return out;
}

/**
 * Fallback supporting-fact inference. BABILong upstream parquet ALWAYS
 * carries `supporting_facts` so this is rarely hit; we ship it so a
 * truncated JSONL export doesn't break the loader entirely. It's lossy —
 * `relevantEventIds` will be a best-guess, not ground truth.
 */
function inferSupportingLines(lines: string[], target: string): number[] {
  const needle = target.trim().toLowerCase();
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!.toLowerCase();
    // bAbI facts are short, declarative, and contain the answer string.
    // Filler PG-19 sentences are long and rarely contain the literal answer.
    if (ln.includes(needle) && ln.length < 120) out.push(i);
  }
  return out;
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function shardIdFor(taskId: BabilongTaskId, instanceIdx: number): string {
  return `babilong-task${taskId}-instance${zeroPadInstance(instanceIdx)}`;
}

/** Zero-pad to 4 digits — supports up to 10k instances per (task, length). */
function zeroPadInstance(n: number): string {
  return String(n).padStart(4, "0");
}

/** Zero-pad to 6 digits — supports up to 1M sentences per instance (1M ctx). */
function zeroPadSentence(n: number): string {
  return String(n).padStart(6, "0");
}

/** Normalise to the form `scoreFreeForm` compares against. */
function normaliseGroundTruth(target: string): string {
  return target.trim().toLowerCase();
}

function assertKnownLabel(label: string): BabilongContextLabel {
  if (!(KNOWN_LENGTH_LABELS as readonly string[]).includes(label)) {
    throw new Error(
      `Unknown BABILong context label "${label}". Supported: ` +
        KNOWN_LENGTH_LABELS.join(", "),
    );
  }
  return label as BabilongContextLabel;
}
