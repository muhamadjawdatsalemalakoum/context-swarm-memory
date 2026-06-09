import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { makeTempStorage } from "./helpers.js";
import { appendEventAndSnapshot, createShard } from "../src/core/commit.js";
import { ask } from "../src/core/ask.js";
import { SHARD_SYSTEM_PROMPT } from "../src/core/prompts.js";
import { MockProvider } from "../src/providers/MockProvider.js";

/**
 * T1 coverage — mutation-safety under CSM_COVERAGE=1 (the hash pattern from
 * tests/mutationSafety.test.ts). The coverage path consumes already-loaded
 * snapshots and builds a packet timeline in memory; durable memory must stay
 * byte-identical and only query-runs.jsonl may grow.
 */

function sha(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function fileSha(path: string): Promise<string | null> {
  try {
    return sha(await fs.readFile(path));
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

describe("coverage mode: csm ask must not alter durable memory", () => {
  let ctx: Awaited<ReturnType<typeof makeTempStorage>>;
  let savedCoverage: string | undefined;

  beforeEach(async () => {
    ctx = await makeTempStorage();
    savedCoverage = process.env.CSM_COVERAGE;
    process.env.CSM_COVERAGE = "1";
  });

  afterEach(async () => {
    if (savedCoverage === undefined) delete process.env.CSM_COVERAGE;
    else process.env.CSM_COVERAGE = savedCoverage;
    await ctx.cleanup();
  });

  it("coverage-shaped ask attaches a timeline and leaves durable memory byte-identical", async () => {
    await createShard({
      storage: ctx.storage,
      id: "gw-001",
      name: "Gateway decisions",
      description: "payment gateway rollout decisions",
      tags: ["gateway", "payments"],
      systemPrompt: SHARD_SYSTEM_PROMPT,
      summary: "Gateway rollout decisions and incidents.",
    });
    for (let i = 0; i < 4; i++) {
      await appendEventAndSnapshot({
        storage: ctx.storage,
        shardId: "gw-001",
        event: {
          role: "user",
          content: `Gateway decision ${i + 1}: rollout step about settlement and routing.`,
          tags: ["gateway"],
        },
        reason: "seed",
        actor: "user",
      });
    }

    const dirBefore = await fileSha(ctx.storage.paths.directoryFile);
    const chronicleBefore = await fileSha(ctx.storage.paths.chronicleFile);
    const shardsBefore = await dirSha(ctx.storage.paths.shardsDir);
    const queryRunsBefore = await fileSha(ctx.storage.paths.queryRunsFile);

    const result = await ask({
      provider: new MockProvider(),
      storage: ctx.storage,
      query: "Summarize everything we decided about the gateway.",
    });

    expect(result.mutated).toBe(false);
    // Coverage actually fired (this is the wired demonstration, not a skip).
    expect(result.memoryPacket.timeline).toBeDefined();
    expect(result.memoryPacket.timeline!.length).toBeGreaterThan(0);

    // Durable memory byte-identical; only query-runs.jsonl may change.
    expect(await fileSha(ctx.storage.paths.directoryFile)).toBe(dirBefore);
    expect(await fileSha(ctx.storage.paths.chronicleFile)).toBe(chronicleBefore);
    const shardsAfter = await dirSha(ctx.storage.paths.shardsDir);
    expect(Object.keys(shardsAfter).sort()).toEqual(Object.keys(shardsBefore).sort());
    for (const k of Object.keys(shardsBefore)) {
      expect(shardsAfter[k]).toBe(shardsBefore[k]);
    }
    expect(await fileSha(ctx.storage.paths.queryRunsFile)).not.toBe(queryRunsBefore);
  });
});
