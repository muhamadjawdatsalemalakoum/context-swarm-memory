import { describe, it, expect } from "vitest";
import {
  selectEventDigest,
  salientWithinBudget,
  truncate,
  resolveSignalsRanker,
  type DigestEvent,
} from "../src/core/digestSelection.js";
import { resolveRecallBudget } from "../src/core/tokenBudget.js";
import { recallShard } from "../src/core/recall.js";
import { SHARD_SYSTEM_PROMPT } from "../src/core/prompts.js";
import type { MemoryShardSnapshot } from "../src/core/types.js";
import type {
  CompleteJsonInput,
  CompleteTextInput,
  LlmProvider,
  ProviderResponse,
} from "../src/providers/LlmProvider.js";

function ev(eventId: string, content: string, tags: string[] = []): DigestEvent {
  return { eventId, role: "user", content, createdAt: "2024-01-01T00:00:00.000Z", tags };
}

describe("selectEventDigest — blind mode (legacy parity)", () => {
  it("renders the exact legacy line format", () => {
    const out = selectEventDigest([ev("e0001", "hello world", ["x"])], { maxTokens: 1000 });
    expect(out.text).toBe("- [e0001] (user 2024-01-01) hello world  tags=[x]");
    expect(out.selectedIds).toEqual(["e0001"]);
  });

  it("emits the overflow marker and keeps used tokens within budget", () => {
    const events = [ev("e0001", "alpha beta"), ev("e0002", "gamma delta"), ev("e0003", "epsilon")];
    const out = selectEventDigest(events, { maxTokens: 12 });
    expect(out.droppedCount).toBeGreaterThan(0);
    expect(out.text).toContain("more events truncated to fit budget");
    expect(out.usedTokens).toBeLessThanOrEqual(12);
  });

  it("falls back to (no events) when empty", () => {
    expect(selectEventDigest([], { maxTokens: 1000 }).text).toBe("(no events)");
  });

  it("is deterministic — identical inputs give byte-identical output", () => {
    const events = [ev("e0001", "alpha gamma"), ev("e0002", "beta gamma delta")];
    const a = selectEventDigest(events, { maxTokens: 50, reorderBySalience: true, query: "gamma delta" });
    const b = selectEventDigest(events, { maxTokens: 50, reorderBySalience: true, query: "gamma delta" });
    expect(a.text).toBe(b.text);
    expect(a.selectedIds).toEqual(b.selectedIds);
  });

  it("does not mutate the input event array", () => {
    const events = [ev("e0001", "alpha"), ev("e0002", "beta gamma")];
    const before = events.map((e) => e.eventId);
    selectEventDigest(events, { maxTokens: 1000, reorderBySalience: true, query: "gamma" });
    expect(events.map((e) => e.eventId)).toEqual(before);
  });

  it("throws if a salience lever is enabled without a query", () => {
    expect(() => selectEventDigest([ev("e0001", "x")], { maxTokens: 100, reorderBySalience: true })).toThrow();
  });
});

describe("selectEventDigest — lever #1 (salient reordering)", () => {
  it("rescues a relevant event that blind order would drop under budget", () => {
    // e0001 (no query terms) is first by insertion order; e0002 (query terms) is
    // second. The budget fits only one line.
    const events = [ev("e0001", "alpha beta"), ev("e0002", "gamma delta")];
    const blind = selectEventDigest(events, { maxTokens: 12 });
    const salient = selectEventDigest(events, { maxTokens: 12, reorderBySalience: true, query: "gamma delta" });
    expect(blind.selectedIds).toEqual(["e0001"]);
    expect(salient.selectedIds).toEqual(["e0002"]);
  });

  it("hint-first: probe-hinted events lead even with lower salience (Pareto-safe vs blind)", () => {
    // e0001 matches the query (high salience) but is NOT hinted; e0002 is hinted
    // but has no query terms. Hint-first must keep e0002 ahead of e0001.
    const events = [ev("e0001", "gamma delta"), ev("e0002", "alpha beta")];
    const salient = selectEventDigest(events, {
      maxTokens: 1000,
      reorderBySalience: true,
      query: "gamma delta",
      hint: ["e0002"],
    });
    expect(salient.selectedIds).toEqual(["e0002", "e0001"]);
  });
});

describe("salientWithinBudget — lever #2 (intra-event selection)", () => {
  const q = new Set(["price", "launch"]);

  it("returns content unchanged when it already fits", () => {
    expect(salientWithinBudget("short text", 480, q)).toBe("short text");
  });

  it("keeps the query-salient sentence over earlier filler when truncating", () => {
    const filler = "This is unrelated boilerplate about the weather. ".repeat(12); // > 480 chars
    const content = filler + "The launch price was finalised.";
    const out = salientWithinBudget(content, 200, q);
    expect(out).toContain("launch price");
    expect(out.length).toBeLessThanOrEqual(200);
  });

  it("anchor guard: never drops a fragment carrying an embedded [eXXXX] ref", () => {
    const filler = "Neutral filler sentence with no signal. ".repeat(15); // > 480 chars
    const content = filler + "See [e0099] for the cross-reference.";
    const out = salientWithinBudget(content, 150, new Set(["nothing"]));
    expect(out).toContain("[e0099]");
  });
});

describe("truncate", () => {
  it("caps with an ellipsis past the limit", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abc", 4)).toBe("abc");
  });
});

describe("resolveRecallBudget", () => {
  it("returns the default when unset, the override when valid", () => {
    expect(resolveRecallBudget(1200, {})).toBe(1200);
    expect(resolveRecallBudget(1200, { CSM_RECALL_BUDGET: "" })).toBe(1200);
    expect(resolveRecallBudget(1200, { CSM_RECALL_BUDGET: "600" })).toBe(600);
  });

  it("THROWS on a present but invalid value (invariant 5) instead of silently running at the default", () => {
    // These four used to resolve to 1200 / 640 — a mistyped budget quietly ran
    // the wrong experiment. Same silent-default class as CSM_ROUTER_HYBRID=off.
    for (const bad of ["0", "-5", "abc", "640.7"]) {
      expect(() => resolveRecallBudget(1200, { CSM_RECALL_BUDGET: bad })).toThrow(/CSM_RECALL_BUDGET/);
    }
  });
});

describe("resolveSignalsRanker", () => {
  it("defaults OFF and parses truthy values", () => {
    expect(resolveSignalsRanker({})).toBe(false);
    expect(resolveSignalsRanker({ CSM_SIGNALS_RANKER: "0" })).toBe(false);
    expect(resolveSignalsRanker({ CSM_SIGNALS_RANKER: "1" })).toBe(true);
    expect(resolveSignalsRanker({ CSM_SIGNALS_RANKER: "true" })).toBe(true);
    expect(resolveSignalsRanker({ CSM_SIGNALS_RANKER: "TRUE" })).toBe(true);
  });
});

// Token-free integration: capture the recall `system` string and prove the
// flag actually changes the digest bytes (which is what diverges the cache key)
// while keeping the SHARD_SYSTEM_PROMPT prefix byte-identical.
class CapturingProvider implements LlmProvider {
  readonly name = "stub";
  calls: string[] = [];
  async completeJson<T>(input: CompleteJsonInput): Promise<ProviderResponse<T>> {
    this.calls.push(input.system);
    const data = {
      shard_id: input.shardId ?? "s-stub",
      snapshot_id: input.snapshotId ?? "S001",
      confidence: 0.9,
      answer: "stub",
      claims: [{ claim: "x", support: ["e_001"], confidence: 0.9 }],
      unknowns: [],
      conflicts: [],
    };
    return {
      data: data as T,
      usage: { inputTokensEstimate: 1, outputTokensEstimate: 1, estimatedUsd: 0, latencyMs: 1 },
      rawText: JSON.stringify(data),
    };
  }
  async completeText(_i: CompleteTextInput): Promise<ProviderResponse<string>> {
    throw new Error("not used");
  }
}

function twoEventSnapshot(): MemoryShardSnapshot {
  return {
    shardId: "s-stub",
    snapshotId: "S001",
    systemPrompt: SHARD_SYSTEM_PROMPT,
    summary: "stub shard summary",
    events: [
      { eventId: "e_001", role: "user", content: "alpha beta gamma", createdAt: "2024-01-01T00:00:00.000Z", importance: 0.5, tags: [] },
      { eventId: "e_002", role: "user", content: "the launch price was approved", createdAt: "2024-01-01T00:00:00.000Z", importance: 0.5, tags: [] },
    ],
    indexTerms: [],
    createdAt: "2024-01-01T00:00:00.000Z",
    parentSnapshotId: null,
  };
}

describe("recallShard — CSM_SIGNALS_RANKER flag", () => {
  it("OFF keeps insertion order; ON surfaces the query-relevant late event", async () => {
    // Tight budget fits only one event line, so ordering decides which survives.
    const off = new CapturingProvider();
    await recallShard({ provider: off, userQuery: "launch price", snapshot: twoEventSnapshot(), maxRecallTokensPerShard: 20, useSignalsRanker: false });
    const on = new CapturingProvider();
    await recallShard({ provider: on, userQuery: "launch price", snapshot: twoEventSnapshot(), maxRecallTokensPerShard: 20, useSignalsRanker: true });

    const offSystem = off.calls[0]!;
    const onSystem = on.calls[0]!;
    // OFF: blind insertion order keeps the irrelevant e_001, drops e_002.
    expect(offSystem).toContain("[e_001]");
    expect(offSystem).not.toContain("launch price");
    // ON: salient reorder pulls e_002 in.
    expect(onSystem).toContain("[e_002]");
    expect(onSystem).toContain("launch price");
    // The flag changed the bytes → the cache key diverges automatically.
    expect(offSystem).not.toBe(onSystem);
    // Prefix-cache contract holds in both modes.
    expect(offSystem.startsWith(SHARD_SYSTEM_PROMPT)).toBe(true);
    expect(onSystem.startsWith(SHARD_SYSTEM_PROMPT)).toBe(true);
  });
});
