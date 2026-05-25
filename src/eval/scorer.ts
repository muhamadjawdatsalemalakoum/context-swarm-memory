import {
  isFreeFormQuery,
  isMcqQuery,
  normaliseFreeFormAnswer,
  type Answer,
  type FreeFormAnswer,
  type FreeFormQuery,
  type McqAnswer,
  type McqQuery,
  type Query,
} from "./mcq.js";

/**
 * Programmatic score for one (query, answer) pair. No LLM judge involved.
 * (Name retained for backwards-compat; applies to both MCQ and free-form queries.)
 */
export interface McqScore {
  /** Exact-match: option-index for MCQ; normalised string-match for free-form. */
  correct: boolean;
  /** |cited ∩ relevant| / |cited|. See `scoreAnswer` for edge-case conventions. */
  citationPrecision: number;
  /** |cited ∩ relevant| / |relevant|. */
  citationRecall: number;
  /** Harmonic mean of precision and recall. */
  citationF1: number;
}

/**
 * Score one query/answer pair. Dispatches on `query.kind`.
 *
 * Citation P/R conventions for the empty-set edge cases:
 * - both empty → P=1, R=1 (vacuous perfect agreement)
 * - cited empty, relevant non-empty → P=0, R=0 (system gave no support)
 * - cited non-empty, relevant empty → P=0, R=1 (system cited stuff that wasn't needed; we penalize)
 *
 * F1 is 0 when both P and R are 0 (avoids 0/0).
 */
export function scoreAnswer(query: Query, answer: Answer): McqScore {
  if (isMcqQuery(query)) {
    if (answer.kind !== undefined && answer.kind !== "mcq") {
      throw new Error(
        `scoreAnswer: MCQ query "${query.id}" expects MCQ answer, got kind="${answer.kind}"`,
      );
    }
    return scoreMcq(query, answer as McqAnswer);
  }
  if (isFreeFormQuery(query)) {
    if (answer.kind !== "free-form") {
      throw new Error(
        `scoreAnswer: free-form query "${query.id}" expects free-form answer, got kind="${answer.kind ?? "mcq"}"`,
      );
    }
    return scoreFreeForm(query, answer);
  }
  throw new Error("scoreAnswer: unknown query kind");
}

function scoreMcq(query: McqQuery, answer: McqAnswer): McqScore {
  const correct =
    answer.chosenOption !== null && answer.chosenOption === query.correctOption;
  return {
    correct,
    ...scoreCitations(answer.citedEventIds, query.relevantEventIds),
  };
}

function scoreFreeForm(query: FreeFormQuery, answer: FreeFormAnswer): McqScore {
  const expected = [query.correctAnswer, ...(query.alternativeAnswers ?? [])].map(
    normaliseFreeFormAnswer,
  );
  const actual =
    answer.chosenAnswer === null ? null : normaliseFreeFormAnswer(answer.chosenAnswer);
  const correct = actual !== null && expected.includes(actual);
  return {
    correct,
    ...scoreCitations(answer.citedEventIds, query.relevantEventIds),
  };
}

export function scoreCitations(
  citedIds: string[],
  relevantIds: string[],
): {
  citationPrecision: number;
  citationRecall: number;
  citationF1: number;
} {
  const cited = new Set(citedIds);
  const relevant = new Set(relevantIds);
  const tp = [...cited].filter((id) => relevant.has(id)).length;

  let citationPrecision: number;
  let citationRecall: number;
  if (cited.size === 0 && relevant.size === 0) {
    citationPrecision = 1;
    citationRecall = 1;
  } else if (cited.size === 0) {
    citationPrecision = 0;
    citationRecall = 0;
  } else if (relevant.size === 0) {
    citationPrecision = 0;
    citationRecall = 1;
  } else {
    citationPrecision = tp / cited.size;
    citationRecall = tp / relevant.size;
  }

  const denom = citationPrecision + citationRecall;
  const citationF1 =
    denom === 0 ? 0 : (2 * citationPrecision * citationRecall) / denom;

  return { citationPrecision, citationRecall, citationF1 };
}

/**
 * Aggregate score across many (query × trial) pairs for one system.
 */
export interface AggregateScore {
  n: number;
  /** Mean accuracy (fraction of pairs where `correct` is true). */
  accuracy: number;
  /** [lower, upper] bootstrap 95% CI on accuracy. */
  accuracyCi95: [number, number];
  meanCitationPrecision: number;
  meanCitationRecall: number;
  meanCitationF1: number;
}

/**
 * Mulberry32 — small, fast, seedable PRNG. Used so bootstrap CIs are
 * reproducible across replays (otherwise replay would produce different
 * intervals on each run, and the "byte-identical summary" acceptance gate
 * would fail).
 */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface AggregateOptions {
  bootstrapResamples?: number;
  /** Default 42 — bake any seed override into the run config. */
  seed?: number;
}

export function aggregate(
  scores: McqScore[],
  opts: AggregateOptions = {},
): AggregateScore {
  const n = scores.length;
  if (n === 0) {
    return {
      n: 0,
      accuracy: 0,
      accuracyCi95: [0, 0],
      meanCitationPrecision: 0,
      meanCitationRecall: 0,
      meanCitationF1: 0,
    };
  }
  const bootstrapResamples = opts.bootstrapResamples ?? 10_000;
  const rng = mulberry32(opts.seed ?? 42);

  // Annotate as number[] to keep TS from inferring the literal type `(0|1)[]`,
  // which then trips the `.reduce` overload selection.
  const correctVec: number[] = scores.map((s) => (s.correct ? 1 : 0));
  const accuracy = correctVec.reduce((a, b) => a + b, 0) / n;

  const sampled: number[] = new Array(bootstrapResamples);
  for (let i = 0; i < bootstrapResamples; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) {
      sum += correctVec[Math.floor(rng() * n)]!;
    }
    sampled[i] = sum / n;
  }
  sampled.sort((a, b) => a - b);
  const lo = sampled[Math.floor(0.025 * bootstrapResamples)]!;
  const hi = sampled[Math.floor(0.975 * bootstrapResamples)]!;

  const meanCitationPrecision =
    scores.reduce((a, s) => a + s.citationPrecision, 0) / n;
  const meanCitationRecall =
    scores.reduce((a, s) => a + s.citationRecall, 0) / n;
  const meanCitationF1 = scores.reduce((a, s) => a + s.citationF1, 0) / n;

  return {
    n,
    accuracy,
    accuracyCi95: [lo, hi],
    meanCitationPrecision,
    meanCitationRecall,
    meanCitationF1,
  };
}

/**
 * Paired McNemar's exact test — for binary accuracy outcomes between two
 * systems on the SAME query × trial pairs.
 *
 * Returns the two-tailed exact binomial p-value on the discordant pairs.
 *
 * If both systems are tied on every query (no discordant pairs), p=1 by
 * convention (the test is uninformative).
 */
export interface McNemarResult {
  /** A correct, B incorrect. */
  aOnly: number;
  /** B correct, A incorrect. */
  bOnly: number;
  bothCorrect: number;
  bothIncorrect: number;
  /** Two-tailed p-value (1 if no discordant pairs). */
  pValue: number;
  /** "A" / "B" if pValue < α, "tie" otherwise. α defaults to 0.05. */
  winner: "A" | "B" | "tie";
}

export function mcNemar(
  scoresA: McqScore[],
  scoresB: McqScore[],
  alpha = 0.05,
): McNemarResult {
  if (scoresA.length !== scoresB.length) {
    throw new Error(
      `mcNemar requires paired scores: got ${scoresA.length} vs ${scoresB.length}`,
    );
  }
  let aOnly = 0;
  let bOnly = 0;
  let bothCorrect = 0;
  let bothIncorrect = 0;
  for (let i = 0; i < scoresA.length; i++) {
    const a = scoresA[i]!.correct;
    const b = scoresB[i]!.correct;
    if (a && b) bothCorrect++;
    else if (a && !b) aOnly++;
    else if (!a && b) bOnly++;
    else bothIncorrect++;
  }

  const n = aOnly + bOnly;
  let pValue: number;
  if (n === 0) {
    pValue = 1;
  } else {
    const k = Math.min(aOnly, bOnly);
    // Two-tailed: 2 × P(X ≤ k | X ~ Binomial(n, 0.5)), clamped to ≤ 1.
    let cumP = 0;
    for (let i = 0; i <= k; i++) cumP += binomialPmf(n, i, 0.5);
    pValue = Math.min(1, 2 * cumP);
  }

  const winner: "A" | "B" | "tie" =
    pValue >= alpha ? "tie" : aOnly > bOnly ? "A" : "B";

  return { aOnly, bOnly, bothCorrect, bothIncorrect, pValue, winner };
}

/**
 * Benjamini-Hochberg FDR correction. Returns adjusted p-values in input order.
 * Use when reporting many pairwise comparisons (e.g. CSM vs each baseline ×
 * each metric) to avoid inflating false-positive rate.
 */
export function benjaminiHochberg(pValues: number[]): number[] {
  const n = pValues.length;
  if (n === 0) return [];
  const indexed = pValues.map((p, i) => ({ p, i }));
  indexed.sort((a, b) => a.p - b.p);
  const adjusted = new Array<number>(n);
  let prev = 1;
  for (let rank = n; rank >= 1; rank--) {
    const { p, i } = indexed[rank - 1]!;
    const adj = Math.min(prev, (p * n) / rank);
    adjusted[i] = adj;
    prev = adj;
  }
  return adjusted;
}

function binomialPmf(n: number, k: number, p: number): number {
  const logCoef = logFactorial(n) - logFactorial(k) - logFactorial(n - k);
  const logProb =
    (p === 0 ? (k === 0 ? 0 : -Infinity) : k * Math.log(p)) +
    (1 - p === 0 ? (n - k === 0 ? 0 : -Infinity) : (n - k) * Math.log(1 - p));
  return Math.exp(logCoef + logProb);
}

function logFactorial(n: number): number {
  if (n <= 1) return 0;
  let sum = 0;
  for (let i = 2; i <= n; i++) sum += Math.log(i);
  return sum;
}
