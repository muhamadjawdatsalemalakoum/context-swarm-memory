import { describe, expect, it } from "vitest";

import {
  chunkByTokenBudget,
  CsmBaseline,
  mapWithConcurrency,
} from "../src/eval/baselines/csm.js";
import type {
  CompleteTextInput,
  LlmProvider,
  ProviderResponse,
} from "../src/providers/LlmProvider.js";

/** Records every completeText call and returns a distinct, deterministic body
 *  ("OUT#N") so the test can distinguish map calls from the final reduce. */
class RecordingProvider implements LlmProvider {
  readonly name = "recording";
  calls: CompleteTextInput[] = [];
  // Must mirror the interface's generic signature: a bare `unknown` return
  // does not satisfy `completeJson<T>(...): Promise<ProviderResponse<T>>`, so
  // this class only *looked* like an LlmProvider.
  async completeJson<T>(): Promise<ProviderResponse<T>> {
    throw new Error("completeJson not used in these tests");
  }
  async completeText(input: CompleteTextInput): Promise<ProviderResponse<string>> {
    this.calls.push(input);
    const data = `OUT#${this.calls.length}`;
    return {
      data,
      usage: {
        inputTokensEstimate: 100,
        outputTokensEstimate: 10,
        estimatedUsd: 0,
        latencyMs: 1,
      },
      rawText: data,
    };
  }
}

describe("chunkByTokenBudget", () => {
  it("keeps everything in one chunk when under budget", () => {
    const items = ["a", "b", "c"];
    expect(chunkByTokenBudget(items, 1_000_000)).toEqual([items]);
  });

  it("splits in order once the budget is exceeded", () => {
    // Each item ~long enough to matter; small budget forces multiple chunks.
    const items = Array.from({ length: 6 }, (_, i) => "x".repeat(400) + i);
    const chunks = chunkByTokenBudget(items, 150); // ~100 tokens/item → 1 per chunk-ish
    // Order preserved: flattening reproduces the input.
    expect(chunks.flat()).toEqual(items);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("gives an oversize single item its own chunk (never splits a turn)", () => {
    const items = ["small", "y".repeat(8000), "small2"];
    const chunks = chunkByTokenBudget(items, 100);
    expect(chunks.flat()).toEqual(items);
    // The huge middle item is isolated.
    const huge = chunks.find((c) => c.length === 1 && c[0]!.startsWith("y"));
    expect(huge).toBeDefined();
  });

  it("handles empty input", () => {
    expect(chunkByTokenBudget([], 100)).toEqual([]);
  });
});

describe("mapWithConcurrency", () => {
  it("preserves order regardless of completion timing", async () => {
    const out = await mapWithConcurrency([10, 20, 30, 40], 2, async (n) => {
      await new Promise((r) => setTimeout(r, (50 - n) % 7));
      return n * 2;
    });
    expect(out).toEqual([20, 40, 60, 80]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("handles empty input", async () => {
    expect(await mapWithConcurrency([], 4, async (x) => x)).toEqual([]);
  });

  it("fails fast: after one rejection, workers stop claiming new items", async () => {
    // 12 items, concurrency 2; item 2 rejects. Without the aborted flag the
    // surviving worker would process all remaining items (the 10M-tier
    // token-burn bug); with it, at most the already-in-flight item completes.
    const attempted: number[] = [];
    await expect(
      mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 2, async (n) => {
        attempted.push(n);
        await new Promise((r) => setTimeout(r, 3));
        if (n === 2) throw new Error("chunk failed");
        return n;
      }),
    ).rejects.toThrow("chunk failed");
    // Let any straggler in-flight work settle before asserting.
    await new Promise((r) => setTimeout(r, 30));
    // Item 2 rejects while at most one sibling is in flight; workers then stop.
    // Allow the sibling + one boundary claim, but nowhere near all 12.
    expect(attempted.length).toBeLessThanOrEqual(5);
  });
});

describe("organizeMemoryScaled", () => {
  it("single-pass for small input: one LLM call, chunks=1", async () => {
    const provider = new RecordingProvider();
    const baseline = new CsmBaseline({ provider });
    const res = await baseline.organizeMemoryScaled({
      query: "focus",
      eventContents: ["the user asked about auth", "the user picked SQLite"],
      model: "m",
      singlePassTokens: 1_000_000,
    });
    expect(res.chunks).toBe(1);
    expect(provider.calls.length).toBe(1); // organizeMemory only
    expect(res.text).toBe("OUT#1");
  });

  it("map-reduce for large input: N map calls + 1 reduce, returns the merge", async () => {
    const provider = new RecordingProvider();
    const baseline = new CsmBaseline({ provider });
    const events = Array.from({ length: 8 }, (_, i) => "z".repeat(400) + i);
    const expectedChunks = chunkByTokenBudget(events, 120).length;
    const res = await baseline.organizeMemoryScaled({
      query: "focus",
      eventContents: events,
      model: "m",
      singlePassTokens: 50, // force the hierarchical path
      chunkTokens: 120,
      mapConcurrency: 2,
    });
    expect(expectedChunks).toBeGreaterThan(1);
    expect(res.chunks).toBe(expectedChunks);
    // One completeText per chunk (map) plus exactly one reduce.
    expect(provider.calls.length).toBe(expectedChunks + 1);
    // The returned text is the LAST call (the merge), not a map output.
    expect(res.text).toBe(`OUT#${expectedChunks + 1}`);
    // Token accounting sums every call.
    expect(res.inputTokens).toBe(100 * (expectedChunks + 1));
    expect(res.outputTokens).toBe(10 * (expectedChunks + 1));
    // The reduce prompt is built from segment summaries.
    expect(provider.calls.at(-1)!.prompt).toContain("SEGMENT SUMMARIES");
  });
});
