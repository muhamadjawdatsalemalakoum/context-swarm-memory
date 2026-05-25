import { describe, expect, it } from "vitest";

import { compactEventIndex, probeShard } from "../src/core/probe.js";
import { recallShard } from "../src/core/recall.js";
import { SHARD_SYSTEM_PROMPT } from "../src/core/prompts.js";
import type {
  MemoryShardSnapshot,
  ProbeResult,
  RecallResult,
} from "../src/core/types.js";
import type {
  CompleteJsonInput,
  CompleteTextInput,
  LlmProvider,
  ProviderResponse,
} from "../src/providers/LlmProvider.js";

/**
 * Prefix-cache contract — Phase α regression guard.
 *
 * Under `OLLAMA_NUM_PARALLEL=1`, Ollama's slot-based KV cache reuses any
 * byte-identical prefix across sequential requests in the same slot. CSM's
 * probe and recall stages both prepend `SHARD_SYSTEM_PROMPT` (~140 tokens) to
 * the per-shard system prompt. Under 8 probes + ≤4 recalls per query, the
 * server pays the prefill for those ~140 tokens ONCE, not 12 times — saving
 * ~50ms/query of latency.
 *
 * This contract is silently broken the moment a future refactor:
 *   - Reorders the system-prompt construction (puts `[Shard X@Y]` first)
 *   - Interpolates a per-call variable (timestamp, shard summary, ID) into
 *     the prefix
 *   - Adds whitespace/header lines above SHARD_SYSTEM_PROMPT
 *
 * These tests record the system prompt sent to the provider and assert it
 * starts with the literal SHARD_SYSTEM_PROMPT. They do NOT exercise an LLM
 * call — a stub provider captures the system field and returns a canned JSON
 * response.
 */

interface CapturedCall {
  system: string;
  prompt: string;
  schemaName: string;
}

class CapturingProvider implements LlmProvider {
  readonly name = "stub";
  calls: CapturedCall[] = [];

  async completeJson<T>(input: CompleteJsonInput): Promise<ProviderResponse<T>> {
    this.calls.push({
      system: input.system,
      prompt: input.prompt,
      schemaName: input.schemaName,
    });
    const usage = {
      inputTokensEstimate: 100,
      outputTokensEstimate: 50,
      estimatedUsd: 0,
      latencyMs: 5,
    };
    let data: unknown;
    if (input.schemaName === "ProbeResult") {
      data = {
        knows: true,
        confidence: 0.8,
        memory_type: "direct",
        estimated_answer_value: "high",
        needs_full_recall: true,
        relevant_event_ids: ["e_001"],
      };
    } else if (input.schemaName === "RecallResult") {
      data = {
        shard_id: input.shardId ?? "s-stub",
        snapshot_id: input.snapshotId ?? "S001",
        confidence: 0.9,
        answer: "stub",
        claims: [{ claim: "x", support: ["e_001"], confidence: 0.9 }],
        unknowns: [],
        conflicts: [],
      };
    } else {
      data = {};
    }
    return {
      data: data as T,
      usage,
      rawText: JSON.stringify(data),
    };
  }

  async completeText(_i: CompleteTextInput): Promise<ProviderResponse<string>> {
    throw new Error("not used");
  }
}

function makeSnapshot(): MemoryShardSnapshot {
  return {
    shardId: "s-stub",
    snapshotId: "S001",
    systemPrompt: SHARD_SYSTEM_PROMPT,
    summary: "stub shard summary",
    events: [
      {
        eventId: "e_001",
        role: "user",
        content: "Stub event content for prefix-cache test.",
        createdAt: "2024-01-01T00:00:00.000Z",
        importance: 0.5,
        tags: ["stub"],
      },
    ],
    indexTerms: ["stub"],
    createdAt: "2024-01-01T00:00:00.000Z",
    parentSnapshotId: null,
  };
}

describe("prefix-cache contract", () => {
  it("probe system prompt starts with SHARD_SYSTEM_PROMPT verbatim", async () => {
    const provider = new CapturingProvider();
    const snapshot = makeSnapshot();
    await probeShard({ provider, userQuery: "anything", snapshot });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.system.startsWith(SHARD_SYSTEM_PROMPT)).toBe(true);
  });

  it("recall system prompt starts with SHARD_SYSTEM_PROMPT verbatim", async () => {
    const provider = new CapturingProvider();
    const snapshot = makeSnapshot();
    await recallShard({
      provider,
      userQuery: "anything",
      snapshot,
      relevantEventIdsHint: ["e_001"],
    });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.system.startsWith(SHARD_SYSTEM_PROMPT)).toBe(true);
  });

  it("probe and recall use the SAME first-N-character prefix (KV-cache reuse)", async () => {
    // The win comes from prefix MATCH between probe and recall calls within the
    // same query. If a future refactor diverges them (e.g., recall adds a line
    // BEFORE SHARD_SYSTEM_PROMPT), KV cache reuse breaks and we silently lose
    // ~50ms/query of latency under Ollama. This pins that the SHARD_SYSTEM_PROMPT
    // prefix appears verbatim, byte-identical, at offset 0 of both.
    const provider = new CapturingProvider();
    const snapshot = makeSnapshot();
    await probeShard({ provider, userQuery: "anything", snapshot });
    await recallShard({
      provider,
      userQuery: "anything",
      snapshot,
      relevantEventIdsHint: ["e_001"],
    });
    expect(provider.calls).toHaveLength(2);
    const probeSystem = provider.calls[0]!.system;
    const recallSystem = provider.calls[1]!.system;
    const sharedPrefixLen = SHARD_SYSTEM_PROMPT.length;
    expect(probeSystem.slice(0, sharedPrefixLen)).toBe(SHARD_SYSTEM_PROMPT);
    expect(recallSystem.slice(0, sharedPrefixLen)).toBe(SHARD_SYSTEM_PROMPT);
    // The shared prefix should extend past SHARD_SYSTEM_PROMPT to the start of
    // the per-shard `[Shard X@Y]` block, which is also identical between probe
    // and recall (same shardId/snapshotId).
    const sharedExtended = `${SHARD_SYSTEM_PROMPT}\n\n[Shard ${snapshot.shardId}@${snapshot.snapshotId}]`;
    expect(probeSystem.startsWith(sharedExtended)).toBe(true);
    expect(recallSystem.startsWith(sharedExtended)).toBe(true);
  });
});

// Use the imports so eslint/tsc doesn't complain (re-exported types).
type _Used = ProbeResult | RecallResult;
type _Test = ReturnType<typeof compactEventIndex>;
