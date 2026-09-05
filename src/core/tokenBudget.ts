import type { MemoryEvent } from "./types.js";

/** Cheap 4-chars-per-token estimator. Good enough for routing/fullness math. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function estimateEventsTokens(events: MemoryEvent[]): number {
  let total = 0;
  for (const e of events) {
    total += estimateTokens(e.content) + estimateTokens(e.role) + 8; // role + delimiters overhead
    total += estimateTokens(e.tags.join(","));
  }
  return total;
}

export function fullnessPct(tokens: number, contextLimit: number): number {
  if (contextLimit <= 0) return 0;
  return Math.min(100, (tokens / contextLimit) * 100);
}

export const DEFAULT_RECALL_BUDGET = {
  maxCandidateShards: 8,
  maxProbeShards: 8,
  maxRecallShards: 4,
  maxRecallTokensPerShard: 1200,
  maxMemoryPacketTokens: 2500,
} as const;

/**
 * Resolve an optional recall-budget override (`CSM_RECALL_BUDGET`). When set to
 * a positive integer it caps `maxRecallTokensPerShard` for the run — used to A/B
 * the token-cut config (e.g. Signals ranker @ 600 vs blind @ 1200). Unset →
 * the supplied default; a present but non-positive-integer value THROWS
 * (invariant 5 — a mistyped budget must not silently run at the default). Pure;
 * the resulting digest is part of the cache-key `system`, so a changed budget
 * re-keys distinctly on its own.
 */
import { envPositiveInt } from "../utils/env.js";

export function resolveRecallBudget(
  defaultTokens: number,
  env: Record<string, string | undefined> = process.env,
): number {
  return envPositiveInt(env.CSM_RECALL_BUDGET, {
    name: "CSM_RECALL_BUDGET",
    fallback: defaultTokens,
  });
}

/**
 * `CSM_MAX_PROBE_SHARDS` / `CSM_MAX_RECALL_SHARDS` — shard-count overrides.
 *
 * These exist because shard SIZE and these counts are one coupled system.
 * `CSM_VIRTUAL_SHARDS=4` cut shard size ~10x and, with these counts fixed,
 * retrieved evidence fell 55% (58.3 -> 26.4 events) and coverage went DOWN
 * 0.743 -> 0.620 even though the router itself got measurably better in
 * isolation. See `docs/experiments/EXP-virtual-shards-system.md`.
 *
 * The pipeline conserves SHARDS; what actually matters is EVENTS. When shard
 * size changes, these must move inversely or the harvest starves.
 *
 * Both default to the frozen values, so unset is byte-identical. A present but
 * non-positive-integer value throws (invariant 5).
 */
export function resolveShardCount(
  key: "CSM_MAX_PROBE_SHARDS" | "CSM_MAX_RECALL_SHARDS",
  defaultCount: number,
  env: Record<string, string | undefined> = process.env,
): number {
  return envPositiveInt(env[key], { name: key, fallback: defaultCount });
}
