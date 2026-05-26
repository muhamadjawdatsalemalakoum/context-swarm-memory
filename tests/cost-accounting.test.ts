import { afterEach, describe, expect, it, vi } from "vitest";

import { CsmBaseline } from "../src/eval/baselines/csm.js";
import type { BenchEvent, Corpus } from "../src/eval/corpus.js";
import type { McqQuery } from "../src/eval/mcq.js";
import type {
  CompleteJsonInput,
  CompleteTextInput,
  LlmProvider,
  ProviderResponse,
} from "../src/providers/LlmProvider.js";

/**
 * Cost-accounting contract test.
 *
 * The rule (see `docs/COST_ACCOUNTING.md` and the JSDoc on `BaselineResult`):
 *   For any multi-call baseline, `inputTokens` / `outputTokens` / `latencyMs`
 *   at the top level of `BaselineResult` MUST be the TOTAL across every LLM
 *   call the baseline made — not just the final answering call.
 *
 * This pins the contract for CSM specifically — the only multi-call baseline
 * today and the one where the bug originated. The test uses a stub
 * `LlmProvider` that returns canned schema-shaped responses for every CSM
 * pipeline stage and records each call's usage. Then it asserts:
 *
 *   - Top-level `inputTokens === meta.pipelineInputTokens + meta.finalCallInputTokens`
 *   - Same for output tokens and latency.
 *   - `pipelineInputTokens > 0` (because at least probes ran).
 *   - The recorded number of provider calls is > 1 (pipeline actually fired).
 *
 * Any refactor that drops pipeline cost back into `meta` (the original bug
 * shape) will fail this test loudly.
 */

interface UsageStub {
  inputTokensEstimate: number;
  outputTokensEstimate: number;
  estimatedUsd: number;
  latencyMs: number;
}

class RecordingStubProvider implements LlmProvider {
  readonly name = "stub";
  calls: Array<{ kind: "json" | "text"; schemaName?: string }> = [];
  perCallUsage: UsageStub = {
    inputTokensEstimate: 100,
    outputTokensEstimate: 50,
    estimatedUsd: 0,
    latencyMs: 25,
  };

  async completeJson<T>(input: CompleteJsonInput): Promise<ProviderResponse<T>> {
    this.calls.push({ kind: "json", schemaName: input.schemaName });

    // Return a canned response that matches whatever schema CSM's pipeline is
    // asking for at this stage. The CSM pipeline calls `probe`, then `recall`,
    // then optionally `synthesize` — each with a distinct schema name.
    // Stub responses match the exact schemas in `src/core/schemas.ts`
    // (probeResultSchema, recallResultSchema, memoryPacketSchema). Field
    // names are snake_case to match what those schemas expect.
    let data: unknown;
    if (input.schemaName === "ProbeResult") {
      data = {
        knows: true,
        confidence: 0.8,
        memory_type: "direct",
        estimated_answer_value: "high",
        needs_full_recall: true,
        relevant_event_ids: ["e1"],
      };
    } else if (input.schemaName === "RecallResult") {
      data = {
        shard_id: input.shardId ?? "s-stub",
        snapshot_id: input.snapshotId ?? "S001",
        confidence: 0.8,
        answer: "stub recall answer",
        claims: [
          {
            claim: "stub fact",
            support: ["e1"],
            confidence: 0.8,
          },
        ],
        unknowns: [],
        conflicts: [],
      };
    } else if (input.schemaName === "MemoryPacket") {
      data = {
        query: "stub query",
        summary: "stub summary",
        key_claims: [
          { claim: "stub claim", sources: ["s-stub@S001:e1"], confidence: 0.8 },
        ],
        caveats: [],
        conflicts: [],
        recommended_main_context: "stub recommended context",
      };
    } else {
      data = {};
    }

    return {
      data: data as T,
      usage: { ...this.perCallUsage },
      rawText: JSON.stringify(data),
    };
  }

  async completeText(_input: CompleteTextInput): Promise<ProviderResponse<string>> {
    this.calls.push({ kind: "text" });
    // Final MCQ call. Larger usage than the pipeline calls to make the bug
    // obvious if it ever returns — top-level should be larger than this.
    const usage: UsageStub = {
      inputTokensEstimate: 500,
      outputTokensEstimate: 75,
      estimatedUsd: 0,
      latencyMs: 200,
    };
    return {
      data: "ANSWER: 1\nCITATIONS: e1",
      usage,
      rawText: "ANSWER: 1\nCITATIONS: e1",
    };
  }
}

function buildTinyCorpus(): Corpus {
  const events: BenchEvent[] = [
    {
      id: "e1",
      shardId: "s-stub",
      content: "Stub event with content about the project.",
      tokenCount: 12,
      isCore: true,
      tier: 0,
      tags: ["stub"],
    },
    {
      id: "e2",
      shardId: "s-stub-other",
      content: "Another stub event for the other shard.",
      tokenCount: 11,
      isCore: true,
      tier: 0,
      tags: ["stub", "other"],
    },
  ];
  const byShard = new Map<string, BenchEvent[]>();
  const byId = new Map<string, BenchEvent>();
  for (const e of events) {
    byId.set(e.id, e);
    const arr = byShard.get(e.shardId);
    if (arr) arr.push(e);
    else byShard.set(e.shardId, [e]);
  }
  return {
    events,
    coreEvents: events,
    fillerEvents: [],
    totalTokens: events.reduce((s, e) => s + e.tokenCount, 0),
    byShard,
    byId,
    targetTokens: 100,
    sampleSeed: 42,
  };
}

const mcqQuery: McqQuery = {
  id: "qstub",
  question: "What is the test asking?",
  options: ["correct one", "wrong", "wrong", "wrong", "wrong"],
  correctOption: 1,
  relevantEventIds: ["e1"],
  category: "single-shard",
};

describe("Cost-accounting contract — CsmBaseline", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("top-level inputTokens === meta.pipelineInputTokens + meta.finalCallInputTokens", async () => {
    vi.stubEnv("CSM_EMBED_FLOOR_K", "0");
    vi.stubEnv("CSM_SHARD_EXPAND_K", "0");
    vi.stubEnv("CSM_ENTITY_BRIDGE_K", "0");

    const provider = new RecordingStubProvider();
    const csm = new CsmBaseline({ provider });
    const corpus = buildTinyCorpus();

    const result = await csm.answer(mcqQuery, corpus, {
      maxInputTokens: 4096,
      model: "stub-model",
      maxOutputTokens: 256,
      temperature: 0,
      seed: 1,
    });

    // Pipeline metadata must be present.
    const meta = result.meta as Record<string, number>;
    expect(meta.pipelineInputTokens).toBeDefined();
    expect(meta.pipelineOutputTokens).toBeDefined();
    expect(meta.pipelineLatencyMs).toBeDefined();
    expect(meta.finalCallInputTokens).toBeDefined();
    expect(meta.finalCallOutputTokens).toBeDefined();
    expect(meta.finalCallLatencyMs).toBeDefined();

    // Pipeline cost must be > 0 (at least probes ran). If this fires it means
    // CSM's pipeline didn't actually invoke any LLM calls.
    expect(meta.pipelineInputTokens).toBeGreaterThan(0);

    // THE CONTRACT: top-level === pipeline + final. This is the assertion
    // that would have failed against the original buggy csm.ts and saved us.
    expect(result.inputTokens).toBe(
      meta.pipelineInputTokens + meta.finalCallInputTokens,
    );
    expect(result.outputTokens).toBe(
      meta.pipelineOutputTokens + meta.finalCallOutputTokens,
    );
    expect(result.latencyMs).toBe(
      meta.pipelineLatencyMs + meta.finalCallLatencyMs,
    );

    // Sanity: the recording provider must have been called more than once
    // (otherwise we're not actually testing the multi-call case).
    expect(provider.calls.length).toBeGreaterThan(1);

    // Sanity: top-level must exceed the final call alone — otherwise the
    // pipeline cost was silently dropped (the original bug shape).
    expect(result.inputTokens).toBeGreaterThan(meta.finalCallInputTokens);
  });
});
