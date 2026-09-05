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

  it("carries the router's and recall's select() reports onto the result and the query-run record (invariant 4)", async () => {
    const provider = new MockProvider();
    const q1 = "What did we decide about OpenClaw and Thalm?";
    const q2 = "what colour is the moon today";
    const r1 = await ask({ provider, storage: ctx.storage, query: q1 });
    const r2 = await ask({ provider, storage: ctx.storage, query: q2 });
    for (const r of [r1, r2]) {
      // The report used to be computed by select() and dropped before it reached anyone.
      expect(r.selection.router.path).toBe("lexical");
      expect(typeof r.selection.router.discriminated).toBe("boolean");
      expect(r.selection.router.totalCandidates).toBeGreaterThan(0);
      expect(typeof r.selection.recall.discriminated).toBe("boolean");
    }
    const runs = await ctx.storage.readQueryRuns();
    const rec1 = runs.find((r) => r.query === q1)!;
    const rec2 = runs.find((r) => r.query === q2)!;
    expect(rec1).toBeDefined();
    expect(rec2).toBeDefined();
    for (const [rec, res] of [[rec1, r1], [rec2, r2]] as const) {
      expect(rec.routerDiscriminated).toBe(res.selection.router.discriminated);
      expect(rec.recallDiscriminated).toBe(res.selection.recall.discriminated);
      // A degenerate cut is NAMED in the record; a clean one leaves no entry.
      expect(rec.degenerate.some((d) => d.startsWith("router:"))).toBe(!res.selection.router.discriminated);
      expect(rec.degenerate.some((d) => d.startsWith("recall:"))).toBe(!res.selection.recall.discriminated);
    }
  });
});
