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
}

export interface ProviderUsage {
  inputTokensEstimate: number;
  outputTokensEstimate: number;
  estimatedUsd: number;
  latencyMs: number;
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
  | "anthropic";

export interface ProviderEnv {
  CSM_PROVIDER?: string;
  CSM_OPENAI_BASE_URL?: string;
  CSM_GEMINI_BASE_URL?: string;
  CSM_GEMINI_MODEL?: string;
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
): StageModels {
  const fallback = env.CSM_OPENAI_MODEL || env.CSM_GEMINI_MODEL || env.CSM_MODEL;
  return {
    probe: overrides.probe ?? env.CSM_PROBE_MODEL ?? fallback,
    recall: overrides.recall ?? env.CSM_RECALL_MODEL ?? fallback,
    synth: overrides.synth ?? env.CSM_SYNTH_MODEL ?? fallback,
  };
}
