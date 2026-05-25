import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempStorage } from "./helpers.js";
import { createShard, appendEventAndSnapshot } from "../src/core/commit.js";
import { SHARD_SYSTEM_PROMPT } from "../src/core/prompts.js";
import { JsonlStorage } from "../src/storage/jsonlStorage.js";

describe("JsonlStorage", () => {
  let ctx: Awaited<ReturnType<typeof makeTempStorage>>;
  beforeEach(async () => { ctx = await makeTempStorage(); });
  afterEach(async () => { await ctx.cleanup(); });

  it("initializes empty directory", async () => {
    const dir = await ctx.storage.loadDirectory();
    expect(dir.entries).toEqual([]);
    expect(await ctx.storage.isInitialized()).toBe(true);
  });

  it("creates a shard with an initial S001 snapshot and chronicle entry", async () => {
    const { snapshot, entry, chronicle } = await createShard({
      storage: ctx.storage,
      id: "test-shard-001",
      name: "Test shard",
      description: "Just a test",
      tags: ["test"],
      systemPrompt: SHARD_SYSTEM_PROMPT,
      summary: "Empty test summary.",
    });
    expect(snapshot.snapshotId).toBe("S001");
    expect(snapshot.events.length).toBe(0);
    expect(entry.id).toBe("test-shard-001");
    expect(entry.fullnessPct).toBe(0);
    expect(chronicle.type).toBe("shard_created");

    const ids = await ctx.storage.listShardIds();
    expect(ids).toContain("test-shard-001");

    const chronicleAll = await ctx.storage.readChronicle();
    expect(chronicleAll.length).toBe(1);
  });

  it("appendEventAndSnapshot creates a new immutable snapshot and refuses overwrite", async () => {
    await createShard({
      storage: ctx.storage,
      id: "alpha-001",
      name: "Alpha",
      description: "α",
      tags: ["alpha"],
      systemPrompt: SHARD_SYSTEM_PROMPT,
      summary: "Alpha shard.",
    });

    const r1 = await appendEventAndSnapshot({
      storage: ctx.storage,
      shardId: "alpha-001",
      event: { role: "user", content: "first event" },
      reason: "test",
      actor: "user",
    });
    expect(r1.snapshot.snapshotId).toBe("S002");
    expect(r1.snapshot.events.length).toBe(1);
    expect(r1.snapshot.parentSnapshotId).toBe("S001");

    const r2 = await appendEventAndSnapshot({
      storage: ctx.storage,
      shardId: "alpha-001",
      event: { role: "user", content: "second event" },
      reason: "test",
      actor: "user",
    });
    expect(r2.snapshot.snapshotId).toBe("S003");
    expect(r2.snapshot.events.length).toBe(2);
    expect(r2.snapshot.parentSnapshotId).toBe("S002");

    // Trying to write S001 again should refuse.
    await expect(
      ctx.storage.writeSnapshot({
        ...r1.snapshot,
        snapshotId: "S001",
      }),
    ).rejects.toThrow(/Refusing to overwrite/);
  });

  it("loads what it saved (round-trip)", async () => {
    await createShard({
      storage: ctx.storage,
      id: "beta-001",
      name: "Beta",
      description: "β",
      tags: ["beta"],
      systemPrompt: SHARD_SYSTEM_PROMPT,
      summary: "Beta shard.",
    });
    const fresh = new JsonlStorage(ctx.root);
    const m = await fresh.loadManifest("beta-001");
    expect(m?.id).toBe("beta-001");
    const dir = await fresh.loadDirectory();
    expect(dir.entries.map((e) => e.id)).toContain("beta-001");
  });
});
