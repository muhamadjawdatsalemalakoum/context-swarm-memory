import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cacheGet,
  CacheRefusedEmptyError,
  cacheRoot,
  cacheSet,
  cacheStats,
  computeCacheKey,
  type CacheKeyInput,
} from "../src/eval/cache.js";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "csm-cache-test-"));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

const sampleInput: CacheKeyInput = {
  model: "gemma4:31b",
  prompt: "Test prompt",
  system: "Test system",
  temperature: 0,
  maxOutputTokens: 256,
};

describe("computeCacheKey", () => {
  it("returns the same hex digest for identical inputs", () => {
    expect(computeCacheKey(sampleInput)).toEqual(computeCacheKey(sampleInput));
  });

  it("changes when any field changes", () => {
    const base = computeCacheKey(sampleInput);
    expect(computeCacheKey({ ...sampleInput, model: "gemma4:e4b" })).not.toEqual(base);
    expect(computeCacheKey({ ...sampleInput, prompt: "Different" })).not.toEqual(base);
    expect(computeCacheKey({ ...sampleInput, temperature: 0.7 })).not.toEqual(base);
    expect(computeCacheKey({ ...sampleInput, seed: 1 })).not.toEqual(base);
    expect(computeCacheKey({ ...sampleInput, maxOutputTokens: 512 })).not.toEqual(base);
    expect(computeCacheKey({ ...sampleInput, system: undefined })).not.toEqual(base);
    expect(computeCacheKey({ ...sampleInput, reasoningEffort: "low" })).not.toEqual(base);
  });

  it("is insensitive to field ordering (stableStringify is sorted)", () => {
    const reordered: CacheKeyInput = {
      maxOutputTokens: sampleInput.maxOutputTokens,
      prompt: sampleInput.prompt,
      temperature: sampleInput.temperature,
      model: sampleInput.model,
      system: sampleInput.system,
    };
    expect(computeCacheKey(reordered)).toEqual(computeCacheKey(sampleInput));
  });

  it("produces a 64-char hex string (sha256)", () => {
    const k = computeCacheKey(sampleInput);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("cacheGet / cacheSet round-trip", () => {
  it("returns null on miss", async () => {
    const result = await cacheGet(sampleInput, tempRoot);
    expect(result).toBeNull();
  });

  it("returns the stored response after cacheSet", async () => {
    await cacheSet(sampleInput, { response: "stored answer", latencyMs: 1234 }, tempRoot);
    const result = await cacheGet(sampleInput, tempRoot);
    expect(result).not.toBeNull();
    expect(result!.response).toBe("stored answer");
    expect(result!.latencyMs).toBe(1234);
    expect(result!.key).toBe(computeCacheKey(sampleInput));
  });

  it("subsequent sets with different keys do not interfere", async () => {
    await cacheSet(sampleInput, { response: "answer-A", latencyMs: 1 }, tempRoot);
    await cacheSet(
      { ...sampleInput, prompt: "Other" },
      { response: "answer-B", latencyMs: 2 },
      tempRoot,
    );
    expect((await cacheGet(sampleInput, tempRoot))!.response).toBe("answer-A");
    expect((await cacheGet({ ...sampleInput, prompt: "Other" }, tempRoot))!.response).toBe(
      "answer-B",
    );
  });

  it("refuses to write empty responses (prevents poisoning on timeout/CPU-offload)", async () => {
    // Empty string — the timeout failure mode that nearly silently shipped null
    // answers through the scorer. cacheSet must throw, not store the entry.
    await expect(
      cacheSet(sampleInput, { response: "", latencyMs: 260_000 }, tempRoot),
    ).rejects.toBeInstanceOf(CacheRefusedEmptyError);
    // And nothing was written to disk.
    expect(await cacheGet(sampleInput, tempRoot)).toBeNull();
  });

  it("refuses to write whitespace-only / near-empty responses", async () => {
    await expect(
      cacheSet(sampleInput, { response: "   \n  ", latencyMs: 100 }, tempRoot),
    ).rejects.toBeInstanceOf(CacheRefusedEmptyError);
    await expect(
      cacheSet(sampleInput, { response: "yes", latencyMs: 100 }, tempRoot),
    ).rejects.toBeInstanceOf(CacheRefusedEmptyError);
  });
});

describe("cacheStats", () => {
  it("returns zero counts for an empty cache", async () => {
    const s = await cacheStats(tempRoot);
    expect(s.count).toBe(0);
    expect(s.sizeBytes).toBe(0);
  });

  it("counts files after writes", async () => {
    await cacheSet(sampleInput, { response: "answer-1", latencyMs: 1 }, tempRoot);
    await cacheSet(
      { ...sampleInput, prompt: "two" },
      { response: "answer-2", latencyMs: 1 },
      tempRoot,
    );
    await cacheSet(
      { ...sampleInput, prompt: "three" },
      { response: "answer-3", latencyMs: 1 },
      tempRoot,
    );
    const s = await cacheStats(tempRoot);
    expect(s.count).toBe(3);
    expect(s.sizeBytes).toBeGreaterThan(0);
  });
});

describe("cacheRoot", () => {
  it("respects the rootDir override", () => {
    const r = cacheRoot(tempRoot);
    expect(r.startsWith(tempRoot)).toBe(true);
    expect(r.includes("eval")).toBe(true);
    expect(r.includes("cache")).toBe(true);
  });
});
