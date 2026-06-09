import { describe, expect, it } from "vitest";

import {
  centroidOf,
  decodeCentroid,
  deriveShardDescriptors,
  descriptorText,
  encodeCentroid,
  type ShardDescriptorSource,
} from "../src/core/descriptors.js";

function beamishSources(): ShardDescriptorSource[] {
  // BEAM-shaped: every event starts with the same boilerplate ("User:" /
  // "Assistant:" turn framing), only the topical payload differs.
  return [
    {
      shardId: "conv-auth",
      events: [
        { content: "[Turn 1] User: We chose PBKDF2 with SHA256 for password hashing." },
        { content: "[Turn 2] Assistant: Iterations set to 600k for password storage." },
        { content: "[Turn 3] User: Lockout policy is five failed password attempts." },
      ],
    },
    {
      shardId: "conv-db",
      events: [
        { content: "[Turn 1] User: Database is SQLite for the MVP, Postgres later." },
        { content: "[Turn 2] Assistant: Noted, SQLite keeps the database simple." },
      ],
    },
    {
      shardId: "conv-travel",
      events: [
        { content: "[Turn 1] User: Booked the Lisbon flight for the offsite." },
        { content: "[Turn 2] Assistant: Lisbon hotel reserved near the venue." },
      ],
    },
  ];
}

describe("deriveShardDescriptors (TF-IDF auto-tags)", () => {
  it("surfaces shard-distinctive terms and suppresses corpus-wide boilerplate", () => {
    const descriptors = deriveShardDescriptors(beamishSources(), { maxTerms: 6 });
    const auth = descriptors.get("conv-auth")!;
    expect(auth.terms).toContain("password");
    // "turn" / "user" / "assistant" appear in EVERY shard → idf ≈ 0 → they
    // must rank below the topical terms (and outside a tight top-K).
    expect(auth.terms.slice(0, 4)).not.toContain("turn");
    expect(auth.terms.slice(0, 4)).not.toContain("assistant");

    const db = descriptors.get("conv-db")!;
    expect(db.terms).toContain("sqlite");
    const travel = descriptors.get("conv-travel")!;
    expect(travel.terms).toContain("lisbon");
  });

  it("is deterministic and independent of source ordering", () => {
    const a = deriveShardDescriptors(beamishSources());
    const reversed = [...beamishSources()].reverse();
    const b = deriveShardDescriptors(reversed);
    expect([...a.keys()]).toEqual([...b.keys()]); // sorted shard ids
    for (const id of a.keys()) {
      expect(a.get(id)!.terms).toEqual(b.get(id)!.terms);
      expect(a.get(id)!.eventCount).toBe(b.get(id)!.eventCount);
    }
  });

  it("boosts curated tags above prose-only terms", () => {
    const sources: ShardDescriptorSource[] = [
      {
        shardId: "s1",
        events: [
          {
            content: "general words about projects and roadmaps and planning",
            tags: ["chairsync"],
          },
        ],
      },
      {
        shardId: "s2",
        events: [{ content: "general words about other projects entirely" }],
      },
    ];
    const d = deriveShardDescriptors(sources, { maxTerms: 4 });
    expect(d.get("s1")!.terms[0]).toBe("chairsync");
  });

  it("respects maxTerms and handles empty shards", () => {
    const d = deriveShardDescriptors(
      [
        { shardId: "s1", events: [{ content: "alpha beta gamma delta epsilon zeta" }] },
        { shardId: "s-empty", events: [] },
      ],
      { maxTerms: 3 },
    );
    expect(d.get("s1")!.terms.length).toBe(3);
    expect(d.get("s-empty")!.terms).toEqual([]);
    expect(d.get("s-empty")!.eventCount).toBe(0);
  });

  it("does not mutate its inputs", () => {
    const sources = beamishSources();
    const snapshot = JSON.stringify(sources);
    deriveShardDescriptors(sources);
    expect(JSON.stringify(sources)).toBe(snapshot);
  });
});

describe("centroidOf", () => {
  it("returns the L2-normalized mean", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    const c = centroidOf([a, b])!;
    const expected = 1 / Math.sqrt(2);
    expect(c[0]).toBeCloseTo(expected, 5);
    expect(c[1]).toBeCloseTo(expected, 5);
    // Unit norm.
    expect(Math.hypot(c[0]!, c[1]!)).toBeCloseTo(1, 5);
  });

  it("returns null for empty input and throws on dim mismatch", () => {
    expect(centroidOf([])).toBeNull();
    expect(() =>
      centroidOf([new Float32Array([1, 0]), new Float32Array([1, 0, 0])]),
    ).toThrow(/dim mismatch/);
  });

  it("handles the degenerate all-zero mean without NaN", () => {
    const c = centroidOf([
      new Float32Array([1, 0]),
      new Float32Array([-1, 0]),
    ])!;
    expect(c[0]).toBe(0);
    expect(c[1]).toBe(0);
  });
});

describe("encodeCentroid / decodeCentroid", () => {
  it("round-trips exactly", () => {
    const v = new Float32Array([0.25, -0.5, 0.125, 1]);
    const back = decodeCentroid(encodeCentroid(v));
    expect([...back]).toEqual([...v]);
  });
});

describe("descriptorText", () => {
  it("is deterministic and caps event heads", () => {
    const t1 = descriptorText({
      name: "s-architecture",
      description: "Benchmark shard s-architecture",
      terms: ["postgres", "monolith"],
      eventHeads: ["one", "two", "three"],
      maxHeads: 2,
    });
    const t2 = descriptorText({
      name: "s-architecture",
      description: "Benchmark shard s-architecture",
      terms: ["postgres", "monolith"],
      eventHeads: ["one", "two", "three"],
      maxHeads: 2,
    });
    expect(t1).toBe(t2);
    expect(t1).toContain("postgres, monolith");
    expect(t1).toContain("two");
    expect(t1).not.toContain("three");
  });
});
