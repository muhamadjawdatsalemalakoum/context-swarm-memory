import type {
  CompleteJsonInput,
  CompleteTextInput,
  LlmProvider,
  ProviderResponse,
  ProviderUsage,
} from "./LlmProvider.js";

/** OpenAI-compatible HTTP provider.
 *
 *  Defaults are friendly to local **Ollama** (`http://localhost:11434/v1`) so
 *  zero-cost inference on a local Gemma 4 / Llama / etc. works out of the box.
 *  Set `CSM_OPENAI_BASE_URL`, `CSM_OPENAI_MODEL`, `OPENAI_API_KEY` (or any
 *  non-empty token for Ollama) via env, or pass them to the constructor.
 *
 *  The provider sends `response_format: { type: "json_object" }` for JSON
 *  calls, but the upstream `completeAndValidate` helper still parses
 *  defensively via `extractJson`, so non-strict servers still work.
 */
export interface OpenAIProviderOptions {
  baseURL?: string;
  apiKey?: string;
  defaultModel?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Logical name surfaced via `provider.name`. Defaults to "openai" but may be "ollama" etc. */
  providerName?: string;
  /**
   * Use HTTP streaming (SSE) instead of buffered single-shot completion.
   * Recommended for slow local models (Gemma 31B on a 4090) — Undici's
   * `headersTimeout` fires if no bytes arrive within ~300s; streaming
   * eliminates that because the server sends headers immediately and
   * pushes tokens as they're generated. Default false for back-compat.
   */
  stream?: boolean;
}

interface OpenAIChatResponse {
  id?: string;
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      /** Some thinking-style models (Gemma 4, DeepSeek R1, etc.) put chain-of-thought
       *  here while the final answer goes in `content`. When max_tokens is too small the
       *  reasoning budget can consume everything and `content` ends up empty — in that
       *  case we fall back to extracting JSON from `reasoning`. */
      reasoning?: string | null;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  model?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class OpenAIProvider implements LlmProvider {
  readonly name: string;
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly defaultModel: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly streamMode: boolean;

  constructor(opts: OpenAIProviderOptions = {}) {
    this.baseURL = stripSlash(opts.baseURL ?? process.env.CSM_OPENAI_BASE_URL ?? "https://api.openai.com/v1");
    // For Ollama, no real key is needed but the OpenAI client still expects an Authorization header.
    // We accept any non-empty placeholder.
    this.apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? (isLocalBase(this.baseURL) ? "ollama" : "");
    this.defaultModel = opts.defaultModel ?? process.env.CSM_OPENAI_MODEL;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.streamMode = opts.stream ?? false;
    this.name = opts.providerName ?? (isLocalBase(this.baseURL) ? "ollama" : "openai");
  }

  async completeJson<T>(input: CompleteJsonInput): Promise<ProviderResponse<T>> {
    return this.chat<T>({
      ...input,
      jsonMode: true,
      disableThinking: input.disableThinking,
    });
  }

  async completeText(input: CompleteTextInput): Promise<ProviderResponse<string>> {
    const r = await this.chat<string>({
      ...input,
      jsonMode: false,
      disableThinking: input.disableThinking,
    });
    return r;
  }

  private async chat<T>(args: {
    system: string;
    prompt: string;
    maxOutputTokens: number;
    temperature?: number;
    model?: string;
    jsonMode: boolean;
    disableThinking?: boolean;
    seed?: number;
  }): Promise<ProviderResponse<T>> {
    const model = args.model ?? this.defaultModel;
    if (!model) {
      throw new Error(
        "OpenAIProvider: no model specified. Set CSM_OPENAI_MODEL, or pass per-stage CSM_PROBE_MODEL/CSM_RECALL_MODEL/CSM_SYNTH_MODEL.",
      );
    }
    if (!this.apiKey) {
      throw new Error(
        "OpenAIProvider: no API key. Set OPENAI_API_KEY, or use a local OpenAI-compatible endpoint (Ollama) via CSM_OPENAI_BASE_URL=http://localhost:11434/v1.",
      );
    }

    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: args.system },
        { role: "user", content: args.prompt },
      ],
      temperature: args.temperature ?? 0,
      max_tokens: args.maxOutputTokens,
      stream: this.streamMode,
    };
    // Forward the sampling seed when provided. OpenAI accepts `seed`; Ollama's
    // OpenAI-compat endpoint maps it to `options.seed`. (No-op at temperature 0,
    // where decoding is greedy, but makes the "seeded" claim true and aids
    // reproducibility at temperature > 0.)
    if (args.seed !== undefined) {
      body.seed = args.seed;
    }
    if (args.jsonMode) {
      body.response_format = { type: "json_object" };
    }
    // Ollama-native field. Suppresses the <think>...</think> reasoning channel
    // for thinking-style models (Gemma 4, DeepSeek R1, Qwen 3). Silently ignored
    // by real OpenAI. We set it only when explicitly requested so existing
    // cached responses (generated with thinking ON) remain byte-identical replays.
    if (args.disableThinking) {
      body.think = false;
    }

    // Manual AbortController + unref'd timer.
    // Why not AbortSignal.timeout: on Windows + Node 24 with multiple parallel
    // fetches, libuv races during shutdown of the unfired timers and prints
    // an assertion ("UV_HANDLE_CLOSING") to stderr. Manual setTimeout we can
    // .unref() so it does not keep the loop alive, and clearTimeout it on resolve.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
      (timer as unknown as { unref: () => void }).unref();
    }
    const start = Date.now();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const errBody = await safeReadBody(response);
      throw new Error(
        `${this.name}: HTTP ${response.status} from ${this.baseURL}/chat/completions :: ${errBody.slice(0, 400)}`,
      );
    }

    let content = "";
    let reasoning = "";
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;

    if (this.streamMode) {
      // Parse SSE stream: each `data: {...}` line is an incremental chunk.
      // Keeps the connection alive so Undici's headersTimeout never fires.
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error(`${this.name}: stream mode but response.body is null`);
      }
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nlIdx: number;
        // SSE events are separated by "\n\n", but Ollama uses "\n". Handle either.
        while ((nlIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nlIdx).trim();
          buffer = buffer.slice(nlIdx + 1);
          if (!line) continue;
          if (line === "data: [DONE]") continue;
          const dataPrefix = "data: ";
          const payload = line.startsWith(dataPrefix) ? line.slice(dataPrefix.length) : line;
          try {
            const chunk = JSON.parse(payload) as {
              choices?: Array<{
                delta?: { content?: string | null; reasoning?: string | null };
                message?: { content?: string | null; reasoning?: string | null };
              }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number };
            };
            const delta = chunk.choices?.[0]?.delta;
            // Content and reasoning are tracked separately. Gemma 4 31B and
            // other thinking-style models stream internal CoT in
            // `delta.reasoning` while `delta.content` is empty. For JSON-mode
            // calls (probe/recall/synth) we want CONTENT ONLY — reasoning is
            // not JSON. For text-mode calls (the final MCQ answer) the model
            // may exhaust its output budget entirely on reasoning, never
            // emitting content; in that case we fall back to reasoning after
            // the stream closes (see the `content || reasoning` resolution
            // below). Keeping them in separate buffers lets us decide per-call.
            if (delta?.content) content += delta.content;
            if (delta?.reasoning) reasoning += delta.reasoning;
            // Some servers send `message` instead of `delta` on the final frame.
            const msg = chunk.choices?.[0]?.message;
            if (msg?.content && !delta?.content) content += msg.content;
            if (msg?.reasoning && !delta?.reasoning) reasoning += msg.reasoning;
            if (chunk.usage?.prompt_tokens !== undefined) promptTokens = chunk.usage.prompt_tokens;
            if (chunk.usage?.completion_tokens !== undefined) completionTokens = chunk.usage.completion_tokens;
          } catch {
            // Skip unparseable lines (keep-alives, comments, etc.)
          }
        }
      }
      // Text-mode fallback: when a thinking model spends its entire output
      // budget on reasoning without ever emitting content (observed on Gemma
      // 4 31B + 40-option MCQs at 2048 budget), the final `ANSWER: N` line is
      // typically buried in the reasoning trace. Surface it to the parser.
      // JSON mode keeps content-only because reasoning isn't valid JSON.
      if (!args.jsonMode && !content && reasoning) {
        content = reasoning;
      }
    } else {
      const json = (await response.json()) as OpenAIChatResponse;
      const message = json.choices?.[0]?.message;
      content = message?.content ?? "";
      // Thinking-model fallback: if content is empty but the model emitted chain-of-thought
      // into `reasoning`, the final JSON is usually somewhere in there. Let extractJson dig.
      if (!content && message?.reasoning) {
        content = message.reasoning;
      }
      promptTokens = json.usage?.prompt_tokens;
      completionTokens = json.usage?.completion_tokens;
    }

    const usage: ProviderUsage = {
      inputTokensEstimate: promptTokens ?? Math.ceil((args.system.length + args.prompt.length) / 4),
      outputTokensEstimate: completionTokens ?? Math.ceil(content.length / 4),
      estimatedUsd: 0, // local Gemma path; cost left to caller for hosted models
      latencyMs: Date.now() - start,
    };

    if (args.jsonMode) {
      // Do not parse here — `completeAndValidate` runs Zod + extractJson + retry.
      // Just return `content` as the raw payload; downstream parses.
      return { data: content as unknown as T, usage, rawText: content };
    }
    return { data: content as unknown as T, usage, rawText: content };
  }
}

function stripSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function isLocalBase(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal)/i.test(url);
}

async function safeReadBody(r: Response): Promise<string> {
  try {
    return await r.text();
  } catch {
    return "<unreadable body>";
  }
}
