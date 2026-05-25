import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempStorage } from "./helpers.js";
import { seedFixtures } from "../src/eval/fixtures.js";
import { ask } from "../src/core/ask.js";
import { MockProvider } from "../src/providers/MockProvider.js";

describe("ask pipeline", () => {
  let ctx: Awaited<ReturnType<typeof makeTempStorage>>;
  beforeEach(async () => {
    ctx = await makeTempStorage();
    await seedFixtures(ctx.storage);
  });
  afterEach(async () => { await ctx.cleanup(); });

  it("returns a memory packet about OpenClaw with citations", async () => {
    const provider = new MockProvider();
    const result = await ask({ provider, storage: ctx.storage, query: "What did we decide about OpenClaw and Thalm?" });

    expect(result.mutated).toBe(false);
    expect(result.memoryPacket.query).toContain("OpenClaw");
    expect(result.candidates[0]?.entry.id).toBe("thalm-architecture-001");

    const probedThalm = result.probes.find((p) => p.shardId === "thalm-architecture-001");
    expect(probedThalm).toBeDefined();
    expect(probedThalm?.knows).toBe(true);
    expect(probedThalm?.needsFullRecall).toBe(true);

    const recallThalm = result.recalls.find((r) => r.shardId === "thalm-architecture-001");
    expect(recallThalm).toBeDefined();
    expect(recallThalm!.claims.length).toBeGreaterThan(0);
    for (const c of recallThalm!.claims) {
      // Every claim must cite at least one event ID.
      expect(c.support.length).toBeGreaterThan(0);
    }

    const packetText = [
      result.memoryPacket.summary,
      result.memoryPacket.recommendedMainContext,
      ...result.memoryPacket.keyClaims.map((k) => k.claim),
    ].join(" ").toLowerCase();
    expect(packetText).toContain("openclaw");
    expect(packetText).toContain("shell");

    // Sources should reference shard@snapshot:event
    const sourceTags = result.memoryPacket.keyClaims.flatMap((k) => k.sources);
    expect(sourceTags.some((s) => s.startsWith("thalm-architecture-001@"))).toBe(true);
  });

  it("returns no relevant claims when no shard matches", async () => {
    const provider = new MockProvider();
    const result = await ask({ provider, storage: ctx.storage, query: "what colour is the moon today" });
    // We tolerate no key claims; mutation must still be false.
    expect(result.mutated).toBe(false);
  });
});
