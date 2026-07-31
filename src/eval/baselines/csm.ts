import { ask } from "../../core/ask.js";
import { collectTimelineEventIds } from "../../core/coverage.js";
import { centroidOf, deriveShardDescriptors } from "../../core/descriptors.js";
import { partitionIntoUnits, resolveUnitSize } from "../../core/retrievalUnit.js";
import {
  buildRouterIndex,
  hybridEquivalentOfLexScore,
  type RouterIndex,
} from "../../core/routerEmbed.js";
import { SHARD_SYSTEM_PROMPT } from "../../core/prompts.js";
import {
  estimateEventsTokens,
  estimateTokens,
  fullnessPct,
} from "../../core/tokenBudget.js";
import type {
  MemoryDirectory,
  MemoryDirectoryEntry,
  MemoryEvent,
  MemoryPacket,
  MemoryShardSnapshot,
} from "../../core/types.js";
import type { LlmProvider } from "../../providers/LlmProvider.js";
import type { StorageReader } from "../../storage/jsonlStorage.js";
import { buildPrompt, parseAnswer } from "../answer.js";
import { callLlmCached } from "../cachedLlm.js";
import type { BenchEvent, Corpus } from "../corpus.js";
import { embed, EMBED_MODEL_NAME, topKCosine } from "../embed.js";
import type { Query } from "../mcq.js";
import type {
  BaselineResult,
  BaselineRunContext,
  BaselineRunner,
} from "./types.js";

/** Reserved input-token budget for MCQ scaffolding (question + 40 options +
 *  the "Respond with..." instructions). Mirrors the other baselines. */
const MCQ_SCAFFOLDING_TOKENS = 512;

/** Default per-snapshot context limit used to compute fullness for the
 *  synthesised directory entries. The exact value doesn't matter for
 *  routing (the scorer uses it only for the fullness penalty), but
 *  picking the modern Gemma 4 31B window keeps fullness numbers sane. */
const SYNTHETIC_CONTEXT_LIMIT = 128_000;

/**
 * Embedding recall floor — pure backfill logic (the testable core of the
 * `CSM_EMBED_FLOOR_K` feature; the embed/cosine side-effects stay in `answer`).
 *
 * Given the pipeline's `baseOrder` of retrieved event IDs, a floor `k`, and
 * `rankedIds` (event IDs ranked by embedding similarity to the query), append
 * ranked IDs that aren't already present until the order reaches `k`. Returns
 * the new order plus whether/how many were added.
 *
 * Fires only when the pipeline is starved (`baseOrder.length < k`). Appends
 * AFTER the pipeline's own hits so the budgeted context still packs CSM's
 * precise events first (preserving citation precision); the embedding hits
 * only fill the remaining slots. With `k <= 0` it's a no-op so callers can
 * explicitly disable the safety net.
 */
export function applyEmbeddingFloor(
  baseOrder: string[],
  k: number,
  rankedIds: string[],
): { order: string[]; fired: boolean; count: number; addedIds: string[] } {
  if (!Number.isFinite(k) || k <= 0 || baseOrder.length >= k) {
    return { order: baseOrder, fired: false, count: 0, addedIds: [] };
  }
  const order = [...baseOrder];
  const already = new Set(order);
  const addedIds: string[] = [];
  let count = 0;
  for (const id of rankedIds) {
    if (already.has(id)) continue;
    order.push(id);
    already.add(id);
    addedIds.push(id);
    count++;
    if (order.length >= k) break;
  }
  return { order, fired: count > 0, count, addedIds };
}

export function resolveEmbeddingFloorK(raw = process.env.CSM_EMBED_FLOOR_K): number {
  if (raw === undefined || raw.trim().length === 0) return 10;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 10;
}

export interface ShardLocalExpansionInput {
  shardId: string;
  afterEventId: string;
  rankedIds: string[];
}

/**
 * Insert nearest sibling events from already-touched shards.
 *
 * The global embedding floor fixes fully-starved queries, but at larger corpus
 * sizes it can still land on only one or two events from the right shard. That
 * makes the answer model correct more often than it makes the citation set
 * complete. Local expansion keeps the retrieval precise by expanding inside a
 * shard CSM already touched, then inserts those siblings beside the shard's
 * current foothold so they survive context truncation.
 */
export function applyShardLocalExpansion(
  baseOrder: string[],
  groups: ShardLocalExpansionInput[],
  maxTotal: number,
  maxPerGroup: number = Number.POSITIVE_INFINITY,
): { order: string[]; fired: boolean; count: number; shardIds: string[] } {
  const perGroupLimit = Number.isFinite(maxPerGroup)
    ? maxPerGroup
    : Number.POSITIVE_INFINITY;
  if (
    !Number.isFinite(maxTotal) ||
    maxTotal <= baseOrder.length ||
    perGroupLimit <= 0
  ) {
    return { order: baseOrder, fired: false, count: 0, shardIds: [] };
  }

  const order = [...baseOrder];
  const already = new Set(order);
  const shardIds: string[] = [];
  let count = 0;

  for (const group of groups) {
    if (order.length >= maxTotal) break;
    let insertAt = order.lastIndexOf(group.afterEventId);
    if (insertAt === -1) continue;

    let addedForShard = false;
    let addedForGroup = 0;
    for (const id of group.rankedIds) {
      if (already.has(id)) continue;
      order.splice(insertAt + 1, 0, id);
      insertAt++;
      already.add(id);
      addedForShard = true;
      addedForGroup++;
      count++;
      if (order.length >= maxTotal || addedForGroup >= perGroupLimit) break;
    }

    if (addedForShard) shardIds.push(group.shardId);
  }

  return { order, fired: count > 0, count, shardIds };
}

export function resolveShardExpandK(raw = process.env.CSM_SHARD_EXPAND_K): number {
  if (raw === undefined || raw.trim().length === 0) return 3;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 3;
}

export function resolveShardExpandMax(
  raw = process.env.CSM_SHARD_EXPAND_MAX,
): number {
  if (raw === undefined || raw.trim().length === 0) return 16;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 16;
}

export interface EntityBridgeEvent {
  id: string;
  shardId: string;
  content: string;
}

/**
 * Build expansion groups for entity-chain recall.
 *
 * This is deliberately lexical and local: after CSM has retrieved a foothold
 * event, extract salient entity terms from the query + foothold content, then
 * surface same-shard events that mention those terms. It helps tasks where the
 * answer depends on a bridge fact ("Mary got the milk" -> later "Mary moved to
 * the hallway") without relying on gold labels or mutating durable memory.
 */
export function buildEntityBridgeGroups(
  baseOrder: string[],
  eventLookup: Map<string, EntityBridgeEvent>,
  eventsByShard: Map<string, EntityBridgeEvent[]>,
  query: string,
  rankedLimit = 24,
): ShardLocalExpansionInput[] {
  const groups: ShardLocalExpansionInput[] = [];
  const seenGroup = new Set<string>();

  for (const eventId of baseOrder) {
    const seed = eventLookup.get(eventId);
    if (!seed) continue;
    const terms = extractBridgeTerms(`${query} ${seed.content}`);
    if (terms.length === 0) continue;
    const groupKey = `${seed.shardId}|${eventId}`;
    if (seenGroup.has(groupKey)) continue;
    seenGroup.add(groupKey);

    const candidates = (eventsByShard.get(seed.shardId) ?? [])
      .filter((event) => event.id !== eventId)
      .map((event) => ({
        event,
        score: bridgeScore(event.content, terms),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.event.id.localeCompare(a.event.id);
      })
      .slice(0, rankedLimit)
      .map((item) => item.event.id);

    if (candidates.length > 0) {
      groups.push({
        shardId: seed.shardId,
        afterEventId: eventId,
        rankedIds: candidates,
      });
    }
  }

  return groups;
}

export function buildLocalLexicalBridgeGroups(
  baseOrder: string[],
  eventLookup: Map<string, EntityBridgeEvent>,
  eventsByShard: Map<string, EntityBridgeEvent[]>,
  query: string,
  rankedLimit = 16,
): ShardLocalExpansionInput[] {
  const queryTerms = extractBridgeTerms(query);
  if (queryTerms.length === 0) return [];

  const lastEventIdByShard = new Map<string, string>();
  for (const eventId of baseOrder) {
    const shardId = eventLookup.get(eventId)?.shardId;
    if (shardId) lastEventIdByShard.set(shardId, eventId);
  }

  const groups: ShardLocalExpansionInput[] = [];
  for (const [shardId, afterEventId] of lastEventIdByShard) {
    const candidates = (eventsByShard.get(shardId) ?? [])
      .map((event) => ({
        event,
        score: bridgeScore(event.content, queryTerms),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.event.id.localeCompare(a.event.id);
      })
      .slice(0, rankedLimit)
      .map((item) => item.event.id);

    if (candidates.length > 0) {
      groups.push({ shardId, afterEventId, rankedIds: candidates });
    }
  }

  return groups;
}

export function resolveLexicalBridgeK(raw = process.env.CSM_LEXICAL_BRIDGE_K): number {
  if (raw === undefined || raw.trim().length === 0) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function resolveLexicalBridgeMax(
  raw = process.env.CSM_LEXICAL_BRIDGE_MAX,
): number {
  if (raw === undefined || raw.trim().length === 0) return 20;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 20;
}

export function resolveEntityBridgeK(raw = process.env.CSM_ENTITY_BRIDGE_K): number {
  if (raw === undefined || raw.trim().length === 0) return 6;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 6;
}

export function resolveEntityBridgeMax(
  raw = process.env.CSM_ENTITY_BRIDGE_MAX,
): number {
  if (raw === undefined || raw.trim().length === 0) return 24;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 24;
}

/**
 * Probe/recall concurrency policy. Local single-GPU servers serialize
 * internally anyway, and concurrent fetches against them tripped Undici's
 * connection-pool limits (see CHANGELOG "Serialised CSM probes"), so they
 * stay serial. Hosted APIs handle concurrency fine, and serializing them is
 * the single biggest latency cost in the pipeline: the BEAM 100K run paid
 * ~7.25 probes + ~3.55 recalls per query back-to-back (~28.4 s of a ~29.2 s
 * average retrieval). `CSM_PARALLEL_PROBES=0|1` overrides the heuristic —
 * use `0` when pointing the "openai" provider at a local OpenAI-compat
 * endpoint.
 */
export function resolveParallelProbes(
  providerName: string,
  raw = process.env.CSM_PARALLEL_PROBES,
): boolean {
  if (raw !== undefined && raw.trim().length > 0) {
    const v = raw.trim().toLowerCase();
    return !(v === "0" || v === "false" || v === "no");
  }
  return providerName !== "ollama" && providerName !== "llama-server";
}

/**
 * Hybrid-router toggle for the baseline adapter (`CSM_ROUTER_HYBRID=1`).
 * Default OFF on mainline: the 2026-06-10 live PaySwift 30q gate
 * (rd-t2hybrid-30q-v1 vs rd-probelite-30q-v1) showed parity (29/30 both,
 * −5% latency) but +6.4% pipeline input tokens — outside the +5% bar — and
 * PaySwift's augmentation stack masks router differences anyway (embedding
 * floor fired on 28/30 queries in BOTH arms). The hybrid's offline wins are
 * decisive where routing actually starves (BEAM-shaped corpora, Discovery A
 * in docs/RD_PORTFOLIO_2026_06.md), so the default flips after the T3
 * BEAM-slice recall@k A/B confirms it on real BEAM data.
 */
/**
 * `CSM_SHARD_DESCRIPTORS` — write TF-IDF-derived terms into directory entries so
 * the lexical router has query signal. Default OFF: at 100K the router selects
 * 8 of 8.5 shards, so this cannot help there and must not perturb the frozen
 * baseline. See `docs/experiments/EXP-router-component-bench.md`.
 */
export function resolveShardDescriptors(
  raw = process.env.CSM_SHARD_DESCRIPTORS,
): boolean {
  if (raw === undefined || raw.trim().length === 0) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Leading `[Month-DD-YYYY | Turn N]` header, as a "Mar-15-2024. " prefix. */
function firstDatedHeader(events: Array<{ content: string }>): string | null {
  for (const e of events) {
    const m = /\[([A-Z][a-z]+-\d{1,2}-\d{4})\s*\|/.exec(e.content ?? "");
    if (m) return `${m[1]!}. `;
  }
  return null;
}

export function resolveRouterHybrid(
  raw = process.env.CSM_ROUTER_HYBRID,
): boolean {
  if (raw === undefined || raw.trim().length === 0) return false;
  const v = raw.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "no");
}

/** Everything `answer()` needs from the retrieval half of the baseline, and
 *  everything the AMB bridge needs WITHOUT the final answer call. */
export interface CsmRetrieval {
  contextString: string;
  contextTokens: number;
  packedEventIds: string[];
  packetTokens: number;
  csmRetrievedEventIds: string[];
  pipelineCost: {
    inputTokensEstimate: number;
    outputTokensEstimate: number;
    estimatedUsd: number;
    latencyMs: number;
  };
  meta: Record<string, unknown>;
}

/**
 * CSM baseline for the Phase C scaling study.
 *
 * Drives the existing read-only CSM pipeline (`router → probe → recall →
 * synthesise → MemoryPacket`) over the in-memory benchmark `Corpus`, then
 * formats the resulting packet plus cited events as the MCQ context for
 * the same answering LLM all other baselines use.
 *
 * **Path A (in-memory adapter).** Rather than materialise the corpus to
 * disk and run CSM against a temp `JsonlStorage`, this baseline uses a
 * private `InMemoryStorageReader` that synthesises one `MemoryShardSnapshot`
 * per distinct `shardId` in the corpus and a matching `MemoryDirectory`.
 * `ask()` was widened (purely additively) to accept the new `StorageReader`
 * interface; `JsonlStorage` still satisfies it structurally so nothing else
 * changes. This keeps the benchmark fast (no per-query disk I/O for million-
 * event corpora) and trivially preserves the mutation-safety invariant:
 * the adapter has no `appendQueryRun` method, `ask()` is called with
 * `skipQueryLog: true`, and there are no other write methods on the
 * interface at all.
 *
 * Telemetry exposed in `meta` mirrors what naturally falls out of an
 * `AskRunResult`: router hits, probe-accepted shard ids, recall ids, the
 * packet's cited event ids, and packet-token / context-token sizes.
 */
export class CsmBaseline implements BaselineRunner {
  readonly name = "csm";

  /** Cached adapters keyed by corpus identity (sampleSeed + targetTokens +
   *  byId.size). Building shard snapshots is O(events) — cheap relative to
   *  an LLM call but worth avoiding when we sweep multiple queries per
   *  corpus sample. */
  private adapterCache = new WeakMap<Corpus, InMemoryStorageReader>();

  /** One hybrid RouterIndex per corpus (descriptors + MiniLM centroids),
   *  built lazily on first query. Promise-cached so concurrent queries share
   *  the single build. */
  private routerIndexCache = new WeakMap<Corpus, Promise<RouterIndex>>();

  constructor(private opts: { provider: LlmProvider }) {}

  /**
   * Synthesis-engine pass for the AMB bridge (CSM_AMB_SYNTH_MEMORY). Organizes
   * the retrieved conversation events into a comprehensive, chronological
   * "organized memory" — the pre-digested, ordered view that lets the answer
   * model REPORT rather than synthesize from a raw event pile (which is how a
   * purpose-built memory system like Hindsight wins the synthesis-heavy
   * summarization / event_ordering categories). Read-only: organizes only the
   * provided events, no gold, no outside knowledge.
   */
  async organizeMemory(args: {
    query: string;
    eventContents: string[];
    model: string;
    maxOutputTokens?: number;
  }): Promise<{ text: string; inputTokens: number; outputTokens: number; latencyMs: number }> {
    const { query, eventContents, model, maxOutputTokens = 2048 } = args;
    const events = eventContents.map((c, i) => `[${i + 1}] ${c}`).join("\n\n");
    const system =
      "You organize a user's conversation memory faithfully and completely. Use ONLY the " +
      "provided events. Do not add outside knowledge, do not answer any question, do not invent.";
    const prompt =
      "The events below are the user's own conversation turns, already in CHRONOLOGICAL ORDER " +
      "(earliest first). Produce a COMPREHENSIVE, CHRONOLOGICAL account of what the user brought " +
      "up and how things developed over time.\n" +
      "Rules:\n" +
      "- Walk through the events in order, first to last; preserve that order.\n" +
      "- Include EVERY distinct topic, request, decision, or event the user raised — do NOT omit " +
      "or merge them; this is the user's memory, completeness matters.\n" +
      "- For each, state briefly what the USER did or asked, in their framing (\"the user asked " +
      "about X\", \"the user decided Y\"), with the concrete specifics (names, topics, values).\n" +
      "- Output a numbered timeline, one entry per distinct topic/event, in order.\n" +
      "- Be faithful and complete; do NOT answer any question, just organize the memory.\n\n" +
      `Focus area for emphasis (still include everything): ${query}\n\n` +
      `EVENTS (chronological):\n${events}`;
    const res = await this.opts.provider.completeText({
      system,
      prompt,
      model,
      maxOutputTokens,
      temperature: 0,
    });
    return {
      text: res.data,
      inputTokens: res.usage.inputTokensEstimate,
      outputTokens: res.usage.outputTokensEstimate,
      latencyMs: res.usage.latencyMs,
    };
  }

  /**
   * Scale-aware organized memory (hierarchical / map-reduce). A single
   * organizeMemory() call cannot summarize a conversation larger than the
   * model's context window — BEAM 10M conversations are ~11M tokens, far past
   * the ~1M flash context, so the single-pass Observation that wins at 100K
   * physically cannot run at 10M. This packs the events into context-sized
   * chunks, summarizes each chunk in order (map), then merges the ordered chunk
   * summaries into one comprehensive chronological organized memory (reduce).
   * Below `singlePassTokens` it is byte-equivalent to a single organizeMemory()
   * call, so 100K-tier conversations (the proven win) are unchanged.
   */
  async organizeMemoryScaled(args: {
    query: string;
    eventContents: string[];
    model: string;
    chunkTokens?: number;
    singlePassTokens?: number;
    chunkOutputTokens?: number;
    finalOutputTokens?: number;
    mapConcurrency?: number;
    /** Optional progress sink (chunk/reduce milestones) for live monitoring of
     *  long 10M-tier builds. Pure side-channel; does not affect output. */
    onProgress?: (msg: string) => void;
  }): Promise<{
    text: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    chunks: number;
  }> {
    const {
      query,
      eventContents,
      model,
      chunkTokens = 600_000,
      singlePassTokens = 700_000,
      chunkOutputTokens = 3000,
      finalOutputTokens = 12_000,
      mapConcurrency = 4,
      onProgress,
    } = args;

    const totalTokens = eventContents.reduce((sum, c) => sum + estimateTokens(c), 0);
    if (totalTokens <= singlePassTokens) {
      const r = await this.organizeMemory({
        query,
        eventContents,
        model,
        maxOutputTokens: finalOutputTokens,
      });
      return { ...r, chunks: 1 };
    }

    const chunks = chunkByTokenBudget(eventContents, chunkTokens);
    onProgress?.(`map start: ${chunks.length} chunks, concurrency=${mapConcurrency}`);
    // Map: summarize each ordered chunk. Concurrency-limited so a 10M
    // conversation's many chunks don't fire as one quota-busting burst.
    let mapDone = 0;
    const mapped = await mapWithConcurrency(chunks, mapConcurrency, async (chunkEvents, i) => {
      const r = await this.summarizeSegment({
        segmentIndex: i,
        segmentCount: chunks.length,
        eventContents: chunkEvents,
        model,
        maxOutputTokens: chunkOutputTokens,
      });
      mapDone += 1;
      onProgress?.(`map ${mapDone}/${chunks.length} done (${Math.round(r.latencyMs)}ms)`);
      return r;
    });
    onProgress?.(`reduce start: merging ${chunks.length} segment summaries`);
    // Reduce: weave the ordered segment summaries into one organized memory.
    const merged = await this.mergeSegmentSummaries({
      query,
      segmentSummaries: mapped.map((m) => m.text),
      model,
      maxOutputTokens: finalOutputTokens,
    });
    onProgress?.(`reduce done (${Math.round(merged.latencyMs)}ms)`);

    return {
      text: merged.text,
      inputTokens: mapped.reduce((s, m) => s + m.inputTokens, 0) + merged.inputTokens,
      outputTokens: mapped.reduce((s, m) => s + m.outputTokens, 0) + merged.outputTokens,
      // Map runs concurrently, so its wall-clock is ~the slowest chunk, not the
      // sum; approximate with max + the reduce call.
      latencyMs:
        (mapped.length ? Math.max(...mapped.map((m) => m.latencyMs)) : 0) + merged.latencyMs,
      chunks: chunks.length,
    };
  }

  /**
   * Scale-aware FACT REGISTRY (hierarchical / map-reduce). The second write-time
   * lever, aimed at the aggregation failure mode the prose Observation cannot
   * fix: multi-session questions like "how many X in total when combining A and
   * B" fail at baseline because the answer model aggregates STALE values — BEAM
   * conversations update the same metric repeatedly ("1M docs" → later "1.8M
   * docs") and placeholder dates hide which value is current (measured: 10M-tier
   * multi_session_reasoning = 0.120, answers confidently sum outdated numbers).
   * The registry tracks each metric's VALUE HISTORY in conversation order with
   * the LATEST value marked — the per-entity observation / bi-temporal pattern
   * of Hindsight and Zep/Graphiti. Same chunking/concurrency contract as
   * organizeMemoryScaled.
   */
  async organizeFactsScaled(args: {
    eventContents: string[];
    model: string;
    chunkTokens?: number;
    singlePassTokens?: number;
    chunkOutputTokens?: number;
    finalOutputTokens?: number;
    mapConcurrency?: number;
    onProgress?: (msg: string) => void;
  }): Promise<{
    text: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    chunks: number;
  }> {
    const {
      eventContents,
      model,
      chunkTokens = 600_000,
      singlePassTokens = 700_000,
      chunkOutputTokens = 4000,
      finalOutputTokens = 12_000,
      mapConcurrency = 4,
      onProgress,
    } = args;

    const totalTokens = eventContents.reduce((sum, c) => sum + estimateTokens(c), 0);
    const chunks =
      totalTokens <= singlePassTokens
        ? [eventContents]
        : chunkByTokenBudget(eventContents, chunkTokens);
    onProgress?.(`fact map start: ${chunks.length} chunks, concurrency=${mapConcurrency}`);
    let mapDone = 0;
    const mapped = await mapWithConcurrency(chunks, mapConcurrency, async (chunkEvents, i) => {
      const r = await this.extractFactsSegment({
        segmentIndex: i,
        segmentCount: chunks.length,
        eventContents: chunkEvents,
        model,
        maxOutputTokens: chunkOutputTokens,
      });
      mapDone += 1;
      onProgress?.(`fact map ${mapDone}/${chunks.length} done (${Math.round(r.latencyMs)}ms)`);
      return r;
    });
    // Single chunk still goes through the merge: it converts the raw ordered
    // fact lines into the deduplicated per-metric registry with LATEST markers.
    const merged = await this.mergeFactSegments({
      segmentFacts: mapped.map((m) => m.text),
      model,
      maxOutputTokens: finalOutputTokens,
    });
    onProgress?.(`fact reduce done (${Math.round(merged.latencyMs)}ms)`);

    return {
      text: merged.text,
      inputTokens: mapped.reduce((s, m) => s + m.inputTokens, 0) + merged.inputTokens,
      outputTokens: mapped.reduce((s, m) => s + m.outputTokens, 0) + merged.outputTokens,
      latencyMs:
        (mapped.length ? Math.max(...mapped.map((m) => m.latencyMs)) : 0) + merged.latencyMs,
      chunks: chunks.length,
    };
  }

  /**
   * Write-time STANDING PREFERENCE PROFILE — the third write-time extractor,
   * alongside `organizeMemoryScaled` (narrative) and `organizeFactsScaled`
   * (metric histories).
   *
   * WHY IT EXISTS, and why it is ALWAYS-ON rather than gated:
   *
   * `preference_following` and `instruction_following` queries never mention the
   * thing they are testing. Real BEAM examples:
   *
   *   "I'm planning to build a text generation pipeline. Which transformer
   *    model would you suggest I start with?"
   *   "I'm applying for a job in the UK. How should I format it?"
   *
   * The gold is a standing preference stated much earlier, in different words,
   * about a different immediate topic. Because the query does not describe the
   * target, NO query-conditioned retrieval can find it — which is why four
   * separate selection-side fixes (router descriptors+hybrid, signals ranker,
   * probe full-scan, best-passage retrieval units) each repaired a real measured
   * defect and each left this category flat.
   *
   * A lexical gate was attempted over all 2,000 BEAM queries and abandoned: the
   * best safe variant reached 50.5% recall while still firing 27 times on
   * `multi_session_reasoning`, a category CSM wins. So the profile is retrieved
   * by USER, not by query match — the same shape as Hindsight's `[world]`
   * memories.
   *
   * Being always-on makes the cost explicit and measurable rather than hidden
   * behind a gate: it spends one of the ~24 returned slots on every query, and
   * that displacement is exactly what the calibrated answer gate is for. Keep
   * the output SMALL for that reason.
   */
  async organizePreferencesScaled(args: {
    eventContents: string[];
    model: string;
    chunkTokens?: number;
    singlePassTokens?: number;
    chunkOutputTokens?: number;
    finalOutputTokens?: number;
    mapConcurrency?: number;
    onProgress?: (msg: string) => void;
  }): Promise<{
    text: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    chunks: number;
  }> {
    const {
      eventContents,
      model,
      chunkTokens = 600_000,
      singlePassTokens = 700_000,
      chunkOutputTokens = 3000,
      // Deliberately smaller than the fact registry's 12k: this is injected on
      // EVERY query, so it competes for a return slot every time.
      finalOutputTokens = 2500,
      mapConcurrency = 4,
      onProgress,
    } = args;

    const totalTokens = eventContents.reduce((sum, c) => sum + estimateTokens(c), 0);
    const chunks =
      totalTokens <= singlePassTokens
        ? [eventContents]
        : chunkByTokenBudget(eventContents, chunkTokens);
    onProgress?.(`pref map start: ${chunks.length} chunks, concurrency=${mapConcurrency}`);

    let mapDone = 0;
    const mapped = await mapWithConcurrency(chunks, mapConcurrency, async (chunkEvents, i) => {
      const r = await this.extractPreferencesSegment({
        segmentIndex: i,
        segmentCount: chunks.length,
        eventContents: chunkEvents,
        model,
        maxOutputTokens: chunkOutputTokens,
      });
      mapDone += 1;
      onProgress?.(`pref map ${mapDone}/${chunks.length} done (${Math.round(r.latencyMs)}ms)`);
      return r;
    });

    const merged = await this.mergePreferenceSegments({
      segmentPrefs: mapped.map((m) => m.text),
      model,
      maxOutputTokens: finalOutputTokens,
    });
    onProgress?.(`pref reduce done (${Math.round(merged.latencyMs)}ms)`);

    return {
      text: merged.text,
      inputTokens: mapped.reduce((s, m) => s + m.inputTokens, 0) + merged.inputTokens,
      outputTokens: mapped.reduce((s, m) => s + m.outputTokens, 0) + merged.outputTokens,
      latencyMs:
        (mapped.length ? Math.max(...mapped.map((m) => m.latencyMs)) : 0) + merged.latencyMs,
      chunks: chunks.length,
    };
  }

  /** Map step: pull standing preferences/instructions out of ONE segment. */
  private async extractPreferencesSegment(args: {
    segmentIndex: number;
    segmentCount: number;
    eventContents: string[];
    model: string;
    maxOutputTokens: number;
  }): Promise<{ text: string; inputTokens: number; outputTokens: number; latencyMs: number }> {
    const { segmentIndex, segmentCount, eventContents, model, maxOutputTokens } = args;
    const events = eventContents.map((c, i) => `[${i + 1}] ${c}`).join("\n\n");
    const system =
      "You extract STANDING PREFERENCES and STANDING INSTRUCTIONS from one segment of a long " +
      "user conversation, faithfully. Use ONLY the provided events. Do not add outside " +
      "knowledge, do not answer any question, do not invent anything.";
    const prompt =
      `This is segment ${segmentIndex + 1} of ${segmentCount} of one long conversation, in ` +
      "CHRONOLOGICAL ORDER (earliest first).\n\n" +
      "List the working instructions the user gave the assistant that are still in force — " +
      "the ones a later reply on a DIFFERENT topic should still follow. In scope: the " +
      "languages, frameworks, libraries and versions they said to use or avoid; code and " +
      "writing style rules they asked for; output and formatting conventions they requested; " +
      "approaches they said they did not want; and technical constraints they told the " +
      "assistant to design within.\n" +
      "Rules:\n" +
      "- One line each: PREF | <area> | <the instruction, in the user's own words> | <turn ref if visible>\n" +
      "- Only what the USER asked for, not what the assistant proposed, unless the user " +
      "explicitly agreed to it.\n" +
      "- When the user CHANGED an instruction, output the new one as its own line in order — " +
      "do NOT collapse the change; later lines supersede earlier ones.\n" +
      "- Skip one-off task details that carry no forward implication.\n" +
      "- Nothing about the person themselves — only how they asked for the work to be done.\n" +
      "- No commentary, no answers.\n\n" +
      `EVENTS (chronological):\n${events}`;
    const res = await this.opts.provider.completeText({
      system,
      prompt,
      model,
      maxOutputTokens,
      temperature: 0,
    });
    return {
      text: res.data,
      inputTokens: res.usage.inputTokensEstimate,
      outputTokens: res.usage.outputTokensEstimate,
      latencyMs: res.usage.latencyMs,
    };
  }

  /** Reduce step: dedupe into a compact profile with CURRENT markers. */
  private async mergePreferenceSegments(args: {
    segmentPrefs: string[];
    model: string;
    maxOutputTokens: number;
  }): Promise<{ text: string; inputTokens: number; outputTokens: number; latencyMs: number }> {
    const { segmentPrefs, model, maxOutputTokens } = args;
    const joined = segmentPrefs.map((t, i) => `--- segment ${i + 1} ---\n${t}`).join("\n\n");
    const system =
      "You consolidate extracted preference lines into one compact standing-preference " +
      "profile. Use ONLY the provided lines. Do not invent, do not answer questions.";
    const prompt =
      "Below are PREF lines extracted from consecutive segments of ONE user's conversation, " +
      "in chronological order.\n\n" +
      "Produce a SHORT profile of what this user durably prefers, grouped by area. Rules:\n" +
      "- Group by area (e.g. Languages & frameworks, Style, Tooling, Constraints, Workflow).\n" +
      "- One bullet per distinct preference, in the user's own terms.\n" +
      "- When a preference was REVISED, keep only the latest and mark it: " +
      "`X (CURRENT; previously Y)`.\n" +
      "- Drop anything that is a one-off task detail rather than a standing preference.\n" +
      "- Be concise. This profile is shown on EVERY query, so every line must earn its place. " +
      "Aim for at most 25 bullets.\n" +
      "- Output the profile only. No preamble, no commentary.\n\n" +
      `EXTRACTED LINES:\n${joined}`;
    const res = await this.opts.provider.completeText({
      system,
      prompt,
      model,
      maxOutputTokens,
      temperature: 0,
    });
    return {
      text: res.data,
      inputTokens: res.usage.inputTokensEstimate,
      outputTokens: res.usage.outputTokensEstimate,
      latencyMs: res.usage.latencyMs,
    };
  }

  /** Map step: extract every quantitative/stateful fact from ONE segment. */
  private async extractFactsSegment(args: {
    segmentIndex: number;
    segmentCount: number;
    eventContents: string[];
    model: string;
    maxOutputTokens: number;
  }): Promise<{ text: string; inputTokens: number; outputTokens: number; latencyMs: number }> {
    const { segmentIndex, segmentCount, eventContents, model, maxOutputTokens } = args;
    const events = eventContents.map((c, i) => `[${i + 1}] ${c}`).join("\n\n");
    const system =
      "You extract facts from ONE segment of a long user conversation, faithfully and " +
      "completely. Use ONLY the provided events. Do not add outside knowledge, do not answer " +
      "any question, do not invent values.";
    const prompt =
      `This is segment ${segmentIndex + 1} of ${segmentCount} of one long conversation, in ` +
      "CHRONOLOGICAL ORDER (earliest first). Extract EVERY quantitative or stateful fact the " +
      "USER stated about their projects, plans, metrics, or life: counts, capacities, targets, " +
      "percentages, durations, prices, quantities, named items in lists.\n" +
      "Rules:\n" +
      "- One line per fact, IN ORDER: FACT | <topic/metric, specific> | <value with unit> | <turn ref if visible>\n" +
      "- When the user UPDATES or revises an earlier value, output the new value as its own " +
      "line in order — do NOT collapse updates; the sequence matters.\n" +
      "- Include distinct named items (e.g. error types, tools tried) as list-membership facts.\n" +
      "- Do NOT omit any number the user stated. Do NOT answer questions. No commentary.\n\n" +
      `EVENTS (chronological):\n${events}`;
    const res = await this.opts.provider.completeText({
      system,
      prompt,
      model,
      maxOutputTokens,
      temperature: 0,
    });
    return {
      text: res.data,
      inputTokens: res.usage.inputTokensEstimate,
      outputTokens: res.usage.outputTokensEstimate,
      latencyMs: res.usage.latencyMs,
    };
  }

  /** Reduce step: merge ordered per-segment fact lines into a value-history
   *  registry with LATEST markers. */
  private async mergeFactSegments(args: {
    segmentFacts: string[];
    model: string;
    maxOutputTokens: number;
  }): Promise<{ text: string; inputTokens: number; outputTokens: number; latencyMs: number }> {
    const { segmentFacts, model, maxOutputTokens } = args;
    const segments = segmentFacts.map((s, i) => `### Segment ${i + 1}\n${s}`).join("\n\n");
    const system =
      "You merge ordered fact lists from ONE long conversation into a single faithful fact " +
      "registry. Use ONLY the provided facts. Do not add outside knowledge, do not answer any " +
      "question, do not invent values.";
    const prompt =
      "Below are CHRONOLOGICAL fact lists (segment 1 = earliest) extracted from one long " +
      "conversation. Merge them into ONE FACT REGISTRY.\n" +
      "Rules:\n" +
      "- One entry per DISTINCT metric/topic. Do not merge different metrics; do not drop any.\n" +
      "- Each entry shows the value HISTORY in conversation order and marks the latest:\n" +
      "  - <metric>: <v1> -> <v2> -> <v3>; LATEST: <v3>\n" +
      "- A metric mentioned once shows: - <metric>: LATEST: <v1>\n" +
      "- Keep list-membership facts as: - <topic> items mentioned: <a>, <b>, <c> (count: N)\n" +
      "- Preserve concrete units and names. No commentary.\n\n" +
      `FACT LISTS (chronological):\n${segments}`;
    const res = await this.opts.provider.completeText({
      system,
      prompt,
      model,
      maxOutputTokens,
      temperature: 0,
    });
    return {
      text: res.data,
      inputTokens: res.usage.inputTokensEstimate,
      outputTokens: res.usage.outputTokensEstimate,
      latencyMs: res.usage.latencyMs,
    };
  }

  /** Map step: comprehensive chronological summary of ONE segment. */
  private async summarizeSegment(args: {
    segmentIndex: number;
    segmentCount: number;
    eventContents: string[];
    model: string;
    maxOutputTokens: number;
  }): Promise<{ text: string; inputTokens: number; outputTokens: number; latencyMs: number }> {
    const { segmentIndex, segmentCount, eventContents, model, maxOutputTokens } = args;
    const events = eventContents.map((c, i) => `[${i + 1}] ${c}`).join("\n\n");
    const system =
      "You faithfully summarize ONE segment of a long user conversation. Use ONLY the " +
      "provided events. Do not add outside knowledge, do not answer any question, do not invent.";
    const prompt =
      `This is segment ${segmentIndex + 1} of ${segmentCount} of one long conversation, in ` +
      "CHRONOLOGICAL ORDER (earliest first). Produce a COMPREHENSIVE, CHRONOLOGICAL list of " +
      "what the user brought up in THIS segment.\n" +
      "Rules:\n" +
      "- Walk the events in order; preserve that order.\n" +
      "- Include EVERY distinct topic, request, decision, or event the user raised — do NOT " +
      "omit or merge them; completeness matters.\n" +
      "- State briefly what the USER did or asked, in their framing, with concrete specifics " +
      "(names, topics, values).\n" +
      "- Output a numbered list, one entry per distinct topic/event, in order.\n" +
      "- Be faithful and complete; do NOT answer any question.\n\n" +
      `EVENTS (chronological):\n${events}`;
    const res = await this.opts.provider.completeText({
      system,
      prompt,
      model,
      maxOutputTokens,
      temperature: 0,
    });
    return {
      text: res.data,
      inputTokens: res.usage.inputTokensEstimate,
      outputTokens: res.usage.outputTokensEstimate,
      latencyMs: res.usage.latencyMs,
    };
  }

  /** Reduce step: merge ordered segment summaries into one organized memory. */
  private async mergeSegmentSummaries(args: {
    query: string;
    segmentSummaries: string[];
    model: string;
    maxOutputTokens: number;
  }): Promise<{ text: string; inputTokens: number; outputTokens: number; latencyMs: number }> {
    const { query, segmentSummaries, model, maxOutputTokens } = args;
    const segments = segmentSummaries
      .map((s, i) => `### Segment ${i + 1}\n${s}`)
      .join("\n\n");
    const system =
      "You merge ordered segment summaries of ONE long conversation into a single faithful " +
      "organized memory. Use ONLY the provided summaries. Do not add outside knowledge, do not " +
      "answer any question, do not invent.";
    const prompt =
      "Below are CHRONOLOGICAL segment summaries (segment 1 = earliest) of one long " +
      "conversation. Merge them into ONE comprehensive, chronological organized memory.\n" +
      "Rules:\n" +
      "- Preserve chronological order across segments (segment 1 earliest, last segment most recent).\n" +
      "- Include EVERY distinct topic/request/decision from EVERY segment — do NOT drop or " +
      "over-merge; this is the user's memory, completeness matters.\n" +
      "- Keep concrete specifics (names, topics, values).\n" +
      "- Output a single numbered timeline, one entry per distinct topic/event, in order.\n" +
      "- Do NOT answer any question; just organize the memory.\n\n" +
      `Focus area for emphasis (still include everything): ${query}\n\n` +
      `SEGMENT SUMMARIES (chronological):\n${segments}`;
    const res = await this.opts.provider.completeText({
      system,
      prompt,
      model,
      maxOutputTokens,
      temperature: 0,
    });
    return {
      text: res.data,
      inputTokens: res.usage.inputTokensEstimate,
      outputTokens: res.usage.outputTokensEstimate,
      latencyMs: res.usage.latencyMs,
    };
  }

  async answer(
    query: Query,
    corpus: Corpus,
    ctx: BaselineRunContext,
  ): Promise<BaselineResult> {
    const retrieval = await this.retrieveContext(query, corpus, ctx);

    // 3. Ask the answering LLM. Prompt + system come from the shared
    //    dispatcher so MCQ and free-form queries are wrapped uniformly.
    //
    //    Phase α (initial): tried `disableThinking: true` to skip Gemma 4's
    //    2-3K reasoning tokens before the `ANSWER: N` line. Measured on
    //    `phase-alpha-10q`: CSM dropped 9/10 → 8/10 (q02 + q23 regressed) on
    //    multi-option discrimination queries that genuinely needed the
    //    reasoning trace. Reverted: the answer stage KEEPS thinking enabled.
    //    Probe (binary classification, e4b) still benefits from disabling —
    //    that change stays. Keep this note here so the retired runbook doc
    //    is not needed to preserve the benchmark rationale.
    const { system, prompt } = buildPrompt(query, retrieval.contextString);
    const llm = await callLlmCached({
      provider: this.opts.provider,
      model: ctx.model,
      system,
      prompt,
      maxOutputTokens: ctx.maxOutputTokens ?? 256,
      temperature: ctx.temperature ?? 0,
      seed: ctx.seed ?? 42,
      // disableThinking intentionally NOT set — answer accuracy > latency on
      // multi-option MCQs. See phase-alpha-10q A/B above.
    });

    // 4. Parse. Apply citation fallback: if the model produced a usable
    //    answer but echoed no event IDs, fall back to what CSM retrieved
    //    — the system DID use those events even if the model didn't list
    //    them.
    const parsed = parseAnswer(query, llm.response);
    const hasAnswer =
      parsed.kind === "free-form"
        ? parsed.chosenAnswer !== null
        : parsed.chosenOption !== null;
    if (hasAnswer && parsed.citedEventIds.length === 0) {
      parsed.citedEventIds = retrieval.packedEventIds.length
        ? retrieval.packedEventIds
        : retrieval.csmRetrievedEventIds;
    }

    // Honest accounting: top-level `inputTokens` / `outputTokens` / `latencyMs`
    // must reflect the WHOLE pipeline (probes + recalls + synth + final MCQ
    // answer), not just the final call. Reporting only `llm.*` here was a real
    // bug that made CSM look 60-70% cheaper than it actually is. The full
    // breakdown stays in `meta` so the report can show both.
    return {
      answer: parsed,
      inputTokens: retrieval.pipelineCost.inputTokensEstimate + llm.inputTokens,
      outputTokens:
        retrieval.pipelineCost.outputTokensEstimate + llm.outputTokens,
      latencyMs: retrieval.pipelineCost.latencyMs + llm.latencyMs,
      model: ctx.model,
      meta: {
        ...retrieval.meta,
        // Per-stage breakdown so the report can disambiguate pipeline vs final.
        finalCallInputTokens: llm.inputTokens,
        finalCallOutputTokens: llm.outputTokens,
        finalCallLatencyMs: llm.latencyMs,
      },
    };
  }

  /**
   * The retrieval half of the baseline: CSM pipeline + retrieval-order
   * augmentation + budgeted context assembly — everything `answer()` does
   * EXCEPT the final answering-LLM call.
   *
   * This is the AMB bridge entry point. In AMB's rag mode the harness runs
   * its own answer model over the returned documents, so the internal answer
   * call was pure discarded cost there: ~7.1K input tokens and ~2.7 s per
   * query on the BEAM 100K run.
   */
  async retrieveContext(
    query: Query,
    corpus: Corpus,
    ctx: BaselineRunContext,
  ): Promise<CsmRetrieval> {
    const storage = this.getAdapter(corpus);

    // Content-derived hybrid router index (local MiniLM only; zero LLM).
    // Opt-in via CSM_ROUTER_HYBRID=1 — see resolveRouterHybrid for the gate
    // verdict; default is the byte-identical Phase-0 path.
    const routerIndex = resolveRouterHybrid()
      ? await this.getRouterIndex(corpus)
      : null;

    // 1. Drive the full CSM pipeline. `skipQueryLog: true` short-circuits
    //    the only write path on the read-only `StorageReader` interface
    //    (which our adapter doesn't implement anyway — see top-of-file).
    const askResult = await ask({
      provider: this.opts.provider,
      storage,
      query: query.question,
      skipQueryLog: true,
      routerIndex,
      // Parallel probes/recalls for hosted providers; serial for local
      // single-GPU servers (Ollama/llama-server) where concurrent fetches
      // tripped Undici's connection pool. See resolveParallelProbes.
      parallelProbes: resolveParallelProbes(this.opts.provider.name),
    });

    // 2. Convert the MemoryPacket + cited events to a context string the
    //    answering LLM can see. We prefer showing the cited events' raw
    //    content over relying on the packet's free-form summary alone:
    //    the goal is to give the answering LLM the same evidence the
    //    other baselines see, just retrieved differently.
    const citedEventIds = collectCitedEventIds(askResult.memoryPacket);
    const recalledEventIds = collectRecalledEventIds(askResult.recalls);
    // **Audit retraction**: an earlier audit pass added probe-identified
    // events as a third retrieval tier. Reverted because at filler-heavy
    // corpora the probe accepts filler shards and pollutes the context.
    // See git log / CHANGELOG for the v1→v3 retraction story.
    //
    // **T1 coverage timeline** (CSM_COVERAGE, default off → empty array):
    // the chronicle assembler's date-ordered evidence joins AFTER the
    // recall-cited tiers, so the precise LLM-cited events still pack first
    // and the timeline only widens coverage. Unlike the retracted
    // probe-tier, timeline entries are term-scored against query+foothold
    // vocabulary, not raw probe accepts — filler shards score ~0.
    const timelineEventIds = collectTimelineEventIds(askResult.memoryPacket);
    const baseRetrievalOrder = dedupeInOrder([
      ...citedEventIds,
      ...recalledEventIds,
      ...timelineEventIds,
    ]);

    // **RAG-floor augmentation** — the key insight from the q11 debug:
    //
    // The recall LLM is "smart" but conservative: it might cite only 1 event
    // when the shard has 5 relevant ones. RAG never has this problem because
    // RAG packs the top-K events directly. To match RAG's floor (and ensure
    // near-duplicate-distractor questions like q11 have enough evidence to
    // discriminate), CSM should pack at least MIN_FROM_TOP_SHARD events from
    // the router's top candidate when that candidate has genuine semantic
    // signal. Events already in baseRetrievalOrder don't double-count.
    //
    // **Threshold: router score > 4** (calibrated empirically).
    //
    // Router score = tagOverlap*2 + descMatch + nameMatch + summaryMatch +
    // recency. Each strong tag match contributes +2. score > 4 means at
    // least two genuine tag matches — the router has high confidence in the
    // shard. Lower thresholds (> 2) trigger false positives like q17
    // ("PaySwift pricing"), where the filler shard `f1-mealhaul-customers`
    // scored 4.0 on overlap with generic terms `pricing` + `launch`, but
    // wasn't actually about PaySwift. With > 4, the augmentation only fires
    // when the router has high-confidence semantic signal — when in doubt,
    // we trust the recall stage's cited events as-is rather than risk
    // injecting filler noise.
    //
    // Effect on q11 (router score 6.0, ≥ 4): augmentation fills with rest
    // of s-customers including e0032 → model gets full evidence → correct.
    // Effect on q17 (router score 4.0, NOT ≥ 4): augmentation skipped, 0
    // events packed (same as pre-audit lucky-correct) → no regression.
    const MIN_FROM_TOP_SHARD = 8;
    const RAG_FLOOR_SCORE_THRESHOLD = 4;
    // [T2 WORKTREE WIRING] Hybrid scores live on a different scale; convert
    // the lexical threshold so the floor's firing semantics are preserved
    // (lex>4 ⇔ hybrid lexical leg > wLex*satLex(4); embedding confidence can
    // also clear it, which is intended — see EXP-T2-router.md §5).
    const ragFloorThreshold = routerIndex
      ? hybridEquivalentOfLexScore(RAG_FLOOR_SCORE_THRESHOLD)
      : RAG_FLOOR_SCORE_THRESHOLD;
    let augmentedRetrievalOrder = [...baseRetrievalOrder];
    let ragFallbackFired = false;
    let ragFallbackShardId: string | null = null;
    let ragAugmentCount = 0;
    const topCandidate = askResult.candidates[0];
    if (
      topCandidate &&
      topCandidate.score > ragFloorThreshold &&
      augmentedRetrievalOrder.length < MIN_FROM_TOP_SHARD
    ) {
      const shardEvents = corpus.byShard.get(topCandidate.entry.id) ?? [];
      const alreadyIncluded = new Set(augmentedRetrievalOrder);
      for (const e of shardEvents) {
        if (alreadyIncluded.has(e.id)) continue;
        augmentedRetrievalOrder.push(e.id);
        ragAugmentCount++;
        if (augmentedRetrievalOrder.length >= MIN_FROM_TOP_SHARD) break;
      }
      if (ragAugmentCount > 0) {
        ragFallbackFired = true;
        ragFallbackShardId = topCandidate.entry.id;
      }
    }

    // **Embedding recall floor** — env-tunable via `CSM_EMBED_FLOOR_K`
    // (default 10; set `CSM_EMBED_FLOOR_K=0` to disable).
    //
    // The keyword router + probe pipeline above is precise but brittle on a
    // filler-heavy corpus. When a query is framed in first-person project
    // terms with no distinguishing proper noun ("what database backs the core
    // service?"), the keyword router cannot separate the real shard from
    // filler-company shards that share generic vocabulary — so the right shard
    // never becomes a candidate, never gets probed, and zero gold events reach
    // the answer model. In the v020-30q-t1 run this was the entire CSM accuracy
    // gap: q03/q04/q17 packed ZERO relevant events; the only 4 losses all sat
    // in the bottom retrieval-recall bucket (mean recall 0.036 vs 0.507 on the
    // 24 it answered correctly). vanilla RAG got all 4 right purely on
    // embedding similarity.
    //
    // This floor gives CSM the same recall safety net: when the pipeline
    // retrieved fewer than K events, backfill with embedding top-K over the
    // whole sampled corpus — identical retrieval to `vanillaRag` — appended
    // AFTER the pipeline's own events. Ordering matters: CSM's precise hits
    // stay first so the budgeted context packs them preferentially and
    // citation precision on the queries CSM already handles is preserved; the
    // embedding hits only fill the remaining slots on starved queries. The
    // embeddings are disk-cached per (model, content), so this reuses whatever
    // `vanillaRag` already computed. Default is 10; set `CSM_EMBED_FLOOR_K=0`
    // to disable for byte-identical replay of old runs.
    const embedFloorK = resolveEmbeddingFloorK();
    let embedFloorFired = false;
    let embedFloorCount = 0;
    let embedFloorAddedEventIds: string[] = [];
    let eventVecs: Float32Array[] | null = null;
    let queryVec: Float32Array | null = null;
    let eventIndexById: Map<string, number> | null = null;

    const ensureEmbeddings = async (): Promise<{
      eventVecs: Float32Array[];
      queryVec: Float32Array;
      eventIndexById: Map<string, number>;
    } | null> => {
      if (!eventVecs) {
        eventVecs = await embed(
          corpus.events.map((e) => e.content),
          EMBED_MODEL_NAME,
        );
      }
      if (!eventIndexById) {
        eventIndexById = new Map(corpus.events.map((e, i) => [e.id, i]));
      }
      if (!queryVec) {
        const [embeddedQuery] = await embed([query.question], EMBED_MODEL_NAME);
        queryVec = embeddedQuery ?? null;
      }
      if (!queryVec) return null;
      return { eventVecs, queryVec, eventIndexById };
    };

    if (
      Number.isFinite(embedFloorK) &&
      embedFloorK > 0 &&
      augmentedRetrievalOrder.length < embedFloorK
    ) {
      const embeddings = await ensureEmbeddings();
      if (embeddings) {
        // Pull a few extra (×3) so dedupe against already-packed events still
        // leaves enough to reach the floor.
        const topK = topKCosine(
          embeddings.queryVec,
          embeddings.eventVecs,
          embedFloorK * 3,
        );
        const rankedIds = topK
          .map((hit) => corpus.events[hit.index]?.id)
          .filter((id): id is string => Boolean(id));
        const floor = applyEmbeddingFloor(
          augmentedRetrievalOrder,
          embedFloorK,
          rankedIds,
        );
        augmentedRetrievalOrder = floor.order;
        embedFloorFired = floor.fired;
        embedFloorCount = floor.count;
        embedFloorAddedEventIds = floor.addedIds;
      }
    }

    // **Shard-local semantic expansion** - env-tunable via
    // `CSM_SHARD_EXPAND_K` (default 3; set 0 to disable) and
    // `CSM_SHARD_EXPAND_MAX` (default 16).
    //
    // The 1M-token Gemma scaling run exposed a different failure from the old
    // zero-recall bug: CSM often found the right shard, but not enough sibling
    // evidence inside that shard, so answer accuracy held while citation recall
    // fell. A global embedding floor alone is vulnerable to filler swamping as
    // the corpus grows. Once CSM has a foothold in a shard, dense retrieval
    // should operate locally inside that shard, where distractor pressure is
    // much lower. We insert those local hits immediately after the shard's
    // existing foothold so they survive context truncation ahead of unrelated
    // trailing filler events.
    const shardExpandK = resolveShardExpandK();
    const shardExpandMax = resolveShardExpandMax();
    let shardExpandFired = false;
    let shardExpandCount = 0;
    let shardExpandShardIds: string[] = [];
    if (
      Number.isFinite(shardExpandK) &&
      shardExpandK > 0 &&
      Number.isFinite(shardExpandMax) &&
      shardExpandMax > augmentedRetrievalOrder.length
    ) {
      const embeddings = await ensureEmbeddings();
      if (embeddings) {
        const lastEventIdByShard = new Map<string, string>();
        const retrievalShardIds: string[] = [];
        for (const eventId of augmentedRetrievalOrder) {
          const shardId = corpus.byId.get(eventId)?.shardId;
          if (!shardId) continue;
          lastEventIdByShard.set(shardId, eventId);
          retrievalShardIds.push(shardId);
        }

        const embedFloorShardIds = embedFloorAddedEventIds
          .map((eventId) => corpus.byId.get(eventId)?.shardId)
          .filter((id): id is string => Boolean(id));
        const seedShardIds = dedupeInOrder([
          ...embedFloorShardIds,
          ...(topCandidate ? [topCandidate.entry.id] : []),
          ...askResult.recalls.map((r) => r.shardId),
          ...askResult.candidates.map((c) => c.entry.id),
          ...retrievalShardIds,
        ]);

        const groups: ShardLocalExpansionInput[] = [];
        for (const shardId of seedShardIds) {
          const afterEventId = lastEventIdByShard.get(shardId);
          if (!afterEventId) continue;
          const shardEvents = corpus.byShard.get(shardId) ?? [];
          const indexed = shardEvents
            .map((event) => {
              const index = embeddings.eventIndexById.get(event.id);
              if (index === undefined) return null;
              const vec = embeddings.eventVecs[index];
              return vec ? { event, vec } : null;
            })
            .filter(
              (item): item is { event: BenchEvent; vec: Float32Array } =>
                item !== null,
            );
          if (indexed.length === 0) continue;

          const rankedIds = topKCosine(
            embeddings.queryVec,
            indexed.map((item) => item.vec),
            Math.min(indexed.length, shardExpandK * 4 + 4),
          )
            .map((hit) => indexed[hit.index]?.event.id)
            .filter((id): id is string => Boolean(id));
          groups.push({ shardId, afterEventId, rankedIds });
        }

        const expanded = applyShardLocalExpansion(
          augmentedRetrievalOrder,
          groups,
          shardExpandMax,
          shardExpandK,
        );
        augmentedRetrievalOrder = expanded.order;
        shardExpandFired = expanded.fired;
        shardExpandCount = expanded.count;
        shardExpandShardIds = expanded.shardIds;
      }
    }

    // **Shard-local lexical bridge** - env-tunable via
    // `CSM_LEXICAL_BRIDGE_K` (default 0/off; set >0 to enable) and
    // `CSM_LEXICAL_BRIDGE_MAX` (default 20).
    //
    // Dense retrieval is good at paraphrase but can miss exact, low-frequency
    // entities under heavy filler. Once CSM has selected a shard, run a small
    // exact-term pass inside that shard before the entity bridge below. This
    // is the local hybrid-RAG analogue: it catches foothold facts like "Mary
    // got the milk" so the next step can bridge to Mary-related updates.
    const lexicalBridgeK = resolveLexicalBridgeK();
    const lexicalBridgeMax = resolveLexicalBridgeMax();
    let lexicalBridgeFired = false;
    let lexicalBridgeCount = 0;
    let lexicalBridgeShardIds: string[] = [];
    if (
      Number.isFinite(lexicalBridgeK) &&
      lexicalBridgeK > 0 &&
      Number.isFinite(lexicalBridgeMax) &&
      lexicalBridgeMax > augmentedRetrievalOrder.length
    ) {
      const groups = buildLocalLexicalBridgeGroups(
        augmentedRetrievalOrder,
        corpus.byId,
        corpus.byShard,
        query.question,
      );
      const expanded = applyShardLocalExpansion(
        augmentedRetrievalOrder,
        groups,
        lexicalBridgeMax,
        lexicalBridgeK,
      );
      augmentedRetrievalOrder = expanded.order;
      lexicalBridgeFired = expanded.fired;
      lexicalBridgeCount = expanded.count;
      lexicalBridgeShardIds = expanded.shardIds;
    }

    // **Entity-bridge expansion** - env-tunable via `CSM_ENTITY_BRIDGE_K`
    // (default 6; set 0 to disable) and `CSM_ENTITY_BRIDGE_MAX` (default 24).
    //
    // Some external memory benchmarks (notably BABILong task 2) require a
    // bridge through an entity chain: retrieve "Mary got the milk", then also
    // retrieve later facts about Mary to answer where the milk is now. Dense
    // similarity to the original query often finds the item event but misses
    // the holder/location follow-up. This local lexical bridge pulls same-shard
    // events that mention salient entities from already-retrieved footholds.
    const entityBridgeK = resolveEntityBridgeK();
    const entityBridgeMax = resolveEntityBridgeMax();
    let entityBridgeFired = false;
    let entityBridgeCount = 0;
    let entityBridgeShardIds: string[] = [];
    if (
      Number.isFinite(entityBridgeK) &&
      entityBridgeK > 0 &&
      Number.isFinite(entityBridgeMax) &&
      entityBridgeMax > augmentedRetrievalOrder.length
    ) {
      const groups = buildEntityBridgeGroups(
        augmentedRetrievalOrder,
        corpus.byId,
        corpus.byShard,
        query.question,
      );
      const expanded = applyShardLocalExpansion(
        augmentedRetrievalOrder,
        groups,
        entityBridgeMax,
        entityBridgeK,
      );
      augmentedRetrievalOrder = expanded.order;
      entityBridgeFired = expanded.fired;
      entityBridgeCount = expanded.count;
      entityBridgeShardIds = expanded.shardIds;
    }

    const csmRetrievedEventIds = augmentedRetrievalOrder;
    const retrievalOrder = csmRetrievedEventIds;

    const contextBudget = Math.max(
      0,
      ctx.maxInputTokens - MCQ_SCAFFOLDING_TOKENS,
    );

    const { contextString, contextTokens, packedEventIds, packetTokens } =
      buildContextString({
        packet: askResult.memoryPacket,
        retrievalOrder,
        eventLookup: corpus.byId,
        budgetTokens: contextBudget,
      });

    const pipelineCost = askResult.cost ?? {
      inputTokensEstimate: 0,
      outputTokensEstimate: 0,
      estimatedUsd: 0,
      latencyMs: 0,
    };

    return {
      contextString,
      contextTokens,
      packedEventIds,
      packetTokens,
      csmRetrievedEventIds,
      pipelineCost,
      meta: {
        csmRetrievedEventIds,
        packedEventIds,
        packetTokens,
        contextTokens,
        routerHits: askResult.candidates.length,
        probeCount: askResult.probes.length,
        probeAcceptCount: askResult.probes.filter((p) => p.knows).length,
        recallCount: askResult.recalls.length,
        candidateShardIds: askResult.candidates.map((c) => c.entry.id),
        probedShardIds: askResult.probes.map((p) => p.shardId),
        recalledShardIds: askResult.recalls.map((r) => r.shardId),
        ragFallbackFired,
        ragFallbackShardId,
        ragAugmentCount,
        embedFloorFired,
        embedFloorCount,
        shardExpandFired,
        shardExpandCount,
        shardExpandShardIds,
        lexicalBridgeFired,
        lexicalBridgeCount,
        lexicalBridgeShardIds,
        entityBridgeFired,
        entityBridgeCount,
        entityBridgeShardIds,
        coverageTimelineCount: timelineEventIds.length,
        coverageFired: timelineEventIds.length > 0,
        // Full timeline entries (date/eventRef/line) so the AMB bridge can
        // render its evidence capsule from the core's chronicle instead of
        // re-deriving one with the legacy regex heuristics.
        coverageTimeline: askResult.memoryPacket.timeline ?? [],
        routerTopScore: askResult.candidates[0]?.score ?? 0,
        routerHybrid: Boolean(routerIndex), // [T2 WORKTREE WIRING]
        packetCost: askResult.cost,
        pipelineInputTokens: pipelineCost.inputTokensEstimate,
        pipelineOutputTokens: pipelineCost.outputTokensEstimate,
        pipelineLatencyMs: pipelineCost.latencyMs,
        truncated: packedEventIds.length < retrievalOrder.length,
      },
    };
  }

  private getAdapter(corpus: Corpus): InMemoryStorageReader {
    const hit = this.adapterCache.get(corpus);
    if (hit) return hit;
    const adapter = new InMemoryStorageReader(corpus);
    this.adapterCache.set(corpus, adapter);
    return adapter;
  }

  /** [T2 WORKTREE WIRING — merge-window material] Build the hybrid router
   *  index for a corpus: TF-IDF descriptor terms + per-shard MiniLM
   *  centroids from per-event embeddings (same disk-cache keys the
   *  embed-floor / vanillaRag paths already populate). O(events) once per
   *  corpus; zero LLM calls. The merge window should lift this into a shared
   *  src/eval helper so the AMB bridge reuses it verbatim. */
  private getRouterIndex(corpus: Corpus): Promise<RouterIndex> {
    const hit = this.routerIndexCache.get(corpus);
    if (hit) return hit;
    const built = (async () => {
      const sources = [...corpus.byShard.entries()].map(([shardId, events]) => ({
        shardId,
        events: events.map((e) => ({ content: e.content, tags: e.tags })),
      }));
      const descriptors = deriveShardDescriptors(sources);
      const allVecs = await embed(
        corpus.events.map((e) => e.content),
        EMBED_MODEL_NAME,
      );
      const vecByEventId = new Map<string, Float32Array>();
      corpus.events.forEach((e, i) => vecByEventId.set(e.id, allVecs[i]!));
      // Retrieval units (CSM_RETRIEVAL_UNITS, default 0 = off = legacy
      // whole-shard centroid). When on, the router scores a shard by its BEST
      // passage instead of its mean, so a preference stated in one span of an
      // otherwise-unrelated document is no longer averaged into noise.
      // Shards themselves are untouched, so all downstream budgets keep their
      // meaning — see src/core/retrievalUnit.ts for why that matters.
      const unitSize = resolveUnitSize();
      const shards = [...corpus.byShard.entries()].map(([shardId, events]) => {
        const vecs = events
          .map((e) => vecByEventId.get(e.id))
          .filter((v): v is Float32Array => Boolean(v));
        const base = {
          shardId,
          terms: descriptors.get(shardId)?.terms ?? [],
          centroid: centroidOf(vecs),
        };
        if (unitSize <= 0 || vecs.length === 0) return base;
        const units = partitionIntoUnits(shardId, vecs.length, { targetSize: unitSize });
        const unitCentroids = units
          .map((u) => centroidOf(vecs.slice(u.start, u.end)))
          .filter((v): v is Float32Array => Boolean(v));
        return unitCentroids.length > 0 ? { ...base, unitCentroids } : base;
      });
      return buildRouterIndex({
        shards,
        embed: (texts) => embed(texts, EMBED_MODEL_NAME),
        model: EMBED_MODEL_NAME,
      });
    })();
    this.routerIndexCache.set(corpus, built);
    return built;
  }
}

// ─── In-memory adapter ──────────────────────────────────────────────────────

/**
 * Read-only `StorageReader` that exposes a benchmark `Corpus` to the CSM
 * pipeline as if it were a normal on-disk shard layout.
 *
 * Construction rules:
 * - One synthetic shard per distinct `BenchEvent.shardId`.
 * - One snapshot per shard, fixed at `S001`.
 * - Snapshot `summary` is a deterministic shard label so the router and
 *   probe both have something to chew on. `indexTerms` is built from the
 *   union of event tags so the router's tag-overlap scoring still fires
 *   when the synthetic shards expose tagged content.
 * - Directory `tags` mirrors the union of event tags (lowercased); `name`
 *   and `description` derive from `shardId`. This is deliberately thin —
 *   we don't want to hand the router an unfair semantic shortcut.
 *
 * No write methods are implemented (`appendQueryRun` is intentionally
 * omitted). Any attempt to mutate via this adapter is therefore a type
 * error, not a runtime one — which is exactly what we want for the
 * read-only invariant under `tests/mutationSafety.test.ts`.
 */
class InMemoryStorageReader implements StorageReader {
  private readonly directory: MemoryDirectory;
  private readonly snapshots: Map<string, MemoryShardSnapshot>;

  constructor(corpus: Corpus) {
    const { directory, snapshots } = buildShardsFromCorpus(corpus);
    this.directory = directory;
    this.snapshots = snapshots;
  }

  async loadDirectory(): Promise<MemoryDirectory> {
    return this.directory;
  }

  async loadSnapshot(
    shardId: string,
    snapshotId: string,
  ): Promise<MemoryShardSnapshot | null> {
    const key = `${shardId}@${snapshotId}`;
    return this.snapshots.get(key) ?? null;
  }
}

/**
 * Exported so component benches (`scripts/bench-router.ts`) can drive the
 * router in isolation against the exact directory the pipeline builds. Export
 * only — behaviour is unchanged.
 *
 * NOTE for anyone tuning the router: on BEAM every entry below is boilerplate.
 * `name` is the shard id, `description` is "Benchmark shard <id>", `summary` is
 * "Synthetic shard <id> (n events)." and `tags` is the same four-tag union for
 * every shard of a user. `scoreEntryLexical` scores tags, description, name and
 * summary — so on BEAM the lexical leg has no query signal at all and selection
 * falls through to recency/directory order.
 */
export function buildShardsFromCorpus(corpus: Corpus): {
  directory: MemoryDirectory;
  snapshots: Map<string, MemoryShardSnapshot>;
} {
  const entries: MemoryDirectoryEntry[] = [];
  const snapshots = new Map<string, MemoryShardSnapshot>();
  const createdAt = "2024-01-01T00:00:00.000Z";
  const snapshotId = "S001";

  /**
   * Real, query-scorable descriptors instead of boilerplate.
   *
   * `deriveShardDescriptors` (TF-IDF over sibling shards) already existed and
   * was already used to build the router INDEX — but its terms were never
   * written into the directory entries, which is what `scoreEntryLexical`
   * actually reads. So the lexical router scored `name` = shard id,
   * `description` = "Benchmark shard <id>", `summaryShort` = "Synthetic shard
   * <id> (n events)." and one identical tag union per user, i.e. no query
   * signal at all, and `selectCandidates` fell through to its
   * `status === "active"` passthrough.
   *
   * Measured in `docs/experiments/EXP-router-component-bench.md`: with many
   * shards per user (the upper-ladder regime) this lifts mean gold-facet
   * coverage at a fixed 32-event budget from 0.457 to 0.676 — 54% -> 80% of the
   * oracle — for pure string work, no embeddings and no LLM.
   *
   * Default OFF. 100K is saturated (8 of 8.5 shards probed), so this cannot
   * help there and must not silently perturb the frozen baseline.
   */
  const enrich = resolveShardDescriptors();
  const descriptors = enrich
    ? deriveShardDescriptors(
        [...corpus.byShard.entries()].map(([shardId, events]) => ({
          shardId,
          events: events.map((e) => ({ content: e.content, tags: e.tags })),
        })),
      )
    : null;

  // Sort shard IDs so the directory order is deterministic — keeps the
  // router's tie-break behaviour stable across runs (cache-friendly).
  const shardIds = [...corpus.byShard.keys()].sort();

  for (const shardId of shardIds) {
    const events = corpus.byShard.get(shardId) ?? [];
    // Stable event order: by id ascending. The corpus's `byShard` already
    // tends to be in insertion order, but explicit sort makes the cache
    // key independent of map iteration semantics.
    const sortedEvents = [...events].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    const memoryEvents: MemoryEvent[] = sortedEvents.map((e) =>
      toMemoryEvent(e, createdAt),
    );
    const derived = descriptors?.get(shardId)?.terms ?? [];
    const tagsUnion = dedupeInOrder([
      ...sortedEvents.flatMap((e) => e.tags ?? []).map((t) => t.toLowerCase()),
      // Tags carry the heaviest lexical weight (x2 in scoreEntryLexical), so
      // this is where the derived terms earn the most.
      ...derived,
    ]);
    const summary =
      derived.length > 0
        ? `${firstDatedHeader(sortedEvents) ?? ""}Topics: ${derived.join(", ")}.`
        : `Synthetic shard ${shardId} (${memoryEvents.length} events).`;

    const snapshot: MemoryShardSnapshot = {
      shardId,
      snapshotId,
      systemPrompt: SHARD_SYSTEM_PROMPT,
      summary,
      events: memoryEvents,
      indexTerms: tagsUnion,
      createdAt,
      parentSnapshotId: null,
    };
    snapshots.set(`${shardId}@${snapshotId}`, snapshot);

    const tokens = estimateEventsTokens(memoryEvents);
    entries.push({
      id: shardId,
      name: derived.length > 0 ? `${shardId} ${derived.slice(0, 6).join(" ")}` : shardId,
      description: derived.length > 0 ? summary : `Benchmark shard ${shardId}`,
      tags: tagsUnion,
      createdAt,
      updatedAt: createdAt,
      status: "active",
      snapshotId,
      tokenCountEstimate: tokens,
      contextLimitEstimate: SYNTHETIC_CONTEXT_LIMIT,
      fullnessPct: round2(fullnessPct(tokens, SYNTHETIC_CONTEXT_LIMIT)),
      summaryShort: summary,
      knownConflicts: [],
      parentId: null,
      children: [],
      trustLevel: "imported_doc",
      staleness: "current",
    });
  }

  return { directory: { version: 1, entries }, snapshots };
}

function toMemoryEvent(event: BenchEvent, createdAt: string): MemoryEvent {
  return {
    eventId: event.id,
    role: "user",
    content: event.content,
    createdAt: event.timestamp ?? createdAt,
    importance: event.isCore ? 0.8 : 0.4,
    tags: event.tags ?? [],
  };
}

// ─── Context assembly ───────────────────────────────────────────────────────

/**
 * Build the MCQ context string. Strategy:
 * 1. Lead with a compact "MEMORY PACKET" header (summary + key claims +
 *    conflicts) so the answering LLM sees CSM's synthesised view.
 * 2. Follow with raw event content for the retrieved events, in priority
 *    order (cited > recalled). Truncate by dropping trailing events until
 *    the assembled context fits the input-token budget.
 *
 * Returns the actual list of event IDs that survived truncation so the
 * baseline can fall back to them when the LLM omits citations.
 */
function buildContextString(args: {
  packet: MemoryPacket;
  retrievalOrder: string[];
  eventLookup: Map<string, BenchEvent>;
  budgetTokens: number;
}): {
  contextString: string;
  contextTokens: number;
  packedEventIds: string[];
  packetTokens: number;
} {
  const { packet, retrievalOrder, eventLookup, budgetTokens } = args;
  const header = formatPacketHeader(packet);
  const packetTokens = estimateTokens(header);

  let runningTokens = packetTokens;
  const packedLines: string[] = [];
  const packedEventIds: string[] = [];

  for (const eventId of retrievalOrder) {
    const ev = eventLookup.get(eventId);
    if (!ev) continue;
    const line = `[${ev.id}] ${ev.content}\n`;
    const lineTokens = estimateTokens(line);
    if (runningTokens + lineTokens > budgetTokens) break;
    packedLines.push(line);
    packedEventIds.push(ev.id);
    runningTokens += lineTokens;
  }

  const evidenceBlock = packedLines.length
    ? `CITED EVENTS:\n${packedLines.join("")}`
    : "CITED EVENTS:\n(none — CSM did not retrieve supporting events)\n";

  const contextString = `${header}\n${evidenceBlock}`;
  return {
    contextString,
    contextTokens: runningTokens,
    packedEventIds,
    packetTokens,
  };
}

function formatPacketHeader(packet: MemoryPacket): string {
  const claims = packet.keyClaims.length
    ? packet.keyClaims
        .map(
          (c) =>
            `- ${c.claim} (sources: ${c.sources.join(", ")}, conf=${c.confidence.toFixed(2)})`,
        )
        .join("\n")
    : "- (no key claims surfaced by CSM)";
  const conflicts = packet.conflicts.length
    ? `\nCONFLICTS:\n${packet.conflicts.map((c) => `- ${c}`).join("\n")}`
    : "";
  const caveats = packet.caveats.length
    ? `\nCAVEATS:\n${packet.caveats.map((c) => `- ${c}`).join("\n")}`
    : "";
  // T1 coverage: date-ordered cited timeline (absent unless CSM_COVERAGE
  // produced one). This is the in-context analogue of the AMB evidence
  // capsule — the answer model sees order + dates explicitly instead of
  // inferring them from raw event prose.
  const timeline = packet.timeline?.length
    ? `\nTIMELINE (date-ordered evidence):\n${packet.timeline
        .map((t) => `- ${t.date ?? "undated"} [${t.eventRef}] ${t.line}`)
        .join("\n")}`
    : "";
  return [
    "MEMORY PACKET (from CSM pipeline):",
    `SUMMARY: ${packet.summary}`,
    `KEY CLAIMS:\n${claims}`,
    conflicts,
    caveats,
    timeline,
  ]
    .filter((s) => s.length > 0)
    .join("\n");
}

// ─── helpers ────────────────────────────────────────────────────────────────

function collectCitedEventIds(packet: MemoryPacket): string[] {
  const out: string[] = [];
  for (const claim of packet.keyClaims) {
    for (const src of claim.sources) {
      // sources are formatted as "shard_id@snapshot_id" or
      // "shard_id@snapshot_id:event_id". Extract the trailing event id.
      const ix = src.lastIndexOf(":");
      if (ix === -1) continue;
      const tail = src.slice(ix + 1).trim();
      if (tail.length > 0) out.push(tail);
    }
  }
  return dedupeInOrder(out);
}

function collectRecalledEventIds(
  recalls: Array<{ claims: Array<{ support: string[] }> }>,
): string[] {
  const out: string[] = [];
  for (const r of recalls) {
    for (const claim of r.claims) {
      for (const id of claim.support) {
        out.push(id);
      }
    }
  }
  return dedupeInOrder(out);
}

function dedupeInOrder(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of items) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

const BRIDGE_STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "answer",
  "before",
  "being",
  "could",
  "does",
  "from",
  "have",
  "into",
  "only",
  "question",
  "that",
  "their",
  "there",
  "this",
  "using",
  "what",
  "when",
  "where",
  "which",
  "with",
]);

function extractBridgeTerms(text: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/[A-Za-z][A-Za-z'-]{2,}/g)) {
    const raw = match[0]!;
    const term = raw.toLowerCase().replace(/'s$/g, "");
    if (term.length < 4 && raw[0] !== raw[0]?.toUpperCase()) continue;
    if (BRIDGE_STOP_WORDS.has(term)) continue;
    if (seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms.slice(0, 12);
}

function bridgeScore(content: string, terms: string[]): number {
  const low = content.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const re = new RegExp(`\\b${escapeRegExp(term)}\\b`, "i");
    if (re.test(low)) score++;
  }
  return score;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * Pack ordered event contents into chunks each ≤ `maxTokens` (estimated),
 * preserving order. A single event larger than the budget gets its own chunk
 * (never split — keeps a turn intact). Used by the hierarchical Observation to
 * fit each map call inside the model context window.
 */
export function chunkByTokenBudget(contents: string[], maxTokens: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentTokens = 0;
  for (const content of contents) {
    const tokens = estimateTokens(content);
    if (current.length > 0 && currentTokens + tokens > maxTokens) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(content);
    currentTokens += tokens;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Map `fn` over `items` with at most `limit` in flight at once, preserving
 * input order in the results. Bounds the concurrent LLM calls of the
 * Observation map step so a long conversation's many chunks don't burst the
 * provider's rate limit all at once.
 *
 * Fails fast: when any item's `fn` rejects, the remaining workers stop
 * claiming new items (at most `limit - 1` already-in-flight calls complete).
 * Without this, one failed chunk mid-build would reject the caller while the
 * surviving workers silently burned through every remaining chunk — at the
 * 10M tier that is ~10M discarded input tokens per incident (2026-06-24 audit).
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let aborted = false;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const worker = async (): Promise<void> => {
    while (!aborted) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index]!, index);
      } catch (err) {
        aborted = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
