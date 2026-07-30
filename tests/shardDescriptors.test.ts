/**
 * `CSM_SHARD_DESCRIPTORS` — real TF-IDF descriptors on directory entries.
 *
 * The load-bearing case is `default_off_is_byte_identical`: the frozen BEAM
 * baseline must not move unless the flag is explicitly set. Every lever in this
 * repo ships default-off until it clears the calibrated answer gate.
 */
import { describe, expect, it } from "vitest";

import {
  buildShardsFromCorpus,
  resolveShardDescriptors,
} from "../src/eval/baselines/csm.js";
import type { BenchEvent, Corpus } from "../src/eval/corpus.js";

function makeCorpus(): Corpus {
  const events: BenchEvent[] = [
    {
      id: "d1#turn-0",
      shardId: "d1",
      content:
        "[March-15-2024 | Turn 0] User: I need help with the kubernetes autoscaler " +
        "configuration for the payments cluster. ->-> 1,1",
      tags: ["amb", "beam"],
      timestamp: null,
    } as BenchEvent,
    {
      id: "d1#turn-1",
      shardId: "d1",
      content:
        "[Turn 1] Assistant: For the kubernetes autoscaler, set the payments " +
        "cluster replica floor higher.",
      tags: ["amb", "beam"],
      timestamp: null,
    } as BenchEvent,
    {
      id: "d2#turn-0",
      shardId: "d2",
      content:
        "[April-02-2024 | Turn 0] User: Let's talk about the sourdough starter " +
        "hydration ratio for baking. ->-> 2,1",
      tags: ["amb", "beam"],
      timestamp: null,
    } as BenchEvent,
    {
      id: "d2#turn-1",
      shardId: "d2",
      content: "[Turn 1] Assistant: A wetter sourdough starter ferments faster when baking.",
      tags: ["amb", "beam"],
      timestamp: null,
    } as BenchEvent,
  ];
  const byShard = new Map<string, BenchEvent[]>();
  for (const e of events) {
    if (!byShard.has(e.shardId)) byShard.set(e.shardId, []);
    byShard.get(e.shardId)!.push(e);
  }
  return {
    events,
    byId: new Map(events.map((e) => [e.id, e])),
    byShard,
  } as unknown as Corpus;
}

function withEnv<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.CSM_SHARD_DESCRIPTORS;
  if (value === undefined) delete process.env.CSM_SHARD_DESCRIPTORS;
  else process.env.CSM_SHARD_DESCRIPTORS = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CSM_SHARD_DESCRIPTORS;
    else process.env.CSM_SHARD_DESCRIPTORS = prev;
  }
}

describe("resolveShardDescriptors", () => {
  it("defaults to off and accepts only explicit truthy values", () => {
    expect(resolveShardDescriptors(undefined)).toBe(false);
    expect(resolveShardDescriptors("")).toBe(false);
    expect(resolveShardDescriptors("0")).toBe(false);
    expect(resolveShardDescriptors("no")).toBe(false);
    expect(resolveShardDescriptors("1")).toBe(true);
    expect(resolveShardDescriptors("true")).toBe(true);
    expect(resolveShardDescriptors("YES")).toBe(true);
  });
});

describe("shard descriptors", () => {
  it("default_off_is_byte_identical", () => {
    // The frozen BEAM baseline must not move unless the flag is set.
    const off = withEnv(undefined, () => buildShardsFromCorpus(makeCorpus()));
    const explicitOff = withEnv("0", () => buildShardsFromCorpus(makeCorpus()));
    expect(JSON.stringify(explicitOff.directory)).toBe(JSON.stringify(off.directory));

    const d1 = off.directory.entries.find((e) => e.id === "d1")!;
    expect(d1.name).toBe("d1");
    expect(d1.description).toBe("Benchmark shard d1");
    expect(d1.summaryShort).toBe("Synthetic shard d1 (2 events).");
    // The defect this documents: every shard's tags are the same union, so the
    // lexical scorer has no query signal.
    const d2 = off.directory.entries.find((e) => e.id === "d2")!;
    expect(d2.tags).toEqual(d1.tags);
  });

  it("on: writes discriminative terms into the fields scoreEntryLexical reads", () => {
    const on = withEnv("1", () => buildShardsFromCorpus(makeCorpus()));
    const d1 = on.directory.entries.find((e) => e.id === "d1")!;
    const d2 = on.directory.entries.find((e) => e.id === "d2")!;

    // Terms that appear in one shard but not the other must survive TF-IDF.
    expect(d1.tags.join(" ")).toMatch(/kubernetes|autoscaler|payments/);
    expect(d2.tags.join(" ")).toMatch(/sourdough|hydration|baking/);

    // And the two shards must no longer look identical to the router.
    expect(d1.tags).not.toEqual(d2.tags);
    expect(d1.description).not.toBe(d2.description);
    expect(d1.summaryShort).not.toBe(d2.summaryShort);
  });

  it("on: keeps the original corpus tags as well as the derived ones", () => {
    const on = withEnv("1", () => buildShardsFromCorpus(makeCorpus()));
    const d1 = on.directory.entries.find((e) => e.id === "d1")!;
    expect(d1.tags).toContain("amb");
    expect(d1.tags).toContain("beam");
  });

  it("on: surfaces the dated header so recency/temporal queries have a hook", () => {
    const on = withEnv("1", () => buildShardsFromCorpus(makeCorpus()));
    const d1 = on.directory.entries.find((e) => e.id === "d1")!;
    expect(d1.summaryShort.startsWith("March-15-2024. ")).toBe(true);
  });

  it("on: event content and ids are untouched (only metadata changes)", () => {
    const off = withEnv(undefined, () => buildShardsFromCorpus(makeCorpus()));
    const on = withEnv("1", () => buildShardsFromCorpus(makeCorpus()));
    const a = off.snapshots.get("d1@S001")!;
    const b = on.snapshots.get("d1@S001")!;
    expect(b.events.map((e) => e.id)).toEqual(a.events.map((e) => e.id));
    expect(b.events.map((e) => e.content)).toEqual(a.events.map((e) => e.content));
  });
});
