import type {
  CompleteJsonInput,
  CompleteTextInput,
  LlmProvider,
  ProviderResponse,
  ProviderUsage,
} from "./LlmProvider.js";

export const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
export const GEMINI_DEFAULT_MODEL = "gemini-3.5-flash";

export interface GeminiProviderOptions {
  apiKey?: string;
  baseURL?: string;
  defaultModel?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
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
  };
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class GeminiProvider implements LlmProvider {
  readonly name = "gemini";
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly defaultModel: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: GeminiProviderOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";
    this.baseURL = stripSlash(opts.baseURL ?? process.env.CSM_GEMINI_BASE_URL ?? GEMINI_DEFAULT_BASE_URL);
    this.defaultModel = opts.defaultModel ?? process.env.CSM_GEMINI_MODEL ?? process.env.CSM_MODEL ?? GEMINI_DEFAULT_MODEL;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
  }): Promise<ProviderResponse<T>> {
    if (!this.apiKey) {
      throw new Error(
        "GeminiProvider: no API key. Set GEMINI_API_KEY or GOOGLE_API_KEY, or use CSM_PROVIDER=mock for local tests.",
      );
    }

    const model = args.model ?? this.defaultModel;
    const endpoint = `${this.baseURL}/models/${encodeURIComponent(model)}:generateContent`;
    const thinkingConfig = geminiThinkingConfig(model);
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
    const usage: ProviderUsage = {
      inputTokensEstimate:
        json.usageMetadata?.promptTokenCount ?? Math.ceil((args.system.length + args.prompt.length) / 4),
      outputTokensEstimate:
        json.usageMetadata?.candidatesTokenCount ?? Math.ceil(content.length / 4),
      estimatedUsd: 0,
      latencyMs: Date.now() - start,
    };

    return {
      data: content as unknown as T,
      rawText: content,
      usage,
    };
  }
}

function stripSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function redactedEndpoint(baseURL: string, model: string): string {
  return `${stripSlash(baseURL)}/models/${encodeURIComponent(model)}:generateContent`;
}

function geminiThinkingConfig(model: string): Record<string, unknown> | undefined {
  const mode = (process.env.CSM_GEMINI_THINKING ?? "low").toLowerCase().trim();
  if (mode === "default") return undefined;
  const lower = model.toLowerCase();
  if (lower.startsWith("gemini-3")) {
    if (mode === "none") return undefined;
    return { thinkingLevel: mode };
  }
  return undefined;
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
