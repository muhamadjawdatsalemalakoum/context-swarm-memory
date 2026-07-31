import type { LlmProvider, ProviderUsage } from "../providers/LlmProvider.js";
import type { MemoryEvent, MemoryShardSnapshot, ProbeResult } from "./types.js";
import { probeResultSchema } from "./schemas.js";
import { completeAndValidate } from "./providerJson.js";
import { probePrompt, SHARD_SYSTEM_PROMPT } from "./prompts.js";
import { tokenize, termMatchesAnyTag } from "./router.js";
import { estimateTokens } from "./tokenBudget.js";
import { select } from "./selection.js";
import { envFlag } from "../utils/env.js";

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
    // Shared selection contract (src/core/selection.ts) instead of a fourth
    // hand-rolled score → sort → tiebreak. `limit` is the event count, not the
    // char budget: the char budget is applied by the packing loop below, which
    // is a different unit and must stay a different decision.
    events = select(snapshot.events, {
      score: (e) => relevanceScore(e, queryTerms),
      key: (e) => e.eventId,
      limit: snapshot.events.length,
    }).selected;
  } else {
    events = snapshot.events;
  }

  const lines: string[] = [];
  let used = 0;
  for (const e of events) {
    const head = e.content.replace(/\s+/g, " ").slice(0, 80);
    // Tags are omitted when every event in the shard carries the same set:
    // they cost ~42 of a ~145-char line (29% of the whole visibility budget)
    // while carrying zero discriminating information. On BEAM every event is
    // tagged [amb, beam, beam-turn, conversation:N], so dropping them raises
    // the events the probe can see from ~8 to ~11 (+38%) at no cost.
    const tags = e.tags.length && !uniformTags(snapshot) ? ` tags=[${e.tags.join(",")}]` : "";
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

/** True when every event in the shard carries an identical tag set, i.e. the
 *  tags cannot discriminate between events and are pure overhead in the index. */
function uniformTags(snapshot: MemoryShardSnapshot): boolean {
  if (snapshot.events.length < 2) return false;
  const first = [...snapshot.events[0]!.tags].sort().join(",");
  return snapshot.events.every((e) => [...e.tags].sort().join(",") === first);
}

/** Cheap relevance signal: count of query tokens present in event tags
 *  (weighted ×2) plus event content (weighted ×1). Hand-tuned: tags are a
 *  much stronger signal than content prose, so they dominate.
 */
export function relevanceScore(event: MemoryEvent, queryTerms: Set<string>): number {
  let score = 0;
  for (const tag of event.tags) {
    const tagLow = tag.toLowerCase();
    if (queryTerms.has(tagLow)) {
      score += 2;
    } else {
      // Reuses the router's prefix rule instead of re-implementing it. The old
      // inline copy was commented "mirrors the relaxation used in the router"
      // but had DIVERGED: it required the QUERY TERM to be >=4, so it matched
      // the 3-char BEAM tag "amb" for any query word beginning "amb", whereas
      // `prefixMatch` requires the SHORTER string to be >=4 and would not.
      if (termMatchesAnyTag(tagLow, queryTerms)) score += 2;
    }
  }

  // Content scan.
  //
  // This used to read only `content.slice(0, 200)` — "where titles/headings
  // tend to live". That assumption is false for conversational memory: a BEAM
  // turn opens with a `[Month-DD-YYYY | Turn N] User:` header (~30 chars) and
  // runs to 6,000+ chars, so a preference or instruction stated mid-turn was
  // invisible to the ranker. MEASURED consequence: for a real BEAM 1M query the
  // set of events shown to the probe was byte-identical to passing NO QUERY AT
  // ALL, because nothing scored and the tiebreak fell to lexicographic event id.
  //
  // Scoring DISTINCT terms over the full body (rather than occurrences) keeps
  // long events from winning on length alone.
  const body = resolveProbeFullScan() ? event.content.toLowerCase() : event.content.slice(0, 200).toLowerCase();
  for (const term of queryTerms) {
    if (body.includes(term)) score += 1;
  }
  return score;
}

/**
 * `CSM_PROBE_FULL_SCAN` — score the whole event body rather than its first 200
 * characters. Default OFF only so the change can be gated on the answer metric
 * like every other behaviour change in this repo; the 200-char window is not a
 * defensible default and this is expected to become the default once measured.
 */
export function resolveProbeFullScan(raw = process.env.CSM_PROBE_FULL_SCAN): boolean {
  return envFlag(raw, { name: "CSM_PROBE_FULL_SCAN", fallback: false });
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
