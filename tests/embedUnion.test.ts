/**
 * Always-on global event-level dense union — `CSM_EMBED_ALWAYS_K`.
 *
 * The needle net. Measured cause (500K, 2026-08-02): information_extraction
 * losses are hard ABSENCES — the rubric literal occurs 0× in CSM's context in
 * 7/7 losses and ≥1× in 13/13 wins — because BEAM gold is one short turn inside
 * a ~100K-char session document that the router scores by the MEAN of its
 * 50–70 turn vectors. The existing `applyEmbeddingFloor` is the only global,
 * event-level stage, but it no-ops unless the pipeline came back starved.
 *
 * Contract pinned here:
 *  - off by default, and `k <= 0` is byte-identical (same array reference);
 *  - fires REGARDLESS of how full baseOrder is (that is the whole difference
 *    from the floor, which is why the floor is tested separately);
 *  - never duplicates an id the pipeline already returned;
 *  - adds at the HEAD — at the tail a RETURN_K cut discards it first, which
 *    would silently reproduce the bug it exists to fix;
 *  - preserves the pipeline's own relative order after the added block, so the
 *    dense hits are additive evidence and never reorder CSM's citations.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  applyEmbeddingFloor,
  applyEmbeddingUnion,
  resolveEmbeddingFloorK,
  resolveEmbeddingUnionBeatsBest,
  resolveEmbeddingUnionK,
  resolveEmbeddingUnionMinCos,
} from "../src/eval/baselines/csm.js";
import { EnvConfigError } from "../src/utils/env.js";

afterEach(() => {
  delete process.env.CSM_EMBED_ALWAYS_K;
  delete process.env.CSM_EMBED_FLOOR_K;
});

describe("resolveEmbeddingUnionK", () => {
  it("defaults 0 (off) and rejects garbage instead of silently defaulting", () => {
    expect(resolveEmbeddingUnionK(undefined)).toBe(0);
    expect(resolveEmbeddingUnionK("")).toBe(0);
    expect(resolveEmbeddingUnionK("5")).toBe(5);
    expect(() => resolveEmbeddingUnionK("five")).toThrow(EnvConfigError);
  });
});

describe("resolveEmbeddingFloorK", () => {
  it("keeps its default of 10 but now throws on garbage", () => {
    expect(resolveEmbeddingFloorK(undefined)).toBe(10);
    expect(resolveEmbeddingFloorK("3")).toBe(3);
    // Previously `Number.parseInt` + a silent fallback — the exact shape the
    // env.ts invariant exists to forbid.
    expect(() => resolveEmbeddingFloorK("ten")).toThrow(EnvConfigError);
  });
});

describe("applyEmbeddingUnion", () => {
  const base = ["a", "b", "c"];

  it("is an exact no-op when k <= 0", () => {
    for (const k of [0, -1, Number.NaN]) {
      const out = applyEmbeddingUnion(base, k, ["x", "y"]);
      expect(out.order).toBe(base); // same reference, not just equal
      expect(out.fired).toBe(false);
      expect(out.count).toBe(0);
    }
  });

  it("fires even when baseOrder is already large — the floor would not", () => {
    const full = Array.from({ length: 24 }, (_, i) => `e${i}`);
    const ranked = ["needle", "e0", "second"];
    // The starvation floor no-ops here...
    expect(applyEmbeddingFloor(full, 10, ranked).fired).toBe(false);
    // ...while the union still injects the needle.
    const out = applyEmbeddingUnion(full, 2, ranked);
    expect(out.fired).toBe(true);
    expect(out.addedIds).toEqual(["needle", "second"]);
  });

  it("adds at the HEAD so a RETURN_K cut cannot discard the needle", () => {
    const full = Array.from({ length: 24 }, (_, i) => `e${i}`);
    const out = applyEmbeddingUnion(full, 1, ["needle"]);
    expect(out.order[0]).toBe("needle");
    // Survives the downstream budget cut, which is the entire point.
    expect(out.order.slice(0, 24)).toContain("needle");
  });

  it("never duplicates ids the pipeline already returned", () => {
    const out = applyEmbeddingUnion(base, 3, ["b", "z", "a", "w"]);
    expect(out.addedIds).toEqual(["z", "w"]);
    expect(out.order).toEqual(["z", "w", "a", "b", "c"]);
    expect(new Set(out.order).size).toBe(out.order.length);
  });

  it("preserves the pipeline's own relative order after the added block", () => {
    const out = applyEmbeddingUnion(base, 2, ["x", "y"]);
    expect(out.order.slice(2)).toEqual(base);
  });

  it("reports not-fired when every ranked id was already present", () => {
    const out = applyEmbeddingUnion(base, 5, ["a", "b", "c"]);
    expect(out.order).toBe(base);
    expect(out.fired).toBe(false);
    expect(out.count).toBe(0);
  });

  it("caps additions at k even when many ranked ids are new", () => {
    const out = applyEmbeddingUnion(base, 2, ["p", "q", "r", "s"]);
    expect(out.count).toBe(2);
    expect(out.addedIds).toEqual(["p", "q"]);
  });
});

describe("resolveEmbeddingUnionBeatsBest / MinCos", () => {
  it("both gates default off and reject garbage", () => {
    expect(resolveEmbeddingUnionBeatsBest(undefined)).toBe(false);
    expect(resolveEmbeddingUnionBeatsBest("1")).toBe(true);
    expect(() => resolveEmbeddingUnionBeatsBest("maybe")).toThrow(EnvConfigError);

    expect(resolveEmbeddingUnionMinCos(undefined)).toBe(0);
    // Percent-of-cosine, so it can go through envInt and a typo throws.
    expect(resolveEmbeddingUnionMinCos("55")).toBeCloseTo(0.55, 10);
    expect(() => resolveEmbeddingUnionMinCos("0.55")).toThrow(EnvConfigError);
    expect(() => resolveEmbeddingUnionMinCos("140")).toThrow(EnvConfigError);
  });
});
