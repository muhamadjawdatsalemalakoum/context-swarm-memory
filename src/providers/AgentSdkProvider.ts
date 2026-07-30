import type {
  CompleteJsonInput,
  CompleteTextInput,
  LlmProvider,
  ProviderResponse,
  ProviderUsage,
} from "./LlmProvider.js";

/**
 * Runs CSM's probe/recall/synthesis stages on Claude via the Claude Agent SDK,
 * which authenticates through Claude Code's credential chain — i.e. on a Claude
 * subscription rather than a metered API key.
 *
 * The SDK is NOT a dependency of this package: it peer-requires zod 4 while CSM
 * is pinned to zod 3. It runs in an isolated sidecar with its own node_modules
 * (`integrations/claude-agent/`), and this provider is a thin HTTP client over
 * it. That keeps the frozen, benchmarked pipeline's dependency tree untouched.
 *
 * Setup:
 *   claude setup-token                     # one-off, long-lived subscription token
 *   cd integrations/claude-agent && npm install && npm start
 *   CSM_PROVIDER=agent-sdk npm run csm -- ask "..."
 *
 * REPRODUCIBILITY: numbers produced through this provider are for ITERATION
 * ONLY. A third party cannot replay them with their own API key, so nothing
 * measured here is publishable evidence. Confirm on a documented key-based
 * provider (`CSM_PROVIDER=gemini`) before any result is reported.
 *
 * Like every other CSM provider, `data` carries the RAW text — `completeAndValidate`
 * downstream runs extractJson + Zod + retry. Do not parse here.
 */
export class AgentSdkProvider implements LlmProvider {
  readonly name = "agent-sdk";

  private readonly baseURL: string;
  private readonly defaultModel: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: {
    baseURL?: string;
    model?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  } = {}) {
    this.baseURL = (
      options.baseURL ??
      process.env.CSM_AGENT_BASE_URL ??
      `http://127.0.0.1:${process.env.CSM_AGENT_PORT ?? "8787"}`
    ).replace(/\/$/, "");
    this.defaultModel = options.model ?? process.env.CSM_AGENT_MODEL;
    // Claude with adaptive thinking can spend well over a minute on a synthesis
    // call; default generously so slow stages fail on quality, not the clock.
    this.timeoutMs = options.timeoutMs ?? parseIntOr(process.env.CSM_AGENT_TIMEOUT_MS, 300_000);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async completeJson<T>(input: CompleteJsonInput): Promise<ProviderResponse<T>> {
    return this.request<T>({
      system: input.system,
      prompt: input.prompt,
      model: input.model,
      jsonMode: true,
    });
  }

  async completeText(input: CompleteTextInput): Promise<ProviderResponse<string>> {
    return this.request<string>({
      system: input.system,
      prompt: input.prompt,
      model: input.model,
      jsonMode: false,
    });
  }

  private async request<T>(args: {
    system: string;
    prompt: string;
    model?: string;
    jsonMode: boolean;
  }): Promise<ProviderResponse<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
      (timer as unknown as { unref: () => void }).unref();
    }

    const start = Date.now();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseURL}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system: args.system,
          prompt: args.prompt,
          model: args.model ?? this.defaultModel,
          jsonMode: args.jsonMode,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (isAbortLike(err)) {
        throw new Error(
          `${this.name}: request timed out after ${this.timeoutMs}ms against ${this.baseURL}`,
        );
      }
      throw new Error(
        `${this.name}: cannot reach the sidecar at ${this.baseURL}. ` +
          `Start it with: cd integrations/claude-agent && npm start :: ${String(
            (err as Error)?.message ?? err,
          ).slice(0, 200)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const rawBody = await response.text();
    let json: {
      text?: string;
      usage?: { inputTokens?: number | null; outputTokens?: number | null };
      error?: string;
    };
    try {
      json = JSON.parse(rawBody) as typeof json;
    } catch {
      throw new Error(
        `${this.name}: non-JSON response from ${this.baseURL} :: ${rawBody.slice(0, 300)}`,
      );
    }

    if (!response.ok || json.error) {
      throw new Error(
        `${this.name}: HTTP ${response.status} from ${this.baseURL} :: ${String(
          json.error ?? rawBody,
        ).slice(0, 400)}`,
      );
    }

    const content = json.text ?? "";
    if (!content) {
      throw new Error(`${this.name}: empty completion from ${this.baseURL}`);
    }

    const usage: ProviderUsage = {
      // The sidecar reports real SDK usage when the message carries it; fall
      // back to the same chars/4 estimate every other CSM provider uses.
      inputTokensEstimate:
        json.usage?.inputTokens ?? Math.ceil((args.system.length + args.prompt.length) / 4),
      outputTokensEstimate: json.usage?.outputTokens ?? Math.ceil(content.length / 4),
      // Subscription-backed: no per-call metered charge to attribute.
      estimatedUsd: 0,
      latencyMs: Date.now() - start,
    };

    return { data: content as unknown as T, usage, rawText: content };
  }
}

function parseIntOr(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isAbortLike(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === "AbortError" || name === "TimeoutError";
}
