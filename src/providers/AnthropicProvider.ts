import type {
  CompleteJsonInput,
  CompleteTextInput,
  LlmProvider,
  ProviderResponse,
} from "./LlmProvider.js";

/** Placeholder provider — Phase 1 wiring stub.
 *  Real network code is intentionally omitted from the MVP so tests pass
 *  without API keys. Construction succeeds, but call sites throw a clear
 *  error if invoked without ANTHROPIC_API_KEY. */
export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  private readonly apiKey: string | undefined;

  constructor(apiKey: string | undefined = process.env.ANTHROPIC_API_KEY) {
    this.apiKey = apiKey;
  }

  async completeJson<T>(_input: CompleteJsonInput): Promise<ProviderResponse<T>> {
    this.requireKey();
    throw new Error(
      "AnthropicProvider.completeJson is a Phase 1 stub. Wire fetch to /v1/messages with response_format=json here.",
    );
  }

  async completeText(_input: CompleteTextInput): Promise<ProviderResponse<string>> {
    this.requireKey();
    throw new Error(
      "AnthropicProvider.completeText is a Phase 1 stub. Wire fetch to /v1/messages here.",
    );
  }

  private requireKey(): void {
    if (!this.apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. Set CSM_PROVIDER=mock for tests, or provide an API key.",
      );
    }
  }
}
