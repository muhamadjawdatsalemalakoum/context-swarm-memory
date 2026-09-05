// First-class coverage & chronicle recall (R&D brief T1).
//
// CSM loses to Hindsight on exactly two BEAM categories — summarization and
// event_ordering — and locally the same failure shows as multi-event coverage
// collapse (PaySwift q04 packs 0/6 gold events, q27 packs 2/13). The current
// mitigation is an external regex heuristic ("evidence capsule") in
// scripts/amb-csm-retrieve.ts that is overfit to BEAM content domains
// (hardcoded security/database/weather/performance term tables).
//
// This module is the general, in-core replacement. Three deterministic parts:
//
//   1. classifyQueryIntent — lexical query-shape classifier (a generalized
//      port of the bridge's detectAmbQueryIntent, no domain tables).
//   2. assembleChronicle — deterministic chronicle assembler: date-sorted,
//      term-scored selection across candidate shards, bucketed for timeline
//      spread (port of selectChronologicalCoverageIds + spreadAcrossTimeline
//      into core), fed by router/probe footholds. Zero LLM cost.
//   3. computeTemporalRelation — deterministic date-anchor pairing and day
//      arithmetic (port of buildTemporalRelationLine/parseDatePhrase). The
//      LLM is never asked to do date math unaided.
//
// Term source is ALWAYS query + foothold-derived (the extractBridgeTerms
// pattern from src/eval/baselines/csm.ts) — never hardcoded domains.
//
// Read-path discipline: every function here is pure (no I/O, no storage
// access, no LLM calls). Callers hand in already-loaded snapshots; nothing
// here can mutate durable memory. Citation discipline: every produced
// reference is a full "shard_id@snapshot_id:event_id".

import type {
  MemoryEvent,
  MemoryPacket,
  MemoryPacketClaim,
  MemoryPacketTimelineEntry,
  MemoryShardSnapshot,
  QueryIntent,
  QueryIntentFacets,
} from "./types.js";
import { estimateTokens } from "./tokenBudget.js";
import { envFlag, envInt, envPositiveInt } from "../utils/env.js";
import { dedupeInOrder } from "./selection.js";
import { escapeRegExp } from "../utils/text.js";

// ─── Intent classification ──────────────────────────────────────────────────

interface CueDef {
  facet: keyof QueryIntentFacets;
  label: string;
  re: RegExp;
}

/**
 * Cue table. Deliberately conservative: a false negative degrades to today's
 * behaviour (point lookup, no chronicle); a false positive adds cheap
 * deterministic evidence but changes LLM inputs — so precision wins.
 *
 * Notable conservative choices (documented divergences from the bridge's
 * detectAmbQueryIntent):
 * - Bare "why did …" is NOT a cue. It overlaps the bridge's abstention-risk
 *   class ("why did you choose X" rationale questions where surfacing broad
 *   evidence hurts BEAM's abstention category). Retrospective evaluation
 *   ("why was X considered a mistake") IS a cue — that shape needs the
 *   narrative.
 * - Bare "different" is NOT an aggregation cue (the bridge's countLike
 *   matches it; "why did we choose a different database" is a point lookup).
 * - "how many <time unit>" routes to temporalArithmetic, never aggregation.
 */
const CUES: CueDef[] = [
  // summary / narrative breadth
  { facet: "summary", label: "summarize", re: /\b(summar(?:y|ies|ize|ise|ized|ised|izing|ising)|recap|overview)\b/i },
  { facet: "summary", label: "comprehensive", re: /\bcomprehensive\b/i },
  { facet: "summary", label: "across-history", re: /\bacross (?:our|my|the|all) (?:discussion|discussions|conversation|conversations|history|sessions?|project)\b/i },
  { facet: "summary", label: "everything-all", re: /\b(?:everything|all (?:the )?(?:decisions|changes|events|updates|incidents|discussions))\b.{0,40}\b(?:decided|happened|discussed|made|occurred|about)\b/i },
  { facet: "summary", label: "retrospective", re: /\b(?:in hindsight|in retrospect|looking back)\b/i },
  { facet: "summary", label: "considered-evaluation", re: /\bwhy (?:was|were|is|are) \b.{0,80}\b(?:considered|seen as|deemed|regarded as|viewed as)\b/i },
  { facet: "summary", label: "what-led-to", re: /\bwhat led (?:up )?to\b/i },
  { facet: "summary", label: "history-of", re: /\b(?:history|story|evolution) of\b/i },
  { facet: "summary", label: "impact-of", re: /\b(?:impact|effect|consequences?) (?:of|on)\b/i },
  { facet: "summary", label: "how-evolved", re: /\bhow (?:did|has|have) \b.{0,60}\b(?:evolve[d]?|unfold(?:ed)?|develop(?:ed)?|progress(?:ed)?|change[d]? over)\b/i },

  // ordering / sequence
  { facet: "ordering", label: "chronological", re: /\bchronolog(?:y|ical|ically)\b/i },
  { facet: "ordering", label: "in-order", re: /\b(?:in what order|in which order|in order of|correct order|sequence of events)\b/i },
  { facet: "ordering", label: "timeline", re: /\btimeline\b/i },
  { facet: "ordering", label: "came-first", re: /\bwhich (?:came|happened|occurred|was) (?:first|last|earlier|later)\b/i },
  { facet: "ordering", label: "happened-first", re: /\bwhat happened (?:first|next|last|right before|right after|immediately before|immediately after)\b/i },
  { facet: "ordering", label: "before-or-after", re: /\b(?:before or after|earlier or later)\b/i },

  // temporal arithmetic (deterministic date math — never LLM-computed)
  { facet: "temporalArithmetic", label: "how-many-time-units", re: /\bhow many (?:days|weeks|months|years|hours|minutes)\b/i },
  { facet: "temporalArithmetic", label: "how-long", re: /\bhow long\b/i },
  { facet: "temporalArithmetic", label: "duration", re: /\b(?:duration|elapsed|time between|days between|gap between)\b/i },
  { facet: "temporalArithmetic", label: "between-when", re: /\bbetween when\b/i },
  { facet: "temporalArithmetic", label: "how-much-time", re: /\bhow much time\b/i },

  // aggregation / enumeration
  { facet: "aggregation", label: "how-many", re: /\bhow many (?!days\b|weeks\b|months\b|years\b|hours\b|minutes\b)/i },
  { facet: "aggregation", label: "number-of", re: /\b(?:number of|count of|total number)\b/i },
  { facet: "aggregation", label: "how-often", re: /\bhow (?:often|frequently|many times)\b/i },
  { facet: "aggregation", label: "distinct", re: /\bdistinct\b/i },
  { facet: "aggregation", label: "list-all", re: /\b(?:list|name|enumerate) (?:all|every|each)\b/i },
];

/** Deterministic, lexical query-intent classifier. Pure function of the
 *  query string — usable identically by `ask()` and the AMB bridge. */
export function classifyQueryIntent(query: string): QueryIntent {
  const facets: QueryIntentFacets = {
    summary: false,
    ordering: false,
    temporalArithmetic: false,
    aggregation: false,
  };
  const cues: string[] = [];
  for (const cue of CUES) {
    if (cue.re.test(query)) {
      facets[cue.facet] = true;
      cues.push(`${cue.facet}:${cue.label}`);
    }
  }
  const kind =
    facets.summary || facets.ordering || facets.temporalArithmetic || facets.aggregation
      ? "coverage"
      : "point";
  return { kind, facets, cues };
}

// ─── Term extraction (query + foothold derived; never domain tables) ────────

/** Generic stopwords only — union of the router's STOPWORDS and the bridge's
 *  AMB_STOP_WORDS, minus nothing domain-specific (there is nothing domain-
 *  specific to begin with; that's the point). */
const COVERAGE_STOP_WORDS = new Set([
  "about", "across", "after", "again", "all", "also", "and", "answer", "any",
  "are", "back", "been", "before", "being", "between", "but", "can", "could",
  "did", "does", "doing", "down", "during", "each", "else", "ever", "every",
  "for", "from", "get", "give", "had", "handle", "handled", "has", "have",
  "her", "him", "his", "how", "into", "its", "just", "like", "made", "make",
  "many", "may", "mentioned", "might", "mine", "more", "most", "much", "must",
  "not", "now", "off", "once", "one", "only", "other", "our", "out", "over",
  "own", "provide", "question", "related", "same", "shall", "she", "should",
  "since", "some", "state", "such", "team", "than", "that", "the", "their",
  "them", "then", "there", "these", "they", "this", "those", "through",
  "took", "under", "until", "upon", "used", "using", "very", "was", "were",
  "what", "when", "where", "which", "while", "who", "whom", "why", "will",
  "with", "within", "would", "you", "your",
]);

/**
 * Query-SHAPE vocabulary — the intent classifier's own cue words (and close
 * inflections). These describe what KIND of answer the user wants, not what
 * the answer is about, and the classifier has already consumed that signal.
 * Left in the term set they hijack scoring toward meta-content: on PaySwift
 * q27, "hindsight/considered/mistake" outranked "Bun" and steered every seed
 * to retro/postmortem events. This is classifier vocabulary, not domain
 * vocabulary — it must track CUES, never corpus content.
 */
const INTENT_SHAPE_WORDS = new Set([
  "summary", "summaries", "summarize", "summarise", "summarized",
  "summarised", "summarizing", "summarising", "recap", "overview",
  "comprehensive", "hindsight", "retrospect", "considered", "deemed",
  "regarded", "viewed", "mistake", "impact", "effect", "consequence",
  "consequences", "evolve", "evolved", "unfold", "unfolded", "develop",
  "developed", "progress", "progressed", "history", "story", "evolution",
  "chronology", "chronological", "chronologically", "order", "ordering",
  "sequence", "timeline", "happened", "occurred", "duration", "elapsed",
  "distinct", "count", "enumerate",
]);

/**
 * Salient-term extraction — the `extractBridgeTerms` pattern from
 * `src/eval/baselines/csm.ts` (lexical, generic, capped). Terms shorter than
 * 4 chars survive only when capitalized in the source (proper-noun signal,
 * e.g. "Bun", "GA4"). Stopwords and intent-shape words are excluded — both
 * are generic-English filters, never corpus/domain tables.
 */
export function extractCoverageTerms(text: string, max = 16): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9_.:-]{2,}/g)) {
    const raw = match[0]!;
    const term = raw.toLowerCase().replace(/'s$/, "").replace(/[.:,-]+$/, "");
    if (term.length < 3) continue;
    if (term.length < 4 && raw[0] !== raw[0]?.toUpperCase()) continue;
    if (COVERAGE_STOP_WORDS.has(term)) continue;
    if (INTENT_SHAPE_WORDS.has(term)) continue;
    if (seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= max) break;
  }
  return terms;
}

/**
 * TF-IDF ranking for EXPANSION terms (footholds/seeds — never the user's own
 * query terms). Corpus-derived, zero hardcoded vocabulary — the same
 * statistical machinery as T2's content-derived shard descriptors, applied
 * at query time to the seed pseudo-document:
 *
 *  1. Boilerplate cut: terms in more than `maxDfRatio` of the scoped events
 *     are dropped ("Slack", author names, "PST" in PaySwift; "Turn"/"User"
 *     in BEAM match nearly everything). The floor of 3 keeps the cut
 *     meaningful in tiny scopes.
 *  2. TF-IDF ranking of survivors: weight = tf(term in seed text) ×
 *     ln((N+1)/(df+0.5)). Plain DF cannot separate topic vocabulary from
 *     passing narrative words ("aurora" df=14 vs "better" df=11 on the
 *     PaySwift core slice) — but the seed's own emphasis can: a foothold
 *     about the Aurora decision repeats "aurora" ~5×, while "better" appears
 *     once. Callers cap the ranked list (MAX_EXPANSION_TERMS).
 *
 * `seedTokens` is the full token LIST of the seed text (`tokenListOf`);
 * `tokenSets` must be built with `tokenSetOf`. Both share the grammar of
 * `extractCoverageTerms`, so punctuated terms like "multi-az" stay intact.
 */
export function rankExpansionTerms(
  terms: string[],
  seedTokens: string[],
  tokenSets: Array<Set<string>>,
  maxDfRatio = 0.25,
): string[] {
  if (tokenSets.length === 0) return terms;
  const limit = Math.max(3, Math.floor(tokenSets.length * maxDfRatio));
  const n = tokenSets.length;
  const tf = new Map<string, number>();
  for (const token of seedTokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  const weighted = terms
    .map((term, index) => {
      let df = 0;
      for (const set of tokenSets) {
        if (set.has(term)) df++;
      }
      const weight = (tf.get(term) ?? 1) * Math.log((n + 1) / (df + 0.5));
      return { term, df, weight, index };
    })
    .filter((t) => t.df <= limit);
  return weighted
    .sort((a, b) => (b.weight !== a.weight ? b.weight - a.weight : a.index - b.index))
    .map((t) => t.term);
}

/** Token list (with repeats) of a content string under the coverage term
 *  grammar — the TF side of rankExpansionTerms. */
export function tokenListOf(content: string): string[] {
  const out: string[] = [];
  for (const match of content.matchAll(/[A-Za-z][A-Za-z0-9_.:-]{2,}/g)) {
    out.push(match[0]!.toLowerCase().replace(/'s$/, "").replace(/[.:,-]+$/, ""));
  }
  return out;
}

/** Token set of a content string under the coverage term grammar. */
export function tokenSetOf(content: string): Set<string> {
  const set = new Set<string>();
  for (const match of content.matchAll(/[A-Za-z][A-Za-z0-9_.:-]{2,}/g)) {
    set.add(match[0]!.toLowerCase().replace(/'s$/, "").replace(/[.:,-]+$/, ""));
  }
  return set;
}

/** Whole-word term-overlap score (port of the bridge's coverageScore, minus
 *  the unconditional date bonus — see scoreEventForChronicle). Long terms
 *  (≥7 chars) count double: they are rarer and more discriminative. */
export function scoreEventCoverage(content: string, terms: string[]): number {
  let score = 0;
  for (const term of terms) {
    if (new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(content)) {
      score += term.length >= 7 ? 2 : 1;
    }
  }
  return score;
}

/**
 * Topic-anchor terms of a query: tokens whose source occurrence is
 * capitalized MID-SENTENCE ("…adoption of Bun considered…", "the March data
 * leak", "Mary") or fully uppercase (RDS, PCI, GA4). Pure-statistics IDF
 * cannot tell a topic noun from a query modifier — on the PaySwift core
 * slice "early" is RARER than "bun" (the saga is large), so "early" would
 * out-weight the actual subject. Mid-sentence capitalization is the generic,
 * deterministic, language-level signal for "this is the entity the user is
 * asking about". Anchored terms get a fixed weight boost in chronicle
 * scoring.
 */
export function extractAnchoredTerms(text: string): Set<string> {
  const anchored = new Set<string>();
  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9_.:-]{1,}/g)) {
    const raw = match[0]!;
    const index = match.index ?? 0;
    const head = raw[0]!;
    const isCapitalized = head === head.toUpperCase() && head !== head.toLowerCase();
    if (!isCapitalized) continue;
    const allCaps = raw.length >= 2 && raw === raw.toUpperCase() && /[A-Z]/.test(raw);
    const before = text.slice(0, index);
    const sentenceInitial = before.trim().length === 0 || /[.!?:;]\s*$/.test(before) || /["'(\[]\s*$/.test(before);
    if (sentenceInitial && !allCaps) continue;
    const term = raw.toLowerCase().replace(/'s$/, "").replace(/[.:,-]+$/, "");
    if (term.length < 2) continue;
    if (COVERAGE_STOP_WORDS.has(term) || INTENT_SHAPE_WORDS.has(term)) continue;
    anchored.add(term);
  }
  return anchored;
}

/** Weight multiplier for anchored query terms in chronicle scoring. */
export const ANCHOR_BOOST = 2;

/** Additive bonus (in idf units, where one matched term is worth ~2–6) for
 *  events in a probe-verified foothold shard. Strong enough to win cap-edge
 *  ties for sibling evidence, weak enough never to override topic signal. */
export const FOOTHOLD_SHARD_BONUS = 1.0;

// ─── Dates ───────────────────────────────────────────────────────────────────

/** Extract date phrases from content text: "Mar 12, 2026", "March-12-2026",
 *  "2026-03-12". Port of the bridge's extractDatePhrases (generic regexes,
 *  not domain knowledge). Capped at 8 per event. */
export function extractDatePhrases(content: string): string[] {
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

/** Cap on foothold/seed-derived expansion terms (TF-IDF-ranked). Query terms
 *  are uncapped within extractCoverageTerms' own max. */
const MAX_EXPANSION_TERMS = 12;

/** Chars of each seed/foothold event's content mined for expansion terms.
 *  600 was too small: PaySwift footholds open with conversational preamble
 *  and the topic vocabulary ("Postgres 17", repeated "Aurora") lands later
 *  in the message. */
const SEED_CONTENT_CHARS = 2000;

/** Second-hop expansion bounds: top hop-1 hits mined, terms appended. */
const HOP2_SEEDS = 3;
const HOP2_TERMS = 6;

const MONTH_INDEX = new Map<string, number>([
  ["jan", 0], ["feb", 1], ["mar", 2], ["apr", 3], ["may", 4], ["jun", 5],
  ["jul", 6], ["aug", 7], ["sep", 8], ["oct", 9], ["nov", 10], ["dec", 11],
]);

/** Parse a date phrase to epoch ms (UTC midnight). NaN when unparseable.
 *  Port of the bridge's parseDatePhrase. */
export function parseDatePhrase(dateText: string): number {
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

// ─── Natural comparison (deterministic tiebreaks) ────────────────────────────

/** Numeric-aware string comparison so "doc#turn-10" sorts after "doc#turn-2"
 *  and "e0063" before "e0064". Generic — no assumption about ID shapes. */
export function compareNaturally(a: string, b: string): number {
  const ax = a.match(/\d+|\D+/g) ?? [a];
  const bx = b.match(/\d+|\D+/g) ?? [b];
  const n = Math.min(ax.length, bx.length);
  for (let i = 0; i < n; i++) {
    const as = ax[i]!;
    const bs = bx[i]!;
    const an = /^\d/.test(as) ? Number.parseInt(as, 10) : Number.NaN;
    const bn = /^\d/.test(bs) ? Number.parseInt(bs, 10) : Number.NaN;
    if (Number.isFinite(an) && Number.isFinite(bn)) {
      if (an !== bn) return an - bn;
    } else if (as !== bs) {
      return as < bs ? -1 : 1;
    }
  }
  return ax.length - bx.length;
}

// ─── Chronicle assembly ──────────────────────────────────────────────────────

export interface ChronicleEntry {
  shardId: string;
  snapshotId: string;
  eventId: string;
  /** ISO calendar date (YYYY-MM-DD) from the event's createdAt, else null. */
  date: string | null;
  /** Term-centered excerpt of the event content. */
  line: string;
  /** Term-overlap score that selected this entry (0 for pure spread picks). */
  score: number;
}

export interface AssembleChronicleArgs {
  query: string;
  intent: QueryIntent;
  /** Already-loaded snapshots in scope. `ask()` passes the probed candidates'
   *  snapshots (zero extra storage loads); the bridge/baseline may pass all
   *  shards to reproduce the capsule's includeAllShards behaviour until the
   *  T2 router lands. */
  snapshots: MemoryShardSnapshot[];
  /** Probe-identified event IDs (router/probe footholds). Their CONTENT
   *  expands the term set — the q04 class ("what database backs the core
   *  service?") only resolves through foothold vocabulary (postgres/aurora),
   *  never through the query's own words. */
  footholdEventIds?: string[];
  /** Hard cap on returned entries. Default via resolveCoverageMaxEntries. */
  maxEntries?: number;
  /** Soft token cap across all lines; lowest-score entries dropped first. */
  maxTimelineTokens?: number;
  /** Per-shard bucket count for timeline-spread selection. */
  bucketCount?: number;
  /** Term-anchored picks per bucket. */
  perBucket?: number;
  /** Max self-discovered seed events used for term expansion. */
  seedLimit?: number;
  /** Max excerpt length per line, in chars. */
  maxLineChars?: number;
  /** Force the breadth-spread phase even when the intent facets wouldn't
   *  (used for starvation recovery on point queries). */
  forceSpread?: boolean;
  /** Expansion terms appearing in more than this fraction of scoped events
   *  are dropped as corpus boilerplate (see filterTermsByDf). */
  maxSeedTermDfRatio?: number;
}

interface ScopedEvent {
  shardId: string;
  snapshotId: string;
  event: MemoryEvent;
  timeMs: number; // NaN when createdAt unparseable
}

/**
 * Deterministic chronicle assembler. Selection has three phases:
 *
 *   A. Term-anchored bucket picks (precision + chronological spread): each
 *      shard's events are date-sorted and divided into `bucketCount` buckets;
 *      the top `perBucket` term-scoring events per bucket are picked. Port of
 *      the bridge's selectChronologicalCoverageIds.
 *   B. Global score top-up (precision): remaining slots fill with the best
 *      term-scoring unpicked events across all shards. This is what recovers
 *      tight gold clusters that phase A's per-bucket cap clips (q04's
 *      e0011–e0014 sit in adjacent buckets of one shard).
 *   C. Breadth spread (recall): for summary/aggregation intents (or
 *      forceSpread), remaining slots fill with evenly-spaced events across
 *      the global date-sorted list — port of spreadAcrossTimeline — so a
 *      summary timeline never collapses onto one hot cluster.
 *
 * Terms come from the query plus footholds plus self-discovered seeds (top
 * query-term scorers), never from hardcoded domain tables.
 *
 * Output is globally date-ordered (undated last), deduped, capped, and every
 * entry carries shardId/snapshotId/eventId for full citation discipline.
 */
export function assembleChronicle(args: AssembleChronicleArgs): ChronicleEntry[] {
  const {
    query,
    intent,
    snapshots,
    footholdEventIds = [],
    maxEntries = resolveCoverageMaxEntries(intent),
    maxTimelineTokens = DEFAULT_TIMELINE_TOKENS,
    bucketCount = 12,
    perBucket = 2,
    seedLimit = 6,
    maxLineChars = 160,
    forceSpread = false,
    maxSeedTermDfRatio = 0.25,
  } = args;

  if (snapshots.length === 0 || maxEntries <= 0) return [];

  // Scope: all events of all provided snapshots, with parsed timestamps.
  const scoped: ScopedEvent[] = [];
  // Events are keyed by (shardId, eventId), never by eventId alone: durable
  // store ids are per-shard sequences (`e_0001` exists in every shard), so a
  // bare-id key collided across shards on any multi-shard `csm ask` --
  // scoring one shard's event with another's token set and collapsing
  // distinct events (audit 2026-09-05). Probe footholds still arrive as bare
  // ids; `byBareId` resolves one to every shard that has it.
  const keyOf = (item: ScopedEvent): string => `${item.shardId}\u001f${item.event.eventId}`;
  const byBareId = new Map<string, ScopedEvent[]>();
  for (const snap of [...snapshots].sort((a, b) => compareNaturally(a.shardId, b.shardId))) {
    for (const event of snap.events) {
      const item: ScopedEvent = {
        shardId: snap.shardId,
        snapshotId: snap.snapshotId,
        event,
        timeMs: event.createdAt ? Date.parse(event.createdAt) : Number.NaN,
      };
      scoped.push(item);
      const arr = byBareId.get(event.eventId);
      if (arr) arr.push(item);
      else byBareId.set(event.eventId, [item]);
    }
  }
  if (scoped.length === 0) return [];

  // Token sets over content + tags (tags carry exactly the routing signal
  // the probe/router already trust), shared by IDF weighting and scoring.
  const tokenSets = scoped.map((item) =>
    tokenSetOf(`${item.event.content} ${item.event.tags.join(" ")}`),
  );
  const n = tokenSets.length;
  const idfCache = new Map<string, number>();
  const idf = (term: string): number => {
    const hit = idfCache.get(term);
    if (hit !== undefined) return hit;
    let df = 0;
    for (const set of tokenSets) {
      if (set.has(term)) df++;
    }
    const value = Math.log((n + 1) / (df + 0.5));
    idfCache.set(term, value);
    return value;
  };
  /** IDF-weighted lexical score of event #ix against `terms`, with the
   *  query's proper-noun anchors boosted and a small locality bonus for
   *  events living in a probe-verified (foothold) shard — the same trust
   *  the shard-local expansion stack in the baseline already encodes.
   *  Statistics handle boilerplate and generic vocabulary; the anchor boost
   *  handles topic identification — no length heuristics, no domain tables. */
  const anchored = extractAnchoredTerms(query);
  const footholdShardIds = new Set(
    footholdEventIds.flatMap((id) => (byBareId.get(id) ?? []).map((item) => item.shardId)),
  );
  const scoreAt = (ix: number, terms: string[]): number => {
    const set = tokenSets[ix]!;
    let score = 0;
    for (const term of terms) {
      if (set.has(term)) score += idf(term) * (anchored.has(term) ? ANCHOR_BOOST : 1);
    }
    if (score > 0 && footholdShardIds.has(scoped[ix]!.shardId)) {
      score += FOOTHOLD_SHARD_BONUS;
    }
    return score;
  };
  const indexByKey = new Map<string, number>();
  scoped.forEach((item, ix) => indexByKey.set(keyOf(item), ix));

  // Terms: query → footholds → self-discovered seeds.
  const queryTerms = extractCoverageTerms(query, 16);
  const footholdItems = footholdEventIds.flatMap((id) => byBareId.get(id) ?? []);
  const querySeeds =
    queryTerms.length > 0
      ? scoped
          .map((item, ix) => ({ item, score: scoreAt(ix, queryTerms) }))
          .filter((s) => s.score > 0)
          .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return compareNaturally(a.item.event.eventId, b.item.event.eventId);
          })
          .slice(0, seedLimit)
          .map((s) => s.item)
      : [];
  // Expansion terms: per-seed TF-IDF ranking, then weighted ROUND-ROBIN
  // across seeds. Pooled mining lets one off-topic seed poison the whole
  // set — a leak postmortem that mentions "Bun" once is long and
  // vocabulary-coherent, so its s3/terraform terms would dominate a pooled
  // TF ranking and redirect the entire chronicle. Per-seed slots bound any
  // single seed's influence. FOOTHOLDS are probe-verified evidence and get
  // double slots; query seeds are self-discovered guesses and get one.
  // Query terms are never filtered.
  interface SeedList {
    ranked: string[];
    cursor: number;
    perRound: number;
  }
  const seedLists: SeedList[] = [];
  const seedSeen = new Set<string>();
  const pushSeed = (item: ScopedEvent, perRound: number): void => {
    if (seedSeen.has(keyOf(item))) return;
    seedSeen.add(keyOf(item));
    const content = item.event.content.slice(0, SEED_CONTENT_CHARS);
    const seedIx = indexByKey.get(keyOf(item));
    const ranked = rankExpansionTerms(
      // 128-candidate cap: the cap is pre-RANKING, so a tight cap silently
      // drops topic vocabulary that appears late in the seed's text
      // ("Postgres" at the end of the Aurora foothold). Ranking, not
      // position, must decide.
      extractCoverageTerms(content, 128).filter((t) => !queryTerms.includes(t)),
      tokenListOf(content),
      tokenSets,
      maxSeedTermDfRatio,
    );
    // Association support: below the seed's top-3 topic terms, TF-IDF
    // degenerates into pure rarity and surfaces idiosyncratic prose words
    // ("matters", "happily"). A term is CLUSTER vocabulary only if it
    // co-occurs with a topic anchor (query term or seed top-3) in at least
    // one event other than the seed itself; everything else is seed-private
    // noise and is cut. Proper nouns in the seed (capitalized mid-sentence,
    // ALL-CAPS — "Aurora", "RDS") bypass the support requirement: they are
    // self-evidently topical and small/low-redundancy scopes can't always
    // supply a second co-occurrence. Deterministic co-occurrence statistics
    // — still no hardcoded vocabulary.
    const anchorsForSeed = [...queryTerms, ...ranked.slice(0, 3)];
    const anchoredInSeed = extractAnchoredTerms(content);
    const validated = ranked.filter((term, rank) => {
      if (rank < 3) return true;
      if (anchoredInSeed.has(term)) return true;
      for (let ix = 0; ix < tokenSets.length; ix++) {
        if (ix === seedIx) continue;
        const set = tokenSets[ix]!;
        if (!set.has(term)) continue;
        for (const anchor of anchorsForSeed) {
          if (anchor !== term && set.has(anchor)) return true;
        }
      }
      return false;
    });
    seedLists.push({ ranked: validated, cursor: 0, perRound });
  };
  for (const item of footholdItems) pushSeed(item, 2);
  for (const item of querySeeds) pushSeed(item, 1);

  // Seed-coherence pruning, two regimes:
  //
  // WITH footholds (probe-verified interpretation): query seeds whose top
  // vocabulary shares nothing with the footholds' are competing
  // interpretations the probe already rejected ("database?" could mean the
  // monolith debate, auth storage, or migrations — the foothold says it's
  // the Aurora cluster). Drop them; the foothold storyline owns expansion.
  // This is the router-trust philosophy applied to term mining.
  //
  // WITHOUT footholds: majority quorum. When most seeds share vocabulary
  // (one storyline), a zero-overlap seed is an off-topic interloper (the
  // q27 case: one leak postmortem matched "early"+"Bun" while five seeds
  // told the Bun-adoption story) — drop it. When no coherent group exists,
  // every interpretation stays.
  const topsOf = (list: SeedList): Set<string> => new Set(list.ranked.slice(0, 12));
  const overlapsAny = (a: Set<string>, b: Set<string>): boolean => {
    for (const term of a) {
      if (b.has(term)) return true;
    }
    return false;
  };
  if (footholdItems.length > 0) {
    const reference = new Set<string>();
    for (const list of seedLists) {
      if (list.perRound !== 2) continue; // foothold lists
      for (const term of topsOf(list)) reference.add(term);
    }
    if (reference.size > 0) {
      for (let i = seedLists.length - 1; i >= 0; i--) {
        const list = seedLists[i]!;
        if (list.perRound === 2) continue;
        if (!overlapsAny(topsOf(list), reference)) seedLists.splice(i, 1);
      }
    }
  } else if (seedLists.length >= 3) {
    const tops = seedLists.map(topsOf);
    const overlaps = tops.map((set, i) => {
      let count = 0;
      tops.forEach((other, j) => {
        if (i !== j && overlapsAny(set, other)) count++;
      });
      return count;
    });
    const groupSize = overlaps.filter((c) => c >= 1).length;
    if (groupSize >= Math.ceil(seedLists.length / 2) + 1) {
      for (let i = seedLists.length - 1; i >= 0; i--) {
        if (overlaps[i] === 0) seedLists.splice(i, 1);
      }
    }
  }

  // Adaptive expansion size: foothold vocabularies are probe-verified, so
  // when footholds exist (few, trusted seeds) a deeper term set is safe and
  // necessary — one foothold's rank-13+ terms ("postgres", "serverless")
  // are often exactly the cluster vocabulary. Self-discovered-only seeds
  // stay at the tighter default.
  const maxExpansionTerms = Math.min(
    24,
    MAX_EXPANSION_TERMS + 6 * footholdItems.length,
  );
  const expansionTerms: string[] = [];
  const expansionSeen = new Set<string>();
  while (expansionTerms.length < maxExpansionTerms) {
    let any = false;
    for (const list of seedLists) {
      let taken = 0;
      while (taken < list.perRound && list.cursor < list.ranked.length) {
        const term = list.ranked[list.cursor]!;
        list.cursor++;
        if (expansionSeen.has(term)) continue;
        expansionSeen.add(term);
        expansionTerms.push(term);
        taken++;
        any = true;
        if (expansionTerms.length >= maxExpansionTerms) break;
      }
      if (expansionTerms.length >= maxExpansionTerms) break;
    }
    if (!any) break;
  }
  let terms = dedupeInOrder([...queryTerms, ...expansionTerms]).slice(0, 48);

  // Second-hop expansion (the entity-bridge pattern, bounded at depth 2),
  // FOOTHOLD MODE ONLY: a single probe-verified foothold cannot name every
  // cluster term — "serverless" lives in the events the FIRST hop
  // retrieves, not in the Aurora foothold itself. Take the top HOP2_SEEDS
  // first-hop hits that were not seeds, mine their vocabulary under the
  // same validation, and append up to HOP2_TERMS. Without footholds the
  // multi-seed first hop already covers the storyline and a second hop only
  // adds drift (measured on PaySwift q27: 11→9 gold), so it stays off.
  if (footholdItems.length > 0 && terms.length > 0 && expansionTerms.length > 0) {
    const hop1Top = scoped
      .map((item, ix) => ({ item, ix, score: scoreAt(ix, terms) }))
      .filter((s) => s.score > 0 && !seedSeen.has(keyOf(s.item)))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return compareNaturally(a.item.event.eventId, b.item.event.eventId);
      })
      .slice(0, HOP2_SEEDS);
    const hop2Anchors = [...queryTerms, ...expansionTerms.slice(0, 6)];
    const hop2: string[] = [];
    const hop2Seen = new Set<string>(terms);
    for (const { item, ix } of hop1Top) {
      const content = item.event.content.slice(0, SEED_CONTENT_CHARS);
      const ranked = rankExpansionTerms(
        extractCoverageTerms(content, 128).filter((t) => !hop2Seen.has(t)),
        tokenListOf(content),
        tokenSets,
        maxSeedTermDfRatio,
      ).filter((term) => {
        for (let other = 0; other < tokenSets.length; other++) {
          if (other === ix) continue;
          const set = tokenSets[other]!;
          if (!set.has(term)) continue;
          for (const anchor of hop2Anchors) {
            if (anchor !== term && set.has(anchor)) return true;
          }
        }
        return false;
      });
      for (const term of ranked.slice(0, 2)) {
        if (hop2Seen.has(term)) continue;
        hop2Seen.add(term);
        hop2.push(term);
        if (hop2.length >= HOP2_TERMS) break;
      }
      if (hop2.length >= HOP2_TERMS) break;
    }
    terms = dedupeInOrder([...terms, ...hop2]).slice(0, 48);
  }

  const chrono = (a: ScopedEvent, b: ScopedEvent): number => {
    const aOk = Number.isFinite(a.timeMs);
    const bOk = Number.isFinite(b.timeMs);
    if (aOk && bOk && a.timeMs !== b.timeMs) return a.timeMs - b.timeMs;
    if (aOk !== bOk) return aOk ? -1 : 1; // undated last
    const byShard = compareNaturally(a.shardId, b.shardId);
    if (byShard !== 0) return byShard;
    return compareNaturally(a.event.eventId, b.event.eventId);
  };

  const picked = new Map<string, { item: ScopedEvent; score: number }>();
  const pick = (item: ScopedEvent, score: number): void => {
    const k = keyOf(item);
    const prior = picked.get(k);
    if (!prior || score > prior.score) picked.set(k, { item, score });
  };

  // Phase 0 — footholds are probe-verified evidence: always included.
  for (const item of footholdItems) {
    const ix = indexByKey.get(keyOf(item));
    pick(item, ix === undefined ? 0 : scoreAt(ix, terms));
  }

  // Phase A — per-shard, per-bucket term-anchored picks.
  const byShard = new Map<string, ScopedEvent[]>();
  for (const item of scoped) {
    const arr = byShard.get(item.shardId);
    if (arr) arr.push(item);
    else byShard.set(item.shardId, [item]);
  }
  const shardIds = [...byShard.keys()].sort(compareNaturally);
  for (const shardId of shardIds) {
    const events = [...(byShard.get(shardId) ?? [])].sort(chrono);
    const bucketSize = Math.max(1, Math.ceil(events.length / bucketCount));
    for (let start = 0; start < events.length; start += bucketSize) {
      const bucket = events.slice(start, start + bucketSize);
      const winners = bucket
        .map((item) => ({ item, score: scoreAt(indexByKey.get(keyOf(item))!, terms) }))
        .filter((s) => s.score > 0)
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return chrono(a.item, b.item);
        })
        .slice(0, perBucket);
      for (const w of winners) pick(w.item, w.score);
    }
  }

  // Phase B — global top scorers ALWAYS join the candidate pool (top
  // maxEntries of them). Buckets guarantee chronological spread but clip
  // tight gold clusters (PaySwift q04: e0011–e0014 are minutes apart, so
  // perBucket=2 dropped two of them despite top-10 global scores). The
  // final score-ranked cap arbitrates between spread picks and top scorers.
  {
    const remaining = scoped
      .filter((item) => !picked.has(keyOf(item)))
      .map((item) => ({ item, score: scoreAt(indexByKey.get(keyOf(item))!, terms) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return chrono(a.item, b.item);
      })
      .slice(0, maxEntries);
    for (const s of remaining) pick(s.item, s.score);
  }

  // Phase C — breadth spread for summary/aggregation (or forced).
  const spread = forceSpread || intent.facets.summary || intent.facets.aggregation;
  if (spread && picked.size < maxEntries) {
    const all = [...scoped].sort(chrono);
    const want = maxEntries - picked.size;
    for (let i = 0; i < want && all.length > 0; i++) {
      const ix = want === 1 ? 0 : Math.round((i * (all.length - 1)) / (want - 1));
      const item = all[ix];
      if (item && !picked.has(keyOf(item))) pick(item, 0);
    }
    // Fill any duplicate-index gaps with the earliest unpicked events.
    for (const item of all) {
      if (picked.size >= maxEntries) break;
      if (!picked.has(keyOf(item))) pick(item, 0);
    }
  }

  // Final ordering + caps.
  let selected = [...picked.values()].sort((a, b) => chrono(a.item, b.item));
  if (selected.length > maxEntries) {
    // Keep highest-score entries, then earliest; re-sort chronologically.
    selected = [...selected]
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return chrono(a.item, b.item);
      })
      .slice(0, maxEntries)
      .sort((a, b) => chrono(a.item, b.item));
  }

  let entries = selected.map(({ item, score }) => toEntry(item, score, terms, maxLineChars));

  // Token cap: drop lowest-score (then latest) entries until within budget.
  if (Number.isFinite(maxTimelineTokens) && maxTimelineTokens > 0) {
    const tokensOf = (e: ChronicleEntry): number =>
      estimateTokens(`${e.date ?? "undated"} ${e.shardId}@${e.snapshotId}:${e.eventId} ${e.line}`);
    let total = entries.reduce((sum, e) => sum + tokensOf(e), 0);
    if (total > maxTimelineTokens) {
      const dropOrder = [...entries].sort((a, b) => {
        if (a.score !== b.score) return a.score - b.score; // lowest score first
        const ad = a.date ?? "9999-99-99";
        const bd = b.date ?? "9999-99-99";
        if (ad !== bd) return ad < bd ? 1 : -1; // latest first
        return compareNaturally(b.eventId, a.eventId);
      });
      const entryKey = (e: ChronicleEntry): string => `${e.shardId}\u001f${e.eventId}`;
      const dropped = new Set<string>();
      for (const e of dropOrder) {
        if (total <= maxTimelineTokens) break;
        dropped.add(entryKey(e));
        total -= tokensOf(e);
      }
      entries = entries.filter((e) => !dropped.has(entryKey(e)));
    }
  }

  return entries;
}

function toEntry(
  item: ScopedEvent,
  score: number,
  terms: string[],
  maxLineChars: number,
): ChronicleEntry {
  const date =
    Number.isFinite(item.timeMs) && item.event.createdAt
      ? item.event.createdAt.slice(0, 10)
      : null;
  return {
    shardId: item.shardId,
    snapshotId: item.snapshotId,
    eventId: item.event.eventId,
    date,
    line: termCenteredExcerpt(item.event.content, terms, maxLineChars),
    score,
  };
}

/** Excerpt centered on the strongest term hit (port of the bridge's
 *  relevantExcerpt, minus the HIGH_SIGNAL_TERMS table). */
export function termCenteredExcerpt(
  content: string,
  terms: string[],
  maxChars: number,
): string {
  const clean = content.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  const low = clean.toLowerCase();
  let hit = -1;
  let hitWeight = -1;
  for (const term of terms) {
    const ix = low.indexOf(term.toLowerCase());
    if (ix === -1) continue;
    const weight = Math.min(40, term.length);
    if (weight > hitWeight || (weight === hitWeight && (hit === -1 || ix < hit))) {
      hit = ix;
      hitWeight = weight;
    }
  }
  const center = hit === -1 ? 0 : hit;
  const start = Math.max(0, center - Math.floor(maxChars / 3));
  const end = Math.min(clean.length, start + maxChars);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < clean.length ? "…" : "";
  return `${prefix}${clean.slice(start, end).trim()}${suffix}`;
}

/** Convert chronicle entries to packet timeline entries (full citations). */
export function timelineFromChronicle(entries: ChronicleEntry[]): MemoryPacketTimelineEntry[] {
  return entries.map((e) => ({
    date: e.date,
    eventRef: `${e.shardId}@${e.snapshotId}:${e.eventId}`,
    line: e.line,
  }));
}

// ─── Temporal arithmetic (deterministic; never LLM date math) ────────────────

export interface TemporalRelation {
  fromRef: string;
  fromDate: string;
  toRef: string;
  toDate: string;
  days: number;
  claim: string;
}

interface DateAnchor {
  item: ScopedEvent;
  dateText: string;
  timeMs: number;
  score: number;
}

/**
 * Deterministic date-anchor pairing + day arithmetic. Port of the bridge's
 * buildTemporalRelationLine / collectTemporalDateAnchors /
 * selectSegmentMatchedTemporalPair. Anchors come from date phrases inside
 * event CONTENT (falling back to createdAt when content has none), scored by
 * query+foothold terms; "between X and Y" queries pick one anchor per
 * segment. Returns null when fewer than two distinct-dated anchors exist.
 */
export function computeTemporalRelation(args: {
  query: string;
  snapshots: MemoryShardSnapshot[];
  footholdEventIds?: string[];
}): TemporalRelation | null {
  const { query, snapshots, footholdEventIds = [] } = args;
  const scoped: ScopedEvent[] = snapshots.flatMap((snap) =>
    snap.events.map((event) => ({
      shardId: snap.shardId,
      snapshotId: snap.snapshotId,
      event,
      timeMs: event.createdAt ? Date.parse(event.createdAt) : Number.NaN,
    })),
  );
  if (scoped.length === 0) return null;

  const queryTerms = extractCoverageTerms(query, 16);
  const byId = new Map(scoped.map((item) => [item.event.eventId, item] as const));
  const footholdText = footholdEventIds
    .map((id) => byId.get(id)?.event.content.slice(0, SEED_CONTENT_CHARS) ?? "")
    .join(" ");
  const tokenSets = scoped.map((item) => tokenSetOf(item.event.content));
  const expansionTerms = footholdText
    ? rankExpansionTerms(
        extractCoverageTerms(footholdText, 64).filter((t) => !queryTerms.includes(t)),
        tokenListOf(footholdText),
        tokenSets,
      ).slice(0, MAX_EXPANSION_TERMS)
    : [];
  const terms = dedupeInOrder([...queryTerms, ...expansionTerms]).slice(0, 48);

  const anchors: DateAnchor[] = [];
  const seen = new Set<string>();
  for (const item of scoped) {
    const score = scoreEventCoverage(item.event.content, terms);
    let dates = dedupeInOrder(extractDatePhrases(item.event.content));
    if (dates.length === 0 && Number.isFinite(item.timeMs) && item.event.createdAt) {
      dates = [item.event.createdAt.slice(0, 10)];
    }
    for (const dateText of dates) {
      const parsed = parseDatePhrase(dateText);
      if (!Number.isFinite(parsed)) continue;
      const key = `${item.event.eventId}:${parsed}`;
      if (seen.has(key)) continue;
      seen.add(key);
      anchors.push({ item, dateText, timeMs: parsed, score });
    }
  }
  const ranked = anchors.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.timeMs !== b.timeMs) return a.timeMs - b.timeMs;
    return compareNaturally(a.item.event.eventId, b.item.event.eventId);
  });
  if (ranked.length < 2) return null;

  const segments = extractBetweenSegmentTerms(query);
  const pair = segments
    ? selectSegmentMatchedPair(ranked, segments)
    : selectTopPair(ranked);
  if (!pair) return null;

  const [first, second] = pair[0].timeMs <= pair[1].timeMs ? pair : [pair[1], pair[0]];
  const days = Math.round(Math.abs(second.timeMs - first.timeMs) / (24 * 60 * 60 * 1000));
  const fromRef = `${first.item.shardId}@${first.item.snapshotId}:${first.item.event.eventId}`;
  const toRef = `${second.item.shardId}@${second.item.snapshotId}:${second.item.event.eventId}`;
  const dayLabel = days === 1 ? "day" : "days";
  return {
    fromRef,
    fromDate: first.dateText,
    toRef,
    toDate: second.dateText,
    days,
    claim: `Temporal calculation (deterministic date arithmetic from cited events): from ${first.dateText} [${fromRef}] to ${second.dateText} [${toRef}] = ${days} ${dayLabel}.`,
  };
}

/** Package a TemporalRelation as a fully-cited packet claim. Confidence 0.95:
 *  the arithmetic is exact, but date EXTRACTION from prose can mis-anchor. */
export function temporalRelationToClaim(rel: TemporalRelation): MemoryPacketClaim {
  return { claim: rel.claim, sources: [rel.fromRef, rel.toRef], confidence: 0.95 };
}

/**
 * RESOLVED (audit F6): the AMB bridge used to carry a diverging copy of this
 * (extract-then-EXPAND against a hardcoded synonym table). The bridge now routes
 * through `extractCoverageTerms`, so both paths derive the same terms.
 */
function extractBetweenSegmentTerms(query: string): [string[], string[]] | null {
  const normalized = query.replace(/\s+/g, " ").trim();
  const match = normalized.match(
    /\bbetween\s+(?:when\s+)?(.+?)\s+and\s+(?:when\s+)?(.+?)(?:[?.!]|$)/i,
  );
  if (!match) return null;
  const left = extractCoverageTerms(match[1] ?? "", 16);
  const right = extractCoverageTerms(match[2] ?? "", 16);
  if (left.length === 0 || right.length === 0) return null;
  return [left, right];
}

function selectSegmentMatchedPair(
  anchors: DateAnchor[],
  segments: [string[], string[]],
): [DateAnchor, DateAnchor] | null {
  const first = bestAnchorForTerms(anchors, segments[0]);
  const second = bestAnchorForTerms(
    anchors.filter((a) => a.item.event.eventId !== first?.item.event.eventId),
    segments[1],
  );
  if (first && second && first.timeMs !== second.timeMs) return [first, second];
  return selectTopPair(anchors);
}

function bestAnchorForTerms(anchors: DateAnchor[], terms: string[]): DateAnchor | null {
  const scored = anchors
    .map((anchor) => ({ anchor, score: scoreEventCoverage(anchor.item.event.content, terms) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.anchor.score !== a.anchor.score) return b.anchor.score - a.anchor.score;
      return a.anchor.timeMs - b.anchor.timeMs;
    });
  return scored[0]?.anchor ?? null;
}

function selectTopPair(anchors: DateAnchor[]): [DateAnchor, DateAnchor] | null {
  for (let i = 0; i < anchors.length; i++) {
    for (let j = i + 1; j < anchors.length; j++) {
      if (anchors[i]!.item.event.eventId === anchors[j]!.item.event.eventId) continue;
      if (anchors[i]!.timeMs === anchors[j]!.timeMs) continue;
      return [anchors[i]!, anchors[j]!];
    }
  }
  return null;
}

// ─── Packet helpers ──────────────────────────────────────────────────────────

/** Parse "shard_id@snapshot_id:event_id". Uses the FIRST colon after the "@"
 *  (snapshot IDs are colon-free by construction; event IDs may not be). */
export function parseEventRef(
  ref: string,
): { shardId: string; snapshotId: string; eventId: string } | null {
  const at = ref.indexOf("@");
  if (at <= 0) return null;
  const rest = ref.slice(at + 1);
  const colon = rest.indexOf(":");
  if (colon <= 0 || colon === rest.length - 1) return null;
  return {
    shardId: ref.slice(0, at),
    snapshotId: rest.slice(0, colon),
    eventId: rest.slice(colon + 1),
  };
}

/** Distinct event IDs cited by the packet's key claims (sources of the form
 *  "shard@snap:event"). Drives the starvation trigger. */
export function countCitedEvents(packet: MemoryPacket): number {
  const ids = new Set<string>();
  for (const claim of packet.keyClaims) {
    for (const src of claim.sources) {
      const parsed = parseEventRef(src);
      if (parsed) ids.add(parsed.eventId);
    }
  }
  return ids.size;
}

/** Event IDs referenced by a packet timeline, in timeline order. */
export function collectTimelineEventIds(packet: MemoryPacket): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of packet.timeline ?? []) {
    const parsed = parseEventRef(entry.eventRef);
    if (!parsed || seen.has(parsed.eventId)) continue;
    seen.add(parsed.eventId);
    out.push(parsed.eventId);
  }
  return out;
}

// ─── Budgets & flags ─────────────────────────────────────────────────────────

/** Default recall event-digest budget for coverage-shaped queries. Token
 *  math against the 8,192-token AMB internal-model cap
 *  (CSM_AMB_MODEL_CONTEXT):
 *    SHARD_SYSTEM_PROMPT ~140 + shard header/summary ~80
 *    + digest 3,200 + recall prompt ~450  ≈ 3,870 input tokens
 *  — 4.3K headroom per recall call. At ~125–150 tokens per digest line this
 *  fits 21–26 events/shard, vs ~8–10 at the default 1,200 (which starves
 *  13-gold-event answers like PaySwift q27). Synth worst case (4 recalls ×
 *  ~900 output tokens + prompt ~500 ≈ 4.1K) also stays under the cap. */
export const DEFAULT_COVERAGE_RECALL_TOKENS = 3200;

/** Default soft token cap for the packet timeline (~24 lines × ~45 tokens). */
export const DEFAULT_TIMELINE_TOKENS = 1400;

/** Coverage mode flag — default ON since 2026-06-10 (`CSM_COVERAGE=0`
 *  restores the pre-coverage pipeline byte-identically). Gates passed (see
 *  docs/experiments/EXP-T1-coverage.md §results): PaySwift q04 0/3→3/3 with
 *  the apparent q01/q03 flips shown to be single-trial variance (3/3 in both
 *  arms), +2.8% pipeline input tokens, latency flat; BEAM-slice retrieved
 *  gold coverage +0.179/+0.182 (event_ordering/summarization, CIs
 *  non-overlapping) and returned cov@24 +0.184 on event_ordering once the
 *  bridge consumed the chronicle. */
export function resolveCoverageMode(raw = process.env.CSM_COVERAGE): boolean {
  return envFlag(raw, { name: "CSM_COVERAGE", fallback: true });
}

/** Intent-conditional recall digest budget. Point lookups keep `base`
 *  unchanged (byte-identical); coverage queries get the bigger digest. */
export function resolveCoverageRecallTokens(
  intent: QueryIntent,
  base = 1200,
  raw = process.env.CSM_COVERAGE_RECALL_TOKENS,
): number {
  if (intent.kind !== "coverage") return base;
  return envPositiveInt(raw, {
    name: "CSM_COVERAGE_RECALL_TOKENS",
    fallback: DEFAULT_COVERAGE_RECALL_TOKENS,
  });
}

/** Intent-conditional timeline size. Ordering/temporal queries get 32
 *  (mirrors the bridge's CSM_AMB_REASONING_RETURN_K), summary/aggregation 24
 *  (mirrors CSM_AMB_SUMMARY_RETURN_K / capsule summary snippets). Starvation
 *  recovery gets 32 — breadth is the whole point of the recovery net. */
export function resolveCoverageMaxEntries(
  intent: QueryIntent,
  raw = process.env.CSM_COVERAGE_MAX_ENTRIES,
  starvation = false,
): number {
  const fallback =
    starvation || intent.facets.ordering || intent.facets.temporalArithmetic
      ? 32
      : 24;
  return envPositiveInt(raw, { name: "CSM_COVERAGE_MAX_ENTRIES", fallback });
}

/**
 * Coverage orchestration for `ask()` — the whole merge-window integration is
 * "compute intent, swap the recall token budget, call this once after the
 * packet is built". Read-only: consumes already-loaded snapshots, performs
 * no I/O and no LLM calls, returns a NEW packet (never mutates the input).
 *
 * Fires in two regimes:
 *  - intent mode: the query is coverage-shaped (summary/ordering/temporal/
 *    aggregation) — attach a chronicle timeline (and, for temporal
 *    arithmetic, a deterministic date-difference claim with full citations).
 *  - starvation mode: a point query whose packet cites fewer than the
 *    starvation floor of distinct events (the q04 class: right shard probed,
 *    recall conservative) — run the assembler as a recovery net with
 *    breadth spread.
 */
export function attachCoverage(args: {
  query: string;
  intent: QueryIntent;
  packet: MemoryPacket;
  snapshots: MemoryShardSnapshot[];
  /** Probe-identified event IDs (footholds). */
  probeFootholdEventIds?: string[];
}): MemoryPacket {
  const { query, intent, packet, snapshots, probeFootholdEventIds = [] } = args;
  const starvation = intent.kind !== "coverage";
  if (starvation) {
    const floor = resolveCoverageStarvationFloor();
    if (floor <= 0 || countCitedEvents(packet) >= floor) return packet;
  }
  if (snapshots.length === 0) return packet;

  const chronicle = assembleChronicle({
    query,
    intent,
    snapshots,
    footholdEventIds: probeFootholdEventIds,
    maxEntries: resolveCoverageMaxEntries(intent, undefined, starvation),
    forceSpread: starvation,
  });
  if (chronicle.length === 0) return packet;

  let keyClaims = packet.keyClaims;
  if (intent.facets.temporalArithmetic) {
    const rel = computeTemporalRelation({
      query,
      snapshots,
      footholdEventIds: probeFootholdEventIds,
    });
    if (rel) keyClaims = [temporalRelationToClaim(rel), ...keyClaims];
  }
  return { ...packet, keyClaims, timeline: timelineFromChronicle(chronicle) };
}

/** Starvation floor: when coverage mode is on and a POINT query's packet
 *  cites fewer than this many distinct events, the chronicle assembler runs
 *  as a recovery net (the q04 class: right shard probed, recall conservative,
 *  0–2 events cited). 0 disables. */
export function resolveCoverageStarvationFloor(
  raw = process.env.CSM_COVERAGE_STARVATION_FLOOR,
): number {
  // 0 is a meaningful "disabled", so min is 0 rather than envPositiveInt's 1.
  return envInt(raw, { name: "CSM_COVERAGE_STARVATION_FLOOR", fallback: 4, min: 0 });
}

// ─── small helpers ───────────────────────────────────────────────────────────


