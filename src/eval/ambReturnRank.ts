/**
 * Coverage rerank + token-budget pack for the AMB return slice.
 *
 * The verified BEAM "severe loss" cause: the answer-visible context is the
 * top-RETURN_K count-slice of csmRetrievedEventIds, which drops gold-facet
 * breadth the pipeline already retrieved (summarization cov 0.53 vs retrieved
 * 0.80; event_ordering 0.66 vs 0.83). This module reranks the retrieved ids by
 * greedy max-marginal NEW-term coverage (query terms weighted up) and packs the
 * order to a TOKEN budget instead of a raw count, so the kept set front-loads
 * distinct facet breadth and fills the budget efficiently.
 *
 * Pure + deterministic + dependency-free (no core, no gold) ON PURPOSE: the
 * BEAM-slice strategy lab (scripts/measure-return-strategies.ts) and the
 * production bridge (scripts/amb-csm-retrieve.ts) import the SAME functions, so
 * the lab's token-free numbers are exactly what production does. Validated
 * 2026-06-21: at a 16K-token budget (<= Hindsight's 17.6K), answer-visible
 * facet coverage rises event_ordering 74.1%->82.8% (normPow 1) and
 * summarization 58.0%->65.8% (normPow 0.5), cross-validated on a second run.
 */

const STOP = new Set([
  "the", "and", "for", "are", "was", "were", "this", "that", "with", "have", "has",
  "had", "you", "your", "they", "them", "their", "from", "into", "about", "what",
  "when", "where", "which", "would", "could", "should", "there", "here", "then",
  "than", "user", "assistant", "turn", "said", "say", "says", "will", "can",
]);

/** Distinctive lowercase terms (>=3 chars, minus stopwords). Deterministic. */
export function rankVocab(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of text.toLowerCase().match(/[a-z0-9][a-z0-9_\-]{2,}/g) ?? []) {
    if (!STOP.has(t)) out.add(t);
  }
  return out;
}

/** char/4 token estimate — matches src/core/tokenBudget.ts estimateTokens. */
export function estReturnTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface RerankParams {
  /** Multiplier on new terms that are also query terms (relevance bias). */
  queryWeight: number;
  /** score = newTermGain / tokens^normPow. 0 = diversity (length-biased),
   *  0.5 = sqrt (best for summarization), 1 = per-token (best for ordering). */
  normPow: number;
  /** Pack until this many answer-visible tokens (stay <= Hindsight's ~17.6K). */
  budgetTokens: number;
  /** Hard safety cap on event count regardless of budget. */
  maxCount: number;
}

/**
 * Greedy max-marginal-coverage ordering of `ids`. Repeatedly appends the event
 * whose text adds the most NEW vocabulary (query terms weighted by queryWeight),
 * divided by tokens^normPow. Stable: ties keep the earlier (higher-retrieved) id.
 */
export function greedyCoverageOrder(
  ids: readonly string[],
  getText: (id: string) => string,
  query: string,
  queryWeight: number,
  normPow: number,
): string[] {
  const qTerms = rankVocab(query);
  const remaining = ids.slice();
  const out: string[] = [];
  const covered = new Set<string>();
  const vCache = new Map<string, Set<string>>();
  const vof = (id: string): Set<string> => {
    let v = vCache.get(id);
    if (!v) { v = rankVocab(getText(id)); vCache.set(id, v); }
    return v;
  };
  const denom = (id: string): number =>
    normPow === 0 ? 1 : Math.pow(Math.max(1, estReturnTokens(getText(id))), normPow);
  while (remaining.length) {
    let best = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      let gain = 0;
      for (const t of vof(remaining[i]!)) {
        if (!covered.has(t)) gain += qTerms.has(t) ? queryWeight : 1;
      }
      const score = gain / denom(remaining[i]!);
      if (score > bestScore) { bestScore = score; best = i; }
    }
    const [pick] = remaining.splice(best, 1);
    out.push(pick!);
    for (const t of vof(pick!)) covered.add(t);
  }
  return out;
}

/** Rerank by coverage, then take the prefix that fits the token budget. */
export function coverageRerankAndPack(
  ids: readonly string[],
  getText: (id: string) => string,
  query: string,
  params: RerankParams,
): string[] {
  const ordered = greedyCoverageOrder(ids, getText, query, params.queryWeight, params.normPow);
  const out: string[] = [];
  let used = 0;
  for (const id of ordered) {
    const t = estReturnTokens(getText(id));
    if (out.length > 0 && used + t > params.budgetTokens) break;
    out.push(id);
    used += t;
    if (out.length >= params.maxCount) break;
  }
  return out;
}

/**
 * Per-intent rerank params. Reasoning/ordering queries favour per-token packing
 * (compact sequence markers); summary/other favour the sqrt middle ground
 * (substantive turns carry more rubric topics). Both validated on the slice.
 */
export function resolveRerankParams(opts: {
  reasoning: boolean;
  budgetTokens: number;
  maxCount?: number;
}): RerankParams {
  return {
    queryWeight: 4,
    normPow: opts.reasoning ? 1 : 0.5,
    budgetTokens: opts.budgetTokens,
    maxCount: opts.maxCount ?? 64,
  };
}
