import type { CandidateScore, MemoryDirectory, MemoryDirectoryEntry } from "./types.js";
import { ageDays } from "../utils/time.js";

export interface RouteOptions {
  query: string;
  directory: MemoryDirectory;
  maxCandidates?: number;
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "for", "in", "on", "at", "by", "with",
  "is", "are", "was", "were", "be", "been", "being", "do", "does", "did", "have", "has", "had",
  "what", "when", "where", "why", "how", "which", "who", "whom", "this", "that", "these", "those",
  "i", "we", "you", "they", "it", "as", "if", "then", "else", "from", "into", "about", "us",
  "our", "your", "their", "my", "me", "him", "her", "them", "did", "will", "would", "could",
  "should", "shall", "may", "might", "can", "make", "made",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Prefix-tolerant token match. Returns true when either string is a prefix of
 * the other and the shared prefix is ≥ 4 chars. Lets "authentication" match
 * the shard tag "auth" without falling through to a fuzzy stemmer.
 *
 * Without this, the exact-token matcher misses common abbreviations:
 *   - "authentication" ↔ "auth" (target benchmark case for q05)
 *   - "configuration" ↔ "config"
 *   - "integration" ↔ "integration" (still exact)
 * The 4-char floor prevents pathological short-prefix matches ("ag" → "agile",
 * "agent", "again", etc.).
 */
function prefixMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  if (shorter.length < 4) return false;
  return longer.startsWith(shorter);
}

/** True iff `term` matches ANY of `tagSet` exactly or by prefix-tolerant rule. */
function termMatchesAnyTag(term: string, tagSet: Set<string>): boolean {
  if (tagSet.has(term)) return true;
  for (const tag of tagSet) {
    if (prefixMatch(term, tag)) return true;
  }
  return false;
}

/** Simple, transparent MVP scorer:
 *    score = tagOverlap*2 + descriptionMatch + nameMatch + recencyBoost
 *           - stalenessPenalty - fullnessPenalty - statusPenalty
 *  Each component is documented as a `reason` string so the CLI can show
 *  why a candidate ranked where it did. */
export function selectCandidates(opts: RouteOptions): CandidateScore[] {
  const { query, directory, maxCandidates = 8 } = opts;
  const queryTerms = new Set(tokenize(query));
  const ref = new Date();

  const scored: CandidateScore[] = directory.entries.map((entry) => {
    const reasons: string[] = [];
    let score = 0;

    // Prefix-tolerant tag overlap: "authentication" in the query matches a
    // shard tag of "auth", etc. See `termMatchesAnyTag` / `prefixMatch`.
    const tagSet = new Set(entry.tags.map((t) => t.toLowerCase()));
    let tagOverlap = 0;
    for (const t of queryTerms) {
      if (termMatchesAnyTag(t, tagSet)) tagOverlap++;
    }
    if (tagOverlap > 0) {
      score += tagOverlap * 2;
      reasons.push(`tagOverlap=${tagOverlap}`);
    }

    const descTerms = new Set(tokenize(entry.description));
    let descMatch = 0;
    for (const t of queryTerms) if (termMatchesAnyTag(t, descTerms)) descMatch++;
    if (descMatch > 0) {
      score += descMatch;
      reasons.push(`descMatch=${descMatch}`);
    }

    const nameTerms = new Set(tokenize(entry.name));
    let nameMatch = 0;
    for (const t of queryTerms) if (termMatchesAnyTag(t, nameTerms)) nameMatch++;
    if (nameMatch > 0) {
      score += nameMatch * 1.5;
      reasons.push(`nameMatch=${nameMatch}`);
    }

    const summaryTerms = new Set(tokenize(entry.summaryShort));
    let sumMatch = 0;
    for (const t of queryTerms) if (termMatchesAnyTag(t, summaryTerms)) sumMatch++;
    if (sumMatch > 0) {
      score += sumMatch * 0.75;
      reasons.push(`summaryMatch=${sumMatch}`);
    }

    const days = ageDays(entry.updatedAt, ref);
    if (Number.isFinite(days)) {
      const recency = Math.max(0, 1 - days / 90);
      if (recency > 0) {
        score += recency;
        reasons.push(`recency=${recency.toFixed(2)}`);
      }
    }

    if (entry.staleness === "possibly_stale") {
      score -= 0.5;
      reasons.push("staleness:possibly_stale -0.5");
    } else if (entry.staleness === "stale") {
      score -= 1.0;
      reasons.push("staleness:stale -1.0");
    }

    if (entry.fullnessPct >= 85) {
      score -= 1.0;
      reasons.push(`fullness=${entry.fullnessPct.toFixed(1)}% -1.0`);
    } else if (entry.fullnessPct >= 75) {
      score -= 0.5;
      reasons.push(`fullness=${entry.fullnessPct.toFixed(1)}% -0.5`);
    }

    if (entry.status === "archived" || entry.status === "deleted") {
      score -= 5;
      reasons.push(`status:${entry.status} -5`);
    } else if (entry.status === "frozen") {
      score -= 0.25;
      reasons.push("status:frozen -0.25");
    }

    return { entry, score, reasons };
  });

  return scored
    .filter((c) => c.score > 0 || c.entry.status === "active")
    .sort((a, b) => b.score - a.score)
    .slice(0, maxCandidates);
}
