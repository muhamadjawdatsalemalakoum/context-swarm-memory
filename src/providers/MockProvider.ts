import type {
  CompleteJsonInput,
  CompleteTextInput,
  LlmProvider,
  ProviderResponse,
  ProviderUsage,
} from "./LlmProvider.js";

/** A deterministic provider used for Phase 0 and tests.
 *
 *  It does not call any model. It returns the JSON literally embedded by
 *  the pipeline in the prompt, under a `<<MOCK_RESULT>>` fence. If no fence
 *  is present, it returns a minimal placeholder. This lets the mock pipeline
 *  pre-compute keyword-matching results and pass them through the same
 *  provider seam that real providers will use. */
export class MockProvider implements LlmProvider {
  readonly name = "mock";

  async completeJson<T>(input: CompleteJsonInput): Promise<ProviderResponse<T>> {
    const start = Date.now();
    const fenced = extractMockFence(input.prompt);
    const raw = fenced ?? `{}`;
    const data = JSON.parse(raw) as T;
    const usage: ProviderUsage = estimateUsage(input.system + input.prompt, raw);
    usage.latencyMs = Date.now() - start;
    return { data, usage, rawText: raw };
  }

  async completeText(input: CompleteTextInput): Promise<ProviderResponse<string>> {
    const start = Date.now();
    const fenced = extractMockFence(input.prompt);
    const raw = fenced ?? "";
    const usage: ProviderUsage = estimateUsage(input.system + input.prompt, raw);
    usage.latencyMs = Date.now() - start;
    return { data: raw, usage, rawText: raw };
  }
}

function extractMockFence(prompt: string): string | null {
  const m = prompt.match(/<<MOCK_RESULT>>([\s\S]*?)<<\/MOCK_RESULT>>/);
  return m ? m[1]!.trim() : null;
}

function estimateUsage(input: string, output: string): ProviderUsage {
  // Rough 4-chars-per-token heuristic. Cost is zero for the mock provider.
  return {
    inputTokensEstimate: Math.ceil(input.length / 4),
    outputTokensEstimate: Math.ceil(output.length / 4),
    estimatedUsd: 0,
    latencyMs: 0,
  };
}
