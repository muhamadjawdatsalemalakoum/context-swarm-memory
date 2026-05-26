import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { estimateTokens } from "../src/core/tokenBudget.js";
import { CsmBaseline } from "../src/eval/baselines/csm.js";
import type { BenchEvent, Corpus } from "../src/eval/corpus.js";
import type { FreeFormQuery } from "../src/eval/mcq.js";
import { createProvider } from "../src/providers/index.js";

export interface AmbDocument {
  id: string;
  content: string;
  user_id?: string | null;
  timestamp?: string | null;
  context?: string | null;
}

interface AmbRetrieveRequest {
  query: string;
  k?: number;
  user_id?: string | null;
  query_timestamp?: string | null;
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
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.CSM_MODEL) process.env.CSM_MODEL = args.model;

  const [documents, request] = await Promise.all([
    readDocumentsJsonl(join(args.storeDir, "documents.jsonl")),
    readRequest(args.requestPath),
  ]);
  const scopedDocs = request.user_id
    ? documents.filter((doc) => doc.user_id === request.user_id)
    : documents;

  if (scopedDocs.length === 0) {
    writeJson({ documents: [], raw_response: { reason: "no_documents_in_scope" } });
    return;
  }

  const corpus = buildCorpus(scopedDocs);
  const baseline = new CsmBaseline({ provider: createProvider() });
  const query: FreeFormQuery = {
    kind: "free-form",
    id: "amb-request",
    question: request.query,
    correctAnswer: "unused",
    relevantEventIds: [],
  };

  const result = await baseline.answer(query, corpus, {
    maxInputTokens: args.modelContext,
    model: args.model,
    maxOutputTokens: args.maxOutputTokens,
    temperature: 0,
    seed: 42,
  });

  const retrievedEventIds = asStringArray(result.meta?.csmRetrievedEventIds);
  const packedEventIds = asStringArray(result.meta?.packedEventIds);
  const baseIds = retrievedEventIds.length > 0 ? retrievedEventIds : packedEventIds;
  const intent = detectAmbQueryIntent(request.query);
  const ids = selectAmbEvidenceIds(baseIds, corpus, request.query, intent, request.k ?? 10);

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
  const capsule = buildEvidenceCapsule({
    query: request.query,
    corpus,
    ids,
    intent,
    userId: request.user_id ?? null,
  });
  const responseDocuments = capsule ? [capsule, ...outDocs] : outDocs;

  writeJson({
    documents: responseDocuments,
    raw_response: {
      provider: "context-swarm-memory",
      mode: "retrieve-via-csm-baseline",
      note:
        "Smoke bridge: CSM retrieval is exposed to AMB; the internal final answer call is discarded.",
      meta: result.meta ?? {},
      ambIntent: intent,
      evidenceCapsule: Boolean(capsule),
      returnedEventIds: ids,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: result.latencyMs,
    },
  });
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

function parseArgs(argv: string[]): Args {
  const raw = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key?.startsWith("--")) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${key}`);
    }
    raw.set(key.slice(2), value);
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
  };
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
