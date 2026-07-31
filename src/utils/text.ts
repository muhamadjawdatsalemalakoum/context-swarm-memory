/**
 * TEXT — small pure string helpers shared across the pipeline.
 *
 * These were each defined 2–4 times across `src/` and `scripts/`. None had
 * diverged yet, but the repo has already been bitten twice by exactly this
 * shape: a private copy of `prefixMatch` in `src/core/probe.ts` drifted from
 * the router's version, and `extractBetweenSegmentTerms` still differs between
 * `src/core/coverage.ts` and the AMB bridge. A duplicated one-liner is not a
 * bug; it is an unclaimed opportunity for one.
 *
 * DELIBERATE EXCEPTION: `src/eval/retrievalScore.ts` keeps its own
 * `escapeRegExp`. That module is the BEAM gold-answer leaf and
 * `tests/beamLeakageFirewall.test.ts` requires its import closure to be node
 * builtins only, so it may not import from here. That copy is mandated by the
 * firewall, not an oversight — do not "fix" it.
 */

/** Escape a string for literal use inside a `RegExp`. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Hard character cap with a single-character ellipsis, so the result is never
 *  longer than `n`. */
export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
