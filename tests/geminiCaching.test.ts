import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GEMINI_DEFAULT_MODEL,
  GEMINI_EXPLICIT_CACHE_MIN_TOKENS_DEFAULT,
  GeminiProvider,
  resolveGeminiCacheMode,
} from "../src/providers/GeminiProvider.js";
import { completeAndValidate } from "../src/core/providerJson.js";
import { z } from "zod";
import type {
  CompleteJsonInput,
  CompleteTextInput,
  LlmProvider,
  ProviderResponse,
} from "../src/providers/LlmProvider.js";

/**
 * T4 — Gemini context caching + usage observability.
 *
 * Three invariants pinned here:
 *  1. DEFAULT-OFF BYTE-IDENTITY: with CSM_GEMINI_CACHE unset/off, the request
 *     body is byte-for-byte the pre-T4 body — even when a caller passes
 *     `cacheKey`. All in-flight gates stay valid.
 *  2. OBSERVABILITY IS RESPONSE-SIDE ONLY: cachedContentTokenCount /
 *     thoughtsTokenCount are parsed into optional ProviderUsage fields in every
 *     mode; absent from the API ⇒ absent from usage (never a synthetic 0).
 *  3. EXPLICIT MODE NEVER DEGRADES CORRECTNESS: every cache failure path
 *     (below-minimum, create error, hash mismatch, server-side eviction)
 *     falls back to the uncached legacy body, not to an error or stale bytes.
 */

const ENV_KEYS = [
  "CSM_GEMINI_CACHE",
  "CSM_GEMINI_USAGE_LOG",
  "CSM_GEMINI_CACHE_TTL_S",
  "CSM_GEMINI_CACHE_MIN_TOKENS",
  "CSM_GEMINI_THINKING",
  "CSM_GEMINI_THINKING_MIN",
] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

interface RecordedRequest {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

/** Fake Gemini backend: answers generateContent and cachedContents routes,
 *  records every request. Configurable per-test. */
function fakeGemini(opts?: {
  usageMetadata?: Record<string, unknown>;
  cacheCreateStatus?: number;
  cacheCreateName?: string;
  generateFailuresByMatch?: Array<{ match: RegExp; status: number; message: string; times: number }>;
}) {
  const requests: RecordedRequest[] = [];
  let cacheCounter = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    requests.push({ url, method, body });

    if (url.includes("/cachedContents") && method === "POST") {
      const status = opts?.cacheCreateStatus ?? 200;
      if (status !== 200) {
        return new Response(
          JSON.stringify({ error: { code: status, message: "Cached content is too small.", status: "INVALID_ARGUMENT" } }),
          { status, headers: { "content-type": "application/json" } },
        );
      }
      cacheCounter++;
      return new Response(
        JSON.stringify({
          name: opts?.cacheCreateName ?? `cachedContents/fake-${cacheCounter}`,
          usageMetadata: { totalTokenCount: 5000 },
          expireTime: "2026-06-10T12:00:00Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (method === "DELETE") {
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }

    // generateContent
    const failure = opts?.generateFailuresByMatch?.find(
      (f) => f.times > 0 && f.match.test(JSON.stringify(body ?? {})),
    );
    if (failure) {
      failure.times--;
      return new Response(
        JSON.stringify({ error: { code: failure.status, message: failure.message } }),
        { status: failure.status, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
        usageMetadata: opts?.usageMetadata ?? { promptTokenCount: 10, candidatesTokenCount: 3 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const BIG_SYSTEM = "S".repeat(GEMINI_EXPLICIT_CACHE_MIN_TOKENS_DEFAULT * 4 + 400); // ≈ >4096 tokens
const PING: CompleteJsonInput = {
  system: "Return JSON only.",
  prompt: "ping",
  schemaName: "Ping",
  maxOutputTokens: 64,
  temperature: 0,
};

describe("resolveGeminiCacheMode", () => {
  it("gemini_cache_mode_defaults_off_and_rejects_unknown", () => {
    expect(resolveGeminiCacheMode(undefined)).toBe("off");
    expect(resolveGeminiCacheMode("")).toBe("off");
    expect(resolveGeminiCacheMode("off")).toBe("off");
    expect(resolveGeminiCacheMode("implicit-observe")).toBe("implicit-observe");
    expect(resolveGeminiCacheMode("EXPLICIT")).toBe("explicit");
    // The test was NAMED "rejects_unknown" while asserting the opposite — an
    // unknown value silently became "off" (with a one-time console warning).
    // Now it rejects, like CSM_GEMINI_THINKING already did.
    expect(() => resolveGeminiCacheMode("banana")).toThrow(/CSM_GEMINI_CACHE/);
  });
});

describe("usage observability (all modes)", () => {
  it("gemini_usage_parses_cached_and_thoughts_tokens_when_present", async () => {
    const { fetchImpl } = fakeGemini({
      usageMetadata: {
        promptTokenCount: 6000,
        candidatesTokenCount: 40,
        cachedContentTokenCount: 4500,
        thoughtsTokenCount: 120,
        totalTokenCount: 6160,
      },
    });
    const provider = new GeminiProvider({ apiKey: "k", fetchImpl, usageLogPath: null });
    const r = await provider.completeJson(PING);
    expect(r.usage.inputTokensEstimate).toBe(6000);
    expect(r.usage.outputTokensEstimate).toBe(40);
    expect(r.usage.cachedInputTokens).toBe(4500);
    expect(r.usage.thoughtsTokens).toBe(120);
  });

  it("gemini_usage_omits_optional_fields_when_api_omits_them", async () => {
    const { fetchImpl } = fakeGemini(); // usageMetadata without cached/thoughts
    const provider = new GeminiProvider({ apiKey: "k", fetchImpl, usageLogPath: null });
    const r = await provider.completeJson(PING);
    expect("cachedInputTokens" in r.usage).toBe(false);
    expect("thoughtsTokens" in r.usage).toBe(false);
  });

  it("gemini_cache_stats_aggregate_across_calls", async () => {
    const { fetchImpl } = fakeGemini({
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 10,
        cachedContentTokenCount: 60,
        thoughtsTokenCount: 5,
      },
    });
    const provider = new GeminiProvider({ apiKey: "k", fetchImpl, usageLogPath: null });
    await provider.completeText({ system: "s", prompt: "p", maxOutputTokens: 8 });
    await provider.completeText({ system: "s", prompt: "p", maxOutputTokens: 8 });
    const stats = provider.getCacheStats();
    expect(stats.calls).toBe(2);
    expect(stats.promptTokens).toBe(200);
    expect(stats.cachedInputTokens).toBe(120);
    expect(stats.thoughtsTokens).toBe(10);
  });
});

describe("default-off byte identity", () => {
  it("gemini_cache_off_request_body_is_byte_identical_to_legacy", async () => {
    const { fetchImpl, requests } = fakeGemini();
    const provider = new GeminiProvider({
      apiKey: "k",
      defaultModel: GEMINI_DEFAULT_MODEL,
      fetchImpl,
      usageLogPath: null,
      // No cacheMode override: resolves from (cleared) env → "off".
    });
    // Even a caller that passes cacheKey must not change the bytes in off mode.
    await provider.completeJson({ ...PING, cacheKey: "s-x@S001:probe" });

    expect(requests).toHaveLength(1); // no cachedContents call
    const legacyBody = {
      systemInstruction: { parts: [{ text: PING.system }] },
      contents: [{ role: "user", parts: [{ text: PING.prompt }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 64,
        thinkingConfig: { thinkingLevel: "low" },
        responseMimeType: "application/json",
      },
    };
    expect(JSON.stringify(requests[0]!.body)).toBe(JSON.stringify(legacyBody));
  });

  it("gemini_cache_implicit_observe_keeps_request_bytes_identical", async () => {
    const recOff = fakeGemini();
    const recObserve = fakeGemini();
    const off = new GeminiProvider({ apiKey: "k", fetchImpl: recOff.fetchImpl, cacheMode: "off", usageLogPath: null });
    const observe = new GeminiProvider({
      apiKey: "k",
      fetchImpl: recObserve.fetchImpl,
      cacheMode: "implicit-observe",
      usageLogPath: null,
    });
    await off.completeJson(PING);
    await observe.completeJson(PING);
    expect(JSON.stringify(recObserve.requests[0]!.body)).toBe(
      JSON.stringify(recOff.requests[0]!.body),
    );
  });

  it("gemini_cache_implicit_observe_writes_usage_jsonl", async () => {
    const dir = mkdtempSync(join(tmpdir(), "csm-gemini-usage-"));
    const logPath = join(dir, "usage.jsonl");
    try {
      const { fetchImpl } = fakeGemini({
        usageMetadata: {
          promptTokenCount: 800,
          candidatesTokenCount: 30,
          cachedContentTokenCount: 0,
          thoughtsTokenCount: 12,
        },
      });
      const provider = new GeminiProvider({
        apiKey: "k",
        fetchImpl,
        cacheMode: "implicit-observe",
        usageLogPath: logPath,
      });
      await provider.completeJson({ ...PING, shardId: "s-auth", snapshotId: "S001" });
      const rows = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        mode: "implicit-observe",
        schemaName: "Ping",
        shardId: "s-auth",
        snapshotId: "S001",
        promptTokens: 800,
        cachedInputTokens: 0,
        thoughtsTokens: 12,
        outputTokens: 30,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("explicit cache mode", () => {
  it("gemini_explicit_creates_then_reuses_cachedContents_per_key", async () => {
    const { fetchImpl, requests } = fakeGemini();
    const provider = new GeminiProvider({
      apiKey: "k",
      defaultModel: GEMINI_DEFAULT_MODEL,
      fetchImpl,
      cacheMode: "explicit",
      usageLogPath: null,
    });
    const input: CompleteJsonInput = {
      ...PING,
      system: BIG_SYSTEM,
      cacheKey: "s-auth@S001:probe-v2",
    };
    await provider.completeJson(input);
    await provider.completeJson(input);

    const creates = requests.filter((r) => r.url.endsWith("/cachedContents"));
    const generates = requests.filter((r) => r.url.includes(":generateContent"));
    expect(creates).toHaveLength(1); // second call reuses the registry entry
    expect(generates).toHaveLength(2);

    expect(creates[0]!.body).toMatchObject({
      model: `models/${GEMINI_DEFAULT_MODEL}`,
      systemInstruction: { parts: [{ text: BIG_SYSTEM }] },
      ttl: "3600s",
    });
    for (const g of generates) {
      // Cached system replaces the request systemInstruction — sending both is
      // an API 400 ("CachedContent can not be used with ... system_instruction").
      expect(g.body).not.toHaveProperty("systemInstruction");
      expect(g.body).toMatchObject({ cachedContent: "cachedContents/fake-1" });
    }
    const stats = provider.getCacheStats();
    expect(stats.explicitCacheCreates).toBe(1);
    expect(stats.explicitCacheReuses).toBe(1);
  });

  it("gemini_explicit_recreates_after_ttl_expiry", async () => {
    let nowMs = 1_000_000;
    const { fetchImpl, requests } = fakeGemini();
    const provider = new GeminiProvider({
      apiKey: "k",
      fetchImpl,
      cacheMode: "explicit",
      cacheTtlSeconds: 300,
      usageLogPath: null,
      now: () => nowMs,
    });
    const input: CompleteJsonInput = { ...PING, system: BIG_SYSTEM, cacheKey: "s-a@S001" };
    await provider.completeJson(input);
    nowMs += 301_000; // past the 300s TTL
    await provider.completeJson(input);
    const creates = requests.filter((r) => r.url.endsWith("/cachedContents"));
    expect(creates).toHaveLength(2);
  });

  it("gemini_explicit_below_minimum_estimate_skips_creation_and_sends_legacy_body", async () => {
    const { fetchImpl, requests } = fakeGemini();
    const provider = new GeminiProvider({
      apiKey: "k",
      fetchImpl,
      cacheMode: "explicit",
      usageLogPath: null,
    });
    // PING.system is tiny — far below the 4,096-token explicit minimum.
    await provider.completeJson({ ...PING, cacheKey: "s-tiny@S001" });
    expect(requests.filter((r) => r.url.endsWith("/cachedContents"))).toHaveLength(0);
    expect(requests[0]!.body).toHaveProperty("systemInstruction");
    expect(requests[0]!.body).not.toHaveProperty("cachedContent");
    expect(provider.getCacheStats().explicitCacheFallbacks).toBe(1);
  });

  it("gemini_explicit_creation_failure_falls_back_uncached_without_throwing", async () => {
    const { fetchImpl, requests } = fakeGemini({ cacheCreateStatus: 400 });
    const provider = new GeminiProvider({
      apiKey: "k",
      fetchImpl,
      cacheMode: "explicit",
      usageLogPath: null,
    });
    const input: CompleteJsonInput = { ...PING, system: BIG_SYSTEM, cacheKey: "s-b@S001" };
    const r = await provider.completeJson(input);
    expect(r.rawText).toBe('{"ok":true}');
    const generates = requests.filter((u) => u.url.includes(":generateContent"));
    expect(generates[0]!.body).toHaveProperty("systemInstruction");
    // Negative cache: the second call must NOT retry the doomed creation.
    await provider.completeJson(input);
    expect(requests.filter((u) => u.url.endsWith("/cachedContents"))).toHaveLength(1);
  });

  it("gemini_explicit_refuses_cache_when_system_bytes_change_under_same_key", async () => {
    const { fetchImpl, requests } = fakeGemini();
    const provider = new GeminiProvider({
      apiKey: "k",
      fetchImpl,
      cacheMode: "explicit",
      usageLogPath: null,
    });
    const key = "s-c@S001:probe";
    await provider.completeJson({ ...PING, system: BIG_SYSTEM, cacheKey: key });
    // Same key, DIFFERENT system bytes — the byte-stability contract is broken.
    const mutated = BIG_SYSTEM.replace(/^S/, "X");
    await provider.completeJson({ ...PING, system: mutated, cacheKey: key });

    const generates = requests.filter((r) => r.url.includes(":generateContent"));
    expect(generates[1]!.body).toHaveProperty("systemInstruction"); // uncached fallback
    expect(generates[1]!.body).not.toHaveProperty("cachedContent");
    expect(provider.getCacheStats().cacheKeyContractViolations).toBe(1);
    expect(requests.filter((r) => r.url.endsWith("/cachedContents"))).toHaveLength(1);
  });

  it("gemini_explicit_server_evicted_cache_invalidates_and_retries_uncached", async () => {
    const { fetchImpl, requests } = fakeGemini({
      generateFailuresByMatch: [
        { match: /cachedContents\/fake-1/, status: 403, message: "CachedContent not found (or permission denied)", times: 1 },
      ],
    });
    const provider = new GeminiProvider({
      apiKey: "k",
      fetchImpl,
      cacheMode: "explicit",
      maxRetries: 2,
      retryBaseDelayMs: 0,
      usageLogPath: null,
    });
    const input: CompleteJsonInput = { ...PING, system: BIG_SYSTEM, cacheKey: "s-d@S001" };
    const r = await provider.completeJson(input);
    expect(r.rawText).toBe('{"ok":true}');
    const generates = requests.filter((u) => u.url.includes(":generateContent"));
    expect(generates).toHaveLength(2);
    expect(generates[0]!.body).toHaveProperty("cachedContent");
    expect(generates[1]!.body).toHaveProperty("systemInstruction");
    expect(provider.getCacheStats().explicitCacheFallbacks).toBe(1);
  });

  it("gemini_clear_explicit_caches_deletes_registry_entries", async () => {
    const { fetchImpl, requests } = fakeGemini();
    const provider = new GeminiProvider({
      apiKey: "k",
      fetchImpl,
      cacheMode: "explicit",
      usageLogPath: null,
    });
    await provider.completeJson({ ...PING, system: BIG_SYSTEM, cacheKey: "s-e@S001" });
    const deleted = await provider.clearExplicitCaches();
    expect(deleted).toBe(1);
    const dels = requests.filter((r) => r.method === "DELETE");
    expect(dels).toHaveLength(1);
    expect(dels[0]!.url).toContain("cachedContents/fake-1");
  });
});

describe("providerJson propagation", () => {
  class ScriptedUsageProvider implements LlmProvider {
    readonly name = "scripted";
    constructor(private withOptionalFields: boolean) {}
    async completeJson<T>(_input: CompleteJsonInput): Promise<ProviderResponse<T>> {
      const usage = this.withOptionalFields
        ? {
            inputTokensEstimate: 100,
            outputTokensEstimate: 20,
            estimatedUsd: 0,
            latencyMs: 5,
            cachedInputTokens: 64,
            thoughtsTokens: 9,
          }
        : { inputTokensEstimate: 100, outputTokensEstimate: 20, estimatedUsd: 0, latencyMs: 5 };
      return { data: { ok: true } as T, usage, rawText: '{"ok":true}' };
    }
    async completeText(_i: CompleteTextInput): Promise<ProviderResponse<string>> {
      throw new Error("not used");
    }
  }
  const okSchema = z.object({ ok: z.boolean() });

  it("provider_json_forwards_optional_usage_fields_when_reported", async () => {
    const { usage } = await completeAndValidate(
      new ScriptedUsageProvider(true),
      { system: "s", prompt: "p", schemaName: "Ok", maxOutputTokens: 16 },
      okSchema,
    );
    expect(usage.cachedInputTokens).toBe(64);
    expect(usage.thoughtsTokens).toBe(9);
  });

  it("provider_json_keeps_usage_key_set_unchanged_when_not_reported", async () => {
    const { usage } = await completeAndValidate(
      new ScriptedUsageProvider(false),
      { system: "s", prompt: "p", schemaName: "Ok", maxOutputTokens: 16 },
      okSchema,
    );
    expect("cachedInputTokens" in usage).toBe(false);
    expect("thoughtsTokens" in usage).toBe(false);
    expect(Object.keys(usage).sort()).toEqual([
      "estimatedUsd",
      "inputTokensEstimate",
      "latencyMs",
      "outputTokensEstimate",
    ]);
  });
});
