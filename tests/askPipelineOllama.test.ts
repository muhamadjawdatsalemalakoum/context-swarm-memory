import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempStorage } from "./helpers.js";
import { seedFixtures } from "../src/eval/fixtures.js";
import { ask } from "../src/core/ask.js";
import { OpenAIProvider } from "../src/providers/OpenAIProvider.js";

describe("ask pipeline against a fake OpenAI-compatible (Ollama-style) server", () => {
  let ctx: Awaited<ReturnType<typeof makeTempStorage>>;
  beforeEach(async () => {
    ctx = await makeTempStorage();
    await seedFixtures(ctx.storage);
  });
  afterEach(async () => { await ctx.cleanup(); });

  function makeFakeProvider(history: Array<{ system: string; prompt: string; stage: "probe" | "recall" | "synth" | "unknown" }>) {
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const system = body.messages?.[0]?.content ?? "";
      const userPrompt = body.messages?.[1]?.content ?? "";

      // Stage detection — synth has its own system; probe vs recall by JSON skeleton.
      let stage: "probe" | "recall" | "synth" | "unknown" = "unknown";
      if (/memory synthesizer/i.test(system)) stage = "synth";
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
        // "Knowledge" gated by query terms vs shard id, so only the right shard says knows=true.
        const q = query.toLowerCase();
        const knowsThalm = /thalm|openclaw/.test(q) && /thalm/.test(shardId);
        const knowsMusic = /headphone|sundara|music/.test(q) && /music/.test(shardId);
        const knowsAdmin = /passport|renewal|admin/.test(q) && /admin/.test(shardId);
        const knows = knowsThalm || knowsMusic || knowsAdmin;
        content = JSON.stringify({
          knows,
          confidence: knows ? 0.9 : 0.05,
          memory_type: knows ? "direct" : "none",
          estimated_answer_value: knows ? "high" : "none",
          needs_full_recall: knows,
          relevant_event_ids: knows ? ["e_0001"] : [],
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
    });
  }

  it("runs end-to-end through fetch and never sees the MOCK_RESULT fence", async () => {
    const history: Array<{ system: string; prompt: string; stage: string }> = [];
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

    expect(result.cost.inputTokensEstimate).toBeGreaterThan(0);
    expect(result.cost.outputTokensEstimate).toBeGreaterThan(0);
  });

  it("skips the synthesizer LLM call when only one shard recalls (efficiency win)", async () => {
    const history: Array<{ system: string; prompt: string; stage: string }> = [];
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
    const history: Array<{ system: string; prompt: string; stage: string }> = [];
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
    const history: Array<{ system: string; prompt: string; stage: string }> = [];
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
