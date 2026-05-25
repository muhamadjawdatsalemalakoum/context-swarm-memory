import type { LlmProvider } from "../providers/LlmProvider.js";
import {
  cacheGet,
  cacheSet,
  CacheRefusedEmptyError,
  type CacheKeyInput,
} from "./cache.js";

/**
 * The single LLM-call entry point every baseline goes through. Wraps a raw
 * `LlmProvider` with the content-hashed response cache (`./cache.ts`) so:
 *
 * - First run hits Ollama on the 4090, stores the response.
 * - Every subsequent run (replay) reads from disk — `npm run bench:replay`
 *   regenerates the headline numbers with zero LLM calls.
 *
 * Cache key includes model, prompt, system, temperature, seed, max_tokens.
 * Any change to any of those invalidates the cache entry (no silent drift).
 */
export interface CachedLlmCallInput {
  provider: LlmProvider;
  model: string;
  system: string;
  prompt: string;
  maxOutputTokens: number;
  /** Default 0 (deterministic). Anything else and the cache becomes useless. */
  temperature?: number;
  /** Default undefined; if you set it, it's part of the cache key. */
  seed?: number;
  /** Default true. Set false to force-fresh (e.g., for cache-fill verification). */
  useCache?: boolean;
  /** When true, requests the provider suppress chain-of-thought output (Ollama
   *  `think: false`). Part of the cache key when truthy. See `CompleteJsonInput.disableThinking`. */
  disableThinking?: boolean;
}

export interface CachedLlmCallOutput {
  response: string;
  /** Wall-clock latency of the original (uncached) call. */
  latencyMs: number;
  /** `true` if served from disk cache, `false` if freshly fetched. */
  cached: boolean;
  /** Token usage — exact from provider on miss, char/4 estimate on hit. */
  inputTokens: number;
  outputTokens: number;
}

/**
 * Look up the cache; on miss, call the provider and store the response.
 * Atomicity is provided by `cacheSet` (tmp + rename).
 */
export async function callLlmCached(
  input: CachedLlmCallInput,
): Promise<CachedLlmCallOutput> {
  const useCache = input.useCache ?? true;
  const cacheInput: CacheKeyInput = {
    model: input.model,
    prompt: input.prompt,
    system: input.system,
    temperature: input.temperature ?? 0,
    seed: input.seed,
    maxOutputTokens: input.maxOutputTokens,
    disableThinking: input.disableThinking,
  };

  if (useCache) {
    const hit = await cacheGet(cacheInput);
    if (hit) {
      return {
        response: hit.response,
        latencyMs: hit.latencyMs,
        cached: true,
        // Token counts aren't recorded in cache (small storage win, harmless
        // approximation). Use char/4 estimate for accounting.
        inputTokens: Math.ceil(
          (input.system.length + input.prompt.length) / 4,
        ),
        outputTokens: Math.ceil(hit.response.length / 4),
      };
    }
  }

  const result = await input.provider.completeText({
    system: input.system,
    prompt: input.prompt,
    maxOutputTokens: input.maxOutputTokens,
    temperature: input.temperature ?? 0,
    model: input.model,
    seed: input.seed, // now actually forwarded to the provider (was cache-key only)
    disableThinking: input.disableThinking,
  });

  if (useCache) {
    try {
      await cacheSet(cacheInput, {
        response: result.data,
        latencyMs: result.usage.latencyMs,
      });
    } catch (err) {
      if (err instanceof CacheRefusedEmptyError) {
        // Provider returned no usable text (timeout, CPU-offload stall, etc.).
        // Don't poison the cache — the next run will retry the LLM call.
        // Surface to the caller so the result row records the failure honestly
        // rather than silently propagating null answers through the scorer.
      } else {
        throw err;
      }
    }
  }

  return {
    response: result.data,
    latencyMs: result.usage.latencyMs,
    cached: false,
    inputTokens: result.usage.inputTokensEstimate,
    outputTokens: result.usage.outputTokensEstimate,
  };
}
