import { tokenize } from "./router.js";
import { estimateTokens } from "./tokenBudget.js";
import { envFlag } from "../utils/env.js";
import { truncate } from "../utils/text.js";

/**
 * Minimal event shape the digest builder needs. `MemoryEvent` (src/core/types.ts)
 * is structurally assignable; the benchmark harness maps `BenchEvent` into this
 * same shape via the production `toMemoryEvent` rules.
 */
export interface DigestEvent {
  eventId: string;
  role: string;
  content: string;
  createdAt?: string;
  tags: string[];
}

export interface SelectEventDigestOptions {
  /** Hard cap on event-digest input tokens (production default 1200). */
  maxTokens: number;
  /** Per-event content character cap (production default 480). */
  perEventChars?: number;
  /** Probe hint: when present, these event IDs are prioritised first. */
  hint?: string[];
  /**
   * Signals lever #1 — re-rank candidates by query-term salience before the
   * budget pack (so a relevant event that would be cut by insertion order can
   * survive). Defaults false.
   */
  reorderBySalience?: boolean;
  /**
   * Signals lever #2 — replace blind head-truncation with salience-ranked
   * sentence selection inside each event's char budget (so an answer-bearing
   * clause past char `perEventChars` survives). Defaults false.
   */
  salientTruncation?: boolean;
  /** Required iff `reorderBySalience` or `salientTruncation` is set. */
  query?: string;
}

export interface EventDigestSelection {
  /** The rendered digest string. Byte-identical to the legacy builder in blind mode. */
  text: string;
  /** Event IDs whose line was kept, in emitted order (excludes the overflow marker). */
  selectedIds: string[];
  usedTokens: number;
  /** `candidates.length - keptLines` at the budget break, else 0. */
  droppedCount: number;
}

const DEFAULT_PER_EVENT_CHARS = 480;

/**
 * Build the per-shard event digest shown to the recall LLM.
 *
 * With `reorderBySalience` and `salientTruncation` both false (the default),
 * this reproduces the legacy `scopedEventDigest` byte-for-byte: hint-priority
 * (or insertion) order, blind 480-char head-truncation, greedy token-budget
 * pack, and the `(… N more events truncated)` overflow marker. The two flags
 * turn on the Signals levers; they are pure and deterministic, so the result is
 * replay-stable and safe to fold behind a versioned cache key.
 *
 * Protected citation tokens (`[eXXXX]`, role, date stamp) are always rendered
 * in the line prefix outside the scored/truncated span, so no salience pass can
 * drop or renumber them.
 */
export function selectEventDigest(
  events: readonly DigestEvent[],
  opts: SelectEventDigestOptions,
): EventDigestSelection {
  const perEventChars = opts.perEventChars ?? DEFAULT_PER_EVENT_CHARS;
  const salientMode = opts.reorderBySalience || opts.salientTruncation;
  if (salientMode && opts.query === undefined) {
    throw new Error("selectEventDigest: query is required when a salience lever is enabled");
  }
  const qTerms = salientMode ? new Set(tokenize(opts.query!)) : undefined;

  const candidates = orderCandidates(events, opts, qTerms);

  const lines: string[] = [];
  const selectedIds: string[] = [];
  let usedTokens = 0;
  let droppedCount = 0;
  for (const e of candidates) {
    const body = opts.salientTruncation
      ? salientWithinBudget(e.content, perEventChars, qTerms!)
      : truncate(e.content, perEventChars);
    const line = renderLine(e, body);
    const lineTokens = estimateTokens(line);
    if (usedTokens + lineTokens > opts.maxTokens) {
      droppedCount = candidates.length - lines.length;
      lines.push(`- (… ${droppedCount} more events truncated to fit budget)`);
      break;
    }
    lines.push(line);
    selectedIds.push(e.eventId);
    usedTokens += lineTokens;
  }
  return { text: lines.join("\n") || "(no events)", selectedIds, usedTokens, droppedCount };
}

/** Date-stamp + id/role prefix exactly as the legacy builder rendered it. */
function renderLine(e: DigestEvent, body: string): string {
  const day = e.createdAt ? e.createdAt.slice(0, 10) : "";
  return `- [${e.eventId}] (${e.role}${day ? ` ${day}` : ""}) ${body}${
    e.tags.length ? `  tags=[${e.tags.join(",")}]` : ""
  }`;
}

function orderCandidates(
  events: readonly DigestEvent[],
  opts: SelectEventDigestOptions,
  qTerms: Set<string> | undefined,
): DigestEvent[] {
  if (opts.reorderBySalience) {
    // Rank all candidates by query salience (stable: ties keep original order).
    const ranked = events
      .map((e, i) => ({ e, i, score: salienceScore(e, qTerms!) }))
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map((x) => x.e);
    if (!opts.hint || !opts.hint.length) return ranked;
    // The probe hint is production's safety net: hinted events ALWAYS lead (as in
    // blind mode), salience-ordered within each group. This guarantees salient
    // never demotes a probe-found event below an unhinted one — Pareto-safe vs
    // blind on hinted evidence, while still salience-ordering the unhinted tail.
    const hintSet = new Set(opts.hint);
    const inHint = ranked.filter((e) => hintSet.has(e.eventId));
    const outOfHint = ranked.filter((e) => !hintSet.has(e.eventId));
    return [...inHint, ...outOfHint];
  }
  if (opts.hint && opts.hint.length) {
    const hintSet = new Set(opts.hint);
    const inHint = events.filter((e) => hintSet.has(e.eventId));
    const outOfHint = events.filter((e) => !hintSet.has(e.eventId));
    return [...inHint, ...outOfHint];
  }
  return [...events];
}

/** Lexical salience: count of query terms present in the event content + tags. */
function salienceScore(e: DigestEvent, qTerms: Set<string>): number {
  const evTerms = new Set<string>([
    ...tokenize(e.content),
    ...e.tags.flatMap((t) => tokenize(t)),
  ]);
  let score = 0;
  for (const q of qTerms) if (evTerms.has(q)) score++;
  return score;
}

// Decision/quantity cue words that mark answer-bearing clauses. Kept small and
// deterministic; this is a lexical heuristic, not a model.
const HIGH_SIGNAL: RegExp[] = [
  /\bdecid/i,
  /\bapprov/i,
  /\blaunch/i,
  /\bblock/i,
  /\bdeadline\b/i,
  /\bprice/i,
  /\breject/i,
  /\bden(?:y|ied|ies)\b/i,
  /\bchose\b/i,
  /\bselect/i,
  /\bmigrat/i,
  /\bversion\b/i,
  /\$\s?\d/,
  /\b\d+\s?%/,
];

/**
 * Signals lever #2: keep the most salient sentence fragments of `content`
 * within `maxChars`, in original order. Pure + deterministic. Falls back to
 * head-truncation when the text is short or unsplittable.
 *
 * Anchor guard: any fragment containing an embedded citation/snapshot ref
 * (`[eXXXX]`, `Snnn`) is forced to top priority so it can never be dropped.
 */
export function salientWithinBudget(content: string, maxChars: number, qTerms: Set<string>): string {
  if (content.length <= maxChars) return content;
  const frags = content.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim().length > 0);
  if (frags.length <= 1) return truncate(content, maxChars);

  const scored = frags.map((s, i) => ({ s, i, score: fragmentScore(s, qTerms) }));
  const ranked = [...scored].sort((a, b) => b.score - a.score || a.i - b.i);

  const keep = new Set<number>();
  let used = 0;
  for (const f of ranked) {
    const cost = f.s.length + 1; // +1 for the join space
    if (used + cost > maxChars) continue;
    keep.add(f.i);
    used += cost;
  }
  if (keep.size === 0) return truncate(content, maxChars);

  const out = scored
    .filter((f) => keep.has(f.i))
    .map((f) => f.s)
    .join(" ");
  return out.length <= maxChars ? out : truncate(out, maxChars);
}

function fragmentScore(frag: string, qTerms: Set<string>): number {
  // Anchor-priority guard — embedded citation/snapshot refs must survive.
  if (/\[e\d+\]/i.test(frag) || /\bS\d{3}\b/.test(frag)) return 1e6;
  const terms = new Set(tokenize(frag));
  let score = 0;
  for (const q of qTerms) if (terms.has(q)) score += 2;
  for (const re of HIGH_SIGNAL) if (re.test(frag)) score += 1;
  if (/\d/.test(frag)) score += 0.5;
  return score;
}


/**
 * Resolve the Signals-ranker toggle (`CSM_SIGNALS_RANKER`). Default OFF — when
 * unset/false, recall builds the byte-identical blind digest. Reads env so the
 * benchmark can A/B OFF→ON with no code change, mirroring `resolveCoverageMode`.
 * The digest text is part of the cache-key `system` string, so OFF and ON hash
 * to distinct cache entries automatically (no separate version field needed).
 */
export function resolveSignalsRanker(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return envFlag(env.CSM_SIGNALS_RANKER, {
    name: "CSM_SIGNALS_RANKER",
    fallback: false,
  });
}

/** Re-exported for existing importers; the implementation is shared and lives
 *  in `src/utils/text.ts`. */
export { truncate };
