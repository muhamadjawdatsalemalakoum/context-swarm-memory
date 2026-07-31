import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";

import type {
  CompleteJsonInput,
  CompleteTextInput,
  LlmProvider,
  ProviderResponse,
  ProviderUsage,
} from "./LlmProvider.js";
import { envIntOptional } from "../utils/env.js";

export const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
export const GEMINI_DEFAULT_MODEL = "gemini-3.5-flash";

// ─── Context-cache mode (T4, 2026-06) ────────────────────────────────────────
//
// `CSM_GEMINI_CACHE` selects the provider's caching behavior. Default is `off`
// and `off` is BYTE-IDENTICAL to the pre-T4 provider: same request bytes, same
// endpoints, no cache reads or writes. All in-flight accuracy/latency gates
// therefore stay valid with the flag unset.
//
//   off              (default) no cache behavior at all.
//   implicit-observe request bytes still byte-identical; the provider logs one
//                    observation per call (JSONL when CSM_GEMINI_USAGE_LOG is
//                    set, stderr otherwise) so implicit-cache hits
//                    (usageMetadata.cachedContentTokenCount) and thinking spend
//                    (thoughtsTokenCount) become visible per stage.
//   explicit         additionally manages `cachedContents` server-side caches
//                    for calls that declare a byte-stable system prompt via
//                    `cacheKey` (no CSM call site does yet — see
//                    LlmProvider.CompleteJsonInput.cacheKey). Calls without a
//                    cacheKey behave exactly like `off`.
//
// Response-side usage parsing (cachedInputTokens / thoughtsTokens on
// ProviderUsage) is unconditional in every mode: it reads fields Gemini
// already returns and changes no request bytes.
export type GeminiCacheMode = "off" | "implicit-observe" | "explicit";

let warnedUnknownCacheMode = false;
export function resolveGeminiCacheMode(
  raw = process.env.CSM_GEMINI_CACHE,
): GeminiCacheMode {
  if (raw === undefined || raw.trim().length === 0) return "off";
  const v = raw.trim().toLowerCase();
  if (v === "off" || v === "implicit-observe" || v === "explicit") return v;
  if (!warnedUnknownCacheMode) {
    warnedUnknownCacheMode = true;
    console.error(
      `GeminiProvider: unknown CSM_GEMINI_CACHE value "${raw}" — falling back to "off". ` +
        `Valid: off | implicit-observe | explicit.`,
    );
  }
  return "off";
}

/** Minimum tokens Google will accept for a cachedContents entry on
 *  gemini-3.5-flash (also the implicit-cache floor). Verified 2026-06-10 at
 *  https://ai.google.dev/gemini-api/docs/caching ("Gemini 3.5 Flash: 4096").
 *  Override with CSM_GEMINI_CACHE_MIN_TOKENS if Google changes it. */
export const GEMINI_EXPLICIT_CACHE_MIN_TOKENS_DEFAULT = 4096;
const GEMINI_CACHE_TTL_S_DEFAULT = 3600; // API default TTL ("defaults to 1 hour")
const NEGATIVE_CACHE_MS = 10 * 60 * 1000; // don't retry failed cache creates for 10 min

export interface GeminiProviderOptions {
  apiKey?: string;
  baseURL?: string;
  defaultModel?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  /** Cache mode override; falls back to CSM_GEMINI_CACHE, default "off". */
  cacheMode?: GeminiCacheMode;
  /** Explicit-cache TTL override; falls back to CSM_GEMINI_CACHE_TTL_S, default 3600. */
  cacheTtlSeconds?: number;
  /** Explicit-cache minimum-token guard override; falls back to
   *  CSM_GEMINI_CACHE_MIN_TOKENS, default 4096 (gemini-3.5-flash floor). */
  cacheMinTokens?: number;
  /** Usage-log path override; falls back to CSM_GEMINI_USAGE_LOG. Pass null to
   *  silence file logging in tests regardless of env. */
  usageLogPath?: string | null;
  /** Injectable clock for cache-TTL tests. */
  now?: () => number;
}

/** Aggregate cache/thinking observation counters for one provider instance.
 *  Pure in-memory observability — consumed by scripts/measure-gemini-caching.ts
 *  and the (written, not yet run) observability soak in
 *  docs/experiments/EXP-T4-gemini-caching.md. */
export interface GeminiCacheStats {
  calls: number;
  promptTokens: number;
  cachedInputTokens: number;
  thoughtsTokens: number;
  outputTokens: number;
  explicitCacheCreates: number;
  explicitCacheReuses: number;
  explicitCacheFallbacks: number;
  /** A caller passed `cacheKey` but the system text's SHA-256 did not match the
   *  text cached under that key — the provider refused the cache (correctness
   *  over savings) and fell back to an uncached call. Always a caller bug. */
  cacheKeyContractViolations: number;
}

interface ExplicitCacheEntry {
  name: string; // "cachedContents/..."
  systemSha256: string;
  expiresAtMs: number;
  totalTokenCount?: number;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    /** Tokens served from context cache (implicit hit or explicit cachedContent). */
    cachedContentTokenCount?: number;
    /** Reasoning tokens; billed as output but NOT in candidatesTokenCount. */
    thoughtsTokenCount?: number;
  };
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

interface CachedContentsCreateResponse {
  name?: string;
  usageMetadata?: { totalTokenCount?: number };
  expireTime?: string;
  error?: { code?: number; message?: string; status?: string };
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;

export class GeminiProvider implements LlmProvider {
  readonly name = "gemini";
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly defaultModel: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  // ── T4 cache/observability state (inert when CSM_GEMINI_CACHE=off) ──
  private readonly cacheModeOverride?: GeminiCacheMode;
  private readonly cacheTtlSeconds: number;
  private readonly cacheMinTokens: number;
  private readonly usageLogPathOverride: string | null | undefined;
  private readonly now: () => number;
  /** Explicit-cache registry: `${model}::${cacheKey}` → live cachedContents entry. */
  private readonly explicitCaches = new Map<string, ExplicitCacheEntry>();
  /** Failed cache creations we should not retry for a while: key → retry-after ms. */
  private readonly negativeCache = new Map<string, number>();
  private readonly stats: GeminiCacheStats = {
    calls: 0,
    promptTokens: 0,
    cachedInputTokens: 0,
    thoughtsTokens: 0,
    outputTokens: 0,
    explicitCacheCreates: 0,
    explicitCacheReuses: 0,
    explicitCacheFallbacks: 0,
    cacheKeyContractViolations: 0,
  };

  constructor(opts: GeminiProviderOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";
    this.baseURL = stripSlash(opts.baseURL ?? process.env.CSM_GEMINI_BASE_URL ?? GEMINI_DEFAULT_BASE_URL);
    this.defaultModel = opts.defaultModel ?? process.env.CSM_GEMINI_MODEL ?? process.env.CSM_MODEL ?? GEMINI_DEFAULT_MODEL;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs =
      opts.timeoutMs ??
      envIntOptional(process.env.CSM_GEMINI_TIMEOUT_MS, { name: "CSM_GEMINI_TIMEOUT_MS", min: 1 }) ??
      DEFAULT_TIMEOUT_MS;
    this.maxRetries =
      opts.maxRetries ??
      envIntOptional(process.env.CSM_GEMINI_MAX_RETRIES, { name: "CSM_GEMINI_MAX_RETRIES", min: 0 }) ??
      DEFAULT_MAX_RETRIES;
    this.retryBaseDelayMs =
      opts.retryBaseDelayMs ??
      envIntOptional(process.env.CSM_GEMINI_RETRY_BASE_DELAY_MS, { name: "CSM_GEMINI_RETRY_BASE_DELAY_MS", min: 0 }) ??
      DEFAULT_RETRY_BASE_DELAY_MS;
    this.cacheModeOverride = opts.cacheMode;
    this.cacheTtlSeconds =
      opts.cacheTtlSeconds ??
      envIntOptional(process.env.CSM_GEMINI_CACHE_TTL_S, { name: "CSM_GEMINI_CACHE_TTL_S", min: 1 }) ??
      GEMINI_CACHE_TTL_S_DEFAULT;
    this.cacheMinTokens =
      opts.cacheMinTokens ??
      envIntOptional(process.env.CSM_GEMINI_CACHE_MIN_TOKENS, { name: "CSM_GEMINI_CACHE_MIN_TOKENS", min: 1 }) ??
      GEMINI_EXPLICIT_CACHE_MIN_TOKENS_DEFAULT;
    this.usageLogPathOverride = opts.usageLogPath;
    this.now = opts.now ?? Date.now;
  }

  /** Current cache mode. Env is read per call (mirrors how thinking config is
   *  resolved) so long-lived processes — the warm AMB bridge service — pick up
   *  changes without a restart; the constructor override pins it for tests. */
  private cacheMode(): GeminiCacheMode {
    return this.cacheModeOverride ?? resolveGeminiCacheMode();
  }

  /** Aggregate per-instance cache/thinking counters (all modes; pure memory). */
  getCacheStats(): Readonly<GeminiCacheStats> {
    return { ...this.stats };
  }

  /** Best-effort DELETE of every explicit cachedContents entry this instance
   *  created (cost hygiene at the end of a benchmark unit). Returns the number
   *  of caches successfully deleted. Never throws; failures are dropped because
   *  TTL expiry deletes the entry server-side anyway. */
  async clearExplicitCaches(): Promise<number> {
    let deleted = 0;
    for (const [key, entry] of [...this.explicitCaches]) {
      this.explicitCaches.delete(key);
      try {
        const res = await this.fetchImpl(`${this.baseURL}/${entry.name}`, {
          method: "DELETE",
          headers: { "x-goog-api-key": this.apiKey },
        });
        if (res.ok) deleted++;
      } catch {
        // TTL will reap it server-side.
      }
    }
    return deleted;
  }

  async completeJson<T>(input: CompleteJsonInput): Promise<ProviderResponse<T>> {
    return this.generate<T>({ ...input, jsonMode: true });
  }

  async completeText(input: CompleteTextInput): Promise<ProviderResponse<string>> {
    return this.generate<string>({ ...input, jsonMode: false });
  }

  private async generate<T>(args: {
    system: string;
    prompt: string;
    maxOutputTokens: number;
    temperature?: number;
    model?: string;
    jsonMode: boolean;
    schemaName?: string;
    disableThinking?: boolean;
    shardId?: string;
    snapshotId?: string;
    cacheKey?: string;
  }): Promise<ProviderResponse<T>> {
    if (!this.apiKey) {
      throw new Error(
        "GeminiProvider: no API key. Set GEMINI_API_KEY or GOOGLE_API_KEY, or use CSM_PROVIDER=mock for local tests.",
      );
    }

    const model = args.model ?? this.defaultModel;
    const endpoint = `${this.baseURL}/models/${encodeURIComponent(model)}:generateContent`;
    const thinkingConfig = geminiThinkingConfig(model, args.disableThinking);
    // The legacy request body. This construction is shared by ALL cache modes
    // and MUST stay byte-identical to the pre-T4 provider when serialized —
    // `off` and `implicit-observe` send exactly this object. Pinned by
    // tests/geminiCaching.test.ts (exact JSON equality, not toMatchObject).
    const body: Record<string, unknown> = {
      systemInstruction: {
        parts: [{ text: args.system }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: args.prompt }],
        },
      ],
      generationConfig: {
        temperature: args.temperature ?? 0,
        maxOutputTokens: args.maxOutputTokens,
        ...(thinkingConfig ? { thinkingConfig } : {}),
        ...(args.jsonMode
          ? {
              responseMimeType: "application/json",
              ...geminiResponseSchema(args.schemaName ?? ""),
            }
          : {}),
      },
    };

    // Explicit-cache path: only when the mode is `explicit` AND the caller
    // declared a byte-stable system prompt via `cacheKey`. Every failure mode
    // (below-minimum, creation error, hash mismatch, expiry) degrades to the
    // legacy body — never to an error and never to stale content.
    const mode = this.cacheMode();
    let cachedContentName: string | undefined;
    if (mode === "explicit" && args.cacheKey) {
      cachedContentName = await this.ensureExplicitCache(model, args.cacheKey, args.system);
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // When a cachedContents entry is engaged, the cached systemInstruction
      // replaces the request's — Gemini rejects requests that set BOTH
      // `cachedContent` and `system_instruction` (HTTP 400, verified against
      // live-API behavior reports; see docs/experiments/EXP-T4-gemini-caching.md A6).
      const effectiveBody = cachedContentName
        ? {
            contents: body.contents,
            generationConfig: body.generationConfig,
            cachedContent: cachedContentName,
          }
        : body;
      try {
        return await this.generateOnce<T>({
          args,
          body: effectiveBody,
          endpoint,
          model,
          observe: {
            mode,
            schemaName: args.schemaName,
            shardId: args.shardId,
            snapshotId: args.snapshotId,
            cacheKey: args.cacheKey,
            cachedContentName,
          },
        });
      } catch (err) {
        // Cache-flavored failure (e.g. the server already evicted the cache):
        // drop the registry entry and retry WITHOUT the cache. Does not consume
        // a transient-retry attempt — the uncached call keeps the full budget.
        if (cachedContentName && isCacheRelatedError(err)) {
          this.invalidateExplicitCache(model, args.cacheKey);
          cachedContentName = undefined;
          this.stats.explicitCacheFallbacks++;
          attempt--;
          continue;
        }
        lastError = err;
        if (attempt >= this.maxRetries || !isTransientGeminiError(err)) {
          throw err;
        }
        await sleep(retryDelayMs(attempt, this.retryBaseDelayMs));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** Look up / create the cachedContents entry for (model, cacheKey). Returns
   *  the cache resource name, or undefined to signal "send the legacy body".
   *  Never throws and never leaks the API key into errors (it surfaces none). */
  private async ensureExplicitCache(
    model: string,
    cacheKey: string,
    systemText: string,
  ): Promise<string | undefined> {
    const registryKey = `${model}::${cacheKey}`;
    const sha = sha256Hex(systemText);
    const nowMs = this.now();

    const existing = this.explicitCaches.get(registryKey);
    if (existing && existing.expiresAtMs > nowMs) {
      if (existing.systemSha256 !== sha) {
        // The caller's "byte-stable" promise is broken. Refuse the cache:
        // correctness (fresh content at full price) beats savings.
        this.stats.cacheKeyContractViolations++;
        warnCacheContractViolation(cacheKey);
        return undefined;
      }
      this.stats.explicitCacheReuses++;
      return existing.name;
    }
    if (existing) this.explicitCaches.delete(registryKey);

    const negativeUntil = this.negativeCache.get(registryKey);
    if (negativeUntil !== undefined && negativeUntil > nowMs) {
      this.stats.explicitCacheFallbacks++;
      return undefined;
    }

    // Cheap size guard (~4 chars/token): creation below the model's minimum
    // (4,096 tokens on gemini-3.5-flash) is a guaranteed 400 — skip the round
    // trip. The API remains the authority; if the estimate is wrong the
    // creation call below fails and we negative-cache the key.
    if (Math.ceil(systemText.length / 4) < this.cacheMinTokens) {
      this.negativeCache.set(registryKey, nowMs + NEGATIVE_CACHE_MS);
      this.stats.explicitCacheFallbacks++;
      return undefined;
    }

    try {
      const res = await this.fetchImpl(`${this.baseURL}/cachedContents`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify({
          model: `models/${model}`,
          systemInstruction: { parts: [{ text: systemText }] },
          ttl: `${this.cacheTtlSeconds}s`,
          displayName: `csm:${cacheKey}`.slice(0, 128),
        }),
      });
      const rawBody = await safeReadBody(res);
      const json = JSON.parse(rawBody) as CachedContentsCreateResponse;
      if (!res.ok || json.error || !json.name) {
        this.negativeCache.set(registryKey, nowMs + NEGATIVE_CACHE_MS);
        this.stats.explicitCacheFallbacks++;
        return undefined;
      }
      const ttlMs = this.cacheTtlSeconds * 1000;
      this.explicitCaches.set(registryKey, {
        name: json.name,
        systemSha256: sha,
        // Safety margin so we never send a name the server is about to reap.
        expiresAtMs: nowMs + ttlMs - Math.min(30_000, Math.floor(ttlMs / 10)),
        totalTokenCount: json.usageMetadata?.totalTokenCount,
      });
      this.stats.explicitCacheCreates++;
      return json.name;
    } catch {
      this.negativeCache.set(registryKey, nowMs + NEGATIVE_CACHE_MS);
      this.stats.explicitCacheFallbacks++;
      return undefined;
    }
  }

  private invalidateExplicitCache(model: string, cacheKey: string | undefined): void {
    if (!cacheKey) return;
    this.explicitCaches.delete(`${model}::${cacheKey}`);
  }

  private async generateOnce<T>(input: {
    args: {
      system: string;
      prompt: string;
      maxOutputTokens: number;
    };
    body: Record<string, unknown>;
    endpoint: string;
    model: string;
    observe?: {
      mode: GeminiCacheMode;
      schemaName?: string;
      shardId?: string;
      snapshotId?: string;
      cacheKey?: string;
      cachedContentName?: string;
    };
  }): Promise<ProviderResponse<T>> {
    const { args, body, endpoint, model, observe } = input;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
      (timer as unknown as { unref: () => void }).unref();
    }

    const start = Date.now();
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (isAbortLikeError(err)) {
        throw new Error(
          `${this.name}: request timed out after ${this.timeoutMs}ms from ${redactedEndpoint(this.baseURL, model)}`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    const rawBody = await safeReadBody(response);
    let json: GeminiResponse;
    try {
      json = JSON.parse(rawBody) as GeminiResponse;
    } catch {
      throw new Error(`${this.name}: non-JSON response from ${redactedEndpoint(this.baseURL, model)} :: ${rawBody.slice(0, 400)}`);
    }

    if (!response.ok || json.error) {
      const detail = json.error?.message ?? rawBody;
      throw new Error(
        `${this.name}: HTTP ${response.status} from ${redactedEndpoint(this.baseURL, model)} :: ${detail.slice(0, 400)}`,
      );
    }

    const content = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (!content) {
      const finishReason = json.candidates?.[0]?.finishReason ?? "unknown";
      throw new Error(
        `${this.name}: empty response from ${redactedEndpoint(this.baseURL, model)} (finishReason=${finishReason})`,
      );
    }
    const um = json.usageMetadata;
    const usage: ProviderUsage = {
      inputTokensEstimate:
        um?.promptTokenCount ?? Math.ceil((args.system.length + args.prompt.length) / 4),
      outputTokensEstimate:
        um?.candidatesTokenCount ?? Math.ceil(content.length / 4),
      estimatedUsd: 0,
      latencyMs: Date.now() - start,
      // T4 observability: surface cache hits and thinking spend when Gemini
      // reports them. Response-side parsing only — request bytes unchanged.
      // Absent (not 0) when the API omitted the field, so consumers can tell
      // "no cache hit reported" from "provider doesn't report cache metrics".
      ...(typeof um?.cachedContentTokenCount === "number"
        ? { cachedInputTokens: um.cachedContentTokenCount }
        : {}),
      ...(typeof um?.thoughtsTokenCount === "number"
        ? { thoughtsTokens: um.thoughtsTokenCount }
        : {}),
    };

    this.stats.calls++;
    this.stats.promptTokens += usage.inputTokensEstimate;
    this.stats.cachedInputTokens += usage.cachedInputTokens ?? 0;
    this.stats.thoughtsTokens += usage.thoughtsTokens ?? 0;
    this.stats.outputTokens += usage.outputTokensEstimate;

    if (observe && observe.mode !== "off") {
      this.emitObservation({
        ts: new Date(this.now()).toISOString(),
        mode: observe.mode,
        model,
        schemaName: observe.schemaName,
        shardId: observe.shardId,
        snapshotId: observe.snapshotId,
        cacheKey: observe.cacheKey,
        cachedContent: observe.cachedContentName,
        promptTokens: usage.inputTokensEstimate,
        cachedInputTokens: usage.cachedInputTokens ?? 0,
        thoughtsTokens: usage.thoughtsTokens ?? 0,
        outputTokens: usage.outputTokensEstimate,
        latencyMs: usage.latencyMs,
      });
    }

    return {
      data: content as unknown as T,
      rawText: content,
      usage,
    };
  }

  /** One observation row per LLM call when mode ≠ off. JSONL append when
   *  CSM_GEMINI_USAGE_LOG points at a file (NEVER point it inside a CSM data
   *  store — it is diagnostics, not memory), compact stderr line otherwise.
   *  Logging must never break the call: failures are swallowed. */
  private emitObservation(row: Record<string, unknown>): void {
    try {
      const path =
        this.usageLogPathOverride !== undefined
          ? this.usageLogPathOverride
          : process.env.CSM_GEMINI_USAGE_LOG || null;
      if (path) {
        appendFileSync(path, `${JSON.stringify(row)}\n`, "utf8");
      } else {
        console.error(
          `[gemini-cache] schema=${row.schemaName ?? "-"} shard=${row.shardId ?? "-"} ` +
            `prompt=${row.promptTokens} cached=${row.cachedInputTokens} ` +
            `thoughts=${row.thoughtsTokens} out=${row.outputTokens} lat=${row.latencyMs}ms`,
        );
      }
    } catch {
      // Observability must never take down the request path.
    }
  }
}



function isAbortLikeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || /aborted|abort/i.test(err.message);
}

function isTransientGeminiError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    /HTTP (408|409|429|500|502|503|504)\b/.test(msg) ||
    /timed out|fetch failed|overloaded|RESOURCE_EXHAUSTED|ECONNRESET|ETIMEDOUT|UND_ERR/i.test(
      msg,
    )
  );
}

/** Failures that implicate the explicit cachedContents entry (expired/evicted/
 *  rejected) rather than the request itself. These trigger an immediate retry
 *  with the legacy (uncached) body instead of failing the call. */
function isCacheRelatedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /cached\s*content|cachedContent|CACHED_CONTENT/i.test(err.message);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const warnedContractKeys = new Set<string>();
function warnCacheContractViolation(cacheKey: string): void {
  if (warnedContractKeys.has(cacheKey)) return;
  warnedContractKeys.add(cacheKey);
  console.error(
    `GeminiProvider: cacheKey "${cacheKey}" was reused with DIFFERENT system bytes — ` +
      `explicit cache refused for it (calls proceed uncached). The caller's ` +
      `byte-stability promise is broken; fix the call site.`,
  );
}

function retryDelayMs(attempt: number, baseDelayMs: number): number {
  return baseDelayMs * 2 ** attempt;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function redactedEndpoint(baseURL: string, model: string): string {
  return `${stripSlash(baseURL)}/models/${encodeURIComponent(model)}:generateContent`;
}

function geminiThinkingConfig(
  model: string,
  disableThinking?: boolean,
): Record<string, unknown> | undefined {
  const lower = model.toLowerCase();
  if (!lower.startsWith("gemini-3")) return undefined;

  // Per-call thinking floor for classification-style stages (probe sets
  // `disableThinking: true`). Measured on gemini-3.5-flash with a probe-shaped
  // call (scripts/probe-thinking-levels.ts, 2026-06-09): "minimal" emits 0
  // thought tokens at ~1.6 s vs 125 thoughts at ~2.1 s for "low" and 436
  // thoughts at ~4.0 s at API default. "none" is NOT a valid thinkingLevel
  // (HTTP 400). CSM_GEMINI_THINKING_MIN overrides for models whose floor
  // differs (e.g. gemini-3-pro rejects "minimal" — use "low" there).
  const minLevel = process.env.CSM_GEMINI_THINKING_MIN ?? "minimal";
  if (disableThinking) return { thinkingLevel: minLevel };

  const mode = (process.env.CSM_GEMINI_THINKING ?? "low").toLowerCase().trim();
  if (mode === "default") return undefined;
  // Historical footgun: "none" used to omit thinkingConfig entirely, which is
  // the API DEFAULT (= the most thinking, 436 thought tokens above), the
  // opposite of the requested behavior. Map it to the floor instead.
  if (mode === "none") return { thinkingLevel: minLevel };
  return { thinkingLevel: mode };
}

function geminiResponseSchema(schemaName: string): Record<string, unknown> {
  const schema = CSM_JSON_SCHEMAS[schemaName];
  return schema ? { responseJsonSchema: schema } : {};
}

const stringArray = {
  type: "array",
  items: { type: "string" },
} as const;

const claimSchema = {
  type: "object",
  properties: {
    claim: { type: "string" },
    support: stringArray,
    confidence: { type: "number" },
  },
  required: ["claim", "support", "confidence"],
} as const;

const keyClaimSchema = {
  type: "object",
  properties: {
    claim: { type: "string" },
    sources: stringArray,
    confidence: { type: "number" },
  },
  required: ["claim", "sources", "confidence"],
} as const;

const CSM_JSON_SCHEMAS: Record<string, unknown> = {
  ProbeResult: {
    type: "object",
    properties: {
      knows: { type: "boolean" },
      confidence: { type: "number" },
      memory_type: {
        type: "string",
        enum: ["direct", "adjacent", "conflicting", "vague", "none"],
      },
      estimated_answer_value: {
        type: "string",
        enum: ["none", "low", "medium", "high"],
      },
      needs_full_recall: { type: "boolean" },
      relevant_event_ids: stringArray,
    },
    required: [
      "knows",
      "confidence",
      "memory_type",
      "estimated_answer_value",
      "needs_full_recall",
      "relevant_event_ids",
    ],
  },
  // Batched probe (token plan L2b): one call, one verdict per shard, each
  // echoing its shard_id for caller-side reconciliation.
  BatchedProbeResult: {
    type: "object",
    properties: {
      verdicts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            shard_id: { type: "string" },
            knows: { type: "boolean" },
            confidence: { type: "number" },
            memory_type: {
              type: "string",
              enum: ["direct", "adjacent", "conflicting", "vague", "none"],
            },
            estimated_answer_value: {
              type: "string",
              enum: ["none", "low", "medium", "high"],
            },
            needs_full_recall: { type: "boolean" },
            relevant_event_ids: stringArray,
          },
          required: [
            "shard_id",
            "knows",
            "confidence",
            "memory_type",
            "estimated_answer_value",
            "needs_full_recall",
            "relevant_event_ids",
          ],
        },
      },
    },
    required: ["verdicts"],
  },
  RecallResult: {
    type: "object",
    properties: {
      shard_id: { type: "string" },
      snapshot_id: { type: "string" },
      confidence: { type: "number" },
      answer: { type: "string" },
      claims: {
        type: "array",
        items: claimSchema,
      },
      unknowns: stringArray,
      conflicts: stringArray,
    },
    required: [
      "shard_id",
      "snapshot_id",
      "confidence",
      "answer",
      "claims",
      "unknowns",
      "conflicts",
    ],
  },
  MemoryPacket: {
    type: "object",
    properties: {
      query: { type: "string" },
      summary: { type: "string" },
      key_claims: {
        type: "array",
        items: keyClaimSchema,
      },
      caveats: stringArray,
      conflicts: stringArray,
      recommended_main_context: { type: "string" },
    },
    required: [
      "query",
      "summary",
      "key_claims",
      "caveats",
      "conflicts",
      "recommended_main_context",
    ],
  },
  CommitDecision: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["write", "update", "split", "merge", "freeze", "no_op", "ask_confirmation"],
      },
      target_shard_id: { type: ["string", "null"] },
      memory_type: {
        type: "string",
        enum: [
          "user_preference",
          "project_decision",
          "fact",
          "correction",
          "inference",
          "none",
        ],
      },
      content: { type: "string" },
      confidence: { type: "number" },
      requires_user_confirmation: { type: "boolean" },
      tags: stringArray,
      source: {
        type: "string",
        enum: ["current_conversation", "user_confirmation", "system_inference"],
      },
    },
    required: [
      "action",
      "target_shard_id",
      "memory_type",
      "content",
      "confidence",
      "requires_user_confirmation",
      "tags",
      "source",
    ],
  },
};

async function safeReadBody(r: Response): Promise<string> {
  try {
    return await r.text();
  } catch {
    return "<unreadable body>";
  }
}
