import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempStorage } from "./helpers.js";
import { appendEventAndSnapshot, createShard, dryRunCommit, applyCommitDecision } from "../src/core/commit.js";
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

describe("commit protocol — audit 2026-09-05 fixes", () => {
  let ctx: Awaited<ReturnType<typeof makeTempStorage>>;
  const base = (): CommitDecision => ({
    action: "no_op",
    targetShardId: "c-001",
    memoryType: "fact",
    content: "",
    confidence: 0.7,
    requiresUserConfirmation: false,
    tags: [],
    source: "user_confirmation",
  });
  beforeEach(async () => {
    ctx = await makeTempStorage();
    await createShard({
      storage: ctx.storage,
      id: "c-001",
      name: "C",
      description: "Commit audit test",
      tags: ["c"],
      systemPrompt: SHARD_SYSTEM_PROMPT,
      summary: "x",
    });
  });
  afterEach(async () => { await ctx.cleanup(); });

  it("dry-run reports wouldMutate:false for unimplemented actions, and apply agrees", async () => {
    const unimplemented: CommitDecision["action"][] = ["split", "merge", "ask_confirmation"];
    for (const action of unimplemented) {
      const dec = { ...base(), action };
      const dry = await dryRunCommit({ storage: ctx.storage, decision: dec });
      expect(dry.wouldMutate, action).toBe(false);
      expect(dry.chronicleType, action).toBe("none");
      const applied = await applyCommitDecision({ storage: ctx.storage, decision: dec });
      expect(applied.applied, action).toBe(false);
    }
    // and an unrecognised action string is treated the same way, not as a mutation
    const bogus = { ...base(), action: "bogus" as unknown as CommitDecision["action"] };
    expect((await dryRunCommit({ storage: ctx.storage, decision: bogus })).wouldMutate).toBe(false);
  });

  it("apply refuses a decision that requiresUserConfirmation unless confirmed:true", async () => {
    const dec: CommitDecision = { ...base(), action: "write", content: "needs a human", requiresUserConfirmation: true };
    const before = (await ctx.storage.loadManifest("c-001"))!.latestSnapshotId;
    const refused = await applyCommitDecision({ storage: ctx.storage, decision: dec });
    expect(refused.applied).toBe(false);
    expect(refused.description).toMatch(/requires user confirmation/i);
    expect((await ctx.storage.loadManifest("c-001"))!.latestSnapshotId).toBe(before);

    const ok = await applyCommitDecision({ storage: ctx.storage, decision: dec, confirmed: true });
    expect(ok.applied).toBe(true);
    expect((await ctx.storage.loadManifest("c-001"))!.latestSnapshotId).not.toBe(before);
  });

  it("an orphan snapshot left by a crashed append is diagnosed with a recovery path, not a bare overwrite refusal", async () => {
    const manifest = (await ctx.storage.loadManifest("c-001"))!;
    const prev = (await ctx.storage.loadSnapshot("c-001", manifest.latestSnapshotId))!;
    expect(manifest.latestSnapshotId).toBe("S001");
    // Simulate a previous append that wrote S002 and died before saveManifest.
    await ctx.storage.writeSnapshot({ ...prev, snapshotId: "S002", parentSnapshotId: "S001" });
    await expect(
      appendEventAndSnapshot({
        storage: ctx.storage,
        shardId: "c-001",
        event: { role: "user", content: "after the crash" },
        reason: "test",
        actor: "user",
        chronicleType: "commit_write",
      }),
    ).rejects.toThrow(/Orphan snapshot c-001\/S002 .*not in the manifest.*Recovery/);
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
