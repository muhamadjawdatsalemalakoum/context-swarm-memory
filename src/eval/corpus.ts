import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * One event in the synthetic benchmark corpus.
 *
 * Tier 0 = "core": hand-authored, contains answer-bearing facts. Always
 * included in every sampled corpus regardless of target size.
 * Tier 1–4 = "filler": LLM-generated or programmatically templated, used to
 * scale the corpus from 10K up to 1B tokens for the Phase C sweep.
 */
export interface BenchEvent {
  id: string;
  shardId: string;
  content: string;
  /** Pre-computed at corpus-build time (whitespace approx; close enough for sweep targets). */
  tokenCount: number;
  /** True iff this event contains an answer to some MCQ query (tier 0). */
  isCore: boolean;
  /** 0 = core, 1–4 = filler tiers. */
  tier: 0 | 1 | 2 | 3 | 4;
  timestamp?: string;
  tags?: string[];
}

/**
 * A corpus sampled to a target token count.
 * - `coreEvents` are always present (they hold the answers).
 * - `fillerEvents` are deterministically sampled from tiers 1–4 to fill the
 *   remaining budget. Sampling is seeded so re-runs are reproducible.
 */
export interface Corpus {
  events: BenchEvent[];
  coreEvents: BenchEvent[];
  fillerEvents: BenchEvent[];
  totalTokens: number;
  byShard: Map<string, BenchEvent[]>;
  byId: Map<string, BenchEvent>;
  targetTokens: number;
  sampleSeed: number;
}

const BenchEventZ = z.object({
  id: z.string().min(1),
  shardId: z.string().min(1),
  content: z.string(),
  tokenCount: z.number().int().nonnegative(),
  isCore: z.boolean(),
  tier: z.union([
    z.literal(0),
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
  ]),
  timestamp: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export interface LoadCorpusOptions {
  /** Target total token count for the sampled corpus. */
  targetTokens: number;
  /** Sampling seed for reproducible filler selection. Default 42. */
  seed?: number;
}

/**
 * Load `events.jsonl` and sample to a target token count.
 *
 * All core (tier 0) events are always included. Filler (tiers 1–4) is
 * deterministically shuffled with a seeded RNG and appended until
 * the target is met. Throws if the core alone exceeds the target.
 *
 * **Memory note.** This materialises the sampled events into memory.
 * For `targetTokens >= 1B` this can mean ~5GB+ in RAM, which is OK on
 * machines with 16GB+ but tight on smaller boxes. Lazy-loading variant
 * lives in `loadCorpusStreaming` (TODO; not needed for runs ≤ 100M).
 */
export async function loadCorpus(
  corpusDir: string,
  opts: LoadCorpusOptions,
): Promise<Corpus> {
  const eventsPath = join(corpusDir, "events.jsonl");
  if (!existsSync(eventsPath)) {
    throw new Error(
      `Corpus events.jsonl not found at ${eventsPath}. ` +
        `Run \`csm bench corpus build\` first.`,
    );
  }
  const allEvents = await readEventsJsonl(eventsPath);
  return sampleFromEvents(allEvents, opts);
}

/**
 * Same as `loadCorpus` but takes a pre-loaded event list — useful when
 * sweeping multiple `targetTokens` values without re-reading the file.
 */
export function sampleFromEvents(
  allEvents: BenchEvent[],
  opts: LoadCorpusOptions,
): Corpus {
  const core = allEvents.filter((e) => e.isCore);
  const filler = allEvents.filter((e) => !e.isCore);

  const coreTokens = core.reduce((s, e) => s + e.tokenCount, 0);
  if (coreTokens > opts.targetTokens) {
    throw new Error(
      `targetTokens=${opts.targetTokens} is less than coreTokens=${coreTokens}. ` +
        `Increase target or shrink the hand-authored core.`,
    );
  }

  const seed = opts.seed ?? 42;
  const rng = mulberry32(seed);
  const shuffled = fisherYates(filler, rng);

  const sampledFiller: BenchEvent[] = [];
  let runningTokens = coreTokens;
  for (const e of shuffled) {
    if (runningTokens + e.tokenCount > opts.targetTokens) {
      // Skip oversized events that would push past the budget — keep packing
      // smaller ones until we get close to or hit the target.
      continue;
    }
    sampledFiller.push(e);
    runningTokens += e.tokenCount;
    if (runningTokens >= opts.targetTokens * 0.999) break;
  }

  const events: BenchEvent[] = [...core, ...sampledFiller];
  const byShard = new Map<string, BenchEvent[]>();
  const byId = new Map<string, BenchEvent>();
  for (const e of events) {
    byId.set(e.id, e);
    const arr = byShard.get(e.shardId);
    if (arr) arr.push(e);
    else byShard.set(e.shardId, [e]);
  }

  return {
    events,
    coreEvents: core,
    fillerEvents: sampledFiller,
    totalTokens: runningTokens,
    byShard,
    byId,
    targetTokens: opts.targetTokens,
    sampleSeed: seed,
  };
}

/**
 * Read every event from a corpus's `events.jsonl` (no sampling).
 * Used by the runner so it can sample multiple corpus sizes from one
 * file read instead of paying the I/O cost per sweep cell.
 */
export async function loadAllEvents(corpusDir: string): Promise<BenchEvent[]> {
  const eventsPath = join(corpusDir, "events.jsonl");
  if (!existsSync(eventsPath)) {
    throw new Error(
      `Corpus events.jsonl not found at ${eventsPath}. ` +
        `Run \`csm bench corpus build\` first.`,
    );
  }
  return readEventsJsonl(eventsPath);
}

async function readEventsJsonl(path: string): Promise<BenchEvent[]> {
  const text = await readFile(path, "utf8");
  const out: BenchEvent[] = [];
  // Parse line by line — avoids splitting huge content fields wrong if any
  // accidentally contain unescaped newlines (we control the writer, but be safe).
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parsed = BenchEventZ.parse(JSON.parse(trimmed));
    out.push(parsed);
  }
  return out;
}

/** Deterministic Fisher–Yates shuffle. Does not mutate input. */
function fisherYates<T>(arr: readonly T[], rng: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Mulberry32 PRNG. Mirrors `scorer.ts` so we share zero deps. */
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
// Sweep configuration constants shared by runner + plotter.
// --------------------------------------------------------------------------

/**
 * Corpus token sizes the Phase C scaling study sweeps over.
 * Log-spaced 100K → 1B (10× per step).
 *
 * The 10K start point would be ideal but currently the synthetic core
 * (~66K tokens) exceeds it, so `loadCorpus` would throw. Re-add 10K once
 * the "essential" subset of core is identified per query and the rest is
 * demoted to filler.
 */
export const CORPUS_SIZE_SWEEP = [
  100_000,
  1_000_000,
  10_000_000,
  100_000_000,
  1_000_000_000,
] as const;

/**
 * Model context window points the Phase C study sweeps over.
 * Spans Gemma 4 31B's range: 1K (tiny) → 128K (max).
 */
export const MODEL_CONTEXT_SWEEP = [
  1_024,
  4_096,
  8_192,
  32_768,
  131_072,
] as const;

/**
 * Adaptive early-stop threshold: if a (system × model_context) cell drops
 * below this accuracy at some corpus size, the runner skips all larger
 * corpus sizes for that cell (the system has already failed).
 */
export const EARLY_STOP_ACCURACY = 0.5;
