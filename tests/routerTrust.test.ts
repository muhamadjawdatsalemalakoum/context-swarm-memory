import { describe, expect, it } from "vitest";

import { ask } from "../src/core/ask.js";
import type {
  MemoryDirectory,
  MemoryShardSnapshot,
  ProbeResult,
  RecallResult,
} from "../src/core/types.js";
import { SHARD_SYSTEM_PROMPT } from "../src/core/prompts.js";
import type { StorageReader } from "../src/storage/jsonlStorage.js";
import type {
  CompleteJsonInput,
  CompleteTextInput,
  LlmProvider,
  ProviderResponse,
} from "../src/providers/LlmProvider.js";

/**
 * Router-trust safety-net regression test.
 *
 * Real-bench failure (q11 in csm-vs-baselines-10q + csm-audit-fix-10q): the
 * router correctly picked `s-customers` as the #1 candidate for a dental-SaaS
 * LOI question, but the 8B probe model said `knows: false` because the
 * truncated event index didn't surface the ChairSync events. With probe-only
 * gating, the recall queue was empty for the correct shard and the pipeline
 * returned 0 packed events.
 *
 * Fix in `src/core/ask.ts`: always include the router's top-1 candidate in
 * the recall queue, even if the probe rejected it. The 8B probe is a cheap
 * filter; the 31B recall is the source of truth. We let the stronger model
 * decide whether the shard has the answer.
 *
 * This test pins the new behaviour: when the router picks shard X as #1 but
 * the probe says X "knows: false", the recall queue must STILL include X.
 */

class ScriptedProvider implements LlmProvider {
  readonly name = "stub";
  recallCalls: { shardId: string; snapshotId: string }[] = [];

  constructor(
    private probeKnowsByShardId: Record<string, boolean>,
  ) {}

  async completeJson<T>(input: CompleteJsonInput): Promise<ProviderResponse<T>> {
    const usage = {
      inputTokensEstimate: 50,
      outputTokensEstimate: 30,
      estimatedUsd: 0,
      latencyMs: 5,
    };
    if (input.schemaName === "ProbeResult") {
      const shardId = input.shardId ?? "?";
      const knows = this.probeKnowsByShardId[shardId] ?? false;
      const data = {
        knows,
        confidence: knows ? 0.8 : 0.2,
        memory_type: knows ? "direct" : "none",
        estimated_answer_value: knows ? "high" : "none",
        needs_full_recall: knows,
        relevant_event_ids: knows ? ["e_001"] : [],
      };
      return { data: data as unknown as T, usage, rawText: JSON.stringify(data) };
    }
    if (input.schemaName === "RecallResult") {
      const shardId = input.shardId ?? "?";
      const snapshotId = input.snapshotId ?? "?";
      this.recallCalls.push({ shardId, snapshotId });
      const data = {
        shard_id: shardId,
        snapshot_id: snapshotId,
        confidence: 0.9,
        answer: `recall on ${shardId}`,
        claims: [{ claim: "x", support: ["e_001"], confidence: 0.9 }],
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
    throw new Error(`unexpected schema: ${input.schemaName}`);
  }

  async completeText(_i: CompleteTextInput): Promise<ProviderResponse<string>> {
    throw new Error("not used");
  }
}

function makeStorageReader(
  shardIds: string[],
  tagsByShard: Record<string, string[]>,
): StorageReader {
  const dir: MemoryDirectory = {
    version: 1,
    entries: shardIds.map((id) => ({
      id,
      name: id,
      description: `Test shard ${id}`,
      tags: tagsByShard[id] ?? [],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      status: "active" as const,
      snapshotId: "S001",
      tokenCountEstimate: 100,
      contextLimitEstimate: 128_000,
      fullnessPct: 0,
      summaryShort: `${id} summary`,
      knownConflicts: [],
      parentId: null,
      children: [] as string[],
      trustLevel: "imported_doc" as const,
      staleness: "current" as const,
    })),
  };
  const snapshots = new Map<string, MemoryShardSnapshot>();
  for (const id of shardIds) {
    snapshots.set(`${id}@S001`, {
      shardId: id,
      snapshotId: "S001",
      systemPrompt: SHARD_SYSTEM_PROMPT,
      summary: `shard ${id}`,
      events: [
        {
          eventId: "e_001",
          role: "user",
          content: `content for ${id}`,
          createdAt: "2024-01-01T00:00:00.000Z",
          importance: 0.5,
          tags: tagsByShard[id] ?? [],
        },
      ],
      indexTerms: tagsByShard[id] ?? [],
      createdAt: "2024-01-01T00:00:00.000Z",
      parentSnapshotId: null,
    });
  }
  return {
    async loadDirectory() { return dir; },
    async loadSnapshot(shardId, snapshotId) {
      return snapshots.get(`${shardId}@${snapshotId}`) ?? null;
    },
  };
}

describe("ask — router-trust safety net", () => {
  it("recalls the router top-1 shard even when the probe rejected it", async () => {
    // Router scores: `customers-shard` matches the query's "customer" token →
    // top-1. Probe says `knows: false` for it (the simulated false negative).
    // Filler shards have no matching tags → score 0 → router rank lower.
    const provider = new ScriptedProvider({
      "customers-shard": false, // <-- probe says NO (the bug case)
      "filler-a": false,
      "filler-b": false,
    });
    const storage = makeStorageReader(
      ["customers-shard", "filler-a", "filler-b"],
      {
        "customers-shard": ["customer", "loi"], // matches the query tokens
        "filler-a": ["unrelated"],
        "filler-b": ["unrelated"],
      },
    );

    await ask({
      provider,
      storage,
      query: "Which customer signed the LOI?",
      parallelProbes: false,
      skipQueryLog: true,
    });

    // Pre-fix: probe rejected customers-shard → 0 recall calls.
    // Post-fix: router-trust safety net forces a recall on customers-shard.
    const recalledShardIds = provider.recallCalls.map((c) => c.shardId);
    expect(recalledShardIds).toContain("customers-shard");
  });

  it("does NOT add a duplicate recall when the probe accepted the top shard", async () => {
    // Normal path: probe accepts the router's top shard. The safety net must
    // be a no-op (the shard is already in the recall queue, not duplicated).
    const provider = new ScriptedProvider({
      "customers-shard": true,
      "filler-a": false,
    });
    const storage = makeStorageReader(
      ["customers-shard", "filler-a"],
      {
        "customers-shard": ["customer", "loi"],
        "filler-a": ["unrelated"],
      },
    );

    await ask({
      provider,
      storage,
      query: "Which customer signed the LOI?",
      parallelProbes: false,
      skipQueryLog: true,
    });

    const recalledIds = provider.recallCalls.map((c) => c.shardId);
    const customerRecalls = recalledIds.filter((id) => id === "customers-shard");
    expect(customerRecalls).toHaveLength(1); // not duplicated
  });

  it("respects maxRecallShards budget when prepending the router top", async () => {
    // 5 shards, all probe-accepted EXCEPT the router's top. Recall budget = 4.
    // Pre-fix: 4 probe-accepted shards recalled, top (probe-rejected) is dropped.
    // Post-fix: top is prepended, lowest-scored of the 4 falls off → still 4 total.
    const shardIds = ["s-top", "s-1", "s-2", "s-3", "s-4", "s-5"];
    const provider = new ScriptedProvider({
      "s-top": false, // router top, probe rejects
      "s-1": true,
      "s-2": true,
      "s-3": true,
      "s-4": true,
      "s-5": true,
    });
    const tags: Record<string, string[]> = {
      "s-top": ["customer", "loi", "decision"], // high tag overlap → router #1
      "s-1": ["customer"],
      "s-2": ["customer"],
      "s-3": ["customer"],
      "s-4": ["customer"],
      "s-5": ["customer"],
    };
    const storage = makeStorageReader(shardIds, tags);

    await ask({
      provider,
      storage,
      query: "What customer LOI decision?",
      parallelProbes: false,
      skipQueryLog: true,
    });

    const recalledIds = provider.recallCalls.map((c) => c.shardId);
    expect(recalledIds).toContain("s-top"); // safety net forced this in
    expect(recalledIds.length).toBeLessThanOrEqual(4); // budget respected
  });
});
