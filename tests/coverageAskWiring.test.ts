import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ask } from "../src/core/ask.js";
import { parseEventRef } from "../src/core/coverage.js";
import { SHARD_SYSTEM_PROMPT } from "../src/core/prompts.js";
import type {
  MemoryDirectory,
  MemoryShardSnapshot,
} from "../src/core/types.js";
import type { StorageReader } from "../src/storage/jsonlStorage.js";
import type {
  CompleteJsonInput,
  CompleteTextInput,
  LlmProvider,
  ProviderResponse,
} from "../src/providers/LlmProvider.js";

/**
 * T1 coverage — ask() wiring tests (worktree wiring; merge-window material).
 *
 * Pins the four contractual behaviours of the CSM_COVERAGE flag:
 *   1. OFF (default): no timeline, recall digest budget unchanged (1200) —
 *      byte-identical pipeline.
 *   2. ON + coverage-shaped query: bigger recall digest (deep events become
 *      visible to the recall LLM) and a date-ordered cited packet timeline.
 *   3. ON + point query with well-cited recalls: NO timeline, digest budget
 *      unchanged — coverage must not touch healthy point lookups.
 *   4. ON + point query with starved citations: the starvation net attaches
 *      a timeline anyway.
 * Plus: temporal-arithmetic queries get a deterministic date-difference
 * claim with two full citations (never LLM date math).
 */

class ScriptedProvider implements LlmProvider {
  readonly name = "stub";
  recallSystems: string[] = [];

  constructor(
    private opts: {
      /** claims returned by every recall (controls citation starvation) */
      recallSupports: string[][];
    },
  ) {}

  async completeJson<T>(input: CompleteJsonInput): Promise<ProviderResponse<T>> {
    const usage = {
      inputTokensEstimate: 50,
      outputTokensEstimate: 30,
      estimatedUsd: 0,
      latencyMs: 1,
    };
    if (input.schemaName === "ProbeResult") {
      const data = {
        knows: true,
        confidence: 0.9,
        memory_type: "direct",
        estimated_answer_value: "high",
        needs_full_recall: true,
        relevant_event_ids: ["e_001"],
      };
      return { data: data as unknown as T, usage, rawText: JSON.stringify(data) };
    }
    if (input.schemaName === "RecallResult") {
      this.recallSystems.push(input.system);
      const data = {
        shard_id: input.shardId ?? "?",
        snapshot_id: input.snapshotId ?? "?",
        confidence: 0.9,
        answer: "scripted recall",
        claims: this.opts.recallSupports.map((support, i) => ({
          claim: `claim ${i}`,
          support,
          confidence: 0.9,
        })),
        unknowns: [],
        conflicts: [],
      };
      return { data: data as unknown as T, usage, rawText: JSON.stringify(data) };
    }
    if (input.schemaName === "MemoryPacket") {
      const data = {
        query: "",
        summary: "synth",
        key_claims: this.opts.recallSupports.map((support, i) => ({
          claim: `kc ${i}`,
          sources: support.map((s) => `s-payments@S001:${s}`),
          confidence: 0.9,
        })),
        caveats: [],
        conflicts: [],
        recommended_main_context: "ctx",
      };
      return { data: data as unknown as T, usage, rawText: JSON.stringify(data) };
    }
    throw new Error(`unexpected schema: ${input.schemaName}`);
  }

  async completeText(_i: CompleteTextInput): Promise<ProviderResponse<string>> {
    throw new Error("not used");
  }
}

/** One shard, 30 dated payment-themed events (~45 tokens of digest line
 *  each). At the default 1200-token recall budget only ~25 fit; at the
 *  coverage budget (3200) all 30 fit — so e_030's visibility in the recall
 *  system prompt discriminates the budgets. */
function makeStorage(): StorageReader {
  const events = Array.from({ length: 30 }, (_, i) => ({
    eventId: `e_${String(i + 1).padStart(3, "0")}`,
    role: "user" as const,
    content: `Payment gateway decision number ${i + 1}: routing and settlement details for the gateway rollout phase ${i % 6}, including invoice handling notes and reconciliation steps for milestone ${i + 1}.`,
    createdAt: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T10:00:00.000Z`,
    importance: 0.5,
    tags: ["payments", "gateway"],
  }));
  const snapshot: MemoryShardSnapshot = {
    shardId: "s-payments",
    snapshotId: "S001",
    systemPrompt: SHARD_SYSTEM_PROMPT,
    summary: "Payment gateway decisions.",
    events,
    indexTerms: ["payments", "gateway"],
    createdAt: "2026-01-01T00:00:00.000Z",
    parentSnapshotId: null,
  };
  const dir: MemoryDirectory = {
    version: 1,
    entries: [
      {
        id: "s-payments",
        name: "s-payments",
        description: "Payment gateway decisions",
        tags: ["payments", "gateway"],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        status: "active",
        snapshotId: "S001",
        tokenCountEstimate: 100,
        contextLimitEstimate: 128_000,
        fullnessPct: 0,
        summaryShort: "payment gateway decisions",
        knownConflicts: [],
        parentId: null,
        children: [],
        trustLevel: "imported_doc",
        staleness: "current",
      },
    ],
  };
  return {
    async loadDirectory() {
      return dir;
    },
    async loadSnapshot(shardId, snapshotId) {
      return shardId === "s-payments" && snapshotId === "S001" ? snapshot : null;
    },
  };
}

const COVERAGE_QUERY = "Summarize everything that happened with the payments gateway.";
const POINT_QUERY = "Which payments gateway milestone covered invoice handling?";

const ENV_KEYS = [
  "CSM_COVERAGE",
  "CSM_COVERAGE_RECALL_TOKENS",
  "CSM_COVERAGE_MAX_ENTRIES",
  "CSM_COVERAGE_STARVATION_FLOOR",
];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("ask() coverage wiring", () => {
  it("flag OFF: no timeline, recall digest truncated at the default budget", async () => {
    const provider = new ScriptedProvider({ recallSupports: [["e_001"]] });
    const result = await ask({
      provider,
      storage: makeStorage(),
      query: COVERAGE_QUERY,
      skipQueryLog: true,
      parallelProbes: false,
    });
    expect(result.memoryPacket.timeline).toBeUndefined();
    expect(provider.recallSystems.length).toBeGreaterThan(0);
    // Default 1200-token budget cannot fit all 30 events.
    expect(provider.recallSystems[0]).toMatch(/more events truncated/);
    expect(provider.recallSystems[0]).not.toMatch(/e_030\b/);
  });

  it("flag ON + coverage query: bigger recall digest AND a cited, date-ordered timeline", async () => {
    process.env.CSM_COVERAGE = "1";
    const provider = new ScriptedProvider({ recallSupports: [["e_001"]] });
    const result = await ask({
      provider,
      storage: makeStorage(),
      query: COVERAGE_QUERY,
      skipQueryLog: true,
      parallelProbes: false,
    });
    // Recall budget raised: the deep event now reaches the recall LLM.
    expect(provider.recallSystems[0]).toMatch(/e_030\b/);

    const timeline = result.memoryPacket.timeline;
    expect(timeline).toBeDefined();
    expect(timeline!.length).toBeGreaterThan(0);
    // Citation discipline + date order.
    const dates = timeline!.map((t) => t.date ?? "9999-99-99");
    expect([...dates].sort()).toEqual(dates);
    for (const entry of timeline!) {
      const ref = parseEventRef(entry.eventRef);
      expect(ref).not.toBeNull();
      expect(ref!.shardId).toBe("s-payments");
      expect(ref!.snapshotId).toBe("S001");
    }
    // Read-path invariant is untouched.
    expect(result.mutated).toBe(false);
  });

  it("flag ON + healthy point query: no timeline, default recall budget", async () => {
    process.env.CSM_COVERAGE = "1";
    // Recalls cite 5 distinct events — above the starvation floor (4).
    const provider = new ScriptedProvider({
      recallSupports: [["e_001", "e_002", "e_003", "e_004", "e_005"]],
    });
    const result = await ask({
      provider,
      storage: makeStorage(),
      query: POINT_QUERY,
      skipQueryLog: true,
      parallelProbes: false,
    });
    expect(result.memoryPacket.timeline).toBeUndefined();
    // Point queries keep the 1200-token digest even with the flag on.
    expect(provider.recallSystems[0]).toMatch(/more events truncated/);
    expect(provider.recallSystems[0]).not.toMatch(/e_030\b/);
  });

  it("flag ON + starved point query: the starvation net attaches a timeline", async () => {
    process.env.CSM_COVERAGE = "1";
    // Recall cites only 1 distinct event — below the floor.
    const provider = new ScriptedProvider({ recallSupports: [["e_001"]] });
    const result = await ask({
      provider,
      storage: makeStorage(),
      query: POINT_QUERY,
      skipQueryLog: true,
      parallelProbes: false,
    });
    const timeline = result.memoryPacket.timeline;
    expect(timeline).toBeDefined();
    expect(timeline!.length).toBeGreaterThan(0);
    // Starvation floor 0 disables the net.
    process.env.CSM_COVERAGE_STARVATION_FLOOR = "0";
    const provider2 = new ScriptedProvider({ recallSupports: [["e_001"]] });
    const result2 = await ask({
      provider: provider2,
      storage: makeStorage(),
      query: POINT_QUERY,
      skipQueryLog: true,
      parallelProbes: false,
    });
    expect(result2.memoryPacket.timeline).toBeUndefined();
  });

  it("flag ON + temporal-arithmetic query: deterministic date-difference claim, fully cited", async () => {
    process.env.CSM_COVERAGE = "1";
    const provider = new ScriptedProvider({ recallSupports: [["e_001"]] });
    const result = await ask({
      provider,
      storage: makeStorage(),
      query:
        "How many days passed between when gateway milestone 2 happened and when gateway milestone 20 happened?",
      skipQueryLog: true,
      parallelProbes: false,
    });
    const first = result.memoryPacket.keyClaims[0];
    expect(first).toBeDefined();
    expect(first!.claim).toMatch(/^Temporal calculation/);
    expect(first!.claim).toMatch(/= \d+ days?\./);
    expect(first!.sources).toHaveLength(2);
    for (const src of first!.sources) {
      expect(parseEventRef(src)).not.toBeNull();
    }
  });
});
