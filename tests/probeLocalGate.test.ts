/**
 * Local probe pre-gate (token plan L3, arm B) — CSM_PROBE_LOCAL_KEEP.
 *
 * A cheap local scorer (cross-encoder in production; a fake here) may SKIP
 * witnesses, never answer for them: kept shards still get the full LLM probe.
 * Contract pinned here:
 *   - candidate 0 (router top-1) is ALWAYS kept, whatever its local score —
 *     the router-trust net and the speculative recall depend on it;
 *   - the kept set preserves ROUTER ORDER (insertion order downstream carries
 *     router rank);
 *   - off (0) or keep ≥ candidate count → byte-identical control;
 *   - the scorer sees the SAME digest text the LLM probe would.
 *
 * CSM_PROBE_LOCAL_KEEP itself is UNCHANGED by the 2026-08-01 default flip: it
 * is still 0 (off) — this gate is opt-in and additionally requires a scorer to
 * be injected.
 *
 * CSM_PROBE_BATCH, however, flipped to ON for hosted providers on 2026-08-01,
 * and this file's harness provider (`ScriptedProbeCounter`, name "stub") is
 * hosted-class. That matters here because the batched path collapses
 * candidates 1..N into ONE call, so `provider.probeCount` — which counts solo
 * `ProbeResult` calls — stops being a per-shard census. The gate's arithmetic
 * is therefore pinned twice:
 *   - `describe("… CSM_PROBE_BATCH=0")` sets the flag EXPLICITLY off and keeps
 *     the original one-call-per-kept-shard assertions verbatim (the legacy
 *     control that the L3 measurement was taken against);
 *   - `describe("… under the batched default")` re-pins the same kept set and
 *     the same router order through the batch, where the census has to be read
 *     off the batched call's requested shard list instead of a call count.
 */
import { afterEach, describe, expect, it } from "vitest";

import { ask, resolveProbeLocalKeep } from "../src/core/ask.js";
import type {
  CompleteJsonInput,
  ProviderResponse,
} from "../src/providers/LlmProvider.js";
import { EnvConfigError } from "../src/utils/env.js";
import { makeStorage, ScriptedProbeCounter } from "./probeShrinkHarness.js";

afterEach(() => {
  delete process.env.CSM_PROBE_LOCAL_KEEP;
  delete process.env.CSM_PROBE_BATCH;
});

/**
 * `ScriptedProbeCounter` + a batched-probe answer, so the gate can be observed
 * on the post-2026-08-01 default path. Every shard the batch was asked about is
 * recorded IN REQUEST ORDER (parsed off the `[Shard id@snap]` blocks the
 * batched system prompt stacks), which is what makes the kept set and its
 * router order observable when there is only one call to count.
 *
 * Verdicts mirror the solo stub's (knows:false), so recall behaviour is
 * identical on both paths and the only variable is how probes are packed.
 */
class BatchAwareProbeCounter extends ScriptedProbeCounter {
  /** One entry per batched call: the shard ids that call covered, in order. */
  batchedShardIds: string[][] = [];

  override async completeJson<T>(input: CompleteJsonInput): Promise<ProviderResponse<T>> {
    if (input.schemaName === "BatchedProbeResult") {
      const ids = [...input.system.matchAll(/\[Shard ([^\]@]+)@/g)].map((m) => m[1]!);
      this.batchedShardIds.push(ids);
      const data = {
        verdicts: ids.map((shard_id) => ({
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
    return await super.completeJson<T>(input);
  }

  /** Shards that reached a probe of ANY shape: solo top-1 + everything batched. */
  probedShardCount(): number {
    return this.probeCount + this.batchedShardIds.reduce((n, ids) => n + ids.length, 0);
  }
}

const gateScoring =
  (scoreByShard: Record<string, number>, seen: Array<{ shardId: string; digest: string }[]> = []) =>
  async (_q: string, shards: Array<{ shardId: string; digest: string }>): Promise<number[]> => {
    seen.push(shards);
    return shards.map((s) => scoreByShard[s.shardId] ?? 0);
  };

describe("resolveProbeLocalKeep", () => {
  it("defaults 0 (off) and rejects garbage", () => {
    expect(resolveProbeLocalKeep(undefined)).toBe(0);
    expect(resolveProbeLocalKeep("4")).toBe(4);
    expect(() => resolveProbeLocalKeep("four")).toThrow(EnvConfigError);
  });
});

describe("ask() with a local probe gate, CSM_PROBE_BATCH=0 (legacy solo probes)", () => {
  it("keeps top-1 unconditionally plus the best N-1 others, in ROUTER order", async () => {
    process.env.CSM_PROBE_BATCH = "0";
    process.env.CSM_PROBE_LOCAL_KEEP = "3";
    const provider = new ScriptedProbeCounter();
    const storage = makeStorage(8);
    // s0 (router top-1) gets the WORST local score — it must survive anyway.
    // Best others: s5, s3.
    const result = await ask({
      provider,
      storage,
      query: "what did we decide",
      skipQueryLog: true,
      localProbeGate: gateScoring({ s0: -5, s5: 9, s3: 8, s1: 1 }),
    });
    expect(provider.probeCount).toBe(3);
    expect(result.probes.map((p) => p.shardId)).toEqual(["s0", "s3", "s5"]); // router order, not score order
  });

  it("is a no-op when the flag is 0 even with a scorer injected", async () => {
    process.env.CSM_PROBE_BATCH = "0";
    const provider = new ScriptedProbeCounter();
    const storage = makeStorage(6);
    await ask({
      provider,
      storage,
      query: "q",
      skipQueryLog: true,
      localProbeGate: gateScoring({ s5: 100 }),
    });
    expect(provider.probeCount).toBe(6);
  });

  it("is a no-op when keep >= candidate count", async () => {
    process.env.CSM_PROBE_BATCH = "0";
    process.env.CSM_PROBE_LOCAL_KEEP = "12";
    const provider = new ScriptedProbeCounter();
    const storage = makeStorage(5);
    await ask({
      provider,
      storage,
      query: "q",
      skipQueryLog: true,
      localProbeGate: gateScoring({}),
    });
    expect(provider.probeCount).toBe(5);
  });
});

describe("ask() with a local probe gate, under the batched default (hosted provider)", () => {
  // No CSM_PROBE_BATCH here on purpose: these cases assert what the DEFAULT
  // does for a hosted-class provider name since 2026-08-01. The gate decides
  // which witnesses exist; batching only decides how the survivors are packed
  // into calls — the two levers must compose, not overwrite each other.

  it("cuts the witnesses BEFORE batching: batch covers exactly the kept 1..N-1", async () => {
    process.env.CSM_PROBE_LOCAL_KEEP = "3";
    const provider = new BatchAwareProbeCounter();
    const storage = makeStorage(8);
    // Same scores as the solo case above: s0 worst but forced, then s5, s3.
    const result = await ask({
      provider,
      storage,
      query: "what did we decide",
      skipQueryLog: true,
      localProbeGate: gateScoring({ s0: -5, s5: 9, s3: 8, s1: 1 }),
    });
    // Top-1 stays a SOLO call (the speculative top-1 recall launches off it),
    // and the 2 other survivors — not the 7 skipped ones — go in one batch.
    expect(provider.probeCount).toBe(1);
    expect(provider.batchedShardIds).toEqual([["s3", "s5"]]);
    expect(provider.probedShardCount()).toBe(3);
    // Identical kept set and identical ROUTER order as the CSM_PROBE_BATCH=0
    // case: batching must not reorder, drop, or add a witness.
    expect(result.probes.map((p) => p.shardId)).toEqual(["s0", "s3", "s5"]);
  });

  it("still probes every candidate when the gate is off (no witness lost to batching)", async () => {
    const provider = new BatchAwareProbeCounter();
    const storage = makeStorage(6);
    const result = await ask({
      provider,
      storage,
      query: "q",
      skipQueryLog: true,
      localProbeGate: gateScoring({ s5: 100 }),
    });
    expect(provider.probeCount).toBe(1); // solo top-1
    expect(provider.batchedShardIds).toEqual([["s1", "s2", "s3", "s4", "s5"]]);
    expect(provider.probedShardCount()).toBe(6); // same 6 as the legacy control
    expect(result.probes.map((p) => p.shardId)).toEqual([
      "s0",
      "s1",
      "s2",
      "s3",
      "s4",
      "s5",
    ]);
  });
});

describe("ask() local probe gate — scorer input", () => {
  it("hands the scorer one digest per probed candidate", async () => {
    // Batch-independent by construction: the digests are built from the
    // PRE-gate candidate list, before any decision about how probes are
    // packed into calls. Left on the default path to keep that true.
    process.env.CSM_PROBE_LOCAL_KEEP = "2";
    const provider = new ScriptedProbeCounter();
    const storage = makeStorage(4);
    const seen: Array<{ shardId: string; digest: string }[]> = [];
    await ask({
      provider,
      storage,
      query: "q",
      skipQueryLog: true,
      localProbeGate: gateScoring({}, seen),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.map((s) => s.shardId)).toEqual(["s0", "s1", "s2", "s3"]);
    for (const s of seen[0]!) expect(s.digest.length).toBeGreaterThan(0);
  });
});
