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
 */
import { afterEach, describe, expect, it } from "vitest";

import { ask, resolveProbeLocalKeep } from "../src/core/ask.js";
import { EnvConfigError } from "../src/utils/env.js";
import { makeStorage, ScriptedProbeCounter } from "./probeShrinkHarness.js";

afterEach(() => {
  delete process.env.CSM_PROBE_LOCAL_KEEP;
});

describe("resolveProbeLocalKeep", () => {
  it("defaults 0 (off) and rejects garbage", () => {
    expect(resolveProbeLocalKeep(undefined)).toBe(0);
    expect(resolveProbeLocalKeep("4")).toBe(4);
    expect(() => resolveProbeLocalKeep("four")).toThrow(EnvConfigError);
  });
});

describe("ask() with a local probe gate", () => {
  const gateScoring =
    (scoreByShard: Record<string, number>, seen: Array<{ shardId: string; digest: string }[]> = []) =>
    async (_q: string, shards: Array<{ shardId: string; digest: string }>): Promise<number[]> => {
      seen.push(shards);
      return shards.map((s) => scoreByShard[s.shardId] ?? 0);
    };

  it("keeps top-1 unconditionally plus the best N-1 others, in ROUTER order", async () => {
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

  it("hands the scorer one digest per probed candidate", async () => {
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
