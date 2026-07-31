/**
 * Probe-shrink gate (token plan L2a) — CSM_PROBE_SHRINK.
 *
 * The probe stage is ~72% of pipeline input, fixed at 8 calls/query in every
 * official tier. When the hybrid router's ranking is WELL-SEPARATED,
 * `routeConfidence` recommends probing only the candidates within 0.35 of
 * top-1 (floor 4). Two hard guards this file pins:
 *
 *   1. no shrink without a hybrid router index — the lexical ranking is
 *      degenerate on uniform-tag corpora (the original router bug), and
 *   2. no shrink when the hybrid cut itself did not DISCRIMINATE — shrinking
 *      on an arbitrary ranking would turn the router bug into a probe bug.
 *
 * The stub embedder gives shard centroids on fixed axes so the hybrid scores
 * are controlled exactly.
 */
import { afterEach, describe, expect, it } from "vitest";

import { ask } from "../src/core/ask.js";
import { buildRouterIndex } from "../src/core/routerEmbed.js";
import { routeConfidence } from "../src/core/routerEmbed.js";
import { resolveProbeShrink } from "../src/core/ask.js";
import type { CandidateScore } from "../src/core/types.js";
import { EnvConfigError } from "../src/utils/env.js";

afterEach(() => {
  delete process.env.CSM_PROBE_SHRINK;
});

describe("resolveProbeShrink", () => {
  it("defaults OFF and uses the shared flag vocabulary", () => {
    expect(resolveProbeShrink(undefined)).toBe(false);
    expect(resolveProbeShrink("1")).toBe(true);
    expect(resolveProbeShrink("off")).toBe(false);
    expect(() => resolveProbeShrink("shrink")).toThrow(EnvConfigError);
  });
});

describe("routeConfidence recommendation shape", () => {
  const cand = (id: string, score: number): CandidateScore =>
    ({ entry: { id } as CandidateScore["entry"], score, reasons: [] });

  it("keeps every candidate within 0.35 of top-1, floored at 4", () => {
    // Well-separated: top-1 clearly ahead, 3 stragglers far behind.
    const wellSeparated = [
      cand("a", 0.9),
      cand("b", 0.8),
      cand("c", 0.3),
      cand("d", 0.2),
      cand("e", 0.1),
      cand("f", 0.05),
      cand("g", 0.02),
      cand("h", 0.01),
    ];
    expect(routeConfidence(wellSeparated).recommendedProbeCount).toBe(4);
  });

  it("recommends the full set on a flat (degenerate-looking) ranking", () => {
    // All ~equal — every candidate is within 0.35 of top-1: no shrink signal.
    const flat = Array.from({ length: 8 }, (_, i) => cand(`s${i}`, 0.5));
    expect(routeConfidence(flat).recommendedProbeCount).toBe(8);
  });
});

describe("ask() gate guards", () => {
  it("never shrinks without a router index, even with the flag on", async () => {
    // Import the test harness pieces from the router-trust fixture pattern
    // inline: a scripted provider that counts probe calls, uniform lexical
    // tags so the lexical path would be degenerate.
    const { ScriptedProbeCounter, makeStorage } = await import("./probeShrinkHarness.js");
    process.env.CSM_PROBE_SHRINK = "1";
    const provider = new ScriptedProbeCounter();
    const storage = makeStorage(8);
    await ask({
      provider,
      storage,
      query: "what did we decide about the postgres migration",
      skipQueryLog: true,
      // no routerIndex -> lexical path -> the gate must not engage
    });
    expect(provider.probeCount).toBe(8);
  });

  it("shrinks to the confident set on a well-separated hybrid ranking", async () => {
    const { ScriptedProbeCounter, makeStorage, AXIS_QUERY, axisEmbed } = await import(
      "./probeShrinkHarness.js"
    );
    process.env.CSM_PROBE_SHRINK = "1";
    const provider = new ScriptedProbeCounter();
    const storage = makeStorage(8);
    // Shard s0 aligned with the query axis; the rest orthogonal — hybrid
    // scores are decisively separated, so the gate may shrink to the floor.
    const index = await buildRouterIndex({
      shards: Array.from({ length: 8 }, (_, i) => ({
        shardId: `s${i}`,
        terms: [],
        centroid: axisEmbed(i === 0 ? AXIS_QUERY : `other-${i}`),
      })),
      embed: async (texts) => texts.map(axisEmbed),
      model: "axis-test-v1",
    });
    await ask({
      provider,
      storage,
      query: AXIS_QUERY,
      skipQueryLog: true,
      routerIndex: index,
    });
    expect(provider.probeCount).toBeLessThanOrEqual(4);
    expect(provider.probeCount).toBeGreaterThanOrEqual(1);
  });

  it("does NOT shrink when the flag is off, hybrid or not", async () => {
    const { ScriptedProbeCounter, makeStorage, AXIS_QUERY, axisEmbed } = await import(
      "./probeShrinkHarness.js"
    );
    const provider = new ScriptedProbeCounter();
    const storage = makeStorage(8);
    const index = await buildRouterIndex({
      shards: Array.from({ length: 8 }, (_, i) => ({
        shardId: `s${i}`,
        terms: [],
        centroid: axisEmbed(i === 0 ? AXIS_QUERY : `other-${i}`),
      })),
      embed: async (texts) => texts.map(axisEmbed),
      model: "axis-test-v1",
    });
    await ask({
      provider,
      storage,
      query: AXIS_QUERY,
      skipQueryLog: true,
      routerIndex: index,
    });
    expect(provider.probeCount).toBe(8);
  });
});
