import { describe, expect, it } from "vitest";

import {
  LlamaServerProvider,
  LLAMA_SERVER_DEFAULT_BASE_URL,
  LLAMA_SERVER_DEFAULT_MODEL,
} from "../src/providers/LlamaServerProvider.js";
import {
  OllamaProvider,
  OLLAMA_DEFAULT_BASE_URL,
} from "../src/providers/OllamaProvider.js";
import {
  selectProviderName,
  type ProviderEnv,
} from "../src/providers/LlmProvider.js";

/**
 * Provider-selection contract — Phase β.1.
 *
 * Two daemons coexist for the migration: Ollama on 11434, llama-server on
 * 8080. The discriminator must:
 *   - Honor explicit `CSM_PROVIDER=llama-server`
 *   - Auto-detect port 8080 as llama-server when CSM_PROVIDER is unset
 *   - Keep port 11434 (and other local ports) as ollama for back-compat
 *   - Default to mock when nothing is set
 *
 * These tests pin that behavior so a future env-var refactor doesn't silently
 * regress provider selection.
 */

describe("selectProviderName — discriminator", () => {
  it("honors explicit CSM_PROVIDER=llama-server", () => {
    const env: ProviderEnv = { CSM_PROVIDER: "llama-server" };
    expect(selectProviderName(env)).toBe("llama-server");
  });

  it("honors explicit CSM_PROVIDER=ollama", () => {
    const env: ProviderEnv = { CSM_PROVIDER: "ollama" };
    expect(selectProviderName(env)).toBe("ollama");
  });

  it("auto-detects port 8080 as llama-server when CSM_PROVIDER is unset", () => {
    const env: ProviderEnv = {
      CSM_OPENAI_BASE_URL: "http://localhost:8080/v1",
    };
    expect(selectProviderName(env)).toBe("llama-server");
  });

  it("auto-detects port 8080 via 127.0.0.1 as llama-server", () => {
    const env: ProviderEnv = {
      CSM_OPENAI_BASE_URL: "http://127.0.0.1:8080/v1",
    };
    expect(selectProviderName(env)).toBe("llama-server");
  });

  it("keeps port 11434 as ollama (back-compat for existing setups)", () => {
    const env: ProviderEnv = {
      CSM_OPENAI_BASE_URL: "http://localhost:11434/v1",
    };
    expect(selectProviderName(env)).toBe("ollama");
  });

  it("falls through to ollama for any other local port", () => {
    // We don't want a future port choice to accidentally trigger llama-server
    // routing. Only :8080 is the llama-server convention. Other local ports
    // default to ollama.
    const env: ProviderEnv = {
      CSM_OPENAI_BASE_URL: "http://localhost:9999/v1",
    };
    expect(selectProviderName(env)).toBe("ollama");
  });

  it("defaults to mock when nothing is set", () => {
    const env: ProviderEnv = {};
    expect(selectProviderName(env)).toBe("mock");
  });

  it("explicit CSM_PROVIDER overrides URL-based auto-detection", () => {
    // Edge case: user sets CSM_OPENAI_BASE_URL to 8080 but wants ollama via
    // explicit override. The explicit env value wins.
    const env: ProviderEnv = {
      CSM_PROVIDER: "ollama",
      CSM_OPENAI_BASE_URL: "http://localhost:8080/v1",
    };
    expect(selectProviderName(env)).toBe("ollama");
  });
});

describe("LlamaServerProvider — Phase β.1 defaults", () => {
  it("uses port 8080 by default", () => {
    // Construction without args + without env should pick up the documented default.
    // We can't easily probe the private `baseURL` field; verify via the
    // exported constant matching the documented value instead.
    expect(LLAMA_SERVER_DEFAULT_BASE_URL).toBe("http://localhost:8080/v1");
  });

  it("uses normalised model name 'gemma4-31b' (no colon, distinct cache key from gemma4:31b)", () => {
    // Phase β.1 cache strategy: legacy ollama keys (`gemma4:31b`) remain
    // addressable for `headline-10q` replay; new llama-server runs hash under
    // `gemma4-31b`. This pins the normalised form so a future maintainer
    // doesn't accidentally re-introduce the colon and break the replay story.
    expect(LLAMA_SERVER_DEFAULT_MODEL).toBe("gemma4-31b");
    expect(LLAMA_SERVER_DEFAULT_MODEL.includes(":")).toBe(false);
  });

  it("reports providerName='llama-server'", () => {
    // Don't actually fire fetch — just construct with a stub.
    const p = new LlamaServerProvider({
      apiKey: "x",
      defaultModel: "stub",
      fetchImpl: () => new Response("") as never,
    });
    expect(p.name).toBe("llama-server");
  });

  it("Ollama and llama-server defaults are on DIFFERENT ports (coexistence)", () => {
    // The whole point: rollback is an env-var flip without daemon swap.
    expect(OLLAMA_DEFAULT_BASE_URL).not.toBe(LLAMA_SERVER_DEFAULT_BASE_URL);
    // Be explicit about the canonical ports
    expect(OLLAMA_DEFAULT_BASE_URL).toContain(":11434");
    expect(LLAMA_SERVER_DEFAULT_BASE_URL).toContain(":8080");
  });

  it("Ollama provider name stays 'ollama' (regression guard for selectProviderName)", () => {
    const p = new OllamaProvider({
      apiKey: "x",
      defaultModel: "stub",
      fetchImpl: () => new Response("") as never,
    });
    expect(p.name).toBe("ollama");
  });
});
