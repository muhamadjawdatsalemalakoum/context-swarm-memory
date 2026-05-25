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
