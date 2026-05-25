import { AnthropicProvider } from "./AnthropicProvider.js";
import { GeminiProvider } from "./GeminiProvider.js";
export { GEMINI_DEFAULT_BASE_URL, GEMINI_DEFAULT_MODEL } from "./GeminiProvider.js";
import { LlamaServerProvider } from "./LlamaServerProvider.js";
import { MockProvider } from "./MockProvider.js";
import { OllamaProvider } from "./OllamaProvider.js";
import { OpenAIProvider } from "./OpenAIProvider.js";
import { selectProviderName, type LlmProvider, type ProviderName } from "./LlmProvider.js";

export function createProvider(name: ProviderName = selectProviderName()): LlmProvider {
  switch (name) {
    case "openai":
      return new OpenAIProvider();
    case "ollama":
      // OllamaProvider applies local-Gemma-tuned defaults (incl. 600s timeout
      // because 31b on a 4090 can spend >2min on prefill + generation).
      return new OllamaProvider();
    case "llama-server":
      // Phase β.1: llama.cpp `llama-server` directly, with speculative
      // decoding + real prefix caching + grammar-constrained JSON. ~2×
      // wall-clock improvement vs Ollama on the same Gemma 4 31B weights.
      return new LlamaServerProvider();
    case "gemini":
      return new GeminiProvider();
    case "anthropic":
      return new AnthropicProvider();
    case "mock":
    default:
      return new MockProvider();
  }
}

export {
  AnthropicProvider,
  GeminiProvider,
  LlamaServerProvider,
  MockProvider,
  OllamaProvider,
  OpenAIProvider,
};
export * from "./LlmProvider.js";
