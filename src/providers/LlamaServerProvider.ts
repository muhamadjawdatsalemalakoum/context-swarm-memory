import { Agent, setGlobalDispatcher } from "undici";

import { OpenAIProvider, type OpenAIProviderOptions } from "./OpenAIProvider.js";

/**
 * Default llama.cpp `llama-server` base URL. Conventional port 8080 keeps it
 * distinct from Ollama's 11434 so both daemons can coexist during the
 * Phase β.1 cutover (rollback is a one-env-var flip).
 */
export const LLAMA_SERVER_DEFAULT_BASE_URL = "http://localhost:8080/v1";

/**
 * Default model identifier. Normalised form (no colon) so cache keys for new
 * runs are distinct from the legacy `gemma4:31b` keys Ollama produced. The
 * legacy keys remain addressable for `bench:replay headline-10q` because the
 * cache key hashes whatever `model` string the caller passes — old runs hash
 * `"gemma4:31b"`, new runs hash `"gemma4-31b"`.
 */
export const LLAMA_SERVER_DEFAULT_MODEL = "gemma4-31b";

/**
 * Default probe-stage model. Phase β.1 collapses probe + recall onto the
 * SAME 31B model because speculative decoding (Gemma 3 1B drafter →
 * Gemma 4 31B target) makes 31B inference near-1B speed on a 4090. Drops the
 * model-swap overhead that hurt Ollama under `OLLAMA_NUM_PARALLEL=1`.
 *
 * Falls back automatically if `CSM_PROBE_MODEL` is set explicitly.
 */
export const LLAMA_SERVER_DEFAULT_PROBE_MODEL = "gemma4-31b";

let dispatcherInstalled = false;
function ensureLongTimeoutDispatcher(timeoutMs: number): void {
  if (dispatcherInstalled) return;
  setGlobalDispatcher(
    new Agent({
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      connections: 16,
    }),
  );
  dispatcherInstalled = true;
}

/**
 * Default per-call timeout for llama-server. With speculative decoding (Gemma
 * 3 1B drafter → Gemma 4 31B target) we expect ~1.7× wall-clock improvement
 * vs Ollama, so 300s should be plenty for the worst-case recall on the 9M
 * PaySwift corpus. Keep at 600s with slack via `CSM_LLAMA_TIMEOUT_MS` if
 * speculative decoding fails to engage on a particular model pair.
 */
const LLAMA_SERVER_DEFAULT_TIMEOUT_MS = 600_000;

export type LlamaServerProviderOptions = Omit<OpenAIProviderOptions, "providerName">;

/**
 * Thin wrapper around `OpenAIProvider` with llama.cpp `llama-server` defaults.
 *
 * **Why a separate class?** Same reasoning as `OllamaProvider` — the wire
 * format is identical (OpenAI-compat); only the env defaults differ. Splitting
 * by daemon keeps call sites readable: `new LlamaServerProvider()` says
 * "I'm using llama-server with speculative decoding," not "I'm using
 * OpenAIProvider with some flags."
 *
 * **4090 setup (Phase β.1, replaces the Ollama runbook):**
 * ```
 * # one-time: download GGUFs
 * #   gemma-4-31b-it-Q4_K_M.gguf (~17 GB, target)
 * #   gemma-3-1b-it-Q4_K_M.gguf  (~0.8 GB, speculative drafter)
 * # to C:\models\
 *
 * # start the server (single-line; PowerShell continuation uses backtick `):
 * llama-server.exe `
 *   -m  C:\models\gemma-4-31b-it-Q4_K_M.gguf `
 *   -md C:\models\gemma-3-1b-it-Q4_K_M.gguf `
 *   --host 127.0.0.1 --port 8080 `
 *   -c 16384 -np 4 --cache-reuse 256 `
 *   -fa --swa-full -ngl 99 -ngld 99 `
 *   --draft-max 8 --draft-min 2 --draft-p-min 0.6 `
 *   -t 8 --keep -1 --metrics --log-timestamps
 *
 * # point CSM at it:
 * $env:CSM_PROVIDER         = "llama-server"
 * $env:CSM_OPENAI_BASE_URL  = "http://localhost:8080/v1"
 * $env:CSM_OPENAI_MODEL     = "gemma4-31b"
 * ```
 *
 * **Flag rationale:**
 * - `-md`: speculative drafter. 1.7× lossless wall-clock on Gemma 3 1B → 31B.
 * - `-fa --swa-full`: REQUIRED together for Gemma 4 cache reuse (known
 *   llama.cpp constraint — without `--swa-full` the sliding-window-attention
 *   portion silently disables `--cache-reuse`).
 * - `-np 4`: four parallel KV slots for CSM's probe-stage parallelism.
 * - `--cache-reuse 256`: enable real prefix caching at min-prefix-len 256.
 *   The SHARD_SYSTEM_PROMPT prefix (~140 tokens) won't trigger reuse at this
 *   threshold but the longer recall/synth prompt invariants will.
 * - `--keep -1`: pin model in VRAM (Ollama analogue: `OLLAMA_KEEP_ALIVE=10m`).
 * - `--metrics`: exposes `/metrics` for live spec-decode accept-rate check
 *   (`llamacpp:n_accepted_total / llamacpp:n_drafted_total` ≈ 0.55–0.70 for
 *   a well-matched pair).
 *
 * **Expected on the 4090:** ~70–85 s per bench cell (vs ~140 s under Ollama),
 * VRAM usage ~22.9 GB / 24 GB (1.1 GB headroom; drop `-np` 4→3 or `-c`
 * 16384→12288 if OOM).
 *
 * **Verification gate**: after starting the server, confirm spec-decode is
 * actually firing:
 * ```
 * curl http://127.0.0.1:8080/metrics | grep n_accepted_total
 * ```
 * Non-zero value = drafter loaded and accepted at least one token. Zero =
 * pair is incompatible or `-md` path wrong; fall back to target-only by
 * setting `-md ""`.
 */
export class LlamaServerProvider extends OpenAIProvider {
  constructor(opts: LlamaServerProviderOptions = {}) {
    const envTimeout = process.env.CSM_LLAMA_TIMEOUT_MS
      ? Number.parseInt(process.env.CSM_LLAMA_TIMEOUT_MS, 10)
      : undefined;
    const effectiveTimeout =
      opts.timeoutMs ?? envTimeout ?? LLAMA_SERVER_DEFAULT_TIMEOUT_MS;
    ensureLongTimeoutDispatcher(effectiveTimeout);
    super({
      baseURL:
        opts.baseURL ??
        process.env.CSM_OPENAI_BASE_URL ??
        LLAMA_SERVER_DEFAULT_BASE_URL,
      // llama-server doesn't validate bearer tokens but OpenAI HTTP plumbing
      // requires *some* non-empty value. Conventional placeholder.
      apiKey: opts.apiKey ?? process.env.OPENAI_API_KEY ?? "llama-server",
      defaultModel:
        opts.defaultModel ??
        process.env.CSM_OPENAI_MODEL ??
        process.env.CSM_MODEL ??
        LLAMA_SERVER_DEFAULT_MODEL,
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs ?? envTimeout ?? LLAMA_SERVER_DEFAULT_TIMEOUT_MS,
      // Stream by default — same rationale as Ollama. Spec-decode reduces
      // per-call latency but headers still need to arrive before Undici's
      // headersTimeout fires on a cold start.
      stream: opts.stream ?? true,
      providerName: "llama-server",
    });
  }
}
