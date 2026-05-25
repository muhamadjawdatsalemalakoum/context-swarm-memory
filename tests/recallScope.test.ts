import { describe, expect, it } from "vitest";

import { recallShard } from "../src/core/recall.js";
import type { MemoryShardSnapshot } from "../src/core/types.js";
import { SHARD_SYSTEM_PROMPT } from "../src/core/prompts.js";
import type {
  CompleteJsonInput,
  CompleteTextInput,
  LlmProvider,
  ProviderResponse,
} from "../src/providers/LlmProvider.js";

/**
 * Audit fix #1 regression test.
 *
 * Before the fix: when a probe returned `relevant_event_ids = [e_002, e_003]`,
 * the recall stage HARD-FILTERED its event digest to ONLY those events.
 * Any event the probe missed — even if relevant — was permanently dropped
 * before the recall LLM ever saw it. With an 8B probe model and a 1,200-char
 * compact index, the probe is often INCOMPLETE; that incompleteness then
 * became invisible loss.
 *
 * After the fix: the hint is a PRIORITY ORDER, not a filter. Hinted events
 * appear FIRST in the digest, then non-hinted events fill the remaining
 * token budget so recall can still discover claims the probe missed.
 *
 * This test pins the new behaviour with a stub provider that captures the
 * exact system prompt sent to recall, so we can assert which events were
 * shown.
 */

class CapturingProvider implements LlmProvider {
  readonly name = "stub";
  systems: string[] = [];

  async completeJson<T>(input: CompleteJsonInput): Promise<ProviderResponse<T>> {
    this.systems.push(input.system);
    // Return a minimal valid RecallResult.
    const data = {
      shard_id: input.shardId ?? "s-stub",
      snapshot_id: input.snapshotId ?? "S001",
      confidence: 0.8,
      answer: "stub answer",
      claims: [{ claim: "stub claim", support: ["e_001"], confidence: 0.8 }],
      unknowns: [],
      conflicts: [],
    };
    return {
      data: data as unknown as T,
      usage: {
        inputTokensEstimate: 100,
        outputTokensEstimate: 30,
        estimatedUsd: 0,
        latencyMs: 10,
      },
      rawText: JSON.stringify(data),
    };
  }

  async completeText(_input: CompleteTextInput): Promise<ProviderResponse<string>> {
    throw new Error("Not used in this test");
  }
}

function makeSnapshot(eventCount: number): MemoryShardSnapshot {
  return {
    shardId: "s-test",
    snapshotId: "S001",
    systemPrompt: SHARD_SYSTEM_PROMPT,
    summary: "Test shard with many events for scope testing.",
    events: Array.from({ length: eventCount }, (_, i) => ({
      eventId: `e_${String(i + 1).padStart(3, "0")}`,
      role: "user" as const,
      // Each event is ~120 chars — small enough that many fit in the digest.
      content: `Event number ${i + 1} content with some descriptive text about topic ${i % 4}.`,
      createdAt: "2024-01-01T00:00:00.000Z",
      importance: 0.5,
      tags: [`tag-${i % 4}`],
    })),
    indexTerms: [],
    createdAt: "2024-01-01T00:00:00.000Z",
    parentSnapshotId: null,
  };
}

describe("recall scope — priority-ordering (audit fix #1)", () => {
  it("when hint is provided, hint events appear FIRST in the digest", async () => {
    const provider = new CapturingProvider();
    const snap = makeSnapshot(20);
    await recallShard({
      provider,
      userQuery: "anything",
      snapshot: snap,
      relevantEventIdsHint: ["e_015", "e_005"],
      maxRecallTokensPerShard: 4000,
    });
    const system = provider.systems[0]!;
    const i15 = system.indexOf("e_015");
    const i5 = system.indexOf("e_005");
    const i1 = system.indexOf("e_001");
    expect(i15).toBeGreaterThan(-1);
    expect(i5).toBeGreaterThan(-1);
    expect(i1).toBeGreaterThan(-1);
    // Hint events must come before non-hint events in the digest.
    expect(i15).toBeLessThan(i1);
    expect(i5).toBeLessThan(i1);
  });

  it("when hint is provided, NON-hint events ALSO appear (no hard filter)", async () => {
    // The pre-fix bug: only e_005 and e_015 would have been shown to recall.
    // Post-fix: those go first, but remaining budget includes other events.
    const provider = new CapturingProvider();
    const snap = makeSnapshot(20);
    await recallShard({
      provider,
      userQuery: "anything",
      snapshot: snap,
      relevantEventIdsHint: ["e_015", "e_005"],
      maxRecallTokensPerShard: 4000, // generous budget — should fit many events
    });
    const system = provider.systems[0]!;
    // Non-hint events must be present.
    expect(system).toMatch(/e_001\b/);
    expect(system).toMatch(/e_002\b/);
    // ... and a deep-in-the-shard event we did NOT hint at.
    expect(system).toMatch(/e_010\b/);
  });

  it("when no hint, falls back to insertion-order (backwards compat)", async () => {
    const provider = new CapturingProvider();
    const snap = makeSnapshot(5);
    await recallShard({
      provider,
      userQuery: "anything",
      snapshot: snap,
      maxRecallTokensPerShard: 4000,
    });
    const system = provider.systems[0]!;
    // All five events should be present in insertion order.
    const positions = ["e_001", "e_002", "e_003", "e_004", "e_005"].map((id) =>
      system.indexOf(id),
    );
    for (let i = 0; i < positions.length - 1; i++) {
      expect(positions[i]!).toBeGreaterThan(-1);
      expect(positions[i]!).toBeLessThan(positions[i + 1]!);
    }
  });

  it("budget still binds: tight budget truncates and hint events still go FIRST", async () => {
    // With a tight budget, the digest is truncated. Hint events must appear
    // BEFORE any non-hint events (priority ordering preserved at the edge),
    // and the truncation marker must show up.
    const provider = new CapturingProvider();
    const snap = makeSnapshot(20);
    await recallShard({
      provider,
      userQuery: "anything",
      snapshot: snap,
      relevantEventIdsHint: ["e_010", "e_011"],
      maxRecallTokensPerShard: 80, // only a few events fit
    });
    const system = provider.systems[0]!;
    // Hint events must be present and come first.
    const i10 = system.indexOf("e_010");
    const i11 = system.indexOf("e_011");
    expect(i10).toBeGreaterThan(-1);
    expect(i11).toBeGreaterThan(-1);
    // Deep-in-shard non-hint event e_019 cannot fit at this budget — it
    // would have appeared only if the priority-order pushed it past budget.
    expect(system).not.toMatch(/e_019\b/);
    // Truncation marker is present (budget hit).
    expect(system).toMatch(/more events truncated/);
    // Non-hint events that fit DO appear, but only AFTER the hint events.
    const i1 = system.indexOf("e_001");
    if (i1 !== -1) {
      expect(i10).toBeLessThan(i1);
      expect(i11).toBeLessThan(i1);
    }
  });
});
