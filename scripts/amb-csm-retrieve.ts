import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { estimateTokens } from "../src/core/tokenBudget.js";
import { CsmBaseline } from "../src/eval/baselines/csm.js";
import {
  coverageRerankAndPack,
  greedyCoverageOrder,
  resolveRerankParams,
} from "../src/eval/ambReturnRank.js";
import type { BenchEvent, Corpus } from "../src/eval/corpus.js";
import type { FreeFormQuery } from "../src/eval/mcq.js";
import { createProvider } from "../src/providers/index.js";
import { loadLocalEnv } from "../src/utils/loadEnv.js";

export interface AmbDocument {
  id: string;
  content: string;
  user_id?: string | null;
  timestamp?: string | null;
  context?: string | null;
}

export interface AmbRetrieveRequest {
  query: string;
  k?: number;
  user_id?: string | null;
  query_timestamp?: string | null;
}

export interface AmbBridgeOptions {
  model: string;
  modelContext: number;
  maxOutputTokens: number;
  withInternalAnswer: boolean;
}

export interface AmbRetrievePayload {
  documents: AmbDocument[];
  raw_response: Record<string, unknown>;
}

export interface AmbQueryIntent {
  broadSummary: boolean;
  temporal: boolean;
  contradiction: boolean;
  countLike: boolean;
  userCentric: boolean;
  abstentionRisk: boolean;
}

interface TemporalDateAnchor {
  event: BenchEvent;
  dateText: string;
  timeMs: number;
  score: number;
}

interface Args {
  storeDir: string;
  requestPath: string;
  model: string;
  modelContext: number;
  maxOutputTokens: number;
  /** A/B switch: run the legacy path that also computes CSM's internal final
   *  answer (which AMB discards in rag mode). Default false = retrieve-only. */
  withInternalAnswer: boolean;
}

async function main(): Promise<void> {
  // The AMB provider spawns this script with cwd = CSM_REPO_DIR, so pick up
  // the CSM repo's .env (provider, API key, model) exactly like the CLI does.
  // Vars already exported by the AMB process still win. Without this, a
  // missing shell export silently fell back to MockProvider — which must
  // never be mistaken for a real benchmark retrieval (see llm_provider in
  // the output, and the hard guard in createBridgeProvider).
  loadLocalEnv();
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.CSM_MODEL) process.env.CSM_MODEL = args.model;

  const [documents, request] = await Promise.all([
    readDocumentsJsonl(join(args.storeDir, "documents.jsonl")),
    readRequest(args.requestPath),
  ]);
  const scopedDocs = scopeDocuments(documents, request.user_id);

  if (scopedDocs.length === 0) {
    writeJson(emptyAmbPayload("no_documents_in_scope"));
    return;
  }

  const provider = createBridgeProvider();
  const payload = await executeAmbRetrieve({
    baseline: new CsmBaseline({ provider }),
    providerName: provider.name,
    corpus: buildCorpus(scopedDocs),
    request,
    opts: args,
  });
  writeJson(payload);
}

export function scopeDocuments(
  documents: AmbDocument[],
  userId?: string | null,
): AmbDocument[] {
  return userId ? documents.filter((doc) => doc.user_id === userId) : documents;
}

export function emptyAmbPayload(reason: string): AmbRetrievePayload {
  return { documents: [], raw_response: { reason } };
}

/** Provider factory with the benchmark-integrity guard: a missing key or
 *  provider config falls back to MockProvider, whose instant keyword results
 *  must never be mistaken for a real retrieval row. Opt in explicitly for
 *  plumbing smokes via CSM_AMB_ALLOW_MOCK=1. */
export function createBridgeProvider(): ReturnType<typeof createProvider> {
  const provider = createProvider();
  if (provider.name === "mock" && !isTruthyEnv(process.env.CSM_AMB_ALLOW_MOCK)) {
    throw new Error(
      "AMB bridge resolved the mock provider (no CSM_PROVIDER/API key in env or .env). " +
        "Refusing to produce benchmark rows from mock retrieval. Set CSM_AMB_ALLOW_MOCK=1 to override for plumbing tests.",
    );
  }
  return provider;
}

/** The shared core of the AMB bridge: run CSM retrieval over a pre-built
 *  corpus and shape the response AMB expects. Used by the one-shot script
 *  (per-query process) and the warm server (`scripts/amb-csm-server.ts`,
 *  ingest once / query many). */
export async function executeAmbRetrieve(input: {
  baseline: CsmBaseline;
  providerName: string;
  corpus: Corpus;
  request: AmbRetrieveRequest;
  opts: AmbBridgeOptions;
  /** Pre-built ingestion-time organized-memory ("Observation") for this user
   *  scope (synthesized once over the FULL conversation at write time, cached).
   *  When present, it is returned verbatim as the primary memory and the raw
   *  events are reduced — the Hindsight/RAPTOR/Honcho write-time pattern. The
   *  warm server only passes it for summary-intent queries. */
  observation?: string;
  /** LLM cost of the observation build, present ONLY on the query that paid it
   *  (cache hits pass null). Added to this query's token/latency accounting so
   *  the amortized write-time organization cost is visible in the payload and
   *  the telemetry sidecar — the repo's honest-accounting convention. */
  observationBuildCost?: {
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    chunks: number;
  } | null;
  /** Pre-built write-time FACT REGISTRY (metric value histories, LATEST marked)
   *  for this user scope. The warm server passes it only for aggregation-intent
   *  queries. Same contract as `observation`. */
  factRegistry?: string;
  /** Build cost of the fact registry — same exactly-once attribution contract
   *  as observationBuildCost. */
  factBuildCost?: {
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    chunks: number;
  } | null;
}): Promise<AmbRetrievePayload> {
  const {
    baseline,
    providerName,
    corpus,
    request,
    opts,
    observation,
    observationBuildCost,
    factRegistry,
    factBuildCost,
  } = input;
  const query: FreeFormQuery = {
    kind: "free-form",
    id: "amb-request",
    question: request.query,
    correctAnswer: "unused",
    relevantEventIds: [],
  };

  const runCtx = {
    maxInputTokens: opts.modelContext,
    model: opts.model,
    maxOutputTokens: opts.maxOutputTokens,
    temperature: 0,
    seed: 42,
  };

  // Default is retrieve-only: in AMB rag mode the harness answers with its
  // own model, so CSM's internal answer call was pure discarded cost
  // (~7.1K input tokens + ~2.7 s per query on the BEAM 100K run).
  let meta: Record<string, unknown>;
  let inputTokens: number;
  let outputTokens: number;
  let latencyMs: number;
  let mode: string;
  let note: string;
  if (opts.withInternalAnswer) {
    const result = await baseline.answer(query, corpus, runCtx);
    meta = (result.meta ?? {}) as Record<string, unknown>;
    inputTokens = result.inputTokens;
    outputTokens = result.outputTokens;
    latencyMs = result.latencyMs;
    mode = "retrieve-via-csm-baseline";
    note =
      "A/B bridge: CSM retrieval is exposed to AMB; the internal final answer call is computed and discarded.";
  } else {
    const retrieval = await baseline.retrieveContext(query, corpus, runCtx);
    meta = retrieval.meta;
    inputTokens = retrieval.pipelineCost.inputTokensEstimate;
    outputTokens = retrieval.pipelineCost.outputTokensEstimate;
    latencyMs = retrieval.pipelineCost.latencyMs;
    mode = "retrieve-only";
    note =
      "Retrieve-only bridge: CSM retrieval is exposed to AMB; no internal answer call is made (AMB's answer model owns answering in rag mode).";
  }

  const retrievedEventIds = asStringArray(meta.csmRetrievedEventIds);
  const packedEventIds = asStringArray(meta.packedEventIds);
  // ID-namespace repair (CSM_AMB_ID_REPAIR=1, default OFF — official defaults
  // untouched).
  //
  // `corpus.byId` is keyed `"<docId>#<turn>"` (see buildCorpus/documentToEvents).
  // `csmRetrievedEventIds` is usually in that form, but when the packet's
  // synthesis-cited tier leads it can arrive BARE ("turn-0"), because
  // collectCitedEventIds() parses "shard@snapshot:event" and keeps only the
  // trailing event id, dropping the shard qualifier. Bare ids resolve against
  // nothing, so `outDocs` comes back EMPTY and the answer model receives only
  // the capsule — observed live on the BEAM slice as retrieved=159 -> docs=1,
  // i.e. ~99% of retrieved evidence silently discarded. It is worst on the
  // multi-shard, high-recall queries that dominate larger units, which is the
  // shape of CSM's degradation from 100K to 10M.
  //
  // Do NOT "fix" this by suffix-matching a bare id: every document in a unit has
  // a "turn-0", so that would attach evidence from an arbitrary shard. Instead
  // fall back to `packedEventIds`, which is already correctly qualified and is
  // the same underlying selection.
  // The list is MIXED: measured live, a failing query had 103 retrieved ids of
  // which 33 were bare. Choosing between whole lists is not enough, because the
  // bare ids sort FIRST (the synthesis-cited tier leads baseRetrievalOrder), so
  // the top-K slice selects exactly the unresolvable ones and outDocs empties.
  // Drop unresolvable ids in place, preserving order, and top up from the
  // already-qualified packed list.
  const idRepairActive = process.env.CSM_AMB_ID_REPAIR === "1";
  const baseIds = idRepairActive
    ? dedupeInOrder([
        ...retrievedEventIds.filter((id) => corpus.byId.has(id)),
        ...packedEventIds.filter((id) => corpus.byId.has(id)),
      ])
    : retrievedEventIds.length > 0
      ? retrievedEventIds
      : packedEventIds;
  const intent = detectAmbQueryIntent(request.query);

  // T1 migration step 2 ("bridge consumes core"): when the core's coverage
  // chronicle fired, its retrieval order already IS the coverage selection —
  // cited events first, then the date-ordered, term-scored timeline. The
  // legacy heuristics were measured fighting it (BEAM-slice leg C, 2026-06-10:
  // retrieved gold coverage +0.18 in both losing categories while the legacy
  // k-cut kept returned coverage flat), so coverage queries now trust the
  // core order at the k-cut and render the capsule from packet.timeline.
  // Point queries keep the legacy path byte-identical.
  const coverageTimeline = parseTimelineEntries(meta.coverageTimeline);
  const coverageFired = meta.coverageFired === true && coverageTimeline.length > 0;
  // Coverage rerank (CSM_AMB_COVERAGE_RERANK=1, default OFF — official defaults
  // untouched): replace the RETURN_K count-slice with a coverage-ranked,
  // token-budget-packed slice so already-retrieved gold-facet breadth survives
  // into the answer-visible context. Validated token-free on the BEAM slice
  // (src/eval/ambReturnRank.ts header; scripts/measure-return-strategies.ts).
  // Synthesis engine (CSM_AMB_SYNTH_MEMORY): organized-memory-PRIMARY mode. The
  // organized memory carries the full breadth, so raw events are sharply reduced
  // (Hindsight's formula = organized memory, not a raw dump) to avoid drowning
  // it. Count via CSM_AMB_SYNTH_RAW_DOCS (default 10).
  const synthActive =
    synthMemoryActive() && (intent.broadSummary || intent.temporal || intent.contradiction);
  // Ingestion-time Observation (pre-built, passed by the warm server for summary
  // intent). Like synth mode it leads with organized memory + reduced raw docs,
  // but the organization was done at WRITE time over the FULL conversation.
  const obsActive = typeof observation === "string" && observation.length > 0;
  // Write-time fact registry (passed by the warm server for aggregation intent).
  const factActive = typeof factRegistry === "string" && factRegistry.length > 0;

  // Coverage ORDER applied once, up front, so every downstream return path
  // slices from coverage order instead of raw retrieval order.
  //
  // Previously the reranker was reachable on exactly ONE path (coverageFired &&
  // flag && !synth && !obs && !fact); the synth/obs/fact path hard-cut at
  // .slice(0, SYNTH_RAW_DOCS) and the remaining coverage path at
  // .slice(0, resolveAmbReturnMax) — both in retrieval order.
  //
  // The measured effect is ORDERING, not size: paired and deterministic on the
  // 100K slice at EQUAL token spend, coverage order beats retrieval order by
  // +8.2 pts on event_ordering (14W/0L/26T) and +6.9 pts on summarization
  // (14W/5L/21T). So reorder here and leave every path's own budget/count alone.
  //
  // Still gated on CSM_AMB_COVERAGE_RERANK (default OFF) — official numbers are
  // untouched until the paid answer+judge gate confirms the proxy converts.
  // selectAmbEvidenceIds() is deliberately NOT fed the reordered list: it has
  // its own selection logic that may depend on retrieval order.
  const rerankParams = resolveRerankParams({
    reasoning: intent.temporal || intent.contradiction,
    budgetTokens: parsePositiveInt(process.env.CSM_AMB_RETURN_TOKENS, 16000),
  });
  const orderedBaseIds = coverageRerankActive()
    ? greedyCoverageOrder(
        dedupeInOrder(baseIds),
        (id) => corpus.byId.get(id)?.content ?? "",
        request.query,
        rerankParams.queryWeight,
        rerankParams.normPow,
      )
    : baseIds;

  const ids = synthActive || obsActive || factActive
    ? dedupeInOrder(orderedBaseIds).slice(0, parsePositiveInt(process.env.CSM_AMB_SYNTH_RAW_DOCS, 10))
    : coverageFired
      ? coverageRerankActive()
        ? coverageRerankAndPack(
            dedupeInOrder(orderedBaseIds),
            (id) => corpus.byId.get(id)?.content ?? "",
            request.query,
            rerankParams,
          )
        : dedupeInOrder(orderedBaseIds).slice(0, resolveAmbReturnMax(request.k ?? 10, intent))
      : selectAmbEvidenceIds(baseIds, corpus, request.query, intent, request.k ?? 10);

  const outDocs = ids
    .map((id) => corpus.byId.get(id))
    .filter((event): event is BenchEvent => Boolean(event))
    .map((event) => ({
      id: event.id,
      content: event.content,
      user_id: request.user_id ?? null,
      timestamp: event.timestamp ?? null,
      context: `CSM retrieved from shard ${event.shardId}`,
    }));
  // Synthesis engine (CSM_AMB_SYNTH_MEMORY=1, default OFF): for synthesis-heavy
  // intents, replace the weak deterministic capsule with an LLM-organized
  // chronological "organized memory" — the pre-digested view that lets the
  // answer model report rather than synthesize from a raw event pile (how
  // Hindsight wins summarization / event_ordering). The raw events still follow.
  let capsule: AmbDocument | null;
  if (factActive) {
    // Write-time fact registry: value histories with LATEST markers, so
    // aggregation questions combine CURRENT values instead of stale ones.
    if (factBuildCost) {
      inputTokens += factBuildCost.inputTokens;
      outputTokens += factBuildCost.outputTokens;
      latencyMs += factBuildCost.latencyMs;
    }
    capsule = {
      id: "csm-fact-registry",
      content:
        "CSM fact registry — every metric/topic the user stated, with its value history in " +
        "conversation order and the LATEST value marked (source-derived; no gold answers or " +
        "rubric used). For questions that combine or total values across projects/sessions, " +
        "use the LATEST value of each metric unless the question explicitly asks about earlier " +
        "values. The raw events follow for detail.\n\n" +
        factRegistry,
      user_id: request.user_id ?? null,
      timestamp: null,
      context: "CSM fact registry",
    };
  } else if (obsActive) {
    // Ingestion-time Observation: return the pre-built, full-conversation
    // organized memory verbatim (no query-time synthesis call). The build's
    // LLM cost lands on the query that paid it (cache hits add nothing) —
    // without this, a 10M-tier build (~60 calls over ~18M input tokens) would
    // be invisible to the payload and telemetry, corrupting the token-cost
    // A/B on exactly the axis Hindsight's write-time organization is compared.
    if (observationBuildCost) {
      inputTokens += observationBuildCost.inputTokens;
      outputTokens += observationBuildCost.outputTokens;
      latencyMs += observationBuildCost.latencyMs;
    }
    capsule = {
      id: "csm-organized-memory",
      content:
        "CSM organized memory — a faithful chronological synthesis of the user's events " +
        "(source-derived; no gold answers or rubric used). This is the primary organized record " +
        "of what the user discussed and in what order; the raw events follow for detail.\n\n" +
        observation,
      user_id: request.user_id ?? null,
      timestamp: null,
      context: "CSM organized memory",
    };
  } else if (synthActive) {
    const synthIds = dedupeInOrder(baseIds).slice(0, 50);
    const synthContents = synthIds
      .map((id) => corpus.byId.get(id)?.content)
      .filter((c): c is string => Boolean(c));
    const organized = await baseline.organizeMemory({
      query: request.query,
      eventContents: synthContents,
      model: opts.model,
    });
    inputTokens += organized.inputTokens;
    outputTokens += organized.outputTokens;
    latencyMs += organized.latencyMs;
    capsule = {
      id: "csm-organized-memory",
      content:
        "CSM organized memory — a faithful chronological synthesis of the user's events " +
        "(source-derived; no gold answers or rubric used). This is the primary organized record " +
        "of what the user discussed and in what order; the raw events follow for detail.\n\n" +
        organized.text,
      user_id: request.user_id ?? null,
      timestamp: null,
      context: "CSM organized memory",
    };
  } else if (coverageFired) {
    capsule = renderTimelineCapsule(coverageTimeline, request.user_id ?? null);
  } else {
    capsule = buildEvidenceCapsule({
      query: request.query,
      corpus,
      ids,
      intent,
      userId: request.user_id ?? null,
    });
  }
  const responseDocuments = capsule ? [capsule, ...outDocs] : outDocs;

  return {
    documents: responseDocuments,
    raw_response: {
      provider: "context-swarm-memory",
      llm_provider: providerName,
      llm_model: opts.model,
      mode,
      note,
      meta,
      ambIntent: intent,
      evidenceCapsule: Boolean(capsule),
      returnedEventIds: ids,
      inputTokens,
      outputTokens,
      latencyMs,
      // Present (non-null) only on the query that paid the write-time build —
      // lets analysis separate the one-time build cost from per-query cost.
      observationBuildCost: obsActive ? (observationBuildCost ?? null) : null,
      factBuildCost: factActive ? (factBuildCost ?? null) : null,
    },
  };
}

async function readDocumentsJsonl(path: string): Promise<AmbDocument[]> {
  const text = stripBom(await readFile(path, "utf8"));
  const docs: AmbDocument[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    docs.push(JSON.parse(stripBom(trimmed)) as AmbDocument);
  }
  return docs;
}

async function readRequest(path: string): Promise<AmbRetrieveRequest> {
  const raw = JSON.parse(stripBom(await readFile(path, "utf8"))) as AmbRetrieveRequest;
  if (!raw.query || typeof raw.query !== "string") {
    throw new Error(`AMB request at ${path} is missing string field "query"`);
  }
  return raw;
}

export function buildCorpus(documents: AmbDocument[]): Corpus {
  const events: BenchEvent[] = documents.flatMap((doc, index) =>
    documentToEvents(doc, index),
  );

  const byShard = new Map<string, BenchEvent[]>();
  const byId = new Map<string, BenchEvent>();
  for (const event of events) {
    byId.set(event.id, event);
    const shardEvents = byShard.get(event.shardId);
    if (shardEvents) shardEvents.push(event);
    else byShard.set(event.shardId, [event]);
  }

  const totalTokens = events.reduce((sum, event) => sum + event.tokenCount, 0);
  return {
    events,
    coreEvents: events,
    fillerEvents: [],
    totalTokens,
    byShard,
    byId,
    targetTokens: totalTokens,
    sampleSeed: 42,
  };
}

function documentToEvents(doc: AmbDocument, index: number): BenchEvent[] {
  const docId = doc.id || `amb-doc-${index}`;
  const chunks = splitTurns(doc.content);
  const sourceChunks = chunks.length > 0 ? chunks : [doc.content];
  return sourceChunks.map((chunk, chunkIndex) => {
    const context = doc.context ? `Context: ${doc.context}\n\n` : "";
    const content = `${context}${chunk}`.trim();
    return {
      id: sourceChunks.length === 1 ? docId : `${docId}#turn-${chunkIndex}`,
      shardId: docId,
      content,
      tokenCount: estimateTokens(content),
      isCore: true,
      tier: 0,
      timestamp: extractTimestamp(chunk) ?? doc.timestamp ?? undefined,
      tags: [
        "amb",
        "beam",
        "beam-turn",
        ...(doc.user_id ? [`conversation:${doc.user_id}`] : []),
      ],
    };
  });
}

function splitTurns(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const matches = [...normalized.matchAll(/(?:^|\n)\s*(?:\[[^\]\n]*?\s*\|\s*)?\[?Turn\s+\d+\]?\s+(?:User|Assistant):/g)];
  if (matches.length <= 1) return [];

  const chunks: string[] = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index ?? 0;
    const end = matches[i + 1]?.index ?? normalized.length;
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}

function extractTimestamp(chunk: string): string | undefined {
  const datedTurn = chunk.match(/^\[([A-Z][a-z]+-\d{1,2}-\d{4})\s+\|\s*Turn\s+\d+\]/);
  if (!datedTurn) return undefined;
  const parsed = Date.parse(datedTurn[1].replaceAll("-", " "));
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

interface TimelineEntryLike {
  date: string | null;
  eventRef: string;
  line: string;
}

function parseTimelineEntries(value: unknown): TimelineEntryLike[] {
  if (!Array.isArray(value)) return [];
  const out: TimelineEntryLike[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.eventRef !== "string" || typeof entry.line !== "string") continue;
    out.push({
      date: typeof entry.date === "string" ? entry.date : null,
      eventRef: entry.eventRef,
      line: entry.line,
    });
  }
  return out;
}

/** Render the core's chronicle timeline as the AMB evidence capsule. Replaces
 *  the legacy regex-derived capsule for coverage-shaped queries: same pseudo-
 *  document contract, but every line is a citation-bearing entry produced by
 *  the deterministic assembler in src/core/coverage.ts (no gold, no rubric,
 *  no domain term tables). */
function renderTimelineCapsule(
  timeline: TimelineEntryLike[],
  userId: string | null,
  maxLines = 40,
): AmbDocument | null {
  if (timeline.length === 0) return null;
  if (orderedCapsuleActive()) {
    // Explicit numbered chronological sequence (CSM_AMB_ORDERED_CAPSULE=1).
    // BEAM events carry no real timestamps (they default to a placeholder date),
    // so the date prefix is uninformative and HIDES the order these queries ask
    // for. The timeline is already in true conversation order (session+turn
    // natural sort), so present it as an explicit 1..N sequence the answer model
    // can read directly. Raw events are still returned alongside for content.
    const items = timeline
      .slice(0, maxLines)
      .map((entry, i) => `${i + 1}. [${entry.eventRef}] ${entry.line}`);
    return {
      id: "csm-evidence-capsule",
      content: [
        "CSM chronological index — the user's events in time order (item 1 = earliest, item N = most recent), source-derived from retrieved memories; no gold answers or rubric used. This index gives the SEQUENCE/ordering only; the FULL content of each event is in the documents below (Memory 2 onward). To answer order/timeline/development questions: use this index to establish the order, and use the full documents below for the details of each item. IMPORTANT: this index is a partial summary — do NOT conclude information is missing just because a detail is not spelled out here; check the full documents below before answering, and include relevant items found there.",
        ...items,
      ].join("\n"),
      user_id: userId,
      timestamp: null,
      context: "CSM evidence capsule (ordered)",
    };
  }
  const lines = timeline.slice(0, maxLines).map((entry) => {
    const datePrefix = entry.date ? `${entry.date}: ` : "";
    return `- [${entry.eventRef}] ${datePrefix}${entry.line}`;
  });
  return {
    id: "csm-evidence-capsule",
    content: [
      "CSM chronological evidence capsule (date-ordered, source-derived from retrieved/scoped memories; no gold answers or rubric used).",
      ...lines,
    ].join("\n"),
    user_id: userId,
    timestamp: null,
    context: "CSM evidence capsule",
  };
}

export function detectAmbQueryIntent(query: string): AmbQueryIntent {
  const q = query.toLowerCase();
  return {
    broadSummary:
      /\b(summary|summarize|recap|overview|comprehensive|across (our|my|the) (discussion|discussions|conversation|conversations|history))\b/.test(
        q,
      ),
    temporal:
      /\b(how many (days|weeks|months|years)|duration|between when|between .* and|before|after|earlier|later|when did|timeline|chronological|order)\b/.test(
        q,
      ),
    contradiction:
      /\b(contradict|contradictory|conflict|inconsistent|which statement is correct|have i .* before|did i .* before)\b/.test(
        q,
      ),
    countLike: /\b(how many|number of|count|different|distinct)\b/.test(q),
    userCentric: /\b(i|my|me|mine)\b/.test(q),
    abstentionRisk:
      /\b(rationale|reason behind|why did|why was|why choose|why choosing|choosing)\b/.test(
        q,
      ),
  };
}

function selectAmbEvidenceIds(
  baseIds: string[],
  corpus: Corpus,
  query: string,
  intent: AmbQueryIntent,
  requestedK: number,
): string[] {
  const maxIds = resolveAmbReturnMax(requestedK, intent);
  let ids = dedupeInOrder(baseIds);

  if (intent.temporal || intent.contradiction) {
    ids = dedupeInOrder([
      ...ids,
      ...expandChronologicalNeighbors(ids, corpus, resolveAmbNeighborWindow(intent)),
      ...selectChronologicalCoverageIds(corpus, ids, query, maxIds, true),
    ]);
  }

  if (intent.broadSummary) {
    ids = dedupeInOrder([
      ...ids,
      ...selectChronologicalCoverageIds(corpus, ids, query, maxIds, true),
    ]);
  }

  if (intent.countLike && intent.userCentric) {
    ids = preferUserTurns(ids, corpus);
  }

  return ids.slice(0, maxIds);
}

function resolveAmbReturnMax(requestedK: number, intent: AmbQueryIntent): number {
  if (intent.broadSummary) {
    return parsePositiveInt(
      process.env.CSM_AMB_SUMMARY_RETURN_K,
      Math.max(requestedK, 24),
    );
  }
  if (intent.temporal || intent.contradiction) {
    return parsePositiveInt(
      process.env.CSM_AMB_REASONING_RETURN_K,
      Math.max(requestedK, 32),
    );
  }
  return requestedK;
}

/** CSM_AMB_COVERAGE_RERANK toggle (default OFF). When ON, the coverageFired
 *  return slice is coverage-ranked + token-budget-packed instead of count-cut. */
function coverageRerankActive(): boolean {
  const v = process.env.CSM_AMB_COVERAGE_RERANK;
  return v === "1" || (typeof v === "string" && v.toLowerCase() === "true");
}

/** CSM_AMB_ORDERED_CAPSULE toggle (default OFF). When ON, the evidence capsule
 *  is rendered as an explicit numbered chronological sequence (the order signal
 *  these summarization/event_ordering queries need) instead of a date-prefixed
 *  list where BEAM's placeholder dates hide the order. */
function orderedCapsuleActive(): boolean {
  const v = process.env.CSM_AMB_ORDERED_CAPSULE;
  return v === "1" || (typeof v === "string" && v.toLowerCase() === "true");
}

/** CSM_AMB_SYNTH_MEMORY toggle (default OFF). When ON, synthesis-intent queries
 *  get an LLM-organized chronological "organized memory" doc in place of the
 *  deterministic capsule (the synthesis-engine lever for summarization /
 *  event_ordering). */
function synthMemoryActive(): boolean {
  const v = process.env.CSM_AMB_SYNTH_MEMORY;
  return v === "1" || (typeof v === "string" && v.toLowerCase() === "true");
}

/** CSM_AMB_OBSERVE_MEMORY toggle (default OFF). When ON, the warm server builds
 *  an ingestion-time "Observation" (organized memory over the FULL conversation,
 *  cached per user) and the bridge returns it verbatim for summary-intent queries
 *  — the write-time organization pattern of Hindsight/RAPTOR/Honcho. */
export function observeMemoryActive(): boolean {
  const v = process.env.CSM_AMB_OBSERVE_MEMORY;
  return v === "1" || (typeof v === "string" && v.toLowerCase() === "true");
}

/** Gate for the ingestion-time Observation: fire ONLY on genuine retrospective
 *  summary/recap requests. Deliberately NARROWER than `detectAmbQueryIntent`'s
 *  `broadSummary` — the latter also matches the "across (our|my) conversations"
 *  phrasing, which (measured on the BEAM 100K query set) leaks onto 3 winner-
 *  category queries: two multi_session_reasoning COUNT questions ("how many book
 *  series ... across my conversations") and one preference_following advice query
 *  ("... to make it clear and comprehensive"). A prose organized-memory replaces
 *  the context those queries actually need, so it can only hurt them. The
 *  summarize/recap/overview VERBS alone hit 40/40 summarization queries with zero
 *  leak onto any other category — the organized memory is exactly a retrospective
 *  narrative, which is what those queries ask for.
 *
 *  Fires on the TWO coverage-failure losses. Validated (2026-06-24 audit) against
 *  ALL FOUR tier query sets (100k/500k/1m/10m, 2,000 queries): 100% recall on
 *  summarization (40+70+70+20) AND event_ordering (40+70+70+20), ZERO fires on
 *  any other category at any tier. Both categories fail identically at baseline —
 *  the answer model says "the context lacks the information" because retrieval
 *  drops nuggets scattered across the full conversation; the full-conversation
 *  organized memory is what supplies them.
 *
 *  Two constructions matter (both data-derived, see the audit):
 *  - The nouns summary/overview require a following "of|that": in every genuine
 *    summarization query across all tiers (145/145 noun usages) they head a
 *    request ("summary of how…", "overview that covers…"), while the measured
 *    leaks use them as NOUN MODIFIERS of a topic ("reduce summary generation
 *    time", "improving summary quality" — 1m multi_session; "the design overview
 *    document" — 10m abstention).
 *  - "in order" fires only when NOT the purpose idiom ("in order to/for/that"):
 *    500k/1m event_ordering phrase as "…my progress in order (mention N items)"
 *    and "reconstruct the timeline", which the original phrase list missed
 *    (500k 57/70, 1m 8/70 before this fix). */
export function observationQueryIntent(query: string): boolean {
  return (
    /\b(summarize|summarise|summarized|summarised|recap|recapped|(summary|overview)(?=\s+(of|that)\b))\b/i.test(
      query,
    ) ||
    /\b(in (what|which) order|order in which|list (the |in )?order|walk me through the order|the sequence in which|in chronological order|in order(?!\s+(to|for|that)\b)|reconstruct (the |my )?timeline)\b/i.test(
      query,
    )
  );
}

/** CSM_AMB_FACT_MEMORY toggle (default OFF). When ON, the warm server builds a
 *  write-time FACT REGISTRY (metric value histories with LATEST markers, built
 *  once over the full conversation, cached) and the bridge returns it for
 *  aggregation-intent queries — the per-entity/bi-temporal pattern of Hindsight
 *  and Zep/Graphiti, aimed at the multi-session aggregation failure mode
 *  (baseline sums STALE values; 10M multi_session_reasoning = 0.120). */
export function factMemoryActive(): boolean {
  const v = process.env.CSM_AMB_FACT_MEMORY;
  return v === "1" || (typeof v === "string" && v.toLowerCase() === "true");
}

/** Gate for the fact registry: cross-mention AGGREGATION questions ("how many X
 *  in total when combining A and B", "how much total ... across", "how many
 *  different X did I mention"). Validated on ALL FOUR BEAM tier query sets
 *  (2,000 queries, 2026-07-02): fires ONLY on multi_session_reasoning
 *  (100k 9/40, 500k 17/70, 1m 13/70, 10m 13/20), ZERO fires on any other
 *  category at any tier. Two measured-leak guards (both 500k):
 *  - `(?<!items )in total` — an event_ordering query embeds "(mention 8 items
 *    in total)" as an output-format instruction, not an aggregation ask;
 *  - "how much" must not target a DURATION ("how much total time did I spend
 *    ... across the sessions" is temporal_reasoning's time-arithmetic, a win
 *    category; metric aggregation like "how much total delay" still fires).
 *  Deliberately does NOT try to catch knowledge_update's "current value"
 *  questions — lexically indistinguishable from information_extraction (a
 *  winner), so no safe lexical gate exists for them. */
export function aggregationQueryIntent(query: string): boolean {
  return /\b((?<!items )in total|total .{0,30}(across|combining|combined)|(across|combining|combined).{0,40}\b(total|combined?|altogether)|how (many|much) (?!(total\s+)?(time|minutes|hours|days)\b).{0,60}(across|combined|combining|(?<!items )in total)|how many different .{0,40}(mention|discuss|bring)|altogether)\b/i.test(
    query,
  );
}

function resolveAmbNeighborWindow(intent: AmbQueryIntent): number {
  const fallback = intent.temporal || intent.contradiction ? 1 : 0;
  return parsePositiveInt(process.env.CSM_AMB_NEIGHBOR_WINDOW, fallback);
}

function expandChronologicalNeighbors(
  ids: string[],
  corpus: Corpus,
  window: number,
): string[] {
  if (!Number.isFinite(window) || window <= 0) return [];
  const out: string[] = [];
  for (const id of ids) {
    const event = corpus.byId.get(id);
    if (!event) continue;
    const shardEvents = sortedShardEvents(corpus, event.shardId);
    const index = shardEvents.findIndex((candidate) => candidate.id === id);
    if (index === -1) continue;
    for (let offset = -window; offset <= window; offset++) {
      if (offset === 0) continue;
      const neighbor = shardEvents[index + offset];
      if (neighbor) out.push(neighbor.id);
    }
  }
  return out;
}

function selectChronologicalCoverageIds(
  corpus: Corpus,
  seedIds: string[],
  query: string,
  maxIds: number,
  includeAllShards = false,
): string[] {
  const seedShardIds = dedupeInOrder(
    seedIds
      .map((id) => corpus.byId.get(id)?.shardId)
      .filter((id): id is string => Boolean(id)),
  );
  const shardIds =
    includeAllShards || seedShardIds.length === 0
      ? [...corpus.byShard.keys()].sort()
      : seedShardIds;
  const terms = expandCoverageTerms(extractContentTerms(query));
  const selected: string[] = [];
  const bucketCount = 12;
  const perBucket = 2;

  for (const shardId of shardIds) {
    const shardEvents = sortedShardEvents(corpus, shardId);
    if (shardEvents.length === 0) continue;
    const bucketSize = Math.max(1, Math.ceil(shardEvents.length / bucketCount));
    for (let start = 0; start < shardEvents.length; start += bucketSize) {
      const bucket = shardEvents.slice(start, start + bucketSize);
      const scored = bucket
        .map((event) => ({ event, score: coverageScore(event.content, terms) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return turnNumber(a.event) - turnNumber(b.event);
        })
        .slice(0, perBucket)
        .map((item) => item.event.id);
      selected.push(...scored);
      if (selected.length >= maxIds) return dedupeInOrder(selected);
    }
  }

  return dedupeInOrder(selected);
}

function preferUserTurns(ids: string[], corpus: Corpus): string[] {
  const user: string[] = [];
  const other: string[] = [];
  for (const id of ids) {
    const event = corpus.byId.get(id);
    if (event && eventRole(event.content) === "user") user.push(id);
    else other.push(id);
  }
  return [...user, ...other];
}

export function buildEvidenceCapsule(args: {
  query: string;
  corpus: Corpus;
  ids: string[];
  intent: AmbQueryIntent;
  userId: string | null;
}): AmbDocument | null {
  const { query, corpus, ids, intent, userId } = args;
  if (intent.abstentionRisk && !intent.contradiction) return null;
  if (
    !intent.broadSummary &&
    !intent.temporal &&
    !intent.contradiction &&
    !(intent.countLike && intent.userCentric)
  ) {
    return null;
  }

  const terms = expandCoverageTerms(extractContentTerms(query));
  const candidateEvents = intent.broadSummary
    ? selectCapsuleCoverageEvents(corpus, ids, query)
    : ids
        .map((id) => corpus.byId.get(id))
        .filter((event): event is BenchEvent => Boolean(event));
  const snippetLimit = capsuleSnippetLimit(intent);
  const eventsToSummarize = intent.broadSummary
    ? selectBroadSummaryEvidence(candidateEvents, terms, snippetLimit)
    : intent.temporal
      ? prioritizeTemporalEvidence(candidateEvents, terms, snippetLimit)
      : candidateEvents;

  const relationLine =
    intent.temporal && !intent.contradiction
      ? buildTemporalRelationLine(query, eventsToSummarize, terms)
      : null;

  const snippets: string[] = relationLine ? [relationLine] : [];
  const seen = new Set<string>();
  if (relationLine) seen.add(relationLine);
  for (const event of eventsToSummarize) {
    if (intent.countLike && intent.userCentric && eventRole(event.content) !== "user") {
      continue;
    }
    const score = coverageScore(event.content, terms);
    const hasDate = extractDatePhrases(event.content).length > 0;
    const hasConflictCue =
      intent.contradiction &&
      /\b(never|not|contradict|conflict|inconsistent|before|tested|used|also mentioned)\b/i.test(
        event.content,
      );
    if (!intent.broadSummary && score === 0 && !hasDate && !hasConflictCue) continue;
    const snippet = formatEvidenceSnippet(event, terms);
    if (!snippet || seen.has(snippet)) continue;
    seen.add(snippet);
    snippets.push(snippet);
    if (snippets.length >= snippetLimit) break;
  }

  if (snippets.length === 0) return null;
  const heading = intent.broadSummary
    ? "CSM chronological evidence capsule"
    : intent.temporal
      ? "CSM temporal evidence capsule"
      : intent.contradiction
        ? "CSM contradiction evidence capsule"
        : "CSM user-mentioned evidence capsule";

  return {
    id: "csm-evidence-capsule",
    content: [
      `${heading} (source-derived from retrieved/scoped memories; no gold answers or rubric used).`,
      ...snippets.map((snippet) => `- ${snippet}`),
    ].join("\n"),
    user_id: userId,
    timestamp: null,
    context: "CSM evidence capsule",
  };
}

function selectCapsuleCoverageEvents(
  corpus: Corpus,
  seedIds: string[],
  query: string,
): BenchEvent[] {
  const ids = selectChronologicalCoverageIds(
    corpus,
    seedIds,
    query,
    parsePositiveInt(process.env.CSM_AMB_CAPSULE_COVERAGE_K, 36),
    true,
  );
  const topIds = selectTopCoverageIds(
    corpus,
    query,
    parsePositiveInt(process.env.CSM_AMB_CAPSULE_TOP_K, 24),
  );
  return ids
    .concat(topIds)
    .filter((id, index, all) => all.indexOf(id) === index)
    .map((id) => corpus.byId.get(id))
    .filter((event): event is BenchEvent => Boolean(event))
    .sort((a, b) => {
      const shardCompare = a.shardId.localeCompare(b.shardId);
      if (shardCompare !== 0) return shardCompare;
      return turnNumber(a) - turnNumber(b);
    });
}

function selectTopCoverageIds(corpus: Corpus, query: string, limit: number): string[] {
  const terms = expandCoverageTerms(extractContentTerms(query));
  return corpus.events
    .map((event) => ({ event, score: coverageScore(event.content, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const shardCompare = a.event.shardId.localeCompare(b.event.shardId);
      if (shardCompare !== 0) return shardCompare;
      return turnNumber(a.event) - turnNumber(b.event);
    })
    .slice(0, limit)
    .map((item) => item.event.id);
}

function capsuleSnippetLimit(intent: AmbQueryIntent): number {
  if (intent.broadSummary) {
    return parsePositiveInt(process.env.CSM_AMB_CAPSULE_SUMMARY_SNIPPETS, 24);
  }
  if (intent.temporal || intent.contradiction) {
    return parsePositiveInt(process.env.CSM_AMB_CAPSULE_REASONING_SNIPPETS, 10);
  }
  return parsePositiveInt(process.env.CSM_AMB_CAPSULE_DEFAULT_SNIPPETS, 8);
}

function spreadAcrossTimeline(events: BenchEvent[], limit: number): BenchEvent[] {
  if (events.length <= limit) return events;
  if (!Number.isFinite(limit) || limit <= 0) return [];

  const out: BenchEvent[] = [];
  const used = new Set<string>();
  for (let i = 0; i < limit; i++) {
    const index =
      limit === 1 ? 0 : Math.round((i * (events.length - 1)) / (limit - 1));
    const event = events[index];
    if (event && !used.has(event.id)) {
      out.push(event);
      used.add(event.id);
    }
  }

  for (const event of events) {
    if (out.length >= limit) break;
    if (used.has(event.id)) continue;
    out.push(event);
    used.add(event.id);
  }

  return out.sort((a, b) => {
    const shardCompare = a.shardId.localeCompare(b.shardId);
    if (shardCompare !== 0) return shardCompare;
    return turnNumber(a) - turnNumber(b);
  });
}

function selectBroadSummaryEvidence(
  events: BenchEvent[],
  terms: string[],
  limit: number,
): BenchEvent[] {
  if (events.length <= limit) return events;
  const pinnedLimit = Math.min(
    parsePositiveInt(process.env.CSM_AMB_CAPSULE_PINNED_SNIPPETS, 8),
    Math.max(0, limit),
  );
  const pinned = [...events]
    .map((event) => ({ event, score: coverageScore(event.content, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return turnNumber(a.event) - turnNumber(b.event);
    })
    .slice(0, pinnedLimit)
    .map((item) => item.event);
  const pinnedIds = new Set(pinned.map((event) => event.id));
  const remaining = events.filter((event) => !pinnedIds.has(event.id));
  return dedupeBenchEvents([
    ...spreadAcrossTimeline(remaining, Math.max(0, limit - pinned.length)),
    ...pinned,
  ]).sort((a, b) => {
    const shardCompare = a.shardId.localeCompare(b.shardId);
    if (shardCompare !== 0) return shardCompare;
    return turnNumber(a) - turnNumber(b);
  });
}

function dedupeBenchEvents(events: BenchEvent[]): BenchEvent[] {
  const seen = new Set<string>();
  const out: BenchEvent[] = [];
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    out.push(event);
  }
  return out;
}

function prioritizeTemporalEvidence(
  events: BenchEvent[],
  terms: string[],
  limit: number,
): BenchEvent[] {
  return [...events]
    .map((event) => ({
      event,
      score: coverageScore(event.content, terms),
      dateCount: extractDatePhrases(event.content).length,
      isUserTurn: eventRole(event.content) === "user",
    }))
    .filter((item) => item.score > 0 || item.dateCount > 0)
    .sort((a, b) => {
      if (b.dateCount !== a.dateCount) return b.dateCount - a.dateCount;
      if (b.score !== a.score) return b.score - a.score;
      if (a.isUserTurn !== b.isUserTurn) return a.isUserTurn ? -1 : 1;
      return turnNumber(a.event) - turnNumber(b.event);
    })
    .slice(0, limit)
    .map((item) => item.event);
}

function buildTemporalRelationLine(
  query: string,
  events: BenchEvent[],
  terms: string[],
): string | null {
  const anchors = collectTemporalDateAnchors(events, terms);
  if (anchors.length < 2) return null;

  const segmentTerms = extractBetweenSegmentTerms(query);
  const pair = segmentTerms
    ? selectSegmentMatchedTemporalPair(anchors, segmentTerms)
    : selectTopTemporalPair(anchors);
  if (!pair) return null;

  const [first, second] = pair[0].timeMs <= pair[1].timeMs ? pair : [pair[1], pair[0]];
  const diffDays = Math.round(
    Math.abs(second.timeMs - first.timeMs) / (24 * 60 * 60 * 1000),
  );
  const dayLabel = diffDays === 1 ? "day" : "days";
  const firstExcerpt = dateCenteredExcerpt(first.event.content, first.dateText, 180);
  const secondExcerpt = dateCenteredExcerpt(second.event.content, second.dateText, 180);

  return [
    `Temporal calculation: from ${first.dateText} [${first.event.id}]`,
    `(${firstExcerpt}) to ${second.dateText} [${second.event.id}]`,
    `(${secondExcerpt}) = ${diffDays} ${dayLabel}.`,
  ].join(" ");
}

function collectTemporalDateAnchors(
  events: BenchEvent[],
  terms: string[],
): TemporalDateAnchor[] {
  const anchors: TemporalDateAnchor[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    const score = coverageScore(event.content, terms);
    const dates = dedupeInOrder(extractDatePhrases(event.content));
    for (const dateText of dates) {
      const parsed = parseDatePhrase(dateText);
      if (!Number.isFinite(parsed)) continue;
      const key = `${event.id}:${parsed}`;
      if (seen.has(key)) continue;
      seen.add(key);
      anchors.push({
        event,
        dateText,
        timeMs: parsed,
        score,
      });
    }
  }
  return anchors.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.timeMs - b.timeMs;
  });
}

function selectSegmentMatchedTemporalPair(
  anchors: TemporalDateAnchor[],
  segmentTerms: [string[], string[]],
): [TemporalDateAnchor, TemporalDateAnchor] | null {
  const first = bestAnchorForTerms(anchors, segmentTerms[0]);
  const second = bestAnchorForTerms(
    anchors.filter((anchor) => anchor.event.id !== first?.event.id),
    segmentTerms[1],
  );
  if (first && second && first.timeMs !== second.timeMs) return [first, second];
  return selectTopTemporalPair(anchors);
}

function bestAnchorForTerms(
  anchors: TemporalDateAnchor[],
  terms: string[],
): TemporalDateAnchor | null {
  const scored = anchors
    .map((anchor) => ({
      anchor,
      score: coverageScore(anchor.event.content, terms),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.anchor.score !== a.anchor.score) return b.anchor.score - a.anchor.score;
      return a.anchor.timeMs - b.anchor.timeMs;
    });
  return scored[0]?.anchor ?? null;
}

function selectTopTemporalPair(
  anchors: TemporalDateAnchor[],
): [TemporalDateAnchor, TemporalDateAnchor] | null {
  for (let i = 0; i < anchors.length; i++) {
    for (let j = i + 1; j < anchors.length; j++) {
      if (anchors[i].event.id === anchors[j].event.id) continue;
      if (anchors[i].timeMs === anchors[j].timeMs) continue;
      return [anchors[i], anchors[j]];
    }
  }
  return null;
}

function extractBetweenSegmentTerms(query: string): [string[], string[]] | null {
  const normalized = query.replace(/\s+/g, " ").trim();
  const match = normalized.match(
    /\bbetween\s+(?:when\s+)?(.+?)\s+and\s+(?:when\s+)?(.+?)(?:[?.!]|$)/i,
  );
  if (!match) return null;
  const left = match[1] ?? "";
  const right = match[2] ?? "";
  const leftTerms = expandCoverageTerms(extractContentTerms(left));
  const rightTerms = expandCoverageTerms(extractContentTerms(right));
  if (leftTerms.length === 0 || rightTerms.length === 0) return null;
  return [leftTerms, rightTerms];
}

function parseDatePhrase(dateText: string): number {
  const iso = dateText.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    return Date.UTC(
      Number.parseInt(iso[1]!, 10),
      Number.parseInt(iso[2]!, 10) - 1,
      Number.parseInt(iso[3]!, 10),
    );
  }

  const month = dateText
    .replaceAll("-", " ")
    .replace(/,/g, "")
    .match(/\b([A-Za-z]+)\s+(\d{1,2})\s+(\d{4})\b/);
  const monthIndex = month ? MONTH_INDEX.get(month[1]!.slice(0, 3).toLowerCase()) : undefined;
  if (month && monthIndex !== undefined) {
    return Date.UTC(
      Number.parseInt(month[3]!, 10),
      monthIndex,
      Number.parseInt(month[2]!, 10),
    );
  }

  const parsed = Date.parse(dateText);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function dateCenteredExcerpt(
  content: string,
  dateText: string,
  maxChars: number,
): string {
  const clean = content.replace(/\s+/g, " ").trim();
  const variants = dedupeInOrder([
    dateText,
    dateText.replace(/,/g, ""),
    dateText.replaceAll("-", " "),
    dateText.replaceAll(" ", "-"),
  ]).filter(Boolean);
  const low = clean.toLowerCase();
  let hit = -1;
  for (const variant of variants) {
    hit = low.indexOf(variant.toLowerCase());
    if (hit !== -1) break;
  }
  if (hit === -1) return relevantExcerpt(content, [dateText], maxChars);

  const start = Math.max(0, hit - Math.floor(maxChars * 0.65));
  const end = Math.min(clean.length, start + maxChars);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < clean.length ? "..." : "";
  return `${prefix}${clean.slice(start, end).trim()}${suffix}`;
}

function formatEvidenceSnippet(event: BenchEvent, terms: string[]): string {
  const role = eventRole(event.content);
  const turn = turnLabel(event.content) ?? event.id;
  const dates = extractDatePhrases(event.content);
  const anchors = matchedHighSignalTerms(event.content, terms);
  const snippet = relevantExcerpt(event.content, terms, 360);
  const datePrefix = dates.length ? ` dates=${dedupeInOrder(dates).slice(0, 3).join(", ")};` : "";
  const anchorPrefix = anchors.length ? ` anchors=${anchors.slice(0, 5).join(", ")};` : "";
  return `[${event.id}] ${turn} ${role}:${datePrefix}${anchorPrefix} ${snippet}`;
}

function relevantExcerpt(content: string, terms: string[], maxChars: number): string {
  const clean = content.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;

  const low = clean.toLowerCase();
  const needles = dedupeInOrder([
    ...terms,
    ...extractDatePhrases(clean).map((date) => date.toLowerCase()),
  ].filter((term) => term.length > 0));
  let hit = -1;
  let hitWeight = -1;
  for (const term of needles) {
    const ix = low.indexOf(term.toLowerCase());
    if (ix === -1) continue;
    const weight = highSignalWeight(term);
    if (weight > hitWeight || (weight === hitWeight && (hit === -1 || ix < hit))) {
      hit = ix;
      hitWeight = weight;
    }
  }
  const center = hit === -1 ? 0 : hit;
  const start = Math.max(0, center - Math.floor(maxChars / 3));
  const end = Math.min(clean.length, start + maxChars);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < clean.length ? "..." : "";
  return `${prefix}${clean.slice(start, end).trim()}${suffix}`;
}

function matchedHighSignalTerms(content: string, terms: string[]): string[] {
  const low = content.toLowerCase();
  return dedupeInOrder(
    terms
      .filter((term) => highSignalWeight(term) >= 50)
      .filter((term) => new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(low)),
  );
}

function highSignalWeight(term: string): number {
  const normalized = term.toLowerCase();
  if (HIGH_SIGNAL_TERMS.has(normalized)) return 100;
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return 80;
  if (
    /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(normalized)
  ) {
    return 80;
  }
  return Math.min(40, normalized.length);
}

function extractContentTerms(text: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9_.:-]{2,}/g)) {
    const raw = match[0]!;
    const term = raw.toLowerCase().replace(/'s$/g, "");
    if (term.length < 4 && raw[0] !== raw[0]?.toUpperCase()) continue;
    if (AMB_STOP_WORDS.has(term)) continue;
    if (seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms.slice(0, 16);
}

function expandCoverageTerms(terms: string[]): string[] {
  const expanded = new Set(terms);
  const addWhen = (trigger: string, extra: string[]) => {
    if (expanded.has(trigger)) extra.forEach((term) => expanded.add(term));
  };
  addWhen("security", [
    "auth",
    "authentication",
    "password",
    "hash",
    "csrf",
    "flask-wtf",
    "session",
    "login",
    "lockout",
    "redis",
    "role",
    "https",
  ]);
  addWhen("database", [
    "sqlite",
    "sqlalchemy",
    "postgres",
    "transaction",
    "migration",
    "table",
    "schema",
    "constraint",
    "uuid",
    "operationalerror",
  ]);
  addWhen("weather", [
    "openweather",
    "temperature",
    "humidity",
    "conditions",
    "autocomplete",
    "cors",
    "forecast",
    "api",
    "rate",
    "cache",
  ]);
  addWhen("performance", [
    "lazy",
    "loading",
    "load",
    "latency",
    "bounce",
    "analytics",
    "ga4",
    "tracking",
  ]);
  return [...expanded].slice(0, 48);
}

function coverageScore(content: string, terms: string[]): number {
  const low = content.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(low)) {
      score += term.length >= 7 ? 2 : 1;
    }
  }
  if (extractDatePhrases(content).length > 0) score += 1;
  return score;
}

function sortedShardEvents(corpus: Corpus, shardId: string): BenchEvent[] {
  return [...(corpus.byShard.get(shardId) ?? [])].sort((a, b) => {
    const byTurn = turnNumber(a) - turnNumber(b);
    if (byTurn !== 0) return byTurn;
    return a.id.localeCompare(b.id);
  });
}

function eventRole(content: string): string {
  const match = content.match(/(?:^|\n)\s*(?:\[[^\]\n]*?\s*\|\s*)?\[?Turn\s+\d+\]?\s+(User|Assistant):/i);
  return match?.[1]?.toLowerCase() ?? "memory";
}

function turnLabel(content: string): string | null {
  return (
    content.match(/(?:^|\n)\s*((?:\[[^\]\n]*?\s*\|\s*)?\[?Turn\s+\d+\]?)/i)?.[1] ??
    null
  );
}

function turnNumber(event: BenchEvent): number {
  const fromContent = event.content.match(/\bTurn\s+(\d+)\b/i)?.[1];
  if (fromContent) return Number.parseInt(fromContent, 10);
  const fromId = event.id.match(/#turn-(\d+)$/)?.[1];
  return fromId ? Number.parseInt(fromId, 10) : Number.MAX_SAFE_INTEGER;
}

function extractDatePhrases(content: string): string[] {
  const dates: string[] = [];
  for (const match of content.matchAll(
    /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[\s-]+\d{1,2},?[\s-]+\d{4}\b/g,
  )) {
    dates.push(match[0]!.replaceAll("-", " "));
  }
  for (const match of content.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) {
    dates.push(match[0]!);
  }
  return dates.slice(0, 8);
}

function dedupeInOrder<T>(items: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const AMB_STOP_WORDS = new Set([
  "about",
  "across",
  "after",
  "again",
  "also",
  "answer",
  "before",
  "being",
  "between",
  "could",
  "different",
  "does",
  "from",
  "give",
  "handle",
  "handled",
  "have",
  "into",
  "many",
  "mentioned",
  "only",
  "provide",
  "question",
  "related",
  "should",
  "state",
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
  "would",
]);

const HIGH_SIGNAL_TERMS = new Set([
  "api",
  "api key",
  "csrf",
  "flask-wtf",
  "ga4",
  "lockout",
  "operationalerror",
  "pbkdf2",
  "redis",
  "sha256",
  "unique",
  "constraint",
  "uuid",
  "wireframe",
]);

const MONTH_INDEX = new Map<string, number>([
  ["jan", 0],
  ["feb", 1],
  ["mar", 2],
  ["apr", 3],
  ["may", 4],
  ["jun", 5],
  ["jul", 6],
  ["aug", 7],
  ["sep", 8],
  ["oct", 9],
  ["nov", 10],
  ["dec", 11],
]);

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

const BOOLEAN_FLAGS = new Set(["with-internal-answer"]);

function parseArgs(argv: string[]): Args {
  const raw = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key?.startsWith("--")) continue;
    const name = key.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      raw.set(name, "1");
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${key}`);
    }
    raw.set(name, value);
    i++;
  }

  const storeDir = raw.get("store");
  const requestPath = raw.get("request");
  if (!storeDir) throw new Error("Usage: amb-csm-retrieve --store <dir> --request <json>");
  if (!requestPath) throw new Error("Usage: amb-csm-retrieve --store <dir> --request <json>");

  return {
    storeDir,
    requestPath,
    model:
      raw.get("model") ??
      process.env.CSM_AMB_MODEL ??
      process.env.CSM_MODEL ??
      "gemini-3.5-flash",
    modelContext: parsePositiveInt(
      raw.get("model-context") ?? process.env.CSM_AMB_MODEL_CONTEXT,
      8192,
    ),
    maxOutputTokens: parsePositiveInt(
      raw.get("max-output-tokens") ?? process.env.CSM_AMB_MAX_OUTPUT_TOKENS,
      8,
    ),
    withInternalAnswer:
      raw.has("with-internal-answer") ||
      isTruthyEnv(process.env.CSM_AMB_WITH_INTERNAL_ANSWER),
  };
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(
      `amb-csm-retrieve failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  });
}
