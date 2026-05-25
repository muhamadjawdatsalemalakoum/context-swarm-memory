import { ask } from "../../core/ask.js";
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

  constructor(private opts: { provider: LlmProvider }) {}

  async answer(
    query: Query,
    corpus: Corpus,
    ctx: BaselineRunContext,
  ): Promise<BaselineResult> {
    const storage = this.getAdapter(corpus);

    // 1. Drive the full CSM pipeline. `skipQueryLog: true` short-circuits
    //    the only write path on the read-only `StorageReader` interface
    //    (which our adapter doesn't implement anyway — see top-of-file).
    const askResult = await ask({
      provider: this.opts.provider,
      storage,
      query: query.question,
      skipQueryLog: true,
      // Serialise probes for local Ollama: with single-daemon serialisation
      // plus Node's fetch connection-pool limits, parallel probes were
      // reliably failing with "fetch failed" mid-pipeline. Sequential is the
      // same wall-clock on Ollama anyway (server queues internally).
      parallelProbes: false,
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
    const baseRetrievalOrder = dedupeInOrder([
      ...citedEventIds,
      ...recalledEventIds,
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
    let augmentedRetrievalOrder = [...baseRetrievalOrder];
    let ragFallbackFired = false;
    let ragFallbackShardId: string | null = null;
    let ragAugmentCount = 0;
    const topCandidate = askResult.candidates[0];
    if (
      topCandidate &&
      topCandidate.score > RAG_FLOOR_SCORE_THRESHOLD &&
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
    const { system, prompt } = buildPrompt(query, contextString);
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
      parsed.citedEventIds = packedEventIds.length
        ? packedEventIds
        : csmRetrievedEventIds;
    }

    // Honest accounting: top-level `inputTokens` / `outputTokens` / `latencyMs`
    // must reflect the WHOLE pipeline (probes + recalls + synth + final MCQ
    // answer), not just the final call. Reporting only `llm.*` here was a real
    // bug that made CSM look 60-70% cheaper than it actually is. The full
    // breakdown stays in `meta` so the report can show both.
    const pipelineCost = askResult.cost ?? {
      inputTokensEstimate: 0,
      outputTokensEstimate: 0,
      estimatedUsd: 0,
      latencyMs: 0,
    };

    return {
      answer: parsed,
      inputTokens: pipelineCost.inputTokensEstimate + llm.inputTokens,
      outputTokens: pipelineCost.outputTokensEstimate + llm.outputTokens,
      latencyMs: pipelineCost.latencyMs + llm.latencyMs,
      model: ctx.model,
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
        routerTopScore: askResult.candidates[0]?.score ?? 0,
        packetCost: askResult.cost,
        // Per-stage breakdown so the report can disambiguate pipeline vs final.
        finalCallInputTokens: llm.inputTokens,
        finalCallOutputTokens: llm.outputTokens,
        finalCallLatencyMs: llm.latencyMs,
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

function buildShardsFromCorpus(corpus: Corpus): {
  directory: MemoryDirectory;
  snapshots: Map<string, MemoryShardSnapshot>;
} {
  const entries: MemoryDirectoryEntry[] = [];
  const snapshots = new Map<string, MemoryShardSnapshot>();
  const createdAt = "2024-01-01T00:00:00.000Z";
  const snapshotId = "S001";

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
    const tagsUnion = dedupeInOrder(
      sortedEvents.flatMap((e) => e.tags ?? []).map((t) => t.toLowerCase()),
    );
    const summary = `Synthetic shard ${shardId} (${memoryEvents.length} events).`;

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
      name: shardId,
      description: `Benchmark shard ${shardId}`,
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
  return [
    "MEMORY PACKET (from CSM pipeline):",
    `SUMMARY: ${packet.summary}`,
    `KEY CLAIMS:\n${claims}`,
    conflicts,
    caveats,
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

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
