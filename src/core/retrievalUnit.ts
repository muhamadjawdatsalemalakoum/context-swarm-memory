import { envInt } from "../utils/env.js";
/**
 * RETRIEVAL UNITS — the single source of truth for "what granularity does CSM
 * reason about?"
 *
 * ── THE PROBLEM ─────────────────────────────────────────────────────────────
 *
 * CSM has exactly one retrieval granularity: the shard (on BEAM, a whole
 * conversation document of 20-90 turns). Everything is that size — the router's
 * embedding centroid, the probe's unit of work, the recall digest, the budgets.
 *
 * That is wrong for the failure this fixes. MEASURED chain-of-custody at BEAM
 * 1M, `preference_following` (the last category where Hindsight still beats
 * CSM, 5 losses to 2):
 *
 *     rubric fact present in the user's corpus      0.950
 *     ...still present after routing                0.815   <- 13.5 pts lost HERE
 *     ...still present after probe + recall         0.651
 *     ...still present in the returned documents    0.602
 *
 * A stated preference ("I prefer X") is a SMALL SPAN inside a document that is
 * mostly about something else. `centroidOf` averages every event vector in the
 * document, so that span is mean-pooled into noise and the document does not
 * rank. No amount of better document ranking fixes it: the retrieval UNIT is
 * wrong, not the ranking.
 *
 * ── WHY NOT JUST MAKE SHARDS SMALLER ────────────────────────────────────────
 *
 * That was tried (`CSM_VIRTUAL_SHARDS=4`) and it REGRESSED the system: coverage
 * 0.743 -> 0.620, retrieved evidence down 55% (58.3 -> 26.4 events). Cutting
 * shard size ~10x while every downstream budget still counted SHARDS
 * (`maxRecallShards = 4`, `MIN_FROM_TOP_SHARD = 8`, the expansion caps) starved
 * the harvest. Even with the counts scaled up ~10x it still lost, at 3.5x the
 * probe cost.
 *
 * ── THE DESIGN: SELECT FINE, HARVEST COARSE ─────────────────────────────────
 *
 * Retrieval units are a RANKING-TIME concept only. Shards stay document-sized,
 * so every existing budget keeps exactly the meaning it was tuned for and
 * nothing downstream is starved. What changes is only how a shard is SCORED:
 *
 *     before:  score(shard) = cos(query, mean(all event vectors))
 *     after:   score(shard) = max over units u of cos(query, centroid(u))
 *
 * Max-pooling over passages instead of mean-pooling over the document. A
 * document containing one highly relevant passage now ranks on that passage
 * instead of having it averaged away — which is exactly the
 * `preference_following` failure mode.
 *
 * This module owns unit partitioning and nothing else. Scoring lives in the
 * router, harvesting lives in recall; keeping them separate is deliberate — the
 * previous attempt failed precisely because one change (shard size) silently
 * altered all three concerns at once.
 */

/** A contiguous span of events inside one shard. Ranking-time only. */
export interface RetrievalUnit {
  /** `<shardId>#u<NNNN>` — stable, zero-padded so it sorts numerically. */
  unitId: string;
  shardId: string;
  /** Indices into the shard's event array, [start, end). */
  start: number;
  end: number;
}

export interface PartitionOptions {
  /** Target events per unit. Small enough that a centroid stays meaningful. */
  targetSize?: number;
  /**
   * Optional boundary hint per event — a session/topic key. Consecutive events
   * sharing a key are kept in the same unit where the target size allows.
   * Supplying it is what makes this "session-aware"; omitting it degrades
   * gracefully to fixed chunking, which is the honest null model.
   */
  boundaryKey?: (index: number) => string | null;
}

/** Default unit size. 6 turns is roughly one exchange plus context — small
 *  enough that a centroid is topically coherent, large enough that a single
 *  short turn does not dominate. */
export const DEFAULT_UNIT_SIZE = 6;

/**
 * Partition a shard's events into contiguous retrieval units.
 *
 * Boundary rule, in order:
 *  1. Start a new unit when `boundaryKey` changes (a session/topic boundary).
 *  2. Start a new unit when the current one reaches `targetSize`.
 *
 * Always returns at least one unit for a non-empty shard, and the units always
 * tile the event array exactly — no gaps, no overlaps. Pure and deterministic.
 */
export function partitionIntoUnits(
  shardId: string,
  eventCount: number,
  opts: PartitionOptions = {},
): RetrievalUnit[] {
  const targetSize = Math.max(1, opts.targetSize ?? DEFAULT_UNIT_SIZE);
  if (eventCount <= 0) return [];

  const units: RetrievalUnit[] = [];
  let start = 0;
  let prevKey = opts.boundaryKey ? opts.boundaryKey(0) : null;

  const push = (from: number, to: number): void => {
    units.push({
      unitId: `${shardId}#u${String(units.length).padStart(4, "0")}`,
      shardId,
      start: from,
      end: to,
    });
  };

  for (let i = 1; i < eventCount; i++) {
    const key = opts.boundaryKey ? opts.boundaryKey(i) : null;
    const boundaryChanged = opts.boundaryKey ? key !== prevKey : false;
    const full = i - start >= targetSize;
    if (boundaryChanged || full) {
      push(start, i);
      start = i;
    }
    prevKey = key;
  }
  push(start, eventCount);
  return units;
}

/**
 * Best-unit pooling: a shard scores as its single most relevant unit, not as
 * its average.
 *
 * This is the whole point of the module, expressed in one place so no caller
 * re-invents it (the mistake that produced four divergent selection
 * implementations elsewhere in this codebase).
 *
 * Returns `-Infinity` for a shard with no units so it sorts last rather than
 * silently scoring 0 and tying with everything else — degenerate ties are what
 * the selection contract exists to surface.
 */
export function bestUnitScore(unitScores: readonly number[]): number {
  if (unitScores.length === 0) return Number.NEGATIVE_INFINITY;
  let best = unitScores[0]!;
  for (let i = 1; i < unitScores.length; i++) {
    if (unitScores[i]! > best) best = unitScores[i]!;
  }
  return best;
}

/**
 * Mean of the top-`k` unit scores. A softened pooling for cases where one
 * passage is too brittle a signal (a query whose evidence is genuinely spread).
 * `k = 1` is exactly `bestUnitScore`.
 */
export function topKUnitScore(unitScores: readonly number[], k: number): number {
  if (unitScores.length === 0) return Number.NEGATIVE_INFINITY;
  const sorted = [...unitScores].sort((a, b) => b - a);
  const n = Math.max(1, Math.min(k, sorted.length));
  let sum = 0;
  for (let i = 0; i < n; i++) sum += sorted[i]!;
  return sum / n;
}

/**
 * `CSM_RETRIEVAL_UNITS` — unit size for best-unit pooling. 0 or unset keeps the
 * legacy whole-shard centroid, so the default is byte-identical.
 */
export function resolveUnitSize(raw = process.env.CSM_RETRIEVAL_UNITS): number {
  // 0 = off (legacy whole-shard centroid); any other present value must be a
  // non-negative integer or it throws (invariant 5).
  return envInt(raw, { name: "CSM_RETRIEVAL_UNITS", fallback: 0, min: 0 });
}
