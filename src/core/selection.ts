/**
 * SELECTION — the single source of truth for "choose the best N of these".
 *
 * ── WHY THIS MODULE EXISTS ──────────────────────────────────────────────────
 *
 * CSM had four independent, hand-rolled implementations of score → sort →
 * tiebreak → cut:
 *
 *   src/core/router.ts        selectCandidates        (no explicit tiebreak)
 *   src/core/routerEmbed.ts   selectCandidatesHybrid  (tiebreak on entry.id)
 *   src/core/probe.ts         compactEventIndex       (tiebreak on eventId)
 *   src/core/digestSelection.ts orderCandidates       (insertion order)
 *
 * Four sites, four different tie semantics, and — critically — no shared notion
 * of what it means for a ranking to be MEANINGLESS. That is how one conceptual
 * defect became three separate production bugs:
 *
 *   1. selectCandidates: on BEAM every entry scores ~0, so the sort is a no-op
 *      and the cut returns the alphabetically-first N. MEASURED: 14 of 15 users
 *      received the identical 8 shards for EVERY query at BEAM 1M; CSM read a
 *      fixed 16% of memory regardless of the question.
 *   2. compactEventIndex: same shape one level down. MEASURED: for a real query
 *      the visible event set was byte-identical to passing NO QUERY AT ALL.
 *   3. selectEventDigest: budget overflow drops trailing events, survivors
 *      chosen by insertion order — lexicographic on BEAM.
 *
 * Each was invisible because the degenerate output is indistinguishable from a
 * confident one: a stable sort looks intentional, and an array of ids cannot say
 * "I had no signal, this order is arbitrary".
 *
 * ── THE INVARIANT ───────────────────────────────────────────────────────────
 *
 * **A component that cannot discriminate must say so, not guess quietly.**
 *
 * `select()` therefore returns a RESULT, not a bare array. The result carries
 * whether the scores actually discriminated, and callers that care are forced to
 * look. Tie-breaking is always explicit and never left to sort stability.
 *
 * Pure and deterministic: same inputs → same output, no clock, no randomness.
 */

/** How ties (and total absence of signal) are resolved. Always explicit. */
export type TieBreak = "stable" | "key-asc" | "key-desc";

export interface SelectOptions<T> {
  /** Discriminating score. Higher is better. */
  score: (item: T) => number;
  /** Deterministic tiebreak key. REQUIRED — ties must never fall to sort luck. */
  key: (item: T) => string;
  /** Max items to return. */
  limit: number;
  /**
   * Scores at or below this count as "no signal". Default 0, which is the right
   * floor for the count-based scorers CSM uses.
   */
  signalFloor?: number;
  /** Tie policy among equal scores. Default "key-asc" (deterministic, documented). */
  tieBreak?: TieBreak;
}

export type DegenerateReason =
  | "no-candidates"
  /** Every candidate scored at or below the signal floor. */
  | "no-signal"
  /** Some signal existed, but not enough to order the cut boundary. */
  | "ties-at-cut";

export interface SelectionResult<T> {
  selected: T[];
  /**
   * TRUE only when the scores genuinely ordered the selection. When false the
   * `selected` list is a deterministic fallback, NOT a ranking — treat it as
   * "arbitrary N of many", and prefer widening the budget or finding another
   * signal over trusting the order.
   */
  discriminated: boolean;
  degenerateReason?: DegenerateReason;
  /** Candidates scoring above the floor, as a fraction of all candidates. */
  signalRatio: number;
  totalCandidates: number;
  /** Candidates considered but not selected. `total - selected.length`. */
  dropped: number;
}

/**
 * Rank `items` and take the best `limit`, reporting whether the ranking meant
 * anything.
 *
 * Degeneracy is detected, not assumed:
 *  - every score <= floor            → "no-signal"
 *  - the cut boundary falls inside a
 *    run of equal scores             → "ties-at-cut"
 *
 * The second case is the subtle one and is what bit `selectCandidates`: a few
 * entries can score above zero while the 8th and 9th are tied, so which one
 * makes the cut is decided by the tiebreak rather than by relevance.
 */
export function select<T>(items: readonly T[], opts: SelectOptions<T>): SelectionResult<T> {
  const { score, key, limit } = opts;
  const floor = opts.signalFloor ?? 0;
  const tieBreak = opts.tieBreak ?? "key-asc";
  const total = items.length;

  if (total === 0 || limit <= 0) {
    return {
      selected: [],
      discriminated: false,
      degenerateReason: "no-candidates",
      signalRatio: 0,
      totalCandidates: total,
      dropped: total,
    };
  }

  const scored = items.map((item, index) => ({ item, index, s: score(item), k: key(item) }));
  const withSignal = scored.filter((c) => c.s > floor).length;
  const signalRatio = withSignal / total;

  scored.sort((a, b) => {
    if (b.s !== a.s) return b.s - a.s;
    if (tieBreak === "stable") return a.index - b.index;
    const cmp = a.k < b.k ? -1 : a.k > b.k ? 1 : 0;
    return tieBreak === "key-desc" ? -cmp : cmp;
  });

  const cut = Math.min(limit, total);
  const selected = scored.slice(0, cut).map((c) => c.item);

  let discriminated = true;
  let degenerateReason: DegenerateReason | undefined;
  if (withSignal === 0) {
    discriminated = false;
    degenerateReason = "no-signal";
  } else if (cut < total && scored[cut - 1]!.s === scored[cut]!.s) {
    // The boundary is inside a tie run: membership of the last slot(s) was
    // decided by the tiebreak, not by relevance.
    discriminated = false;
    degenerateReason = "ties-at-cut";
  }

  return {
    selected,
    discriminated,
    degenerateReason,
    signalRatio,
    totalCandidates: total,
    dropped: total - selected.length,
  };
}

/**
 * Pack items into a budget, longest-prefix-first, reporting what was dropped.
 *
 * The third bug site: `selectEventDigest` silently stopped at the budget and
 * emitted a "(… N more truncated)" marker, so the caller could not distinguish
 * "this shard had 11 relevant events" from "this shard had 47 and we showed you
 * the 11 whose ids sort first". `cost` is caller-supplied so this stays unit
 * agnostic — the caller decides whether the budget is chars, tokens or events,
 * which is the mistake that made `maxRecallShards` mean the wrong thing when
 * shard size changed.
 */
export interface PackResult<T> {
  packed: T[];
  usedBudget: number;
  dropped: number;
  /** True iff every candidate fit. When false the tail was cut by budget. */
  complete: boolean;
}

export function packToBudget<T>(
  items: readonly T[],
  cost: (item: T) => number,
  budget: number,
): PackResult<T> {
  const packed: T[] = [];
  let used = 0;
  for (const item of items) {
    const c = cost(item);
    if (used + c > budget) break;
    packed.push(item);
    used += c;
  }
  return {
    packed,
    usedBudget: used,
    dropped: items.length - packed.length,
    complete: packed.length === items.length,
  };
}

/**
 * Order-preserving dedupe. Previously copy-pasted into three modules
 * (`src/core/coverage.ts`, `src/eval/baselines/csm.ts`,
 * `scripts/amb-csm-retrieve.ts`) — one of the concrete duplications that let the
 * selection logic drift apart.
 */
export function dedupeInOrder<T>(items: readonly T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}
