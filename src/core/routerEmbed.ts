// Hybrid lexical + local-embedding router — T2 "Router v1".
//
// `selectCandidatesHybrid` fuses the Phase-0 lexical score (reused verbatim
// via `scoreEntryLexical` — single source of truth for the weights) with a
// cosine similarity between the query embedding and each shard's content
// centroid. Both signals are deterministic given a (model, corpus) pair; no
// LLM is involved at index OR query time (MiniLM runs locally and is inside
// the README's "zero LLM-indexing cost" claim).
//
// Async boundary (design Q4): `selectCandidates` is sync, embeddings are not.
// The split is:
//   - `RouterIndex` — built ONCE per corpus/directory version by the caller
//     (benchmark adapter at corpus build; durable stores read it straight
//     from directory descriptor fields). Building may embed shard texts.
//   - `selectCandidatesHybrid` — async only because it embeds the QUERY
//     (one ~5 ms local call, disk-cached by content hash). Falls back to the
//     lexical `selectCandidates` result whenever no index is supplied or the
//     embedder fails, so callers can pass `index: undefined` for byte-
//     identical Phase-0 behavior.
//
// The eventual `ask.ts` integration is a ≤5-line merge-window edit:
//
//   const candidates: CandidateScore[] = opts.routerIndex
//     ? await selectCandidatesHybrid({ query, directory,
//         maxCandidates: budget.maxCandidateShards, index: opts.routerIndex })
//     : selectCandidates({ query, directory, maxCandidates: budget.maxCandidateShards });
//
// plus an optional `routerIndex?: RouterIndex` field on `AskOptions`.
//
// Read-path safety: this module performs no storage writes. Its only side
// effect is whatever the injected `EmbedFn` does — the default implementation
// (`src/eval/embed.ts`) writes to the `data/eval/embeddings/` disk cache,
// which is the established precedent for non-durable-memory cache writes
// (`tests/mutationSafety.test.ts` hashes directory/shards/chronicle only).

import type {
  CandidateScore,
  MemoryDirectory,
  MemoryDirectoryEntry,
} from "./types.js";
import {
  scoreEntryLexical,
  selectCandidates,
  termMatchesAnyTag,
  tokenize, selectCandidatesDetailed } from "./router.js";
import {
  decodeCentroid,
  type DirectoryEntryWithDescriptors,
} from "./descriptors.js";
import { bestUnitScore } from "./retrievalUnit.js";
import { select, type DegenerateReason } from "./selection.js";

/** Local text embedder. `src/eval/embed.ts#embed` satisfies this; tests
 *  inject deterministic fakes. Declared here so core never imports eval. */
export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;

export interface RouterIndexShard {
  /** Content-derived terms (auto-tags) scored like tags at `termWeight`. */
  terms: string[];
  /** L2-normalized shard centroid, or null when unavailable. */
  centroid: Float32Array | null;
  /**
   * Optional per-retrieval-unit centroids (see `src/core/retrievalUnit.ts`).
   * When present the embedding leg scores the shard by its BEST unit rather
   * than by the whole-shard mean.
   *
   * Why: a stated preference is a small span inside a document about something
   * else, and `centroidOf` over the whole document mean-pools it into noise.
   * Measured at BEAM 1M, `preference_following` loses 13.5 points of gold-fact
   * coverage at the routing step alone for exactly this reason.
   *
   * Ranking-time only — shards keep their size, so every downstream budget
   * keeps the meaning it was tuned for. That is the difference between this and
   * `CSM_VIRTUAL_SHARDS`, which shrank shards and starved the harvest 55%.
   */
  unitCentroids?: Float32Array[];
}

export interface RouterIndex {
  /** Embedding model id the centroids were computed with. */
  model: string;
  /** Embeds the query at select time. MUST match `model`. */
  embed: EmbedFn;
  byShard: Map<string, RouterIndexShard>;
}

// ─── Fusion weights ──────────────────────────────────────────────────────────

export interface HybridWeights {
  /** Weight of the saturated lexical leg. */
  wLex: number;
  /** Weight of the embedding leg (cosine clipped to [0,1]). */
  wEmb: number;
  /** Lexical saturation constant: satLex = lex / (|lex| + lexSat).
   *  lexSat=4 maps the RAG-floor threshold (lex=4) to 0.5. */
  lexSat: number;
  /** Per-match weight of derived descriptor terms inside the lexical leg
   *  (curated tags count 2.0; auto-derived terms are noisier). */
  termWeight: number;
}

/**
 * Calibrated 2026-06-10 via `scripts/router-recall-eval.ts --mode
 * calibrate-joint --corpus-tokens 100K,1M` (180-config grid, PaySwift 28
 * gold-bearing queries, objective: worst-case primary-recall@3 across both
 * corpus sizes, then avg P@3 / P@1 / MRR). This config was the unique
 * worst-case winner (min P@3 0.857 vs 0.821 for every alternative;
 * old lexical router: 0.714 @ 100K, 0.643 @ 1M). The (wLex=0.5, wEmb=2,
 * lexSat=2) cell is a flat optimum — neighbours differ only in MRR digits —
 * so the default is a region centre, not a knife-edge. Full tables in
 * docs/experiments/EXP-T2-router.md.
 */
export const DEFAULT_HYBRID_WEIGHTS: HybridWeights = {
  wLex: 0.5,
  wEmb: 2.0,
  lexSat: 2,
  termWeight: 1.5,
};

/** Bounded, monotone squash of the unbounded lexical score into (-1, 1). */
export function satLex(score: number, lexSat: number): number {
  if (!Number.isFinite(score)) return 0;
  return score / (Math.abs(score) + lexSat);
}

/**
 * Convert a threshold expressed on the OLD lexical scale (e.g. the baseline
 * adapter's RAG-floor `score > 4`) into the hybrid scale, so downstream
 * confidence gates keep their meaning when the router is swapped.
 */
export function hybridEquivalentOfLexScore(
  lexScore: number,
  weights: HybridWeights = DEFAULT_HYBRID_WEIGHTS,
): number {
  return weights.wLex * satLex(lexScore, weights.lexSat);
}

// ─── Index construction ──────────────────────────────────────────────────────

export interface BuildRouterIndexShardInput {
  shardId: string;
  /** Derived descriptor terms (from `deriveShardDescriptors`). */
  terms: string[];
  /** Pre-computed centroid (preferred when event vectors are already cached). */
  centroid?: Float32Array | null;
  /** Text to embed as the shard representation when no centroid is given —
   *  the O(shards) scale option (`descriptorText`). */
  embedText?: string;
}

/**
 * Build a `RouterIndex` from per-shard descriptor inputs. Embeds `embedText`
 * for shards without a pre-computed centroid (batched in one call).
 */
export async function buildRouterIndex(args: {
  shards: BuildRouterIndexShardInput[];
  embed: EmbedFn;
  model: string;
}): Promise<RouterIndex> {
  const byShard = new Map<string, RouterIndexShard>();
  const toEmbed: Array<{ shardId: string; text: string }> = [];

  for (const s of args.shards) {
    if (s.centroid) {
      byShard.set(s.shardId, { terms: s.terms, centroid: s.centroid });
    } else if (s.embedText && s.embedText.trim().length > 0) {
      byShard.set(s.shardId, { terms: s.terms, centroid: null });
      toEmbed.push({ shardId: s.shardId, text: s.embedText });
    } else {
      byShard.set(s.shardId, { terms: s.terms, centroid: null });
    }
  }

  if (toEmbed.length > 0) {
    const vecs = await args.embed(toEmbed.map((t) => t.text));
    toEmbed.forEach((t, i) => {
      const cur = byShard.get(t.shardId);
      if (cur && vecs[i]) byShard.set(t.shardId, { ...cur, centroid: vecs[i]! });
    });
  }

  return { model: args.model, embed: args.embed, byShard };
}

/**
 * Durable-store path: hydrate a `RouterIndex` from descriptor fields already
 * stored on directory entries (written Committer-side at commit time). Pure
 * decode — zero embedding calls for the shards; the query still embeds at
 * select time via `embed`.
 */
export function routerIndexFromDirectory(
  directory: MemoryDirectory,
  embed: EmbedFn,
  model: string,
): RouterIndex | null {
  const byShard = new Map<string, RouterIndexShard>();
  let any = false;
  for (const entry of directory.entries as DirectoryEntryWithDescriptors[]) {
    const terms = entry.derivedTerms ?? [];
    let centroid: Float32Array | null = null;
    if (entry.embedCentroidB64 && (!entry.embedModel || entry.embedModel === model)) {
      try {
        centroid = decodeCentroid(entry.embedCentroidB64);
      } catch {
        centroid = null;
      }
    }
    if (terms.length > 0 || centroid) any = true;
    byShard.set(entry.id, { terms, centroid });
  }
  if (!any) return null; // directory carries no descriptors → caller should fall back
  return { model, embed, byShard };
}

// ─── Hybrid selection ────────────────────────────────────────────────────────

export interface HybridRouteOptions {
  query: string;
  directory: MemoryDirectory;
  maxCandidates?: number;
  /** When absent/null, behaves exactly like the Phase-0 `selectCandidates`. */
  index?: RouterIndex | null;
  weights?: Partial<HybridWeights>;
}

/**
 * Hybrid candidate selection:
 *
 *   lexTotal = phase0LexicalScore + derivedTermOverlap * termWeight
 *   hybrid   = wLex * satLex(lexTotal) + wEmb * max(0, cos(queryVec, centroid))
 *
 * - Phase-0 lexical score comes from `scoreEntryLexical` — identical weights,
 *   reasons preserved.
 * - Derived terms match with the same prefix-tolerant rule as tags.
 * - The `score > 0 || active` passthrough is kept (design Q3): low-signal
 *   directories still probe everything up to the cap, but the ORDER within
 *   the passthrough set is now informed — on BEAM-shaped corpora where every
 *   lexical score is ~0, the embedding leg alone ranks shards, replacing the
 *   alphabetical top-8 with a semantic top-8.
 * - Deterministic: ties break by lexical score desc, then shardId asc.
 *
 * Falls back to `selectCandidates` (byte-identical candidate list) when the
 * index is absent or the query embed fails — the hybrid path can only ever
 * add signal, never lose the lexical baseline.
 *
 * ── THE FALLBACK IS COUNTED, NOT SILENT ─────────────────────────────────────
 *
 * "Degrades gracefully to lexical" reads as a virtue right up until you notice
 * what lexical selection DOES on a BEAM-shaped corpus: every entry scores ~0,
 * so the cut returns the alphabetically-first N for every query — the exact
 * query-independence bug documented in `src/core/router.ts`. The embedding leg
 * is the whole measured win (+0.365 answer score at BEAM 1M, 26W/5L; the
 * descriptor leg alone was flat). So a transient `embed()` failure does not
 * "lose a little signal" — it silently converts the winning configuration into
 * the losing one, mid-run, per query, while the run manifest still says the
 * hybrid router was enabled.
 *
 * `hybridRouterStats()` therefore records every fallback. Anything that reports
 * a hybrid-router measurement must read it and refuse to publish a run in which
 * fallbacks occurred. Counting is deliberately not throwing: aborting a long
 * benchmark on one flaky embed call would be worse than finishing it with an
 * honest, inspectable degradation record.
 */
export interface HybridRouterStats {
  /** Calls that ran the full hybrid (lexical + embedding) path. */
  hybrid: number;
  /** Calls that fell back because no router index was supplied. */
  fallbackNoIndex: number;
  /** Calls that fell back because embedding the query failed or returned empty. */
  fallbackEmbedFailed: number;
  /** Message of the most recent embed failure, for diagnosis. */
  lastEmbedError?: string;
}

const hybridStats: HybridRouterStats = {
  hybrid: 0,
  fallbackNoIndex: 0,
  fallbackEmbedFailed: 0,
};

/** Snapshot of hybrid-router degradation counters for this process. */
export function hybridRouterStats(): HybridRouterStats {
  return { ...hybridStats };
}

/** Reset the counters (tests, and per-run accounting in long harnesses). */
export function resetHybridRouterStats(): void {
  hybridStats.hybrid = 0;
  hybridStats.fallbackNoIndex = 0;
  hybridStats.fallbackEmbedFailed = 0;
  delete hybridStats.lastEmbedError;
}

export interface HybridRouteResult {
  candidates: CandidateScore[];
  selection: HybridSelectionReport & {
    totalCandidates: number;
    path: "hybrid" | "hybrid-fallback-no-index" | "hybrid-fallback-embed-failed";
  };
}

/** Back-compatible array-returning form; prefer `selectCandidatesHybridDetailed`
 *  where the degeneracy report matters (ask() does). */
export async function selectCandidatesHybrid(
  opts: HybridRouteOptions,
): Promise<CandidateScore[]> {
  return (await selectCandidatesHybridDetailed(opts)).candidates;
}

export async function selectCandidatesHybridDetailed(
  opts: HybridRouteOptions,
): Promise<HybridRouteResult> {
  const { query, directory, maxCandidates = 8, index } = opts;
  const lexicalFallback = (path: HybridRouteResult["selection"]["path"]): HybridRouteResult => {
    const r = selectCandidatesDetailed({ query, directory, maxCandidates });
    return {
      candidates: r.selected,
      selection: {
        discriminated: r.discriminated,
        degenerateReason: r.degenerateReason,
        signalRatio: r.signalRatio,
        totalCandidates: r.totalCandidates,
        path,
      },
    };
  };
  if (!index) {
    hybridStats.fallbackNoIndex++;
    return lexicalFallback("hybrid-fallback-no-index");
  }

  let queryVec: Float32Array | null = null;
  let embedError: string | undefined;
  try {
    const [v] = await index.embed([query]);
    queryVec = v ?? null;
    if (!queryVec) embedError = "embed() returned no vector";
  } catch (err) {
    queryVec = null;
    embedError = err instanceof Error ? err.message : String(err);
  }
  if (!queryVec) {
    hybridStats.fallbackEmbedFailed++;
    hybridStats.lastEmbedError = embedError;
    return lexicalFallback("hybrid-fallback-embed-failed");
  }
  hybridStats.hybrid++;

  const weights: HybridWeights = { ...DEFAULT_HYBRID_WEIGHTS, ...opts.weights };
  const queryTerms = new Set(tokenize(query));
  const ref = new Date();

  const scored = directory.entries.map((entry: MemoryDirectoryEntry) => {
    const lex = scoreEntryLexical(queryTerms, entry, ref);
    const reasons = [...lex.reasons];

    const shard = index.byShard.get(entry.id);

    // Derived-term overlap — same prefix-tolerant matcher as tags.
    let termOverlap = 0;
    if (shard && shard.terms.length > 0) {
      const termSet = new Set(shard.terms.map((t) => t.toLowerCase()));
      for (const t of queryTerms) {
        if (termMatchesAnyTag(t, termSet)) termOverlap++;
      }
      if (termOverlap > 0) {
        reasons.push(`derivedTermOverlap=${termOverlap}`);
      }
    }

    const lexTotal = lex.score + termOverlap * weights.termWeight;

    // Embedding leg. Best-unit pooling when unit centroids are available,
    // whole-shard mean otherwise (byte-identical to the legacy path).
    let emb = 0;
    const cos = (v: Float32Array): number => {
      let dot = 0;
      for (let i = 0; i < queryVec!.length; i++) dot += queryVec![i]! * v[i]!;
      return dot;
    };
    const units = shard?.unitCentroids;
    if (units && units.length > 0 && units[0]!.length === queryVec!.length) {
      const best = bestUnitScore(units.map(cos));
      emb = Math.max(0, best);
      reasons.push(`embedSim(best-of-${units.length}-units)=${best.toFixed(3)}`);
    } else if (shard?.centroid && shard.centroid.length === queryVec!.length) {
      const dot = cos(shard.centroid);
      emb = Math.max(0, dot);
      reasons.push(`embedSim=${dot.toFixed(3)}`);
    }

    const hybrid =
      weights.wLex * satLex(lexTotal, weights.lexSat) + weights.wEmb * emb;
    reasons.push(`hybrid=${hybrid.toFixed(3)}`);

    return { entry, score: hybrid, reasons, lexTotal };
  });

  // Score → sort → cut goes through `select()` like every other ranking in the
  // repo (src/core/selection.ts — this function was the last hand-rolled
  // `.sort().slice()` on the production path, an open item from the 2026-07
  // audit). The scoring itself is unchanged; ties break on lexTotal then
  // shardId exactly as before, expressed as a composite key so the policy is
  // stated rather than inherited from sort mechanics.
  //
  // The degeneracy report is not discarded: `lastHybridSelection` records
  // whether the ranking discriminated, and `routeConfidence` consumers (the
  // probe-shrink gate) must refuse to shrink when it did not — shrinking on an
  // arbitrary ranking is how the original router bug becomes a probe bug.
  const result = select(
    scored.filter((c) => c.score > 0 || c.entry.status === "active"),
    {
      score: (c) => c.score,
      // Composite tiebreak: higher lexTotal first, then shardId ascending.
      // (1e9 - lexTotal) inverts the numeric order inside a lexicographic key;
      // lexTotal is a small bounded count, so the padding is safe.
      key: (c) =>
        `${String(1e9 - c.lexTotal).padStart(12, "0")}:${c.entry.id}`,
      limit: maxCandidates,
    },
  );
  lastHybridSelection = {
    discriminated: result.discriminated,
    degenerateReason: result.degenerateReason,
    signalRatio: result.signalRatio,
  };
  return {
    candidates: result.selected.map(({ entry, score, reasons }) => ({ entry, score, reasons })),
    selection: {
      discriminated: result.discriminated,
      degenerateReason: result.degenerateReason,
      signalRatio: result.signalRatio,
      totalCandidates: result.totalCandidates,
      path: "hybrid",
    },
  };
}

/** Degeneracy report of the most recent `selectCandidatesHybrid` cut, for the
 *  probe-shrink gate. Same process-local pattern as `hybridRouterStats`. */
export interface HybridSelectionReport {
  discriminated: boolean;
  degenerateReason?: DegenerateReason;
  signalRatio: number;
}

let lastHybridSelection: HybridSelectionReport | null = null;

export function lastHybridSelectionReport(): HybridSelectionReport | null {
  return lastHybridSelection ? { ...lastHybridSelection } : null;
}

// ─── Route confidence (analysis output; default behavior unchanged) ─────────

export interface RouteConfidence {
  top1Score: number;
  /** Gap between rank-1 and rank-2 hybrid scores. */
  top1Margin: number;
  /** Heuristic probe-set size for confident routes. v1 ships this as
   *  TELEMETRY ONLY — `ask()` keeps probing up to `maxProbeShards` until the
   *  shrink lever passes its own accuracy gate (see EXP-T2-router.md §5). */
  recommendedProbeCount: number;
}

/**
 * Confidence summary for a hybrid candidate list. The shrink heuristic:
 * probe fewer shards when the top of the ranking is well separated —
 * keep every candidate within `keepWithin` of top-1, floor of `minProbes`.
 */
export function routeConfidence(
  candidates: CandidateScore[],
  opts: { minProbes?: number; keepWithin?: number } = {},
): RouteConfidence {
  const minProbes = opts.minProbes ?? 4;
  const keepWithin = opts.keepWithin ?? 0.35;
  const top1Score = candidates[0]?.score ?? 0;
  const top2Score = candidates[1]?.score ?? 0;
  const top1Margin = candidates.length > 1 ? top1Score - top2Score : top1Score;
  let recommended = 0;
  for (const c of candidates) {
    if (top1Score - c.score <= keepWithin) recommended++;
  }
  return {
    top1Score,
    top1Margin,
    recommendedProbeCount: Math.max(
      Math.min(minProbes, candidates.length),
      recommended,
    ),
  };
}
