import { describe, expect, it } from "vitest";
import { z } from "zod";

import { runJobs } from "../src/core/ask.js";
import { completeAndValidate } from "../src/core/providerJson.js";
import type {
  CompleteJsonInput,
  LlmProvider,
  ProviderResponse,
} from "../src/providers/LlmProvider.js";

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("runJobs — parallelProbes serialization (audit F2)", () => {
  /** A job thunk that tracks how many run concurrently. */
  function trackingJobs(n: number) {
    const state = { live: 0, maxLive: 0 };
    const jobs = Array.from({ length: n }, () => async () => {
      state.live++;
      state.maxLive = Math.max(state.maxLive, state.live);
      await tick();
      state.live--;
      return 0;
    });
    return { jobs, state };
  }

  it("runs strictly one-at-a-time when parallel=false", async () => {
    const { jobs, state } = trackingJobs(4);
    await runJobs(jobs, false);
    expect(state.maxLive).toBe(1); // serial: never two in flight
  });

  it("runs concurrently when parallel=true", async () => {
    const { jobs, state } = trackingJobs(4);
    await runJobs(jobs, true);
    expect(state.maxLive).toBeGreaterThan(1); // parallel: overlap happens
  });

  it("does not start a thunk until the previous resolves (serial)", async () => {
    const order: string[] = [];
    const jobs = [
      async () => { order.push("start-a"); await tick(); order.push("end-a"); },
      async () => { order.push("start-b"); await tick(); order.push("end-b"); },
    ];
    await runJobs(jobs, false);
    // serial => a fully finishes before b starts
    expect(order).toEqual(["start-a", "end-a", "start-b", "end-b"]);
  });
});

describe("completeAndValidate — retry usage accounting (audit F4)", () => {
  function fakeProvider(responses: Array<{ data: string; usage: ProviderResponse<unknown>["usage"] }>): LlmProvider {
    let i = 0;
    return {
      name: "fake",
      async completeText() {
        throw new Error("not used");
      },
      async completeJson<T>(_input: CompleteJsonInput): Promise<ProviderResponse<T>> {
        const r = responses[Math.min(i, responses.length - 1)]!;
        i++;
        return { data: r.data as unknown as T, rawText: r.data, usage: r.usage };
      },
    };
  }

  const schema = z.object({ ok: z.boolean() });
  const input: CompleteJsonInput = {
    system: "",
    prompt: "",
    schemaName: "T",
    maxOutputTokens: 100,
  };

  it("sums tokens + latency across a failed attempt and the successful retry", async () => {
    const provider = fakeProvider([
      { data: "not json at all", usage: { inputTokensEstimate: 10, outputTokensEstimate: 5, estimatedUsd: 0, latencyMs: 100 } },
      { data: JSON.stringify({ ok: true }), usage: { inputTokensEstimate: 12, outputTokensEstimate: 6, estimatedUsd: 0, latencyMs: 120 } },
    ]);
    const r = await completeAndValidate(provider, input, schema);
    expect(r.data).toEqual({ ok: true });
    // usage must include BOTH the failed attempt and the successful one
    expect(r.usage.inputTokensEstimate).toBe(22);
    expect(r.usage.outputTokensEstimate).toBe(11);
    expect(r.usage.latencyMs).toBe(220);
  });

  it("returns just the single attempt's usage when the first call succeeds", async () => {
    const provider = fakeProvider([
      { data: JSON.stringify({ ok: true }), usage: { inputTokensEstimate: 9, outputTokensEstimate: 3, estimatedUsd: 0, latencyMs: 50 } },
    ]);
    const r = await completeAndValidate(provider, input, schema);
    expect(r.usage.inputTokensEstimate).toBe(9);
    expect(r.usage.latencyMs).toBe(50);
  });
});
