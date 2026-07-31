/**
 * Batched probe (token plan L2b) — CSM_PROBE_BATCH.
 *
 * One call classifies shards 2..N (top-1 stays solo for the speculative
 * recall), paying the ~349-token probe scaffold once instead of N−1 times
 * (28% of pipeline input at the official 8-probe configuration).
 *
 * The model's output list is NEVER trusted structurally. These tests pin the
 * reconciliation contract of `probeShardsBatched`:
 *   - missing shard  → padded explicit knows:false verdict (probe count stable)
 *   - hallucinated   → dropped
 *   - duplicated     → first occurrence wins
 *   - order          → the REQUESTED order, never model output order (recall
 *                      selection tiebreaks on insertion order = router rank)
 *   - event-id hints → filtered to the shard's OWN events (cross-shard bleed
 *                      would poison the recall digest)
 * and the ask()-level wiring: exactly 2 provider calls, all N candidates
 * still produce a probe result.
 */
import { afterEach, describe, expect, it } from "vitest";

import { ask, resolveProbeBatch } from "../src/core/ask.js";
import { probeShardsBatched } from "../src/core/probe.js";
import { SHARD_SYSTEM_PROMPT } from "../src/core/prompts.js";
import type { MemoryShardSnapshot } from "../src/core/types.js";
import { EnvConfigError } from "../src/utils/env.js";
import type {
  CompleteJsonInput,
  CompleteTextInput,
  LlmProvider,
  ProviderResponse,
} from "../src/providers/LlmProvider.js";
import { makeStorage } from "./probeShrinkHarness.js";

afterEach(() => {
  delete process.env.CSM_PROBE_BATCH;
});

function snap(shardId: string, eventIds: string[]): MemoryShardSnapshot {
  return {
    shardId,
    snapshotId: "S001",
    systemPrompt: SHARD_SYSTEM_PROMPT,
    summary: `shard ${shardId}`,
    events: eventIds.map((eventId) => ({
      eventId,
      role: "user",
      content: `content of ${eventId}`,
      createdAt: "2024-01-01T00:00:00.000Z",
      importance: 0.5,
      tags: [],
    })),
    indexTerms: [],
    createdAt: "2024-01-01T00:00:00.000Z",
    parentSnapshotId: null,
  };
}

const verdict = (shard_id: string, extra: Record<string, unknown> = {}) => ({
  shard_id,
  knows: true,
  confidence: 0.9,
  memory_type: "direct",
  estimated_answer_value: "high",
  needs_full_recall: true,
  relevant_event_ids: [],
  ...extra,
});

/** Provider that returns a FIXED batched verdict payload. */
class BatchedStub implements LlmProvider {
  readonly name = "stub";
  jsonCalls: string[] = [];
  constructor(private readonly verdicts: unknown[]) {}

  async completeJson<T>(input: CompleteJsonInput): Promise<ProviderResponse<T>> {
    this.jsonCalls.push(input.schemaName);
    const usage = { inputTokensEstimate: 10, outputTokensEstimate: 5, estimatedUsd: 0, latencyMs: 1 };
    if (input.schemaName === "BatchedProbeResult") {
      const data = { verdicts: this.verdicts };
      return { data: data as unknown as T, usage, rawText: JSON.stringify(data) };
    }
    if (input.schemaName === "ProbeResult") {
      const data = verdict("solo");
      return { data: data as unknown as T, usage, rawText: JSON.stringify(data) };
    }
    if (input.schemaName === "RecallResult") {
      const data = {
        shard_id: input.shardId ?? "?",
        snapshot_id: input.snapshotId ?? "?",
        confidence: 0.5,
        answer: "stub",
        claims: [],
        unknowns: [],
        conflicts: [],
      };
      return { data: data as unknown as T, usage, rawText: JSON.stringify(data) };
    }
    if (input.schemaName === "MemoryPacket") {
      const data = {
        query: "",
        summary: "",
        key_claims: [],
        caveats: [],
        conflicts: [],
        recommended_main_context: "",
      };
      return { data: data as unknown as T, usage, rawText: JSON.stringify(data) };
    }
    throw new Error(`unexpected schema ${input.schemaName}`);
  }

  async completeText(_i: CompleteTextInput): Promise<ProviderResponse<string>> {
    throw new Error("not used");
  }
}

describe("resolveProbeBatch", () => {
  it("defaults OFF and shares the flag vocabulary", () => {
    expect(resolveProbeBatch(undefined)).toBe(false);
    expect(resolveProbeBatch("1")).toBe(true);
    expect(() => resolveProbeBatch("batched")).toThrow(EnvConfigError);
  });
});

describe("probeShardsBatched reconciliation", () => {
  const snapshots = [snap("s1", ["e1a", "e1b"]), snap("s2", ["e2a"]), snap("s3", ["e3a"])];

  it("pads MISSING shards with an explicit knows:false verdict, keeping count stable", async () => {
    const provider = new BatchedStub([verdict("s1"), verdict("s3")]); // s2 missing
    const { results } = await probeShardsBatched({ provider, userQuery: "q", snapshots });
    expect(results).toHaveLength(3);
    expect(results[1]!.shardId).toBe("s2");
    expect(results[1]!.knows).toBe(false);
    expect(results[1]!.estimatedAnswerValue).toBe("none");
  });

  it("drops HALLUCINATED shard ids", async () => {
    const provider = new BatchedStub([
      verdict("s1"),
      verdict("s-invented"),
      verdict("s2"),
      verdict("s3"),
    ]);
    const { results } = await probeShardsBatched({ provider, userQuery: "q", snapshots });
    expect(results.map((r) => r.shardId)).toEqual(["s1", "s2", "s3"]);
  });

  it("first occurrence wins for DUPLICATED shard ids", async () => {
    const provider = new BatchedStub([
      verdict("s1", { confidence: 0.9 }),
      verdict("s1", { confidence: 0.1 }),
      verdict("s2"),
      verdict("s3"),
    ]);
    const { results } = await probeShardsBatched({ provider, userQuery: "q", snapshots });
    expect(results[0]!.confidence).toBe(0.9);
  });

  it("returns verdicts in the REQUESTED order, not model output order", async () => {
    const provider = new BatchedStub([verdict("s3"), verdict("s1"), verdict("s2")]);
    const { results } = await probeShardsBatched({ provider, userQuery: "q", snapshots });
    expect(results.map((r) => r.shardId)).toEqual(["s1", "s2", "s3"]);
  });

  it("filters event-id hints to the shard's OWN events (no cross-shard bleed)", async () => {
    const provider = new BatchedStub([
      verdict("s1", { relevant_event_ids: ["e1a", "e2a", "nonsense"] }),
      verdict("s2", { relevant_event_ids: ["e2a"] }),
      verdict("s3", { relevant_event_ids: [] }),
    ]);
    const { results } = await probeShardsBatched({ provider, userQuery: "q", snapshots });
    expect(results[0]!.relevantEventIds).toEqual(["e1a"]);
    expect(results[1]!.relevantEventIds).toEqual(["e2a"]);
  });
});

describe("ask() with CSM_PROBE_BATCH", () => {
  it("makes exactly 2 probe-stage calls (solo top-1 + one batch) and probes all candidates", async () => {
    process.env.CSM_PROBE_BATCH = "1";
    // 8 uniform shards s0..s7; batch stub answers for all of s1..s7.
    const provider = new BatchedStub(
      Array.from({ length: 7 }, (_, i) => verdict(`s${i + 1}`, { knows: false, needs_full_recall: false, estimated_answer_value: "none", memory_type: "none", confidence: 0.1 })),
    );
    const storage = makeStorage(8);
    const result = await ask({
      provider,
      storage,
      query: "what did we decide",
      skipQueryLog: true,
    });
    const probeCalls = provider.jsonCalls.filter((s) => s.startsWith("Probe") || s === "BatchedProbeResult");
    expect(probeCalls.sort()).toEqual(["BatchedProbeResult", "ProbeResult"]);
    expect(result.probes).toHaveLength(8);
    // Order preserved: candidate order, not model order.
    expect(result.probes.map((p) => p.shardId)).toEqual(
      ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7"],
    );
  });

  it("with the flag OFF makes one probe call per candidate (control unchanged)", async () => {
    const provider = new BatchedStub([]);
    const storage = makeStorage(4);
    const result = await ask({ provider, storage, query: "q", skipQueryLog: true });
    expect(provider.jsonCalls.filter((s) => s === "ProbeResult")).toHaveLength(4);
    expect(provider.jsonCalls).not.toContain("BatchedProbeResult");
    expect(result.probes).toHaveLength(4);
  });
});
