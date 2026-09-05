/**
 * Tests for `src/core/retrievalUnit.ts`.
 *
 * The load-bearing property is `default_off_is_byte_identical` plus the tiling
 * invariant: units must partition the event array exactly. A gap would silently
 * make a span unreachable — the same class of defect this module exists to fix.
 */
import { describe, expect, it } from "vitest";

import {
  partitionIntoUnits,
  bestUnitScore,
  topKUnitScore,
  resolveUnitSize,
  DEFAULT_UNIT_SIZE,
} from "../src/core/retrievalUnit.js";

describe("partitionIntoUnits", () => {
  it("tiles the event array exactly — no gaps, no overlaps", () => {
    for (const n of [1, 5, 6, 7, 47, 100]) {
      const units = partitionIntoUnits("s1", n, { targetSize: 6 });
      expect(units[0]!.start).toBe(0);
      expect(units[units.length - 1]!.end).toBe(n);
      for (let i = 1; i < units.length; i++) {
        expect(units[i]!.start).toBe(units[i - 1]!.end);
      }
      const covered = units.reduce((s, u) => s + (u.end - u.start), 0);
      expect(covered).toBe(n);
    }
  });

  it("respects the target size", () => {
    const units = partitionIntoUnits("s1", 47, { targetSize: 6 });
    expect(units.length).toBe(8); // ceil(47/6)
    for (const u of units) expect(u.end - u.start).toBeLessThanOrEqual(6);
  });

  it("returns no units for an empty shard", () => {
    expect(partitionIntoUnits("s1", 0)).toEqual([]);
  });

  it("returns a single unit when the shard is smaller than the target", () => {
    const units = partitionIntoUnits("s1", 3, { targetSize: 6 });
    expect(units.length).toBe(1);
    expect(units[0]).toMatchObject({ start: 0, end: 3, shardId: "s1" });
  });

  it("zero-pads unit ids so they sort numerically, not lexicographically", () => {
    // The lexicographic trap that produced three production bugs: without
    // padding, "#u10" sorts before "#u2".
    const units = partitionIntoUnits("s1", 100, { targetSize: 1 });
    const ids = units.map((u) => u.unitId);
    expect(ids[0]).toBe("s1#u0000");
    expect(ids[10]).toBe("s1#u0010");
    expect([...ids].sort()).toEqual(ids);
  });

  it("starts a new unit at a boundary key change", () => {
    // Two sessions of 3 events each, target size 6 — size alone would make ONE
    // unit; the boundary must split them.
    const keys = ["a", "a", "a", "b", "b", "b"];
    const units = partitionIntoUnits("s1", 6, {
      targetSize: 6,
      boundaryKey: (i) => keys[i]!,
    });
    expect(units.length).toBe(2);
    expect(units[0]).toMatchObject({ start: 0, end: 3 });
    expect(units[1]).toMatchObject({ start: 3, end: 6 });
  });

  it("still caps at target size within one long boundary run", () => {
    const units = partitionIntoUnits("s1", 10, {
      targetSize: 4,
      boundaryKey: () => "same",
    });
    for (const u of units) expect(u.end - u.start).toBeLessThanOrEqual(4);
    expect(units[units.length - 1]!.end).toBe(10);
  });

  it("degrades to fixed chunking without a boundary key (the null model)", () => {
    const withKey = partitionIntoUnits("s1", 12, { targetSize: 4, boundaryKey: () => null });
    const without = partitionIntoUnits("s1", 12, { targetSize: 4 });
    expect(withKey.map((u) => [u.start, u.end])).toEqual(without.map((u) => [u.start, u.end]));
  });
});

describe("bestUnitScore — max-pooling instead of mean-pooling", () => {
  it("returns the maximum, so one strong passage carries the shard", () => {
    // The preference_following failure: 1 relevant span among 9 irrelevant.
    // Mean-pooling gives 0.1; max-pooling gives 0.9.
    const scores = [0.02, 0.01, 0.9, 0.03, 0.0, 0.01, 0.02, 0.0, 0.01];
    expect(bestUnitScore(scores)).toBeCloseTo(0.9, 10);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    expect(mean).toBeLessThan(0.15);
  });

  it("sorts a unit-less shard last rather than silently tying at zero", () => {
    expect(bestUnitScore([])).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("topKUnitScore", () => {
  it("equals bestUnitScore at k=1", () => {
    const s = [0.1, 0.5, 0.3];
    expect(topKUnitScore(s, 1)).toBeCloseTo(bestUnitScore(s), 12);
  });

  it("averages the top k for evidence that is genuinely spread", () => {
    expect(topKUnitScore([0.1, 0.5, 0.3], 2)).toBeCloseTo(0.4, 12);
  });

  it("clamps k to the available units", () => {
    expect(topKUnitScore([0.4], 5)).toBeCloseTo(0.4, 12);
  });
});

describe("resolveUnitSize", () => {
  it("defaults to 0 (off), keeping the legacy whole-shard centroid", () => {
    expect(resolveUnitSize(undefined)).toBe(0);
    expect(resolveUnitSize("")).toBe(0);
    expect(resolveUnitSize("0")).toBe(0);
  });

  it("THROWS on garbage or negative input instead of silently turning the lever off (invariant 5)", () => {
    expect(() => resolveUnitSize("nonsense")).toThrow(/CSM_RETRIEVAL_UNITS/);
    expect(() => resolveUnitSize("-4")).toThrow(/CSM_RETRIEVAL_UNITS/);
  });

  it("accepts a positive unit size", () => {
    expect(resolveUnitSize("6")).toBe(6);
    expect(DEFAULT_UNIT_SIZE).toBe(6);
  });
});
