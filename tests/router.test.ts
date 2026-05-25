import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempStorage } from "./helpers.js";
import { seedFixtures } from "../src/eval/fixtures.js";
import { selectCandidates } from "../src/core/router.js";

describe("router.selectCandidates", () => {
  let ctx: Awaited<ReturnType<typeof makeTempStorage>>;
  beforeEach(async () => {
    ctx = await makeTempStorage();
    await seedFixtures(ctx.storage);
  });
  afterEach(async () => { await ctx.cleanup(); });

  it("ranks Thalm shard above music and admin for OpenClaw query", async () => {
    const dir = await ctx.storage.loadDirectory();
    const cands = selectCandidates({ query: "What did we decide about OpenClaw and Thalm?", directory: dir });
    expect(cands.length).toBeGreaterThan(0);
    const top = cands[0]!.entry.id;
    expect(top).toBe("thalm-architecture-001");

    const ranks = cands.map((c) => c.entry.id);
    const thalmIx = ranks.indexOf("thalm-architecture-001");
    const musicIx = ranks.indexOf("music-headphones-001");
    const adminIx = ranks.indexOf("personal-admin-001");
    expect(thalmIx).toBeLessThan(musicIx === -1 ? Number.POSITIVE_INFINITY : musicIx);
    expect(thalmIx).toBeLessThan(adminIx === -1 ? Number.POSITIVE_INFINITY : adminIx);
  });

  it("ranks music shard top for headphone query", async () => {
    const dir = await ctx.storage.loadDirectory();
    const cands = selectCandidates({ query: "Which headphones do I prefer?", directory: dir });
    expect(cands[0]?.entry.id).toBe("music-headphones-001");
  });

  it("ranks admin shard top for passport query", async () => {
    const dir = await ctx.storage.loadDirectory();
    const cands = selectCandidates({ query: "passport renewal window", directory: dir });
    expect(cands[0]?.entry.id).toBe("personal-admin-001");
  });

  it("returns empty when directory has no entries", () => {
    const cands = selectCandidates({ query: "anything", directory: { version: 1, entries: [] } });
    expect(cands).toEqual([]);
  });

  it("prefix-tolerant tag match: 'authentication' query hits shard tagged 'auth'", () => {
    const directory = {
      version: 1,
      entries: [
        {
          id: "core-arch",
          name: "core-arch",
          description: "Architecture",
          tags: ["auth", "lucia", "monolith"],
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
          status: "active" as const,
          snapshotId: "S001",
          tokenCountEstimate: 100,
          contextLimitEstimate: 128_000,
          fullnessPct: 0,
          summaryShort: "core",
          knownConflicts: [],
          parentId: null,
          children: [],
          trustLevel: "imported_doc" as const,
          staleness: "current" as const,
        },
        {
          id: "filler-misc",
          name: "filler-misc",
          description: "Misc",
          tags: ["random", "thing"],
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
          status: "active" as const,
          snapshotId: "S001",
          tokenCountEstimate: 100,
          contextLimitEstimate: 128_000,
          fullnessPct: 0,
          summaryShort: "filler",
          knownConflicts: [],
          parentId: null,
          children: [],
          trustLevel: "imported_doc" as const,
          staleness: "current" as const,
        },
      ],
    };
    const cands = selectCandidates({
      query: "What did the team decide about the authentication system?",
      directory,
    });
    expect(cands[0]!.entry.id).toBe("core-arch");
    // The reason string should mention tag overlap because of prefix match.
    expect(cands[0]!.reasons.some((r) => r.startsWith("tagOverlap="))).toBe(true);
  });

  it("prefix-match requires shared prefix ≥ 4 chars (no pathological short matches)", () => {
    const directory = {
      version: 1,
      entries: [
        {
          id: "shard-ag",
          name: "shard",
          description: "shard",
          tags: ["ag", "agent"], // "ag" is 2 chars — must NOT match arbitrary "ag*" terms
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
          status: "active" as const,
          snapshotId: "S001",
          tokenCountEstimate: 100,
          contextLimitEstimate: 128_000,
          fullnessPct: 0,
          summaryShort: "shard",
          knownConflicts: [],
          parentId: null,
          children: [],
          trustLevel: "imported_doc" as const,
          staleness: "current" as const,
        },
      ],
    };
    // Query token "again" should NOT match tag "ag" (2 chars too short).
    const cands = selectCandidates({ query: "again", directory });
    const reasons = cands[0]?.reasons ?? [];
    expect(reasons.some((r) => r.startsWith("tagOverlap="))).toBe(false);
  });
});
