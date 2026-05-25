import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempStorage } from "./helpers.js";
import { createShard, dryRunCommit, applyCommitDecision } from "../src/core/commit.js";
import { SHARD_SYSTEM_PROMPT } from "../src/core/prompts.js";
import { recommendForFullness, shardHealthReport } from "../src/core/split.js";
import type { CommitDecision, MemoryDirectory } from "../src/core/types.js";

describe("commit protocol skeleton (Phase 2)", () => {
  let ctx: Awaited<ReturnType<typeof makeTempStorage>>;
  beforeEach(async () => {
    ctx = await makeTempStorage();
    await createShard({
      storage: ctx.storage,
      id: "c-001",
      name: "C",
      description: "Commit test",
      tags: ["c"],
      systemPrompt: SHARD_SYSTEM_PROMPT,
      summary: "x",
    });
  });
  afterEach(async () => { await ctx.cleanup(); });

  it("dry-run no_op never mutates", async () => {
    const dec: CommitDecision = {
      action: "no_op",
      targetShardId: "c-001",
      memoryType: "none",
      content: "",
      confidence: 0.5,
      requiresUserConfirmation: false,
      tags: [],
      source: "system_inference",
    };
    const r = await dryRunCommit({ storage: ctx.storage, decision: dec });
    expect(r.wouldMutate).toBe(false);
    const r2 = await applyCommitDecision({ storage: ctx.storage, decision: dec });
    expect(r2.applied).toBe(false);
  });

  it("apply write creates a new snapshot via the same path", async () => {
    const dec: CommitDecision = {
      action: "write",
      targetShardId: "c-001",
      memoryType: "fact",
      content: "Decision: pick option A.",
      confidence: 0.8,
      requiresUserConfirmation: false,
      tags: ["decision"],
      source: "current_conversation",
    };
    const dry = await dryRunCommit({ storage: ctx.storage, decision: dec });
    expect(dry.wouldMutate).toBe(true);

    const before = await ctx.storage.listSnapshotIds("c-001");
    const r = await applyCommitDecision({ storage: ctx.storage, decision: dec });
    expect(r.applied).toBe(true);
    const after = await ctx.storage.listSnapshotIds("c-001");
    expect(after.length).toBe(before.length + 1);

    const chronicle = await ctx.storage.readChronicle();
    const last = chronicle[chronicle.length - 1]!;
    expect(last.actor).toBe("committer");
    expect(last.type).toBe("commit_write");
  });

  it("apply freeze flips status", async () => {
    const dec: CommitDecision = {
      action: "freeze",
      targetShardId: "c-001",
      memoryType: "none",
      content: "",
      confidence: 1,
      requiresUserConfirmation: false,
      tags: [],
      source: "user_confirmation",
    };
    await applyCommitDecision({ storage: ctx.storage, decision: dec });
    const m = await ctx.storage.loadManifest("c-001");
    expect(m?.status).toBe("frozen");
  });
});

describe("split skeleton (Phase 3)", () => {
  it("recommends across thresholds", () => {
    expect(recommendForFullness(10).recommendation).toBe("continue");
    expect(recommendForFullness(60).recommendation).toBe("watch");
    expect(recommendForFullness(70).recommendation).toBe("split_candidate");
    expect(recommendForFullness(80).recommendation).toBe("freeze_recommended");
    expect(recommendForFullness(95).recommendation).toBe("danger_zone");
  });

  it("shardHealthReport tags each entry", () => {
    const dir: MemoryDirectory = {
      version: 1,
      entries: [
        {
          id: "x",
          name: "x",
          description: "",
          tags: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: "active",
          snapshotId: "S001",
          tokenCountEstimate: 0,
          contextLimitEstimate: 100,
          fullnessPct: 80,
          summaryShort: "",
          knownConflicts: [],
          parentId: null,
          children: [],
          trustLevel: "user_memory",
          staleness: "current",
        },
      ],
    };
    const report = shardHealthReport(dir);
    expect(report[0]?.recommendation).toBe("freeze_recommended");
  });
});
