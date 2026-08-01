/**
 * End-to-end ask() against a fake OpenAI-compatible (Ollama-style) server, at
 * the fetch layer — the only place in the suite where prompt BYTES that would
 * hit a real HTTP endpoint are inspected.
 *
 * Probe call shape here is governed by CSM_PROBE_BATCH, whose default became
 * PROVIDER-CLASS DEPENDENT on 2026-08-01: ON for hosted providers, still OFF
 * for "ollama" and "llama-server". `OpenAIProvider` derives `name` from the
 * base URL (localhost ⇒ "ollama"), so the fake server below is local-class by
 * default and hosted-class when constructed with an explicit `providerName`.
 * Both halves of that split are pinned, plus the legacy unbatched pipeline
 * under an EXPLICIT CSM_PROBE_BATCH=0 so it stays pinned regardless of which
 * way any future default moves.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempStorage } from "./helpers.js";
import { seedFixtures } from "../src/eval/fixtures.js";
import { ask, resolveProbeBatch } from "../src/core/ask.js";
import { OpenAIProvider } from "../src/providers/OpenAIProvider.js";

/** Which pipeline stage the fake server decided a given call belongs to. Declared
 *  once here — `makeFakeProvider` and every `history` array below reference this
 *  alias rather than repeating the union, so a stage rename can't drift between
 *  the producer and the assertions that filter on it. */
type FakeStage = "probe" | "probe-batch" | "recall" | "synth" | "unknown";

/** One recorded call to the fake server. */
type FakeCall = { system: string; prompt: string; stage: FakeStage };

/** "Knowledge" gated by query terms vs shard id, so only the right shard says
 *  knows=true. Shared by the solo and the batched probe branch, so the two arms
 *  are semantically identical and the CALL SHAPE is the only thing that differs
 *  between them — which is what makes the batched-vs-unbatched comparisons below
 *  meaningful. */
function shardKnows(query: string, shardId: string): boolean {
  const q = query.toLowerCase();
  const knowsThalm = /thalm|openclaw/.test(q) && /thalm/.test(shardId);
  const knowsMusic = /headphone|sundara|music/.test(q) && /music/.test(shardId);
  const knowsAdmin = /passport|renewal|admin/.test(q) && /admin/.test(shardId);
  return knowsThalm || knowsMusic || knowsAdmin;
}

/** The probe verdict body, minus `shard_id` (solo probes don't carry one). */
function probeVerdict(knows: boolean): Record<string, unknown> {
  return {
    knows,
    confidence: knows ? 0.9 : 0.05,
    memory_type: knows ? "direct" : "none",
    estimated_answer_value: knows ? "high" : "none",
    needs_full_recall: knows,
    relevant_event_ids: knows ? ["e_0001"] : [],
  };
}

describe("ask pipeline against a fake OpenAI-compatible (Ollama-style) server", () => {
  let ctx: Awaited<ReturnType<typeof makeTempStorage>>;
  beforeEach(async () => {
    ctx = await makeTempStorage();
    await seedFixtures(ctx.storage);
  });
  afterEach(async () => {
    delete process.env.CSM_PROBE_BATCH;
    await ctx.cleanup();
  });

  /** `providerName` left undefined ⇒ `OpenAIProvider` derives "ollama" from the
   *  localhost base URL (local provider class). Pass "openai" to label the very
   *  same fake server hosted, which is how the provider-class half of the
   *  CSM_PROBE_BATCH default is exercised without a second fake server. */
  function makeFakeProvider(history: FakeCall[], providerName?: string) {
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const system = body.messages?.[0]?.content ?? "";
      const userPrompt = body.messages?.[1]?.content ?? "";

      // Stage detection — synth has its own system; the batched probe is the
      // only prompt carrying "Shard ids, in order:" and must be matched BEFORE
      // the solo probe (it also contains `relevant_event_ids`); then probe vs
      // recall by JSON skeleton.
      let stage: FakeStage = "unknown";
      if (/memory synthesizer/i.test(system)) stage = "synth";
      else if (/Shard ids, in order:/.test(userPrompt)) stage = "probe-batch";
      else if (/relevant_event_ids/.test(userPrompt)) stage = "probe";
      else if (/answer using only this shard snapshot/i.test(userPrompt)) stage = "recall";
      history.push({ system, prompt: userPrompt, stage });

      const queryMatch = userPrompt.match(/(?:User question:|Question:)\s*(.+)/);
      const query = (queryMatch?.[1] ?? "").trim();
      const shardMatch = system.match(/\[Shard (\S+?)@(\S+?)\]/);
      const shardId = shardMatch?.[1] ?? "";
      const snapshotId = shardMatch?.[2] ?? "";

      let content = "{}";
      if (stage === "probe") {
        content = JSON.stringify(probeVerdict(shardKnows(query, shardId)));
      } else if (stage === "probe-batch") {
        // The batched system prompt stacks one `[Shard X@Y]` block per shard;
        // answer for every one of them through the same gate the solo branch
        // uses. (Reconciliation of missing/extra/duplicate ids is pinned in
        // tests/batchedProbe.test.ts; here the server is well-behaved so the
        // comparison against the unbatched arm isolates call shape.)
        const ids = [...system.matchAll(/\[Shard (\S+?)@(\S+?)\]/g)].map((m) => m[1]!);
        content = JSON.stringify({
          verdicts: ids.map((id) => ({ shard_id: id, ...probeVerdict(shardKnows(query, id)) })),
        });
      } else if (stage === "recall") {
        content = JSON.stringify({
          shard_id: shardId,
          snapshot_id: snapshotId,
          confidence: 0.85,
          answer: `OpenClaw was discussed as Thalm's shell/control plane in ${shardId}.`,
          claims: [
            {
              claim: "OpenClaw is a candidate shell/control plane for Thalm.",
              support: ["e_0001"],
              confidence: 0.85,
            },
          ],
          unknowns: [],
          conflicts: [],
        });
      } else if (stage === "synth") {
        content = JSON.stringify({
          query,
          summary: "Synth summary from fake server.",
          key_claims: [
            { claim: "synth claim", sources: ["x@S001:e_0001"], confidence: 0.8 },
          ],
          caveats: [],
          conflicts: [],
          recommended_main_context: "fake recommended context",
        });
      }

      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content } }],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    return new OpenAIProvider({
      baseURL: "http://localhost:11434/v1",
      apiKey: "ollama",
      defaultModel: "gemma4:31b",
      fetchImpl,
      providerName,
    });
  }

  describe("with CSM_PROBE_BATCH explicitly off (one probe call per shard)", () => {
    // These four pinned the pipeline back when CSM_PROBE_BATCH defaulted OFF
    // for every provider, so an unset env var was enough to reach the unbatched
    // shape. Since 2026-08-01 an unset var means "off for ollama/llama-server,
    // ON for hosted", so the unbatched shape is now reached EXPLICITLY. The
    // assertions are unchanged — only the way the configuration is selected is.
    beforeEach(() => {
      process.env.CSM_PROBE_BATCH = "0";
    });

    it("runs end-to-end through fetch and never sees the MOCK_RESULT fence", async () => {
      const history: FakeCall[] = [];
      const provider = makeFakeProvider(history);
      const result = await ask({
        provider,
        storage: ctx.storage,
        query: "What did we decide about OpenClaw and Thalm?",
      });

      expect(result.mutated).toBe(false);
      expect(result.candidates[0]?.entry.id).toBe("thalm-architecture-001");
      expect(result.recalls.length).toBeGreaterThanOrEqual(1);

      // Critical: the mock-fence must NOT leak into real-provider prompts.
      for (const h of history) {
        expect(h.prompt).not.toContain("<<MOCK_RESULT>>");
        expect(h.system).not.toContain("<<MOCK_RESULT>>");
      }

      // Probe was called per probed shard. Recall was called once for Thalm.
      const probeCount = history.filter((h) => h.stage === "probe").length;
      const recallCount = history.filter((h) => h.stage === "recall").length;
      expect(probeCount).toBeGreaterThanOrEqual(1);
      expect(recallCount).toBe(1);
      // ...and "per probed shard" means EXACTLY that with batching off: one solo
      // call per probe result, no batched call at all. (Without this the arm
      // would also pass under batching, where one solo call still satisfies ≥1.)
      expect(probeCount).toBe(result.probes.length);
      expect(history.filter((h) => h.stage === "probe-batch")).toHaveLength(0);

      expect(result.cost.inputTokensEstimate).toBeGreaterThan(0);
      expect(result.cost.outputTokensEstimate).toBeGreaterThan(0);
    });

    it("skips the synthesizer LLM call when only one shard recalls (efficiency win)", async () => {
      const history: FakeCall[] = [];
      const provider = makeFakeProvider(history);
      await ask({
        provider,
        storage: ctx.storage,
        query: "What did we decide about OpenClaw and Thalm?",
      });
      const synthCalls = history.filter((h) => h.stage === "synth");
      expect(synthCalls.length).toBe(0);
    });

    it("calls the synthesizer when ≥2 shards recall", async () => {
      const history: FakeCall[] = [];
      const provider = makeFakeProvider(history);
      // This query intentionally hits Thalm AND admin (uses "thalm" + "passport").
      await ask({
        provider,
        storage: ctx.storage,
        query: "thalm passport renewal openclaw",
      });
      const recalls = history.filter((h) => h.stage === "recall").length;
      const synthCalls = history.filter((h) => h.stage === "synth").length;
      expect(recalls).toBeGreaterThanOrEqual(2);
      expect(synthCalls).toBe(1);
    });

    it("scopes recall context to probe-identified events", async () => {
      const history: FakeCall[] = [];
      const provider = makeFakeProvider(history);
      await ask({
        provider,
        storage: ctx.storage,
        query: "What did we decide about OpenClaw and Thalm?",
      });
      const recall = history.find((h) => h.stage === "recall");
      expect(recall).toBeDefined();
      // Probe's relevant_event_ids was ["e_0001"]. Recall's Events block should include e_0001
      // and NOT include other event ids from the same shard.
      expect(recall!.system).toMatch(/\[e_0001\]/);
    });
  });

  describe("with CSM_PROBE_BATCH unset (2026-08-01 provider-class default)", () => {
    // The default is a deny-list on provider CLASS, not a single global boolean:
    // batching is ON except for "ollama" and "llama-server". The evidence
    // (−21% internal input at no measurable score cost) came from one hosted
    // model family, and a batched prompt asks a model to judge shards in one
    // pass — a harder task a 4B-class local model may do worse. Both sides of
    // that split are pinned here, through real fetch, on the same fake server.
    //
    // "Unset" has to be enforced, not assumed: a shell that exports
    // CSM_PROBE_BATCH would otherwise turn these into a test of the override.
    beforeEach(() => {
      delete process.env.CSM_PROBE_BATCH;
    });

    it("keeps the solo per-shard probe on a local (Ollama-style) provider", async () => {
      const history: FakeCall[] = [];
      const provider = makeFakeProvider(history);
      // Name is derived from the localhost base URL — nothing sets it here.
      expect(provider.name).toBe("ollama");
      expect(resolveProbeBatch(provider.name)).toBe(false);

      const result = await ask({
        provider,
        storage: ctx.storage,
        query: "What did we decide about OpenClaw and Thalm?",
      });

      expect(history.filter((h) => h.stage === "probe-batch")).toHaveLength(0);
      expect(history.filter((h) => h.stage === "probe")).toHaveLength(result.probes.length);
      expect(result.probes.length).toBeGreaterThan(2);
    });

    it("batches shards 2..N into ONE call on a hosted provider, top-1 still solo", async () => {
      const history: FakeCall[] = [];
      // Same fake server, relabelled hosted: the split is decided by provider
      // class, not by the endpoint the bytes actually go to.
      const provider = makeFakeProvider(history, "openai");
      expect(resolveProbeBatch(provider.name)).toBe(true);

      const result = await ask({
        provider,
        storage: ctx.storage,
        query: "What did we decide about OpenClaw and Thalm?",
      });

      const solo = history.filter((h) => h.stage === "probe");
      const batched = history.filter((h) => h.stage === "probe-batch");
      // Top-1 stays solo so the speculative recall can start on its verdict;
      // every other candidate is classified in a single extra call.
      expect(solo).toHaveLength(1);
      expect(batched).toHaveLength(1);
      // Probe COUNT is preserved by reconciliation — batching changes calls, not
      // witnesses. Same claim the paired gate (r1mJ vs r1mI2) held at 8.00.
      expect(result.probes).toHaveLength(result.candidates.length);
      expect(result.probes.length).toBeGreaterThan(2);
      // The batch carries exactly the non-top-1 candidates, in router order.
      const batchedShardIds = [...batched[0]!.system.matchAll(/\[Shard (\S+?)@/g)].map(
        (m) => m[1],
      );
      expect(batchedShardIds).toEqual(result.candidates.slice(1).map((c) => c.entry.id));

      // The batched prompt has its OWN mock-fence branch in probe.ts; it must be
      // stripped for real providers exactly like the solo one.
      for (const h of history) {
        expect(h.prompt).not.toContain("<<MOCK_RESULT>>");
        expect(h.system).not.toContain("<<MOCK_RESULT>>");
      }

      // Answer shape is unchanged vs the explicit-off arm above: same top
      // candidate, same single recall, still no synthesizer call.
      expect(result.mutated).toBe(false);
      expect(result.candidates[0]?.entry.id).toBe("thalm-architecture-001");
      expect(history.filter((h) => h.stage === "recall")).toHaveLength(1);
      expect(history.filter((h) => h.stage === "synth")).toHaveLength(0);
      expect(result.cost.inputTokensEstimate).toBeGreaterThan(0);
      expect(result.cost.outputTokensEstimate).toBeGreaterThan(0);
    });

    it("still reaches the synthesizer when ≥2 shards recall, batched or not", async () => {
      // Same query as the explicit-off arm ("thalm" + "passport" hits Thalm AND
      // admin). A shard that only ever appears inside the batch must still be
      // able to win a recall slot, or batching would silently drop witnesses.
      const history: FakeCall[] = [];
      const provider = makeFakeProvider(history, "openai");
      await ask({
        provider,
        storage: ctx.storage,
        query: "thalm passport renewal openclaw",
      });
      expect(history.filter((h) => h.stage === "probe-batch")).toHaveLength(1);
      expect(history.filter((h) => h.stage === "recall").length).toBeGreaterThanOrEqual(2);
      expect(history.filter((h) => h.stage === "synth")).toHaveLength(1);
    });
  });
});
