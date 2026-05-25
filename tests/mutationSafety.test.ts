import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { makeTempStorage } from "./helpers.js";
import { createShard, appendEventAndSnapshot } from "../src/core/commit.js";
import { SHARD_SYSTEM_PROMPT } from "../src/core/prompts.js";
import { ask } from "../src/core/ask.js";
import { MockProvider } from "../src/providers/MockProvider.js";

function sha(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function fileSha(path: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(path);
    return sha(buf);
  } catch {
    return null;
  }
}

async function dirSha(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else out[p] = (await fileSha(p)) ?? "<missing>";
    }
  }
  await walk(root);
  return out;
}

describe("mutation safety: csm ask must not alter durable memory", () => {
  let ctx: Awaited<ReturnType<typeof makeTempStorage>>;
  beforeEach(async () => { ctx = await makeTempStorage(); });
  afterEach(async () => { await ctx.cleanup(); });

  it("ask leaves directory snapshot ids, snapshot files, and chronicle unchanged", async () => {
    // 1. Create a shard.
    await createShard({
      storage: ctx.storage,
      id: "thalm-architecture-001",
      name: "Thalm architecture",
      description: "OpenClaw, Thalm, voice, canvas",
      tags: ["thalm", "openclaw"],
      systemPrompt: SHARD_SYSTEM_PROMPT,
      summary: "Thalm architecture decisions, including OpenClaw role.",
    });
    // 2. Add memory.
    await appendEventAndSnapshot({
      storage: ctx.storage,
      shardId: "thalm-architecture-001",
      event: {
        role: "user",
        content: "User said OpenClaw may act as Thalm's shell/control plane.",
        tags: ["openclaw", "shell"],
      },
      reason: "seed",
      actor: "user",
    });

    // 3. Hash everything.
    const dirBefore = await fileSha(ctx.storage.paths.directoryFile);
    const chronicleBefore = await fileSha(ctx.storage.paths.chronicleFile);
    const queryRunsBefore = await fileSha(ctx.storage.paths.queryRunsFile);
    const shardsBefore = await dirSha(ctx.storage.paths.shardsDir);
    const snapshotIdsBefore = (await ctx.storage.loadDirectory()).entries.map((e) => ({
      id: e.id,
      snap: e.snapshotId,
    }));
    const eventCountBefore = (
      await ctx.storage.loadSnapshot(
        "thalm-architecture-001",
        snapshotIdsBefore.find((s) => s.id === "thalm-architecture-001")!.snap,
      )
    )!.events.length;
    const snapshotFilesBefore = await ctx.storage.listSnapshotIds("thalm-architecture-001");

    // 4. Run ask.
    const provider = new MockProvider();
    const result = await ask({ provider, storage: ctx.storage, query: "What did we decide about OpenClaw?" });
    expect(result.mutated).toBe(false);

    // 5. Hash again.
    const dirAfter = await fileSha(ctx.storage.paths.directoryFile);
    const chronicleAfter = await fileSha(ctx.storage.paths.chronicleFile);
    const queryRunsAfter = await fileSha(ctx.storage.paths.queryRunsFile);
    const shardsAfter = await dirSha(ctx.storage.paths.shardsDir);
    const snapshotIdsAfter = (await ctx.storage.loadDirectory()).entries.map((e) => ({
      id: e.id,
      snap: e.snapshotId,
    }));
    const eventCountAfter = (
      await ctx.storage.loadSnapshot(
        "thalm-architecture-001",
        snapshotIdsAfter.find((s) => s.id === "thalm-architecture-001")!.snap,
      )
    )!.events.length;
    const snapshotFilesAfter = await ctx.storage.listSnapshotIds("thalm-architecture-001");

    // 6. Assert: durable memory is byte-identical.
    expect(dirAfter).toBe(dirBefore);
    expect(chronicleAfter).toBe(chronicleBefore);
    expect(snapshotIdsAfter).toEqual(snapshotIdsBefore);
    expect(eventCountAfter).toBe(eventCountBefore);
    expect(snapshotFilesAfter).toEqual(snapshotFilesBefore);

    // No new snapshot files anywhere under shards/.
    expect(Object.keys(shardsAfter).sort()).toEqual(Object.keys(shardsBefore).sort());
    for (const k of Object.keys(shardsBefore)) {
      expect(shardsAfter[k]).toBe(shardsBefore[k]);
    }

    // Query-runs.jsonl IS allowed to change (read-only metadata log).
    expect(queryRunsAfter).not.toBe(queryRunsBefore);
  });

  it("storage refuses to overwrite an existing snapshot id", async () => {
    await createShard({
      storage: ctx.storage,
      id: "imm-001",
      name: "Imm",
      description: "Immutability test",
      tags: [],
      systemPrompt: SHARD_SYSTEM_PROMPT,
      summary: "x",
    });
    const snap = await ctx.storage.loadSnapshot("imm-001", "S001");
    await expect(ctx.storage.writeSnapshot(snap!)).rejects.toThrow(/Refusing to overwrite/);
  });

  it("ask with multiple queries appends only to query-runs.jsonl", async () => {
    await createShard({
      storage: ctx.storage,
      id: "q-001",
      name: "Q",
      description: "Q",
      tags: ["q"],
      systemPrompt: SHARD_SYSTEM_PROMPT,
      summary: "x",
    });
    await appendEventAndSnapshot({
      storage: ctx.storage,
      shardId: "q-001",
      event: { role: "user", content: "tag-q content", tags: ["q"] },
      reason: "seed",
      actor: "user",
    });

    const dirBefore = await fileSha(ctx.storage.paths.directoryFile);
    const chronicleBefore = await fileSha(ctx.storage.paths.chronicleFile);
    const provider = new MockProvider();
    await ask({ provider, storage: ctx.storage, query: "q" });
    await ask({ provider, storage: ctx.storage, query: "q again" });
    expect(await fileSha(ctx.storage.paths.directoryFile)).toBe(dirBefore);
    expect(await fileSha(ctx.storage.paths.chronicleFile)).toBe(chronicleBefore);
    const runs = await ctx.storage.readQueryRuns();
    expect(runs.length).toBe(2);
    expect(runs.every((r) => r.mutated === false)).toBe(true);
  });
});
