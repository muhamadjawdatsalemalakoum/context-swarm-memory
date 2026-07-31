/**
 * Tests for `src/core/selection.ts` — the shared selection contract.
 *
 * The load-bearing cases are the DEGENERACY ones. Three production bugs came
 * from selectors that could not say "I had no signal", so these tests pin that
 * the shared primitive reports it.
 */
import { describe, expect, it } from "vitest";

import { select, packToBudget, dedupeInOrder } from "../src/core/selection.js";

interface Doc {
  id: string;
  hits: number;
}
const docs = (spec: Array<[string, number]>): Doc[] =>
  spec.map(([id, hits]) => ({ id, hits }));

const sel = (items: Doc[], limit: number) =>
  select(items, { score: (d) => d.hits, key: (d) => d.id, limit });

describe("select — normal ranking", () => {
  it("returns the highest scoring items and reports discrimination", () => {
    const r = sel(docs([["a", 1], ["b", 5], ["c", 3]]), 2);
    expect(r.selected.map((d) => d.id)).toEqual(["b", "c"]);
    expect(r.discriminated).toBe(true);
    expect(r.degenerateReason).toBeUndefined();
    expect(r.dropped).toBe(1);
    expect(r.totalCandidates).toBe(3);
  });

  it("breaks ties deterministically by key, never by sort luck", () => {
    // Same scores, deliberately reversed input order.
    const forward = sel(docs([["a", 2], ["b", 2], ["c", 2]]), 2);
    const reversed = sel(docs([["c", 2], ["b", 2], ["a", 2]]), 2);
    expect(forward.selected.map((d) => d.id)).toEqual(reversed.selected.map((d) => d.id));
  });

  it("honours an explicit stable tiebreak when the caller asks for it", () => {
    const r = select(docs([["c", 2], ["a", 2]]), {
      score: (d) => d.hits,
      key: (d) => d.id,
      limit: 1,
      tieBreak: "stable",
    });
    expect(r.selected[0]!.id).toBe("c");
  });
});

describe("select — degeneracy detection (the whole point)", () => {
  it("reports no-signal when every candidate scores at the floor", () => {
    // THE BEAM CONDITION: every shard scores 0 because tags and summaries are
    // identical, so any ordering is arbitrary. selectCandidates silently
    // returned the alphabetically-first N here.
    const r = sel(docs([["z", 0], ["y", 0], ["x", 0], ["w", 0]]), 2);
    expect(r.discriminated).toBe(false);
    expect(r.degenerateReason).toBe("no-signal");
    expect(r.signalRatio).toBe(0);
    // It still returns something deterministic — but the caller now KNOWS.
    expect(r.selected.map((d) => d.id)).toEqual(["w", "x"]);
  });

  it("reports ties-at-cut when the boundary falls inside a tie run", () => {
    // Some signal exists, but the 2nd and 3rd are tied, so which one makes the
    // cut was decided by the tiebreak rather than by relevance.
    const r = sel(docs([["a", 9], ["b", 4], ["c", 4]]), 2);
    expect(r.selected.map((d) => d.id)).toEqual(["a", "b"]);
    expect(r.discriminated).toBe(false);
    expect(r.degenerateReason).toBe("ties-at-cut");
    expect(r.signalRatio).toBe(1);
  });

  it("does not cry degenerate when the cut is clean", () => {
    const r = sel(docs([["a", 9], ["b", 4], ["c", 1]]), 2);
    expect(r.discriminated).toBe(true);
  });

  it("does not cry degenerate when everything fits", () => {
    // No cut boundary at all, so a tie among the tail cannot mislead anyone.
    const r = sel(docs([["a", 2], ["b", 2]]), 5);
    expect(r.discriminated).toBe(true);
    expect(r.dropped).toBe(0);
  });

  it("reports no-candidates for an empty or zero-limit selection", () => {
    expect(sel([], 3).degenerateReason).toBe("no-candidates");
    expect(sel(docs([["a", 1]]), 0).degenerateReason).toBe("no-candidates");
  });

  it("signalRatio quantifies how much of the corpus was discriminable", () => {
    const r = sel(docs([["a", 3], ["b", 0], ["c", 0], ["d", 0]]), 2);
    expect(r.signalRatio).toBeCloseTo(0.25, 10);
  });
});

describe("packToBudget", () => {
  it("packs a prefix and reports incompleteness", () => {
    const r = packToBudget(docs([["a", 1], ["b", 1], ["c", 1]]), () => 40, 100);
    expect(r.packed.map((d) => d.id)).toEqual(["a", "b"]);
    expect(r.usedBudget).toBe(80);
    expect(r.dropped).toBe(1);
    expect(r.complete).toBe(false);
  });

  it("reports complete when everything fits", () => {
    const r = packToBudget(docs([["a", 1]]), () => 10, 100);
    expect(r.complete).toBe(true);
    expect(r.dropped).toBe(0);
  });

  it("is unit-agnostic — cost is caller-supplied", () => {
    // The maxRecallShards mistake was a budget in the wrong unit. Making cost
    // explicit forces the caller to state which unit it means.
    const byChars = packToBudget(docs([["a", 1], ["b", 1]]), () => 600, 1000);
    const byEvents = packToBudget(docs([["a", 1], ["b", 1]]), () => 1, 1000);
    expect(byChars.packed.length).toBe(1);
    expect(byEvents.packed.length).toBe(2);
  });
});

describe("dedupeInOrder", () => {
  it("preserves first-occurrence order", () => {
    expect(dedupeInOrder(["b", "a", "b", "c", "a"])).toEqual(["b", "a", "c"]);
  });

  it("handles empty input", () => {
    expect(dedupeInOrder([])).toEqual([]);
  });
});
