/**
 * REGRESSION GUARD — model ids must never cross provider namespaces.
 *
 * CSM reads model ids from a shared, auto-loaded `.env`, so a value that is
 * correct for one provider is INVALID for another. Passing one across the
 * boundary fails at runtime with a confusing message rather than at compile
 * time. It has bitten three times:
 *
 *   1. An Ollama benchmark 404'd on "gemini-3.5-flash" inherited from
 *      CSM_GEMINI_MODEL.
 *   2. `agent-sdk` fell through the generic fallback and handed the same Gemini
 *      id to the Claude sidecar.
 *   3. The write-time preference extractor was called with `bridgeOpts.model`
 *      (CSM_AMB_MODEL, default "gemini-3.5-flash"); the Claude sidecar answered
 *      "There's an issue with the selected model (gemini-3.5-flash)" and the
 *      build silently degraded to no profile.
 *
 * Cases 1 and 2 were each fixed INSIDE `resolveStageModels`, which is why case 3
 * still happened: the rule existed but only covered three named stages, so every
 * new call site had to remember it. `resolveProviderModel` makes it a primitive.
 * These tests pin the primitive, not any one call site.
 */
import { describe, expect, it } from "vitest";

import {
  providerModelEnvVar,
  resolveProviderModel,
  resolveStageModels,
} from "../src/providers/LlmProvider.js";
import { publishBridgeModel, resolveBridgeModel } from "../scripts/amb-csm-retrieve.js";

/** A .env with EVERY provider's model set — the real-world hazard. */
const CROWDED_ENV = {
  CSM_GEMINI_MODEL: "gemini-3.5-flash",
  CSM_AGENT_MODEL: "claude-sonnet-5",
  CSM_OPENAI_MODEL: "gpt-5.4-mini",
} as NodeJS.ProcessEnv;

describe("resolveProviderModel — namespace isolation", () => {
  it("gives each provider ONLY its own model id", () => {
    expect(resolveProviderModel("gemini", CROWDED_ENV)).toBe("gemini-3.5-flash");
    expect(resolveProviderModel("agent-sdk", CROWDED_ENV)).toBe("claude-sonnet-5");
    expect(resolveProviderModel("openai", CROWDED_ENV)).toBe("gpt-5.4-mini");
    expect(resolveProviderModel("ollama", CROWDED_ENV)).toBe("gpt-5.4-mini");
    expect(resolveProviderModel("llama-server", CROWDED_ENV)).toBe("gpt-5.4-mini");
  });

  it("never hands a Gemini id to the Claude sidecar", () => {
    // The exact case 3 failure.
    const geminiOnly = { CSM_GEMINI_MODEL: "gemini-3.5-flash" } as NodeJS.ProcessEnv;
    expect(resolveProviderModel("agent-sdk", geminiOnly)).toBeUndefined();
    for (const provider of ["agent-sdk", "openai", "ollama", "llama-server"]) {
      expect(resolveProviderModel(provider, CROWDED_ENV)).not.toBe("gemini-3.5-flash");
    }
  });

  it("never hands a Claude id to a non-Claude provider", () => {
    const claudeOnly = { CSM_AGENT_MODEL: "claude-sonnet-5" } as NodeJS.ProcessEnv;
    for (const provider of ["gemini", "openai", "ollama", "llama-server"]) {
      expect(resolveProviderModel(provider, claudeOnly)).toBeUndefined();
    }
  });

  it("returns undefined rather than borrowing, so the provider uses its own default", () => {
    // undefined is the meaningful signal: "this provider has no configured
    // model". Substituting another provider's id is what caused all three bugs.
    expect(resolveProviderModel("agent-sdk", {} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(resolveProviderModel("mock", CROWDED_ENV)).toBeUndefined();
  });

  it("honours the generic CSM_MODEL escape hatch", () => {
    const env = { CSM_MODEL: "shared-model" } as NodeJS.ProcessEnv;
    expect(resolveProviderModel("gemini", env)).toBe("shared-model");
    expect(resolveProviderModel("agent-sdk", env)).toBe("shared-model");
  });

  it("prefers the provider-specific id over the generic one", () => {
    const env = {
      CSM_MODEL: "shared-model",
      CSM_AGENT_MODEL: "claude-sonnet-5",
    } as NodeJS.ProcessEnv;
    expect(resolveProviderModel("agent-sdk", env)).toBe("claude-sonnet-5");
  });
});

describe("providerModelEnvVar — the WRITE side of the same table", () => {
  it("maps each provider to its own slot", () => {
    expect(providerModelEnvVar("gemini")).toBe("CSM_GEMINI_MODEL");
    expect(providerModelEnvVar("agent-sdk")).toBe("CSM_AGENT_MODEL");
    expect(providerModelEnvVar("openai")).toBe("CSM_OPENAI_MODEL");
    expect(providerModelEnvVar("ollama")).toBe("CSM_OPENAI_MODEL");
  });

  it("refuses to name a slot for providers that have none", () => {
    // Callers must then not write at all, rather than pick one.
    expect(providerModelEnvVar("mock")).toBeUndefined();
    expect(providerModelEnvVar(undefined)).toBeUndefined();
  });

  it("never names the generic CSM_MODEL — that slot is read by EVERY provider", () => {
    for (const p of ["gemini", "agent-sdk", "openai", "ollama", "llama-server", "mock"]) {
      expect(providerModelEnvVar(p)).not.toBe("CSM_MODEL");
    }
  });
});

describe("the AMB bridge publishes models without crossing namespaces", () => {
  /**
   * CASE 4 of the same bug, found by the 2026-07-31 system audit. The read side
   * was already guarded by `resolveProviderModel`, but the bridge WROTE its
   * `--model` argument (default `"gemini-3.5-flash"`) into the generic
   * `CSM_MODEL`. Since `resolveProviderModel` falls back to `CSM_MODEL` for
   * every provider, merely starting the bridge under `CSM_PROVIDER=agent-sdk`
   * handed a Gemini id to the Claude sidecar.
   */
  it("does NOT let a bridge model leak into another provider's resolution", () => {
    const env = { CSM_PROVIDER: "agent-sdk" } as NodeJS.ProcessEnv;
    publishBridgeModel("gemini-3.5-flash", "gemini", env);
    expect(env.CSM_GEMINI_MODEL).toBe("gemini-3.5-flash");
    expect(env.CSM_MODEL).toBeUndefined();
    // The exact regression: the Claude sidecar must still have no model.
    expect(resolveProviderModel("agent-sdk", env)).toBeUndefined();
  });

  it("writes into the ACTIVE provider's slot", () => {
    const env = {} as NodeJS.ProcessEnv;
    publishBridgeModel("claude-sonnet-5", "agent-sdk", env);
    expect(env.CSM_AGENT_MODEL).toBe("claude-sonnet-5");
    expect(resolveProviderModel("agent-sdk", env)).toBe("claude-sonnet-5");
  });

  it("never overwrites configuration that is already present", () => {
    const env = { CSM_AGENT_MODEL: "claude-opus-5" } as NodeJS.ProcessEnv;
    publishBridgeModel("claude-sonnet-5", "agent-sdk", env);
    expect(env.CSM_AGENT_MODEL).toBe("claude-opus-5");
  });

  it("writes nothing for providers with no model slot", () => {
    const env = {} as NodeJS.ProcessEnv;
    publishBridgeModel("anything", "mock", env);
    expect(Object.keys(env)).toHaveLength(0);
  });

  it("resolves undefined rather than a hardcoded id when nothing is configured", () => {
    // Was `?? "gemini-3.5-flash"` — a valid id for one of six providers.
    const saved = { ...process.env };
    try {
      delete process.env.CSM_AMB_MODEL;
      delete process.env.CSM_MODEL;
      delete process.env.CSM_AGENT_MODEL;
      process.env.CSM_PROVIDER = "agent-sdk";
      expect(resolveBridgeModel()).toBeUndefined();
      expect(resolveBridgeModel("explicit-flag-wins")).toBe("explicit-flag-wins");
    } finally {
      process.env = saved;
    }
  });
});

describe("resolveStageModels delegates to the primitive", () => {
  it("inherits namespace isolation for every stage", () => {
    const stages = resolveStageModels({}, CROWDED_ENV, "agent-sdk");
    for (const model of [stages.probe, stages.recall, stages.synth]) {
      expect(model).toBe("claude-sonnet-5");
      expect(model).not.toBe("gemini-3.5-flash");
    }
  });

  it("still lets an explicit per-stage override win", () => {
    const stages = resolveStageModels({ probe: "explicit-probe" }, CROWDED_ENV, "agent-sdk");
    expect(stages.probe).toBe("explicit-probe");
    expect(stages.recall).toBe("claude-sonnet-5");
  });
});
