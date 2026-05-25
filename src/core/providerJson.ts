import type { z } from "zod";
import type { LlmProvider, CompleteJsonInput, ProviderResponse } from "../providers/LlmProvider.js";
import { extractJson } from "../utils/json.js";

/** Calls the provider, parses JSON forgivingly, validates with Zod, retries once on failure.
 *  Phase 1 helper. The MockProvider already returns parsed JSON, but real providers may emit
 *  prose or fenced output, so we route everything through extractJson + Zod. */
export async function completeAndValidate<T>(
  provider: LlmProvider,
  input: CompleteJsonInput,
  schema: z.ZodSchema<T>,
): Promise<{ data: T; raw: string; usage: ProviderResponse<unknown>["usage"] }> {
  let lastErr: unknown;
  // Accumulate usage across ALL attempts (including failed/retried ones) so cost
  // accounting doesn't silently drop the tokens/latency spent on invalid-JSON retries.
  const usage = { inputTokensEstimate: 0, outputTokensEstimate: 0, estimatedUsd: 0, latencyMs: 0 };
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await provider.completeJson<unknown>(input);
    usage.inputTokensEstimate += r.usage.inputTokensEstimate;
    usage.outputTokensEstimate += r.usage.outputTokensEstimate;
    usage.estimatedUsd += r.usage.estimatedUsd;
    usage.latencyMs += r.usage.latencyMs;
    try {
      const parsed = typeof r.data === "string" ? extractJson(r.data) : r.data;
      // Fallback: some larger models (Gemma 31B in JSON mode) wrap their final
      // answer in a thinking-array — `[ {thought:...}, {conclusion:...} ]`.
      // If the top-level parse fails AND the value is an array, try the
      // elements in reverse order (conclusion typically comes last) before
      // giving up. Only triggers on validation failure; never on success.
      try {
        const data = schema.parse(parsed);
        return { data, raw: r.rawText, usage };
      } catch (innerErr) {
        if (Array.isArray(parsed)) {
          for (let i = parsed.length - 1; i >= 0; i--) {
            const result = schema.safeParse(parsed[i]);
            if (result.success) {
              return { data: result.data, raw: r.rawText, usage };
            }
          }
        }
        throw innerErr;
      }
    } catch (err) {
      lastErr = err;
      // Retry once with a stricter reminder appended.
      input = {
        ...input,
        prompt:
          input.prompt +
          `\n\nReminder: Return JSON only, valid against schema "${input.schemaName}". Do not include prose or fences. Return a single JSON OBJECT, not an array.`,
      };
    }
  }
  throw new Error(
    `Provider ${provider.name} returned invalid JSON for schema ${input.schemaName}: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}
