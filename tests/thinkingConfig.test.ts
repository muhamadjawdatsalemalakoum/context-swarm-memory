/**
 * Thinking-level configuration: env primitive + cache-key namespacing (audit P4).
 *
 * Two defects this pins:
 *  1. `CSM_GEMINI_THINKING` was read as `(process.env.X ?? "low").toLowerCase()`
 *     — a typo became an API-level thinkingLevel instead of a config error, the
 *     same family as `CSM_ROUTER_HYBRID=off` turning the router ON.
 *  2. The thinking level was ABSENT from the eval cache key, so two arms run at
 *     different levels hashed identically and the second silently replayed the
 *     first's responses — an A/B that measures nothing (cf. F11).
 */
import { afterEach, describe, expect, it } from "vitest";

import { computeCacheKey, thinkingCacheTag } from "../src/eval/cache.js";
import {
  resolveGeminiThinking,
  resolveGeminiThinkingMin,
} from "../src/providers/GeminiProvider.js";
import { envEnum, EnvConfigError } from "../src/utils/env.js";

afterEach(() => {
  delete process.env.CSM_GEMINI_THINKING;
  delete process.env.CSM_GEMINI_THINKING_MIN;
});

describe("envEnum", () => {
  it("falls back when unset/empty, matches case-insensitively, throws on anything else", () => {
    const opts = { name: "X", allowed: ["low", "high"] as const, fallback: "low" as const };
    expect(envEnum(undefined, opts)).toBe("low");
    expect(envEnum("   ", opts)).toBe("low");
    expect(envEnum("HIGH", opts)).toBe("high");
    expect(() => envEnum("higher", opts)).toThrow(EnvConfigError);
    // The error must name the variable and the accepted set — a config error
    // is only useful if it says what to type instead.
    expect(() => envEnum("higher", opts)).toThrow(/X.*low, high/s);
  });
});

describe("gemini thinking resolution", () => {
  it("defaults low / minimal and accepts every documented level", () => {
    expect(resolveGeminiThinking(undefined)).toBe("low");
    expect(resolveGeminiThinkingMin(undefined)).toBe("minimal");
    for (const v of ["minimal", "low", "medium", "high", "none", "default"]) {
      expect(resolveGeminiThinking(v)).toBe(v);
    }
    // gemini-3-pro rejects "minimal", so the floor must be settable to "low".
    expect(resolveGeminiThinkingMin("low")).toBe("low");
  });

  it("rejects typos instead of forwarding them to the API", () => {
    expect(() => resolveGeminiThinking("mimimal")).toThrow(EnvConfigError);
    expect(() => resolveGeminiThinking("off")).toThrow(EnvConfigError);
    // "none"/"default" are levels of the mode, NOT of the floor: a floor must
    // name a real level or `disableThinking` stages have nothing to fall to.
    expect(() => resolveGeminiThinkingMin("none")).toThrow(EnvConfigError);
    expect(() => resolveGeminiThinkingMin("default")).toThrow(EnvConfigError);
  });
});

describe("thinkingCacheTag", () => {
  it("is undefined only when the caller set neither variable", () => {
    expect(thinkingCacheTag({})).toBeUndefined();
    expect(thinkingCacheTag({ CSM_GEMINI_THINKING: "high" })).toBe("high/");
    expect(thinkingCacheTag({ CSM_GEMINI_THINKING_MIN: "low" })).toBe("/low");
    expect(
      thinkingCacheTag({ CSM_GEMINI_THINKING: "HIGH", CSM_GEMINI_THINKING_MIN: "Low" }),
    ).toBe("high/low");
  });
});

describe("computeCacheKey thinking namespacing", () => {
  const base = {
    model: "gemini-3.5-flash",
    prompt: "p",
    system: "s",
    temperature: 0,
    maxOutputTokens: 512,
  };

  it("gives different levels DIFFERENT keys", () => {
    const low = computeCacheKey({ ...base, thinkingLevel: "low/" });
    const high = computeCacheKey({ ...base, thinkingLevel: "high/" });
    expect(low).not.toBe(high);
  });

  it("is byte-identical to the legacy key when no level was ever set", () => {
    // Back-compat: runs that never touched the env vars must keep matching
    // entries written before this field existed.
    expect(computeCacheKey({ ...base, thinkingLevel: undefined })).toBe(
      computeCacheKey(base),
    );
  });
});
