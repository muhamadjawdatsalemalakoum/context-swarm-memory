// Provider abstraction. The MVP runs entirely on MockProvider by default.
// Real providers: OpenAI / Ollama (OpenAI-compatible local) / Gemini / Anthropic stub.

export interface CompleteJsonInput<TSchema = unknown> {
  system: string;
  prompt: string;
  schemaName: string;
  schema?: TSchema;
  maxOutputTokens: number;
  temperature?: number;
  model?: string;
  shardId?: string;
  snapshotId?: string;
  /** Sampling seed forwarded to the provider (`seed` in the OpenAI/Ollama body).
   *  Note: at temperature 0 (greedy) the seed does not change the output token
   *  stream — it only matters when temperature > 0 — so it is a reproducibility
   *  belt-and-suspenders, not the source of temp-0 determinism. */
  seed?: number;
  /** When true, request the provider suppress chain-of-thought / reasoning output.
   *  Honored by Ollama (Gemma 4, DeepSeek R1, Qwen 3) via the `think: false` body field;
   *  ignored by real OpenAI. Use for stages where reasoning is wasted budget — e.g.
   *  the probe stage (binary classification on an 8B model). Recall and synth keep
   *  reasoning enabled because their mid-pipeline reasoning earns its keep. See
   *  CHANGELOG for the Phase α justification. */
  disableThinking?: boolean;
  /** Declares that this call's `system` text is BYTE-STABLE for this key (e.g.
   *  `"s-auth@S001:probe-v2"` once probe prompts are snapshot-stable). Providers
   *  with explicit context caching (GeminiProvider under
   *  `CSM_GEMINI_CACHE=explicit`) MAY then cache the system text server-side
   *  under (model, cacheKey) and reuse it across calls. Ignored by every other
   *  provider and in every other cache mode. NO CSM call site sets this yet —
   *  probe/recall system prompts vary per query (query-ranked event index /
   *  hint-ordered digest), so caching them under a snapshot key would serve
   *  stale content. Wave-2 prompt restructuring is the intended first caller;
   *  see docs/experiments/EXP-T4-gemini-caching.md. GeminiProvider additionally
   *  verifies a SHA-256 of the system text per key and refuses cache reuse on
   *  mismatch, so a buggy caller degrades to uncached, never to wrong content. */
  cacheKey?: string;
}

export interface CompleteTextInput {
  system: string;
  prompt: string;
  maxOutputTokens: number;
  temperature?: number;
  model?: string;
  /** Sampling seed forwarded to the provider (`seed` in the OpenAI/Ollama body).
   *  At temperature 0 (greedy) it does not change output — reproducibility aid for
   *  temperature > 0. See `CompleteJsonInput.seed`. */
  seed?: number;
  /** See `CompleteJsonInput.disableThinking`. The final MCQ answer stage uses this
   *  to skip Gemma 4's 2-3K-token reasoning trace before the `ANSWER: N` line. */
  disableThinking?: boolean;
  /** See `CompleteJsonInput.cacheKey`. */
  cacheKey?: string;
}

export interface ProviderUsage {
  inputTokensEstimate: number;
  outputTokensEstimate: number;
  estimatedUsd: number;
  latencyMs: number;
  /** Input tokens served from the provider's context cache for this call
   *  (Gemini: `usageMetadata.cachedContentTokenCount`, populated on implicit
   *  cache hits and on explicit `cachedContent` use). A SUBSET of
   *  `inputTokensEstimate`, not additional spend — cached tokens bill at the
   *  provider's reduced cached-input rate. Only present when the provider
   *  reported it (T4 observability, 2026-06); absent ≠ 0 for providers that
   *  don't report cache metrics. */
  cachedInputTokens?: number;
  /** Reasoning/thinking tokens the provider spent before the visible output
   *  (Gemini: `usageMetadata.thoughtsTokenCount`). Billed as OUTPUT tokens by
   *  Gemini but NOT included in `candidatesTokenCount`, so
   *  `outputTokensEstimate` alone undercounts billed output for thinking
   *  models. Kept separate (not folded into `outputTokensEstimate`) so all
   *  existing accounting stays byte-identical; consumers that want billed
   *  output should add the two. Only present when the provider reported it. */
  thoughtsTokens?: number;
}

export interface ProviderResponse<T> {
  data: T;
  usage: ProviderUsage;
  rawText: string;
}

export interface LlmProvider {
  readonly name: string;
  completeJson<T>(input: CompleteJsonInput): Promise<ProviderResponse<T>>;
  completeText(input: CompleteTextInput): Promise<ProviderResponse<string>>;
}

export type ProviderName =
  | "mock"
  | "openai"
  | "ollama"
  | "llama-server"
  | "gemini"
  | "anthropic"
  /** Claude via the Claude Agent SDK sidecar (subscription-backed, iteration
   *  only — not independently reproducible; see AgentSdkProvider). */
  | "agent-sdk";

export interface ProviderEnv {
  CSM_PROVIDER?: string;
  CSM_OPENAI_BASE_URL?: string;
  CSM_GEMINI_BASE_URL?: string;
  CSM_GEMINI_MODEL?: string;
  /** Claude model id for CSM_PROVIDER=agent-sdk. Left unset, the sidecar picks
   *  its own default rather than inheriting another provider's model id. */
  CSM_AGENT_MODEL?: string;
  CSM_MODEL?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  GOOGLE_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
}

export function selectProviderName(env: ProviderEnv = process.env as ProviderEnv): ProviderName {
  const explicit = (env.CSM_PROVIDER ?? "").toLowerCase().trim();
  if (
    explicit === "openai" ||
    explicit === "anthropic" ||
    explicit === "agent-sdk" ||
    explicit === "gemini" ||
    explicit === "mock" ||
    explicit === "ollama" ||
    explicit === "llama-server"
  ) {
    return explicit as ProviderName;
  }
  // Auto-detect from base URL when CSM_PROVIDER is unset.
  // Port 8080 is the conventional llama.cpp `llama-server` port; 11434 is
  // Ollama's. Other local ports default to ollama for back-compat.
  const url = env.CSM_OPENAI_BASE_URL ?? "";
  if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal):8080(\b|\/)/i.test(url)) {
    return "llama-server";
  }
  if (/localhost|127\.0\.0\.1/i.test(url)) {
    return "ollama";
  }
  return "mock";
}

/** Per-pipeline-stage model selection. Falls back through the chain so common cases
 *  (single env var) just work, while allowing per-stage overrides for efficiency
 *  (cheap probe model + bigger recall/synth model). */
export interface StageModels {
  probe?: string;
  recall?: string;
  synth?: string;
}

export function resolveStageModels(
  overrides: StageModels = {},
  env: NodeJS.ProcessEnv = process.env,
  providerName?: string,
): StageModels {
  // Provider-scoped fallback. Since the CLI auto-loads the gitignored .env,
  // a Gemini setup (CSM_GEMINI_MODEL=gemini-3.5-flash) must not leak model
  // ids into runs on another provider — an Ollama benchmark was 404ing on
  // "gemini-3.5-flash" exactly this way. When the active provider is known,
  // only ITS model var participates; CSM_MODEL stays the generic fallback.
  const providerDefault =
    providerName === "gemini"
      ? env.CSM_GEMINI_MODEL
      : providerName === "agent-sdk"
        ? // Claude model ids only. Without this branch agent-sdk fell through to
          // the generic tail below and inherited CSM_GEMINI_MODEL from the root
          // .env, handing "gemini-3.5-flash" to the Claude sidecar — the same
          // cross-provider leak that 404'd an Ollama benchmark.
          env.CSM_AGENT_MODEL
        : providerName === "openai" ||
            providerName === "ollama" ||
            providerName === "llama-server"
          ? env.CSM_OPENAI_MODEL
          : env.CSM_OPENAI_MODEL || env.CSM_GEMINI_MODEL;
  const fallback = providerDefault || env.CSM_MODEL;
  return {
    probe: overrides.probe ?? env.CSM_PROBE_MODEL ?? fallback,
    recall: overrides.recall ?? env.CSM_RECALL_MODEL ?? fallback,
    synth: overrides.synth ?? env.CSM_SYNTH_MODEL ?? fallback,
  };
}
