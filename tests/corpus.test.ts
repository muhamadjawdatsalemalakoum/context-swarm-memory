import { describe, expect, it } from "vitest";

import { sampleFromEvents, type BenchEvent } from "../src/eval/corpus.js";

function makeEvent(id: string, tokenCount: number, isCore = false): BenchEvent {
  return {
    id,
    shardId: isCore ? "s-core" : "s-filler",
    content: `event-${id}`,
    tokenCount,
    isCore,
    tier: isCore ? 0 : 1,
  };
}

const tinyCore: BenchEvent[] = [
  makeEvent("c1", 100, true),
  makeEvent("c2", 200, true),
];

function makeFiller(n: number, tokensEach: number): BenchEvent[] {
  return Array.from({ length: n }, (_, i) =>
    makeEvent(`f${i}`, tokensEach, false),
  );
}

describe("sampleFromEvents", () => {
  it("always includes every core event", () => {
    const filler = makeFiller(50, 100);
    const corpus = sampleFromEvents([...tinyCore, ...filler], {
      targetTokens: 1000,
    });
    for (const e of tinyCore) {
      expect(corpus.byId.get(e.id)).toBeDefined();
    }
  });

  it("throws when target is below core token count", () => {
    expect(() =>
      sampleFromEvents([...tinyCore, ...makeFiller(10, 100)], {
        targetTokens: 100, // core is 300 tokens
      }),
    ).toThrow(/less than core/);
  });

  it("is deterministic with the same seed", () => {
    const events = [...tinyCore, ...makeFiller(100, 50)];
    const a = sampleFromEvents(events, { targetTokens: 1000, seed: 42 });
    const b = sampleFromEvents(events, { targetTokens: 1000, seed: 42 });
    expect(a.fillerEvents.map((e) => e.id)).toEqual(
      b.fillerEvents.map((e) => e.id),
    );
  });

  it("produces different samples with different seeds (high probability)", () => {
    const events = [...tinyCore, ...makeFiller(200, 50)];
    const a = sampleFromEvents(events, { targetTokens: 5000, seed: 1 });
    const b = sampleFromEvents(events, { targetTokens: 5000, seed: 2 });
    const idsA = a.fillerEvents.map((e) => e.id).sort();
    const idsB = b.fillerEvents.map((e) => e.id).sort();
    expect(idsA).not.toEqual(idsB);
  });

  it("respects the target token budget (never exceeds)", () => {
    const events = [...tinyCore, ...makeFiller(100, 73)];
    const corpus = sampleFromEvents(events, { targetTokens: 2000, seed: 42 });
    expect(corpus.totalTokens).toBeLessThanOrEqual(2000);
  });

  it("packs events into shards and per-id maps consistently", () => {
    const events = [...tinyCore, ...makeFiller(20, 50)];
    const corpus = sampleFromEvents(events, { targetTokens: 1500, seed: 42 });
    expect(corpus.byId.size).toBe(corpus.events.length);
    // Sum of byShard arrays equals events length
    let total = 0;
    for (const arr of corpus.byShard.values()) total += arr.length;
    expect(total).toBe(corpus.events.length);
  });

  it("records the targetTokens and seed used", () => {
    const corpus = sampleFromEvents(
      [...tinyCore, ...makeFiller(10, 100)],
      { targetTokens: 1500, seed: 7 },
    );
    expect(corpus.targetTokens).toBe(1500);
    expect(corpus.sampleSeed).toBe(7);
  });
});
