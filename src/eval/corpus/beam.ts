/**
 * BEAM slice loader — RETRIEVAL-SIDE ONLY.
 *
 * Reads the local BEAM slice fetched by `scripts/fetch-beam-slice.ts`
 * (`data/eval/corpus-beam-slice/<split>/…`, byte-identical copies of the
 * upstream AMB repo's `data/beam/<split>/…` at the pinned SHA) and exposes:
 *
 *   - `loadBeamDocuments` — the AMB document rows, exactly as AMB's runner
 *     would feed them to a memory provider's `ingest()`.
 *   - `loadBeamRetrievalQueries` — query records with ALL GOLD REDACTED at
 *     parse time. The returned objects carry only what the AMB harness
 *     itself sends to a provider's `retrieve()` (the query string + user
 *     scoping) plus two eval-join keys (query id, question sha256) and the
 *     category label used for slicing.
 *
 * LEAKAGE FIREWALL (the project's hardest rule): BEAM gold answers and
 * rubric/hint metadata never leave this module's parser. The fields below
 * are dropped on the floor and there is deliberately NO API to get them
 * from here. The one module allowed to read them is
 * `src/eval/retrievalScore.ts`, which re-reads the raw files itself and is
 * import-isolated from the retrieval path (enforced by
 * `tests/beamLeakageFirewall.test.ts`).
 *
 * Upstream record shapes (verified against AMB 45fa38052
 * `data/beam/100k/*.json.gz` and `src/memory_bench/dataset/beam.py`):
 *
 *   documents.json.gz: Array<{ id: "conv_sN_M", content, user_id: conv,
 *                              timestamp: null }>
 *   queries.json.gz:   Array<{ id: "conv_category_idx", query, user_id,
 *                              gold_answers: string[], gold_ids: [conv],
 *                              meta: { question_category, conversation_id,
 *                                      rubric, …category-specific hints } }>
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

import { z } from "zod";

// ─── Public types ───────────────────────────────────────────────────────────

/**
 * Structurally identical to the bridge's `AmbDocument`
 * (scripts/amb-csm-retrieve.ts) — declared locally because `src/` cannot
 * import from `scripts/` under the tsconfig rootDir, and TypeScript's
 * structural typing makes `BeamDocument[]` assignable to `AmbDocument[]`
 * at the runner call sites (tests/beamCorpus.test.ts proves it by feeding
 * loader output to the real `buildCorpus`).
 */
export interface BeamDocument {
  id: string;
  content: string;
  user_id?: string | null;
  timestamp?: string | null;
  context?: string | null;
}

export const BEAM_SPLITS = ["100k", "500k", "1m", "10m"] as const;
export type BeamSplit = (typeof BEAM_SPLITS)[number];

/** The two categories CSM loses to Hindsight on — the harness default. */
export const BEAM_LOSING_CATEGORIES = ["summarization", "event_ordering"] as const;

/**
 * A BEAM query as the RETRIEVAL side is allowed to see it.
 *
 * Mirrors exactly what AMB passes to `MemoryProvider.retrieve()`: the query
 * string and the user scoping id. `id`/`questionSha256` are join keys for
 * the eval side; `category` is a slicing label (AMB's own `--category` flag
 * filters on it harness-side, so selection-by-category is not leakage).
 */
export interface BeamRetrievalQuery {
  id: string;
  question: string;
  category: string;
  userId: string;
  /** sha256(question) — the bridge telemetry's `query_sha256` convention. */
  questionSha256: string;
}

/**
 * Raw query-record fields REDACTED by the loader. Documented so the
 * redaction is auditable; `tests/beamCorpus.test.ts` asserts none of these
 * (nor any unknown field) survives into `BeamRetrievalQuery`.
 *
 * - `gold_answers`  — the reference answers (gold).
 * - `gold_ids`      — degenerate evidence ref (= [conversation_id]; see the
 *                     T3 gold-structure memo in EXP-T3-beam-slice.md).
 * - `meta.*` hints  — `rubric`, `why_unanswerable`, `tests_for`,
 *                     `ordering_tested`, `total_mentions`,
 *                     `instruction_being_tested`, `compliance_indicators`,
 *                     `preference_being_tested`, `time_points`,
 *                     `calculation_required` — all answer-side prompting /
 *                     judging material in AMB; CSM retrieval never sees any
 *                     of it.
 */
export const BEAM_QUERY_REDACTED_FIELDS = [
  "gold_answers",
  "gold_ids",
  "meta",
] as const;

export interface LoadBeamOptions {
  /** Slice root. Default: `<cwd>/data/eval/corpus-beam-slice`. */
  sliceDir?: string;
}

// ─── Raw schemas (Zod) ──────────────────────────────────────────────────────

const BeamDocumentRowZ = z.object({
  id: z.string().min(1),
  content: z.string(),
  user_id: z.union([z.string(), z.number()]).transform(String),
  timestamp: z.string().nullable().optional(),
  context: z.string().nullable().optional(),
});

/**
 * Gold-bearing fields are parsed as `z.unknown()` and then DROPPED — never
 * surfaced, never validated further, never logged.
 */
const BeamQueryRowZ = z.object({
  id: z.string().min(1),
  query: z.string().min(1),
  user_id: z.union([z.string(), z.number()]).transform(String),
  gold_answers: z.unknown().optional(),
  gold_ids: z.unknown().optional(),
  meta: z
    .object({ question_category: z.string().optional() })
    .passthrough()
    .optional(),
});

// ─── Loading ────────────────────────────────────────────────────────────────

function defaultSliceDir(): string {
  return resolve(process.cwd(), "data", "eval", "corpus-beam-slice");
}

/**
 * Read `<sliceDir>/<split>/<base>.json` or `.json.gz` (the fetch script
 * copies the upstream `.json.gz` verbatim; tests ship plain `.json`
 * synthetic fixtures).
 */
async function readSliceJson(
  sliceDir: string,
  split: string,
  base: string,
): Promise<unknown> {
  const plain = join(sliceDir, split, `${base}.json`);
  const gz = join(sliceDir, split, `${base}.json.gz`);
  if (existsSync(plain)) {
    return JSON.parse(await readFile(plain, "utf8"));
  }
  if (existsSync(gz)) {
    return JSON.parse(gunzipSync(await readFile(gz)).toString("utf8"));
  }
  throw new Error(
    `BEAM slice file not found for ${split}/${base}. Looked for:\n` +
      `  - ${plain}\n  - ${gz}\n` +
      `Run \`npx tsx scripts/fetch-beam-slice.ts --splits ${split}\` first ` +
      `(see docs/experiments/EXP-T3-beam-slice.md).`,
  );
}

/**
 * Load the split's documents as `AmbDocument[]` — the exact rows AMB's
 * runner ingests (id, content, user_id, timestamp, context). Content is not
 * altered in any way; turn-splitting into events happens downstream in the
 * bridge's `buildCorpus`, same as a real AMB run.
 */
export async function loadBeamDocuments(
  split: string,
  opts: LoadBeamOptions = {},
): Promise<BeamDocument[]> {
  const sliceDir = opts.sliceDir ?? defaultSliceDir();
  const raw = await readSliceJson(sliceDir, split, "documents");
  if (!Array.isArray(raw)) {
    throw new Error(`BEAM ${split}/documents: expected a JSON array.`);
  }
  return raw.map((row, i) => {
    const parsed = BeamDocumentRowZ.safeParse(row);
    if (!parsed.success) {
      throw new Error(
        `BEAM ${split}/documents[${i}]: ${parsed.error.issues[0]?.message ?? "invalid row"}`,
      );
    }
    const doc = parsed.data;
    return {
      id: doc.id,
      content: doc.content,
      user_id: doc.user_id,
      timestamp: doc.timestamp ?? null,
      context: doc.context ?? null,
    };
  });
}

/**
 * Load the split's queries with gold redacted (see
 * {@link BEAM_QUERY_REDACTED_FIELDS}). Category falls back to parsing the
 * BEAM id convention `{conversation}_{category}_{index}` when
 * `meta.question_category` is absent.
 */
export async function loadBeamRetrievalQueries(
  split: string,
  opts: LoadBeamOptions = {},
): Promise<BeamRetrievalQuery[]> {
  const sliceDir = opts.sliceDir ?? defaultSliceDir();
  const raw = await readSliceJson(sliceDir, split, "queries");
  if (!Array.isArray(raw)) {
    throw new Error(`BEAM ${split}/queries: expected a JSON array.`);
  }
  return raw.map((row, i) => {
    const parsed = BeamQueryRowZ.safeParse(row);
    if (!parsed.success) {
      throw new Error(
        `BEAM ${split}/queries[${i}]: ${parsed.error.issues[0]?.message ?? "invalid row"}`,
      );
    }
    const q = parsed.data;
    const category =
      q.meta?.question_category ?? categoryFromQueryId(q.id) ?? "unknown";
    // Gold redaction happens HERE: only the fields below survive.
    return {
      id: q.id,
      question: q.query,
      category,
      userId: q.user_id,
      questionSha256: sha256Hex(q.query),
    };
  });
}

/** Parse `{conversation}_{category}_{index}` (category may contain `_`). */
export function categoryFromQueryId(id: string): string | null {
  const m = id.match(/^[^_]+_(.+)_\d+$/);
  return m ? m[1]! : null;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ─── Deterministic selection helpers (runner-side slicing) ──────────────────

export interface SelectBeamQueriesOptions {
  /** Keep only these categories (default: all). */
  categories?: string[];
  /** Keep only these unit/user ids (default: all). */
  userIds?: string[];
  /** Per-category cap, applied after a seeded shuffle (default: no cap). */
  perCategoryLimit?: number;
  /** Overall cap, applied after per-category selection (default: no cap). */
  queryLimit?: number;
  /** Seed for the deterministic shuffle. Default 42. */
  seed?: number;
}

/**
 * Deterministic, seeded query selection: stable-sort by (category, id),
 * per-category mulberry32 shuffle, take limits, then regroup by unit so the
 * runner can reuse one scoped corpus per unit. Selection is benchmark
 * SLICING (AMB's own `--category`/`--query-limit` flags do the same
 * harness-side) — it never feeds anything into retrieval.
 */
export function selectBeamQueries(
  queries: BeamRetrievalQuery[],
  opts: SelectBeamQueriesOptions = {},
): BeamRetrievalQuery[] {
  const seed = opts.seed ?? 42;
  const wantCategory = opts.categories?.length
    ? new Set(opts.categories)
    : null;
  const wantUser = opts.userIds?.length ? new Set(opts.userIds) : null;

  const byCategory = new Map<string, BeamRetrievalQuery[]>();
  for (const q of [...queries].sort((a, b) =>
    a.category === b.category
      ? a.id.localeCompare(b.id)
      : a.category.localeCompare(b.category),
  )) {
    if (wantCategory && !wantCategory.has(q.category)) continue;
    if (wantUser && !wantUser.has(q.userId)) continue;
    const bucket = byCategory.get(q.category);
    if (bucket) bucket.push(q);
    else byCategory.set(q.category, [q]);
  }

  const selected: BeamRetrievalQuery[] = [];
  for (const [, bucket] of [...byCategory.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const shuffled = seededShuffle(bucket, seed);
    const cap = opts.perCategoryLimit ?? shuffled.length;
    selected.push(...shuffled.slice(0, cap));
  }

  const capped =
    opts.queryLimit !== undefined ? selected.slice(0, opts.queryLimit) : selected;

  // Regroup by unit (stable within unit) so corpora are built once per unit.
  return [...capped].sort((a, b) =>
    a.userId === b.userId
      ? a.id.localeCompare(b.id)
      : a.userId.localeCompare(b.userId),
  );
}

/** Mulberry32 + Fisher-Yates — same pattern as corpus.ts / babilong.ts. */
function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const rng = mulberry32(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

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
