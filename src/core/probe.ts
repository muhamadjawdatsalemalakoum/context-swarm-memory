import type { LlmProvider, ProviderUsage } from "../providers/LlmProvider.js";
import type { MemoryEvent, MemoryShardSnapshot, ProbeResult } from "./types.js";
import { probeResultSchema } from "./schemas.js";
import { completeAndValidate } from "./providerJson.js";
import { probePrompt, SHARD_SYSTEM_PROMPT } from "./prompts.js";
import { tokenize } from "./router.js";
import { estimateTokens } from "./tokenBudget.js";

const PROBE_INDEX_CHAR_BUDGET = 1200;

export async function probeShard(args: {
  provider: LlmProvider;
  userQuery: string;
  snapshot: MemoryShardSnapshot;
  model?: string;
}): Promise<{ result: ProbeResult; usage: ProviderUsage }> {
  const { provider, userQuery, snapshot, model } = args;
  const isMock = provider.name === "mock";

  // For real providers, give a compact event index so the model can populate
  // `relevant_event_ids`. Cheap (a few hundred tokens) but high-leverage:
  // recall later filters its context to just these IDs.
  //
  // CRITICAL: rank events by query relevance BEFORE truncating. With a shard
  // of 45 events and a 1200-char budget, only ~8 events fit. Sorting by event
  // ID (the previous behaviour) meant the auth events at e0017+ never appeared
  // in the index when the shard's early events were about a different topic —
  // probe then correctly concluded "this shard isn't about auth" and the
  // pipeline missed the correct shard. Query-aware ranking puts auth-tagged
  // events first so the probe sees the most-relevant content within budget.
  const eventIndex = compactEventIndex(snapshot, PROBE_INDEX_CHAR_BUDGET, userQuery);

  // For the mock, pre-bake the answer; the MockProvider extracts it verbatim.
  // Real providers ignore the fence (they don't see it).
  let promptSuffix = "";
  if (isMock) {
    const baked = mockProbe(userQuery, snapshot);
    promptSuffix = `\n\n<<MOCK_RESULT>>${JSON.stringify(baked)}<</MOCK_RESULT>>`;
  }

  // PREFIX-CACHE CONTRACT (Phase α): the literal `SHARD_SYSTEM_PROMPT` constant
  // MUST be the first bytes of `system`, byte-identical across every probe call
  // in a query. Under `OLLAMA_NUM_PARALLEL=1` Ollama's slot KV cache reuses the
  // prefill for those ~140 tokens across every probe + recall in the query,
  // saving ~50ms/query of latency. Do not move the `[Shard X@Y]` block above
  // SHARD_SYSTEM_PROMPT or interpolate any per-call variable into the prefix.
  // Mirrored in src/core/recall.ts. Pinned by tests/prefixCacheContract.test.ts.
  const system = `${SHARD_SYSTEM_PROMPT}

[Shard ${snapshot.shardId}@${snapshot.snapshotId}]
Summary:
${snapshot.summary}

Available events (id + tags + first chars):
${eventIndex}`;

  const { data, usage } = await completeAndValidate(
    provider,
    {
      system,
      prompt: probePrompt(userQuery) + promptSuffix,
      schemaName: "ProbeResult",
      // Probe is binary classification ("does this shard know"). Phase α (2026-05)
      // disables Gemma 4 thinking mode for this stage — no reasoning trace, just JSON.
      // Reasoning consumed 600-1500 output tokens per probe on the e4b model; with
      // thinking off the model emits ~100-200 JSON tokens total. Budget held at 2048
      // for back-compat with cached responses (the budget is a ceiling, not a floor).
      maxOutputTokens: 2048,
      temperature: 0,
      model,
      shardId: snapshot.shardId,
      snapshotId: snapshot.snapshotId,
      disableThinking: true,
    },
    probeResultSchema,
  );

  return {
    result: {
      shardId: snapshot.shardId,
      snapshotId: snapshot.snapshotId,
      knows: data.knows,
      confidence: data.confidence,
      memoryType: data.memory_type,
      estimatedAnswerValue: data.estimated_answer_value,
      needsFullRecall: data.needs_full_recall,
      relevantEventIds: data.relevant_event_ids,
    },
    usage,
  };
}

export function compactEventIndex(
  snapshot: MemoryShardSnapshot,
  charBudget: number,
  userQuery?: string,
): string {
  // Query-aware ranking: when a user query is provided, sort events by overlap
  // with the query's tokens (event content + tags). Within each relevance tier
  // we keep stable event-id order for determinism. This guarantees the
  // most-relevant events fit in the truncated index even when a shard has
  // many more events than the char budget allows.
  let events: MemoryEvent[];
  if (userQuery && snapshot.events.length > 0) {
    const queryTerms = new Set(tokenize(userQuery));
    events = [...snapshot.events]
      .map((e) => ({ event: e, score: relevanceScore(e, queryTerms) }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score; // higher score first
        return a.event.eventId < b.event.eventId ? -1 : 1; // stable tiebreak
      })
      .map((x) => x.event);
  } else {
    events = snapshot.events;
  }

  const lines: string[] = [];
  let used = 0;
  for (const e of events) {
    const head = e.content.replace(/\s+/g, " ").slice(0, 80);
    const tags = e.tags.length ? ` tags=[${e.tags.join(",")}]` : "";
    const line = `- [${e.eventId}]${tags} "${head}${e.content.length > 80 ? "…" : ""}"`;
    if (used + line.length > charBudget) {
      lines.push(`- (… ${events.length - lines.length} more events truncated)`);
      break;
    }
    lines.push(line);
    used += line.length;
  }
  return lines.join("\n") || "(no events)";
}

/** Cheap relevance signal: count of query tokens present in event tags
 *  (weighted ×2) plus event content (weighted ×1). Hand-tuned: tags are a
 *  much stronger signal than content prose, so they dominate.
 */
function relevanceScore(event: MemoryEvent, queryTerms: Set<string>): number {
  let score = 0;
  for (const tag of event.tags) {
    const tagLow = tag.toLowerCase();
    if (queryTerms.has(tagLow)) {
      score += 2;
    } else {
      // Prefix-tolerant match: "authentication" query token ↔ "auth" tag.
      // Mirrors the relaxation used in the router.
      for (const term of queryTerms) {
        if (term.length >= 4 && (term.startsWith(tagLow) || tagLow.startsWith(term))) {
          score += 2;
          break;
        }
      }
    }
  }
  // Cheap content scan: count query terms that appear as whole words in the
  // first 200 chars of content (where titles/headings tend to live).
  const head = event.content.slice(0, 200).toLowerCase();
  for (const term of queryTerms) {
    if (head.includes(term)) score += 1;
  }
  return score;
}

// ─── Phase 0 mock implementation (kept inline; only used when provider.name === "mock") ──
function mockProbe(userQuery: string, snapshot: MemoryShardSnapshot) {
  const qTerms = new Set(tokenize(userQuery));
  let hits = 0;
  let total = 0;
  const relevantEventIds: string[] = [];

  for (const ev of snapshot.events) {
    total++;
    const evTerms = new Set([
      ...tokenize(ev.content),
      ...ev.tags.flatMap((t) => tokenize(t)),
    ]);
    let evHits = 0;
    for (const q of qTerms) if (evTerms.has(q)) evHits++;
    if (evHits > 0) {
      hits += evHits;
      relevantEventIds.push(ev.eventId);
    }
  }

  const indexHits = snapshot.indexTerms.filter((t) => qTerms.has(t.toLowerCase())).length;
  const summaryHits = (() => {
    const sumTerms = new Set(tokenize(snapshot.summary));
    let n = 0;
    for (const q of qTerms) if (sumTerms.has(q)) n++;
    return n;
  })();

  const totalSignal = hits + indexHits * 2 + summaryHits;
  const denom = Math.max(1, qTerms.size + total / 3);
  const confidence = Math.max(0, Math.min(1, totalSignal / denom));
  const knows = totalSignal > 0;
  const memoryType = !knows
    ? "none"
    : confidence >= 0.5
      ? "direct"
      : confidence >= 0.2
        ? "adjacent"
        : "vague";
  const estimatedAnswerValue = !knows
    ? "none"
    : confidence >= 0.6
      ? "high"
      : confidence >= 0.3
        ? "medium"
        : "low";

  return {
    knows,
    confidence: round2(confidence),
    memory_type: memoryType,
    estimated_answer_value: estimatedAnswerValue,
    needs_full_recall: knows && confidence >= 0.25,
    relevant_event_ids: relevantEventIds.slice(0, 6),
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

// Used by recall to size its event digest budget.
export function probeIndexTokenEstimate(snapshot: MemoryShardSnapshot): number {
  return estimateTokens(compactEventIndex(snapshot, PROBE_INDEX_CHAR_BUDGET));
}
