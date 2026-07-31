import { describe, expect, it } from "vitest";

import { selectCandidates } from "../src/core/router.js";
import {
  buildRouterIndex,
  DEFAULT_HYBRID_WEIGHTS,
  hybridEquivalentOfLexScore,
  hybridRouterStats,
  resetHybridRouterStats,
  routeConfidence,
  routerIndexFromDirectory,
  satLex,
  selectCandidatesHybrid,
  type EmbedFn,
  type RouterIndex,
} from "../src/core/routerEmbed.js";
import { centroidOf, encodeCentroid } from "../src/core/descriptors.js";
import type {
  MemoryDirectory,
  MemoryDirectoryEntry,
} from "../src/core/types.js";

// ─── Deterministic fake embedder ─────────────────────────────────────────────
// Maps text onto fixed keyword axes, L2-normalized. No model download, no I/O.

const AXES = [
  "password",
  "database",
  "lisbon",
  "pricing",
  "incident",
  "hiring",
  "webhook",
  "compliance",
] as const;

function fakeVec(text: string): Float32Array {
  const low = text.toLowerCase();
  const v = new Float32Array(AXES.length);
  AXES.forEach((axis, i) => {
    let count = 0;
    let ix = low.indexOf(axis);
    while (ix !== -1) {
      count++;
      ix = low.indexOf(axis, ix + axis.length);
    }
    v[i] = count;
  });
  let norm = Math.hypot(...v);
  if (norm === 0) {
    // Unmatched text gets a fixed off-axis direction so cosine vs any
    // topical centroid is 0 but the vector is still unit length.
    v[AXES.length - 1] = 1e-6;
    norm = 1e-6;
  }
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm;
  return v;
}

const fakeEmbed: EmbedFn = async (texts) => texts.map(fakeVec);
const failingEmbed: EmbedFn = async () => {
  throw new Error("embedder offline");
};

// ─── Directory fixtures ──────────────────────────────────────────────────────

function makeEntry(
  id: string,
  over: Partial<MemoryDirectoryEntry> = {},
): MemoryDirectoryEntry {
  return {
    id,
    name: id,
    description: `Benchmark shard ${id}`,
    tags: ["amb", "beam", "beam-turn"],
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    status: "active",
    snapshotId: "S001",
    tokenCountEstimate: 100,
    contextLimitEstimate: 128_000,
    fullnessPct: 0,
    summaryShort: `Synthetic shard ${id} (3 events).`,
    knownConflicts: [],
    parentId: null,
    children: [],
    trustLevel: "imported_doc",
    staleness: "current",
    ...over,
  };
}

/** 12 thin-metadata BEAM-shaped shards. Gold shard `conv-09` (alphabetically
 *  outside the old router's top-8) holds the password-hashing content. */
function beamFixture(): {
  directory: MemoryDirectory;
  contentByShard: Map<string, string[]>;
} {
  const ids = Array.from({ length: 12 }, (_, i) =>
    `conv-${String(i + 1).padStart(2, "0")}`,
  );
  const topics: Record<string, string> = {
    "conv-09": "User: We chose PBKDF2 for password hashing. Assistant: password iterations 600k.",
    "conv-03": "User: Database is SQLite for MVP. Assistant: database migration to Postgres later.",
    "conv-11": "User: Booked the Lisbon offsite. Assistant: lisbon hotel reserved.",
  };
  const contentByShard = new Map<string, string[]>();
  for (const id of ids) {
    contentByShard.set(id, [
      topics[id] ?? `User: routine sync notes for ${id}. Assistant: acknowledged.`,
    ]);
  }
  return {
    directory: { version: 1, entries: ids.map((id) => makeEntry(id)) },
    contentByShard,
  };
}

async function beamIndex(
  contentByShard: Map<string, string[]>,
): Promise<RouterIndex> {
  const shards = [];
  for (const [shardId, texts] of contentByShard) {
    const vecs = await fakeEmbed(texts);
    shards.push({ shardId, terms: [], centroid: centroidOf(vecs) });
  }
  return buildRouterIndex({ shards, embed: fakeEmbed, model: "fake-axes-v1" });
}

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === "object") {
    Object.freeze(obj);
    for (const v of Object.values(obj as Record<string, unknown>)) deepFreeze(v);
  }
  return obj;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("selectCandidatesHybrid — fallback behavior", () => {
  it("matches selectCandidates exactly when no index is supplied", async () => {
    const { directory } = beamFixture();
    const old = selectCandidates({ query: "password hashing", directory });
    const hybrid = await selectCandidatesHybrid({
      query: "password hashing",
      directory,
      index: null,
    });
    expect(hybrid.map((c) => c.entry.id)).toEqual(old.map((c) => c.entry.id));
    expect(hybrid.map((c) => c.score)).toEqual(old.map((c) => c.score));
  });

  it("falls back to the lexical candidate list when the embedder fails", async () => {
    const { directory, contentByShard } = beamFixture();
    const index = await beamIndex(contentByShard);
    const broken: RouterIndex = { ...index, embed: failingEmbed };
    const old = selectCandidates({ query: "password hashing", directory });
    const hybrid = await selectCandidatesHybrid({
      query: "password hashing",
      directory,
      index: broken,
    });
    expect(hybrid.map((c) => c.entry.id)).toEqual(old.map((c) => c.entry.id));
  });
});

describe("selectCandidatesHybrid — BEAM-shaped fixture (Discovery A)", () => {
  it("old router: all-zero scores → alphabetical top-8 drops the gold shard", () => {
    const { directory } = beamFixture();
    const cands = selectCandidates({
      query: "What password hashing algorithm did we choose?",
      directory,
    });
    expect(cands).toHaveLength(8); // active passthrough hits the cap
    expect(cands.every((c) => c.score === 0)).toBe(true);
    // Stable sort preserves directory (alphabetical) order: conv-01..conv-08.
    expect(cands.map((c) => c.entry.id)).toEqual([
      "conv-01", "conv-02", "conv-03", "conv-04",
      "conv-05", "conv-06", "conv-07", "conv-08",
    ]);
    expect(cands.map((c) => c.entry.id)).not.toContain("conv-09"); // gold lost
  });

  it("hybrid router: gold shard ranks top-3 (here #1) on embedding signal alone", async () => {
    const { directory, contentByShard } = beamFixture();
    const index = await beamIndex(contentByShard);
    const cands = await selectCandidatesHybrid({
      query: "What password hashing algorithm did we choose?",
      directory,
      index,
    });
    expect(cands).toHaveLength(8); // passthrough cap preserved
    const ids = cands.map((c) => c.entry.id);
    expect(ids.indexOf("conv-09")).toBeLessThan(3);
    expect(ids[0]).toBe("conv-09");
    // The embedding contribution is visible in the reason trail.
    expect(cands[0]!.reasons.some((r) => r.startsWith("embedSim="))).toBe(true);
    expect(cands[0]!.reasons.some((r) => r.startsWith("hybrid="))).toBe(true);
  });

  it("keeps the `score > 0 || active` passthrough for low-signal queries", async () => {
    const { directory, contentByShard } = beamFixture();
    const index = await beamIndex(contentByShard);
    // Query with no axis hits and no lexical hits: every score ≈ 0 but all
    // 12 shards are active → cap still fills to 8.
    const cands = await selectCandidatesHybrid({
      query: "zzz qqq xxx",
      directory,
      index,
    });
    expect(cands).toHaveLength(8);
  });

  it("does not mutate the directory (read-path safety)", async () => {
    const { directory, contentByShard } = beamFixture();
    deepFreeze(directory);
    const index = await beamIndex(contentByShard);
    await expect(
      selectCandidatesHybrid({ query: "password hashing", directory, index }),
    ).resolves.toBeTruthy();
  });
});

describe("selectCandidatesHybrid — fusion & ordering", () => {
  it("derived terms add lexical signal with prefix-tolerant matching", async () => {
    const directory: MemoryDirectory = {
      version: 1,
      entries: [makeEntry("s-a"), makeEntry("s-b")],
    };
    const index = await buildRouterIndex({
      shards: [
        { shardId: "s-a", terms: ["authentication", "lucia"], centroid: null },
        { shardId: "s-b", terms: ["catering"], centroid: null },
      ],
      embed: fakeEmbed,
      model: "fake-axes-v1",
    });
    const cands = await selectCandidatesHybrid({
      query: "what did we pick for auth?", // "auth" prefix-matches "authentication"
      directory,
      index,
    });
    expect(cands[0]!.entry.id).toBe("s-a");
    expect(
      cands[0]!.reasons.some((r) => r.startsWith("derivedTermOverlap=")),
    ).toBe(true);
  });

  it("embedding similarity breaks lexical ties deterministically", async () => {
    const entries = [
      makeEntry("s-db", { tags: ["decision"] }),
      makeEntry("s-pw", { tags: ["decision"] }),
    ];
    const directory: MemoryDirectory = { version: 1, entries };
    const index = await buildRouterIndex({
      shards: [
        { shardId: "s-db", terms: [], centroid: fakeVec("database database") },
        { shardId: "s-pw", terms: [], centroid: fakeVec("password password") },
      ],
      embed: fakeEmbed,
      model: "fake-axes-v1",
    });
    const cands = await selectCandidatesHybrid({
      query: "decision about password storage",
      directory,
      index,
    });
    // Both get tagOverlap=1 (lexical tie); embedding puts s-pw first.
    expect(cands[0]!.entry.id).toBe("s-pw");
    expect(cands[1]!.entry.id).toBe("s-db");
  });

  it("ties on hybrid AND lexical break by shardId ascending", async () => {
    const directory: MemoryDirectory = {
      version: 1,
      entries: [makeEntry("s-zz"), makeEntry("s-aa")],
    };
    const index = await buildRouterIndex({
      shards: [
        { shardId: "s-zz", terms: [], centroid: null },
        { shardId: "s-aa", terms: [], centroid: null },
      ],
      embed: fakeEmbed,
      model: "fake-axes-v1",
    });
    const cands = await selectCandidatesHybrid({
      query: "anything at all",
      directory,
      index,
    });
    expect(cands.map((c) => c.entry.id)).toEqual(["s-aa", "s-zz"]);
  });
});

describe("buildRouterIndex / routerIndexFromDirectory", () => {
  it("embeds descriptor text for shards without a precomputed centroid", async () => {
    const index = await buildRouterIndex({
      shards: [
        { shardId: "s-1", terms: ["password"], embedText: "password hashing notes" },
        { shardId: "s-2", terms: [], centroid: fakeVec("database") },
        { shardId: "s-3", terms: [] }, // neither → null centroid
      ],
      embed: fakeEmbed,
      model: "fake-axes-v1",
    });
    expect(index.byShard.get("s-1")!.centroid).not.toBeNull();
    expect(index.byShard.get("s-2")!.centroid).not.toBeNull();
    expect(index.byShard.get("s-3")!.centroid).toBeNull();
  });

  it("hydrates from directory descriptor fields and ignores model mismatches", () => {
    const good = makeEntry("s-good") as MemoryDirectoryEntry & {
      derivedTerms?: string[];
      embedCentroidB64?: string;
      embedModel?: string;
    };
    good.derivedTerms = ["password"];
    good.embedCentroidB64 = encodeCentroid(fakeVec("password"));
    good.embedModel = "fake-axes-v1";

    const stale = makeEntry("s-stale") as typeof good;
    stale.embedCentroidB64 = encodeCentroid(fakeVec("database"));
    stale.embedModel = "some-other-model";

    const directory: MemoryDirectory = { version: 1, entries: [good, stale] };
    const index = routerIndexFromDirectory(directory, fakeEmbed, "fake-axes-v1");
    expect(index).not.toBeNull();
    expect(index!.byShard.get("s-good")!.centroid).not.toBeNull();
    expect(index!.byShard.get("s-good")!.terms).toEqual(["password"]);
    expect(index!.byShard.get("s-stale")!.centroid).toBeNull(); // model mismatch

    // A directory with no descriptors at all → null (caller falls back).
    const bare: MemoryDirectory = { version: 1, entries: [makeEntry("s-x")] };
    expect(routerIndexFromDirectory(bare, fakeEmbed, "fake-axes-v1")).toBeNull();
  });
});

describe("weights & confidence helpers", () => {
  it("satLex is bounded, monotone, and maps the RAG-floor threshold to 0.5", () => {
    expect(satLex(0, 4)).toBe(0);
    expect(satLex(4, 4)).toBeCloseTo(0.5, 5);
    expect(satLex(8, 4)).toBeCloseTo(2 / 3, 5);
    expect(satLex(-1, 4)).toBeCloseTo(-0.2, 5);
    expect(satLex(1e9, 4)).toBeLessThan(1);
    expect(satLex(2, 4)).toBeLessThan(satLex(3, 4));
  });

  it("hybridEquivalentOfLexScore converts old-scale thresholds", () => {
    const eq = hybridEquivalentOfLexScore(4, DEFAULT_HYBRID_WEIGHTS);
    expect(eq).toBeCloseTo(
      DEFAULT_HYBRID_WEIGHTS.wLex * satLex(4, DEFAULT_HYBRID_WEIGHTS.lexSat),
      5,
    );
    // Explicit-weights form stays anchored: lexSat=4 maps lex=4 → 0.5.
    expect(
      hybridEquivalentOfLexScore(4, { wLex: 1, wEmb: 1, lexSat: 4, termWeight: 1 }),
    ).toBeCloseTo(0.5, 5);
  });

  it("routeConfidence recommends a small probe set only for separated tops", () => {
    const mk = (id: string, score: number) => ({
      entry: makeEntry(id),
      score,
      reasons: [],
    });
    const separated = [
      mk("a", 1.2), mk("b", 0.5), mk("c", 0.45), mk("d", 0.4),
      mk("e", 0.38), mk("f", 0.3), mk("g", 0.2), mk("h", 0.1),
    ];
    const conf = routeConfidence(separated);
    expect(conf.top1Margin).toBeCloseTo(0.7, 5);
    expect(conf.recommendedProbeCount).toBe(4); // floor at minProbes

    const flat = separated.map((c, i) => mk(c.entry.id, 1 - i * 0.01));
    expect(routeConfidence(flat).recommendedProbeCount).toBe(8); // keep all
  });
});

// ─── Degradation is counted, not silent ──────────────────────────────────────

describe("hybrid router degradation accounting", () => {
  /**
   * "Falls back to lexical" reads as graceful until you notice what lexical
   * selection does on a BEAM-shaped corpus: every entry scores ~0, so the cut
   * returns the alphabetically-first N for every query. The embedding leg is
   * the entire measured win (+0.365 at BEAM 1M). A transient embed failure
   * therefore silently swaps the winning config for the losing one, mid-run,
   * while the manifest still says the hybrid router was on.
   */
  it("counts a fallback when no index is supplied", async () => {
    resetHybridRouterStats();
    const directory: MemoryDirectory = { version: 1, entries: [makeEntry("s-a")] };
    await selectCandidatesHybrid({ query: "password", directory, index: null });
    expect(hybridRouterStats()).toMatchObject({ hybrid: 0, fallbackNoIndex: 1 });
  });

  it("counts a fallback — and records the reason — when embedding throws", async () => {
    resetHybridRouterStats();
    const directory: MemoryDirectory = { version: 1, entries: [makeEntry("s-a")] };
    const index = await buildRouterIndex({
      shards: [{ shardId: "s-a", terms: ["password"], centroid: null }],
      embed: fakeEmbed,
      model: "fake-axes-v1",
    });
    const broken: RouterIndex = {
      ...index!,
      embed: () => Promise.reject(new Error("model download failed")),
    };
    const cands = await selectCandidatesHybrid({ query: "password", directory, index: broken });
    // Still returns the lexical baseline — degradation, not failure.
    expect(cands.length).toBeGreaterThan(0);
    const stats = hybridRouterStats();
    expect(stats.fallbackEmbedFailed).toBe(1);
    expect(stats.hybrid).toBe(0);
    expect(stats.lastEmbedError).toContain("model download failed");
  });

  it("counts an empty embed result as a fallback, not as a hybrid run", async () => {
    resetHybridRouterStats();
    const directory: MemoryDirectory = { version: 1, entries: [makeEntry("s-a")] };
    const index = await buildRouterIndex({
      shards: [{ shardId: "s-a", terms: ["password"], centroid: null }],
      embed: fakeEmbed,
      model: "fake-axes-v1",
    });
    const empty: RouterIndex = { ...index!, embed: () => Promise.resolve([]) };
    await selectCandidatesHybrid({ query: "password", directory, index: empty });
    expect(hybridRouterStats().fallbackEmbedFailed).toBe(1);
  });

  it("counts a real hybrid run as hybrid", async () => {
    resetHybridRouterStats();
    const directory: MemoryDirectory = { version: 1, entries: [makeEntry("s-a")] };
    const index = await buildRouterIndex({
      shards: [{ shardId: "s-a", terms: ["password"], centroid: null }],
      embed: fakeEmbed,
      model: "fake-axes-v1",
    });
    await selectCandidatesHybrid({ query: "password", directory, index });
    expect(hybridRouterStats()).toMatchObject({
      hybrid: 1,
      fallbackNoIndex: 0,
      fallbackEmbedFailed: 0,
    });
  });
});
