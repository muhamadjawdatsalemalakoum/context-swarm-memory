/**
 * `CSM_SHARD_DESCRIPTORS` — real TF-IDF descriptors on directory entries.
 *
 * DEFAULT FLIPPED OFF -> ON on 2026-08-01, together with `CSM_ROUTER_HYBRID`.
 * The descriptor terms ARE the lexical leg the hybrid router consumes, so the
 * two ship as one configuration; leaving descriptors off would have run the
 * (now default-on) router on the boilerplate directory it cannot score.
 * Descriptors are flat as a standalone lever — the reason they ship is the
 * router, not their own gate.
 *
 * The load-bearing case is `explicit_off_is_byte_identical`: the frozen BEAM
 * baseline is still reachable and still byte-for-byte what it always was — it
 * just now requires `CSM_SHARD_DESCRIPTORS=0` instead of an unset variable.
 * That legacy arm is what every pre-2026-08-01 run in `data/eval/runs/` was
 * measured on, so it must stay reproducible to the byte.
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
      tokenCount: 24,
      isCore: true,
      tier: 0,
    },
    {
      id: "d1#turn-1",
      shardId: "d1",
      content:
        "[Turn 1] Assistant: For the kubernetes autoscaler, set the payments " +
        "cluster replica floor higher.",
      tags: ["amb", "beam"],
      tokenCount: 24,
      isCore: true,
      tier: 0,
    },
    {
      id: "d2#turn-0",
      shardId: "d2",
      content:
        "[April-02-2024 | Turn 0] User: Let's talk about the sourdough starter " +
        "hydration ratio for baking. ->-> 2,1",
      tags: ["amb", "beam"],
      tokenCount: 24,
      isCore: true,
      tier: 0,
    },
    {
      id: "d2#turn-1",
      shardId: "d2",
      content: "[Turn 1] Assistant: A wetter sourdough starter ferments faster when baking.",
      tags: ["amb", "beam"],
      tokenCount: 24,
      isCore: true,
      tier: 0,
    },
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

/**
 * The exact bytes `buildShardsFromCorpus(makeCorpus()).directory` produced on
 * the OFF path before the 2026-08-01 default flip, captured verbatim.
 *
 * Pinning the literal — rather than diffing two live builds against each other,
 * which is all this file used to do — is what actually holds the legacy arm
 * still. Two live builds drift together silently; a literal does not. If this
 * ever needs regenerating, print
 * `JSON.stringify(withEnv("0", () => buildShardsFromCorpus(makeCorpus())).directory)`
 * and be certain the change to the frozen baseline was intended.
 */
const FROZEN_OFF_DIRECTORY_JSON =
  `{"version":1,"entries":[` +
  `{"id":"d1","name":"d1","description":"Benchmark shard d1","tags":["amb","beam"],"createdAt":"2024-01-01T00:00:00.000Z","updatedAt":"2024-01-01T00:00:00.000Z","status":"active","snapshotId":"S001","tokenCountEstimate":78,"contextLimitEstimate":128000,"fullnessPct":0.06,"summaryShort":"Synthetic shard d1 (2 events).","knownConflicts":[],"parentId":null,"children":[],"trustLevel":"imported_doc","staleness":"current"},` +
  `{"id":"d2","name":"d2","description":"Benchmark shard d2","tags":["amb","beam"],"createdAt":"2024-01-01T00:00:00.000Z","updatedAt":"2024-01-01T00:00:00.000Z","status":"active","snapshotId":"S001","tokenCountEstimate":68,"contextLimitEstimate":128000,"fullnessPct":0.05,"summaryShort":"Synthetic shard d2 (2 events).","knownConflicts":[],"parentId":null,"children":[],"trustLevel":"imported_doc","staleness":"current"}` +
  `]}`;

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
  it("defaults on and reads the shared flag vocabulary in both directions", () => {
    // NEW DEFAULT (2026-08-01): unset means ON. Empty/whitespace-only is
    // treated as unset by `envFlag`, so it takes the same default — a `.env`
    // line left as `CSM_SHARD_DESCRIPTORS=` does NOT turn the lever off.
    expect(resolveShardDescriptors(undefined)).toBe(true);
    expect(resolveShardDescriptors("")).toBe(true);

    // LEGACY BEHAVIOUR, still pinned — it just has to be asked for explicitly.
    expect(resolveShardDescriptors("0")).toBe(false);
    expect(resolveShardDescriptors("no")).toBe(false);
    expect(resolveShardDescriptors("false")).toBe(false);
    expect(resolveShardDescriptors("off")).toBe(false);

    expect(resolveShardDescriptors("1")).toBe(true);
    expect(resolveShardDescriptors("true")).toBe(true);
    expect(resolveShardDescriptors("YES")).toBe(true);

    // An unrecognised value is an error, never a default. This matters MORE
    // now than it did default-off: a typo in the off-arm of an A/B would
    // otherwise silently fall back to the default, which is the treatment.
    expect(() => resolveShardDescriptors("nope")).toThrow(/CSM_SHARD_DESCRIPTORS/);
  });
});

describe("shard descriptors", () => {
  it("explicit_off_is_byte_identical", () => {
    // The frozen BEAM baseline must not move. Before 2026-08-01 an unset
    // variable selected it; now `=0` does, and the bytes are unchanged.
    const explicitOff = withEnv("0", () => buildShardsFromCorpus(makeCorpus()));
    expect(JSON.stringify(explicitOff.directory)).toBe(FROZEN_OFF_DIRECTORY_JSON);

    // Every spelling of "off" in the shared vocabulary lands on the same bytes.
    for (const spelling of ["0", "false", "no", "off", "disabled"]) {
      const built = withEnv(spelling, () => buildShardsFromCorpus(makeCorpus()));
      expect(JSON.stringify(built.directory)).toBe(FROZEN_OFF_DIRECTORY_JSON);
    }

    const d1 = explicitOff.directory.entries.find((e) => e.id === "d1")!;
    expect(d1.name).toBe("d1");
    expect(d1.description).toBe("Benchmark shard d1");
    expect(d1.summaryShort).toBe("Synthetic shard d1 (2 events).");
    // The defect this documents: every shard's tags are the same union, so the
    // lexical scorer has no query signal. This is exactly why the flag had to
    // flip on when the hybrid router did — the router's lexical leg reads
    // these fields, and off they carry nothing to score.
    const d2 = explicitOff.directory.entries.find((e) => e.id === "d2")!;
    expect(d2.tags).toEqual(d1.tags);
  });

  it("unset now selects the descriptor build, byte-for-byte the same as =1", () => {
    // Companion to the case above: pins the NEW default. A fresh clone with no
    // `.env` must get the enriched directory, not the frozen boilerplate.
    const unset = withEnv(undefined, () => buildShardsFromCorpus(makeCorpus()));
    const explicitOn = withEnv("1", () => buildShardsFromCorpus(makeCorpus()));
    expect(JSON.stringify(unset.directory)).toBe(JSON.stringify(explicitOn.directory));
    expect(JSON.stringify(unset.directory)).not.toBe(FROZEN_OFF_DIRECTORY_JSON);
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
    // `withEnv("0")`, not `withEnv(undefined)`: since the default flip, unset
    // IS the on-path, so the old form compared the enriched build to itself
    // and asserted nothing — the same vacuous-comparison trap the `eventId`
    // note below records.
    const off = withEnv("0", () => buildShardsFromCorpus(makeCorpus()));
    const on = withEnv("1", () => buildShardsFromCorpus(makeCorpus()));
    const a = off.snapshots.get("d1@S001")!;
    const b = on.snapshots.get("d1@S001")!;
    // `eventId`, not `id`: MemoryEvent has no `id`, so the old form compared
    // [undefined, undefined] to [undefined, undefined] and asserted nothing.
    expect(b.events.map((e) => e.eventId)).toEqual(a.events.map((e) => e.eventId));
    expect(b.events.map((e) => e.content)).toEqual(a.events.map((e) => e.content));
    // The off-path snapshot is still the frozen one, so this comparison is a
    // real on-vs-off diff and not two copies of the same build.
    expect(a.summary).toBe("Synthetic shard d1 (2 events).");
    expect(b.summary).not.toBe(a.summary);
  });
});
