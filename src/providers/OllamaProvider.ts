import { Agent, setGlobalDispatcher } from "undici";

import { OpenAIProvider, type OpenAIProviderOptions } from "./OpenAIProvider.js";

/**
 * Node's bundled fetch (Undici) has its own per-request `headersTimeout`
 * defaulting to ~300s. With Gemma 31b on a 4090 we routinely see >300s
 * between request-send and headers-received (model warm-up, long prefill,
 * single-stream generation). The OpenAIProvider's AbortController timeout
 * never fires because Undici aborts first with `UND_ERR_HEADERS_TIMEOUT`.
 *
 * Set a global dispatcher with long timeouts once, at module load. This is
 * a side-effect — but the only fetch traffic in this codebase is the
 * provider HTTP calls, and benchmarks need it. Tests run against
 * `MockProvider` and never hit fetch, so the global state doesn't bleed in.
 */
let dispatcherInstalled = false;
function ensureLongTimeoutDispatcher(timeoutMs: number): void {
  if (dispatcherInstalled) return;
  setGlobalDispatcher(
    new Agent({
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      // Default 6 connections per host is plenty for sequential probes; we
      // bump to 16 in case a future path runs parallel probes intentionally.
      connections: 16,
    }),
  );
  dispatcherInstalled = true;
}

/**
 * Default Ollama base URL. Same value the README documents.
 */
export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434/v1";

/**
 * Default model for the benchmark recall/synth/answer stages on a 4090.
 * Q4_K_M quant of Gemma 4 31B fits in ~17GB VRAM, leaves ~7GB for KV cache + activations
 * with `OLLAMA_NUM_CTX=8192` and `OLLAMA_KV_CACHE_TYPE=q8_0`.
 */
export const OLLAMA_DEFAULT_MODEL = "gemma4:31b";

/**
 * Default smaller model for the probe stage (cheap relevance pass).
 * Gemma 4 e4b runs at 80–150 tok/s on a 4090.
 */
export const OLLAMA_DEFAULT_PROBE_MODEL = "gemma4:e4b";

export type OllamaProviderOptions = Omit<OpenAIProviderOptions, "providerName">;

/**
 * Thin wrapper around `OpenAIProvider` with Ollama-friendly defaults baked in.
 *
 * **Why a separate class?** `OpenAIProvider` already speaks Ollama's
 * OpenAI-compatible endpoint, so this is purely a configuration shortcut.
 * Calling sites (especially the benchmark in `src/eval/`) read more clearly
 * as `new OllamaProvider({ defaultModel: "gemma4:31b" })` than as
 * `new OpenAIProvider({ providerName: "ollama", baseURL: "...", apiKey: "ollama", ... })`.
 *
 * **4090 setup (set before `ollama serve`):**
 * ```
 * export OLLAMA_FLASH_ATTENTION=1
 * export OLLAMA_KV_CACHE_TYPE=q8_0
 * export OLLAMA_NUM_CTX=8192
 * export OLLAMA_KEEP_ALIVE=10m
 * export OLLAMA_NUM_PARALLEL=1
 * # one-time:
 * ollama pull gemma4:31b   # ~17GB, Q4_K_M
 * ollama pull gemma4:e4b   # ~3GB
 * # optional thermal cap (≈10°C cooler, ≈3% perf hit):
 * # nvidia-smi -pl 350
 * ```
 *
 * Expected throughput: ~25–40 tok/s generate for `gemma4:31b`, ~80–150 tok/s
 * for `gemma4:e4b`. GPU temperature stabilises around 70–78°C with stock
 * cooling and decent case airflow.
 */
/**
 * Default per-call timeout for Ollama. Local Gemma 4 31B can spend 50–90s
 * on prefill alone for 6–9K-token prompts on a 4090, plus a one-time
 * model-load cost (~30s for 19GB) on first call. 600s leaves slack for
 * long contexts; override with `CSM_OLLAMA_TIMEOUT_MS` if you have an
 * even slower setup. The OpenAI-via-Ollama path uses the same provider
 * options, so a higher cap doesn't hurt remote callers (they'll never
 * approach it).
 */
const OLLAMA_DEFAULT_TIMEOUT_MS = 600_000;

export class OllamaProvider extends OpenAIProvider {
  constructor(opts: OllamaProviderOptions = {}) {
    const envTimeout = process.env.CSM_OLLAMA_TIMEOUT_MS
      ? Number.parseInt(process.env.CSM_OLLAMA_TIMEOUT_MS, 10)
      : undefined;
    const effectiveTimeout =
      opts.timeoutMs ?? envTimeout ?? OLLAMA_DEFAULT_TIMEOUT_MS;
    ensureLongTimeoutDispatcher(effectiveTimeout);
    super({
      baseURL: opts.baseURL ?? process.env.CSM_OPENAI_BASE_URL ?? OLLAMA_DEFAULT_BASE_URL,
      // Ollama doesn't validate the bearer token, but the OpenAI HTTP plumbing
      // requires *some* non-empty value. "ollama" is a conventional placeholder.
      apiKey: opts.apiKey ?? process.env.OPENAI_API_KEY ?? "ollama",
      defaultModel:
        opts.defaultModel ??
        process.env.CSM_OPENAI_MODEL ??
        process.env.CSM_MODEL ??
        OLLAMA_DEFAULT_MODEL,
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs ?? envTimeout ?? OLLAMA_DEFAULT_TIMEOUT_MS,
      // Stream by default. With Gemma 31B on a 4090, non-streaming completions
      // can take 200-400s and Undici's `headersTimeout` fires before the
      // server sends any bytes. Streaming returns headers immediately and
      // pushes tokens as they generate — root-cause fix, not a workaround.
      stream: opts.stream ?? true,
      providerName: "ollama",
    });
  }
}
