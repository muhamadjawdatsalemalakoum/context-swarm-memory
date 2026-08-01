/**
 * Probe-shrink gate (token plan L2a) — CSM_PROBE_SHRINK.
 *
 * The probe stage is ~72% of pipeline input, fixed at 8 probed shards/query in
 * every official tier. When the hybrid router's ranking is WELL-SEPARATED,
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
 *
 * UNITS — read this before touching a number below (2026-08-01). Since
 * `CSM_PROBE_BATCH` defaults ON for HOSTED providers (and the fixture provider
 * is named "stub", i.e. hosted), "probes" is now two different counts:
 *   - provider CALLS: 2 — the router's top-1 solo, then one batched call for
 *     the rest;
 *   - probed SHARDS: unchanged — batched reconciliation pads missing verdicts
 *     precisely so the shard count stays stable across the two modes.
 * The shrink gate acts on SHARDS, upstream of the batch split. So:
 *   - the `CSM_PROBE_BATCH=0` block pins the gate in the CALL unit the original
 *     L2a measurements were taken in (one call per probed shard), with the same
 *     numbers as before the default flip — it just states the configuration
 *     explicitly instead of inheriting it from an unset flag;
 *   - the batched-default block re-pins the SAME shard numbers under the new
 *     default, which is the claim that actually has to survive.
 * `ScriptedProbeCounter.probeCount` counts solo ProbeResult calls only; under
 * batching that is 1 by construction and says nothing about the gate, which is
 * why the batched block counts `[Shard …]` blocks in the probe prompt instead.
 */
import { afterEach, describe, expect, it } from "vitest";

import { ask, resolveProbeBatch, resolveProbeShrink } from "../src/core/ask.js";
import { buildRouterIndex, routeConfidence } from "../src/core/routerEmbed.js";
import type { CandidateScore } from "../src/core/types.js";
import type {
  CompleteJsonInput,
  ProviderResponse,
} from "../src/providers/LlmProvider.js";
import { EnvConfigError } from "../src/utils/env.js";
import {
  AXIS_QUERY,
  axisEmbed,
  makeStorage,
  ScriptedProbeCounter,
} from "./probeShrinkHarness.js";

afterEach(() => {
  delete process.env.CSM_PROBE_SHRINK;
  delete process.env.CSM_PROBE_BATCH;
});

/** 8 shards on fixed axes: s0 aligned with the query, the rest orthogonal —
 *  hybrid scores are decisively separated, so the gate MAY shrink. */
async function axisRouterIndex() {
  return await buildRouterIndex({
    shards: Array.from({ length: 8 }, (_, i) => ({
      shardId: `s${i}`,
      terms: [],
      centroid: axisEmbed(i === 0 ? AXIS_QUERY : `other-${i}`),
    })),
    embed: async (texts) => texts.map(axisEmbed),
    model: "axis-test-v1",
  });
}

describe("resolveProbeShrink", () => {
  // CSM_PROBE_SHRINK was NOT part of the 2026-08-01 default flip: unlike the
  // hybrid router, descriptors, preference profile, lean-K and probe batching,
  // it never passed its own accuracy gate. Default stays OFF.
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

describe("ask() gate guards — CSM_PROBE_BATCH=0, one provider call per shard", () => {
  // Explicit-off batching, so `probeCount` (solo ProbeResult calls) equals the
  // number of probed shards and these three assertions read in the same unit
  // the L2a evidence was measured in. Same expected numbers as when this block
  // ran on an unset CSM_PROBE_BATCH; only the configuration is now stated.

  it("never shrinks without a router index, even with the flag on", async () => {
    // Uniform lexical tags, so the lexical path would be degenerate — the
    // corpus shape of the original router bug (see probeShrinkHarness.ts).
    process.env.CSM_PROBE_BATCH = "0";
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
    process.env.CSM_PROBE_BATCH = "0";
    process.env.CSM_PROBE_SHRINK = "1";
    const provider = new ScriptedProbeCounter();
    const storage = makeStorage(8);
    const index = await axisRouterIndex();
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
    process.env.CSM_PROBE_BATCH = "0";
    // CSM_PROBE_SHRINK deliberately unset — its default is still OFF.
    const provider = new ScriptedProbeCounter();
    const storage = makeStorage(8);
    const index = await axisRouterIndex();
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

/** Shard ids named in a probe `system` prompt: one `[Shard id@snap]` block in
 *  solo mode, N of them in batched mode. Counting these measures SHARDS
 *  PROBED — the unit the shrink gate acts in — regardless of how many provider
 *  calls carry them. */
function probedShardIds(system: string): string[] {
  return [...system.matchAll(/^\[Shard ([^\]@]+)@/gm)].map((m) => m[1]!);
}

/** ScriptedProbeCounter plus the batched schema, so the DEFAULT (batched) path
 *  runs to completion. Records probed shards and provider calls separately;
 *  the verdicts are the same knows:false payload the solo stub returns, so the
 *  downstream pipeline is identical in both modes. */
class BatchAwareProbeCounter extends ScriptedProbeCounter {
  probeCalls = 0;
  probedShards: string[] = [];

  override async completeJson<T>(input: CompleteJsonInput): Promise<ProviderResponse<T>> {
    if (input.schemaName === "ProbeResult" || input.schemaName === "BatchedProbeResult") {
      this.probeCalls++;
      this.probedShards.push(...probedShardIds(input.system));
    }
    if (input.schemaName !== "BatchedProbeResult") return super.completeJson<T>(input);
    const data = {
      verdicts: probedShardIds(input.system).map((shard_id) => ({
        shard_id,
        knows: false,
        confidence: 0.1,
        memory_type: "none",
        estimated_answer_value: "none",
        needs_full_recall: false,
        relevant_event_ids: [],
      })),
    };
    return {
      data: data as unknown as T,
      usage: { inputTokensEstimate: 10, outputTokensEstimate: 5, estimatedUsd: 0, latencyMs: 1 },
      rawText: JSON.stringify(data),
    };
  }
}

describe("ask() gate guards — batched-probe default (2026-08-01)", () => {
  // CSM_PROBE_BATCH is left UNSET here on purpose: the fixture provider is
  // named "stub" (hosted class), for which the default is now ON. Every case
  // asserts the precondition first, so if that default ever moves back these
  // tests fail loudly instead of silently re-running the unbatched block.

  it("keeps batching ON by default for the hosted fixture provider", () => {
    expect(resolveProbeBatch(new BatchAwareProbeCounter().name)).toBe(true);
  });

  it("never shrinks without a router index, even with the flag on", async () => {
    process.env.CSM_PROBE_SHRINK = "1";
    const provider = new BatchAwareProbeCounter();
    const storage = makeStorage(8);
    await ask({
      provider,
      storage,
      query: "what did we decide about the postgres migration",
      skipQueryLog: true,
      // no routerIndex -> lexical path -> the gate must not engage
    });
    expect(provider.probedShards.length).toBe(8);
    expect(new Set(provider.probedShards).size).toBe(8); // no shard probed twice
    expect(provider.probeCalls).toBe(2); // solo top-1 + one batch
  });

  it("shrinks the probed SHARD set on a well-separated hybrid ranking", async () => {
    process.env.CSM_PROBE_SHRINK = "1";
    const provider = new BatchAwareProbeCounter();
    const storage = makeStorage(8);
    const index = await axisRouterIndex();
    await ask({
      provider,
      storage,
      query: AXIS_QUERY,
      skipQueryLog: true,
      routerIndex: index,
    });
    // Same claim as the unbatched block, in shard units: the gate — not the
    // batch split — is what removes witnesses.
    expect(provider.probedShards.length).toBeLessThanOrEqual(4);
    expect(provider.probedShards.length).toBeGreaterThanOrEqual(1);
    expect(provider.probedShards[0]).toBe("s0"); // router top-1 stays solo
    expect(provider.probeCalls).toBe(2);
  });

  it("does NOT shrink when the flag is off, hybrid or not", async () => {
    // CSM_PROBE_SHRINK deliberately unset — its default is still OFF. Batching
    // collapses 8 shards into 2 calls but must not drop a single witness.
    const provider = new BatchAwareProbeCounter();
    const storage = makeStorage(8);
    const index = await axisRouterIndex();
    await ask({
      provider,
      storage,
      query: AXIS_QUERY,
      skipQueryLog: true,
      routerIndex: index,
    });
    expect(provider.probedShards.length).toBe(8);
    expect(provider.probeCalls).toBe(2);
  });
});
