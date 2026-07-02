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
 * the token-cut config (e.g. Signals ranker @ 600 vs blind @ 1200). Returns the
 * supplied default when unset or invalid. Pure; the resulting digest is part of
 * the cache-key `system`, so a changed budget re-keys distinctly on its own.
 */
export function resolveRecallBudget(
  defaultTokens: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.CSM_RECALL_BUDGET;
  if (raw === undefined) return defaultTokens;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return defaultTokens;
  return Math.floor(n);
}
