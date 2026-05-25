import { describe, expect, it } from "vitest";

import {
  applyEmbeddingFloor,
  resolveEmbeddingFloorK,
} from "../src/eval/baselines/csm.js";

describe("applyEmbeddingFloor (CSM_EMBED_FLOOR_K backfill logic)", () => {
  it("is a no-op when k <= 0 (feature off → baseline byte-identical)", () => {
    const base = ["e1", "e2"];
    const r = applyEmbeddingFloor(base, 0, ["e9", "e8"]);
    expect(r.fired).toBe(false);
    expect(r.count).toBe(0);
    expect(r.order).toBe(base); // same reference — untouched
  });

  it("is a no-op when the pipeline already has >= k events (not starved)", () => {
    const base = ["e1", "e2", "e3", "e4"];
    const r = applyEmbeddingFloor(base, 4, ["e9", "e8"]);
    expect(r.fired).toBe(false);
    expect(r.count).toBe(0);
    expect(r.order).toEqual(base);
  });

  it("backfills ranked ids until the order reaches k, pipeline events first", () => {
    const base = ["e1", "e2"]; // 2 precise pipeline hits
    const ranked = ["e10", "e11", "e12", "e13"]; // embedding top-K
    const r = applyEmbeddingFloor(base, 5, ranked);
    expect(r.fired).toBe(true);
    expect(r.count).toBe(3); // 2 + 3 = 5
    // CSM's precise hits stay at the front; embedding hits fill the rest.
    expect(r.order).toEqual(["e1", "e2", "e10", "e11", "e12"]);
  });

  it("dedupes ranked ids already present in the pipeline order", () => {
    const base = ["e1", "e2"];
    const ranked = ["e2", "e10", "e1", "e11"]; // e1/e2 already packed
    const r = applyEmbeddingFloor(base, 4, ranked);
    expect(r.count).toBe(2); // only e10, e11 added
    expect(r.order).toEqual(["e1", "e2", "e10", "e11"]);
  });

  it("handles a fully-starved pipeline (zero pipeline hits → pure embedding floor)", () => {
    const base: string[] = [];
    const ranked = ["e10", "e11", "e12"];
    const r = applyEmbeddingFloor(base, 3, ranked);
    expect(r.fired).toBe(true);
    expect(r.count).toBe(3);
    expect(r.order).toEqual(["e10", "e11", "e12"]);
  });

  it("stops at k even when more ranked ids are available", () => {
    const r = applyEmbeddingFloor([], 2, ["a", "b", "c", "d"]);
    expect(r.order).toEqual(["a", "b"]);
    expect(r.count).toBe(2);
  });

  it("does not mutate the input baseOrder array", () => {
    const base = ["e1"];
    applyEmbeddingFloor(base, 3, ["e10", "e11"]);
    expect(base).toEqual(["e1"]); // unchanged
  });

  it("reports fired=false when starved but no new ranked ids to add", () => {
    const base = ["e1"];
    const r = applyEmbeddingFloor(base, 5, ["e1"]); // only dup available
    expect(r.fired).toBe(false);
    expect(r.count).toBe(0);
    expect(r.order).toEqual(["e1"]);
  });
});

describe("resolveEmbeddingFloorK", () => {
  it("defaults to the benchmark recall floor", () => {
    expect(resolveEmbeddingFloorK(undefined)).toBe(10);
    expect(resolveEmbeddingFloorK("")).toBe(10);
  });

  it("allows explicit disablement with zero", () => {
    expect(resolveEmbeddingFloorK("0")).toBe(0);
  });

  it("falls back to the default for invalid input", () => {
    expect(resolveEmbeddingFloorK("nope")).toBe(10);
  });
});
