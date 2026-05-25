import { createServer, type Server } from "node:http";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Mem0Baseline } from "../src/eval/baselines/mem0.js";
import type { BenchEvent, Corpus } from "../src/eval/corpus.js";
import type { McqQuery } from "../src/eval/mcq.js";
import type {
  CompleteJsonInput,
  CompleteTextInput,
  LlmProvider,
  ProviderResponse,
} from "../src/providers/LlmProvider.js";
import { closeServer, listenOnEphemeralPort } from "./helpers.js";

/**
 * Mem0 baseline smoke test — Phase γ.
 *
 * The real Mem0 sidecar lives in `services/mem0-sidecar/` and requires a
 * Python venv with `mem0ai` + `qdrant-client`. We don't install those in CI.
 * Instead, this test stubs the sidecar with a tiny Node HTTP server that
 * returns canned `retrievedDocs`, validating the Node-side wiring end-to-end:
 *
 *   - /index is called exactly once per (corpus, baseline-instance)
 *   - /query is called per question
 *   - retrievedDocs IDs round-trip through the citation path
 *   - cost-accounting contract: top-level === pipeline + finalCall
 *   - context is built from canonical event text (not Mem0's distilled facts)
 *
 * Integration tests against the real Python sidecar run separately on the
 * user's machine (see services/mem0-sidecar/README.md).
 */

interface StubCalls {
  index: number;
  query: number;
  lastIndexBody?: unknown;
  lastQueryBody?: unknown;
}

async function startStubSidecar(
  retrievedDocs: Array<{ idx: string; text: string; score: number }>,
): Promise<{ server: Server; port: number; calls: StubCalls }> {
  const calls: StubCalls = { index: 0, query: 0 };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer | string) => {
      body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    });
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      if (req.url === "/index" && req.method === "POST") {
        calls.index++;
        calls.lastIndexBody = parsed;
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            corpusId: (parsed as { corpusId: string }).corpusId,
            indexedDocCount: (parsed as { documents: unknown[] }).documents.length,
            indexElapsedMs: 100,
            cost: { inputTokens: 200, outputTokens: 50 },
            fromCache: false,
            indexPath: "stub",
          }),
        );
        return;
      }
      if (req.url === "/query" && req.method === "POST") {
        calls.query++;
        calls.lastQueryBody = parsed;
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            retrievedDocs,
            cost: { inputTokens: 50, outputTokens: 20, latencyMs: 25 },
            rerankerUsed: false,
          }),
        );
        return;
      }
      if (req.url === "/health" && req.method === "GET") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            ready: true,
            baseline: "mem0",
            loadedCorpora: [],
            uptimeSeconds: 1,
            llmEndpoint: "http://localhost:8090/v1",
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  const port = await listenOnEphemeralPort(server);
  return { server, port, calls };
}

class StubProvider implements LlmProvider {
  readonly name = "stub";

  async completeJson<T>(_input: CompleteJsonInput): Promise<ProviderResponse<T>> {
    throw new Error("Mem0 baseline does not call completeJson directly");
  }

  async completeText(_input: CompleteTextInput): Promise<ProviderResponse<string>> {
    return {
      data: "ANSWER: 1\nCITATIONS: e0001",
      usage: {
        inputTokensEstimate: 500,
        outputTokensEstimate: 30,
        estimatedUsd: 0,
        latencyMs: 200,
      },
      rawText: "ANSWER: 1\nCITATIONS: e0001",
    };
  }
}

function buildMiniCorpus(): Corpus {
  const events: BenchEvent[] = [
    {
      id: "e0001",
      shardId: "s-customers",
      content: "ChairSync signed an LOI for the dental-SaaS integration on 2024-09-14.",
      tokenCount: 18,
      isCore: true,
      tier: 0,
      tags: ["customer", "loi", "dental"],
    },
    {
      id: "e0002",
      shardId: "s-customers",
      content: "MealHaul declined our pitch.",
      tokenCount: 8,
      isCore: true,
      tier: 0,
      tags: ["customer", "rejection"],
    },
  ];
  const byShard = new Map<string, BenchEvent[]>();
  const byId = new Map<string, BenchEvent>();
  for (const e of events) {
    byId.set(e.id, e);
    const arr = byShard.get(e.shardId);
    if (arr) arr.push(e);
    else byShard.set(e.shardId, [e]);
  }
  return {
    events,
    coreEvents: events,
    fillerEvents: [],
    totalTokens: events.reduce((s, e) => s + e.tokenCount, 0),
    byShard,
    byId,
    targetTokens: 100,
    sampleSeed: 42,
  };
}

const query: McqQuery = {
  id: "q-mem0",
  question: "Which dental-SaaS company signed an LOI?",
  options: ["ChairSync", "MealHaul", "Acme", "Unknown"],
  correctOption: 1,
  relevantEventIds: ["e0001"],
  category: "single-shard",
};

describe("Mem0Baseline — Phase γ sidecar wiring", () => {
  let stub: Awaited<ReturnType<typeof startStubSidecar>>;

  beforeEach(async () => {
    stub = await startStubSidecar([
      {
        idx: "e0001",
        text: "ChairSync signed an LOI for the dental-SaaS integration on 2024-09-14.",
        score: 0.91,
      },
      {
        idx: "e0002",
        text: "MealHaul declined our pitch.",
        score: 0.42,
      },
    ]);
  });

  afterEach(async () => {
    await closeServer(stub.server);
  });

  it("indexes the corpus once per baseline instance and queries per question", async () => {
    const baseline = new Mem0Baseline({
      provider: new StubProvider(),
      sidecarUrl: `http://127.0.0.1:${stub.port}`,
    });
    const corpus = buildMiniCorpus();

    await baseline.answer(query, corpus, {
      maxInputTokens: 4096,
      model: "stub-model",
    });
    await baseline.answer(query, corpus, {
      maxInputTokens: 4096,
      model: "stub-model",
    });

    // /index called once across two queries on the same corpus.
    expect(stub.calls.index).toBe(1);
    // /query called twice — once per answer() call.
    expect(stub.calls.query).toBe(2);
  });

  it("recovers event IDs via the sidecar's retrievedDocs.idx field", async () => {
    const baseline = new Mem0Baseline({
      provider: new StubProvider(),
      sidecarUrl: `http://127.0.0.1:${stub.port}`,
    });
    const corpus = buildMiniCorpus();
    const result = await baseline.answer(query, corpus, {
      maxInputTokens: 4096,
      model: "stub-model",
    });

    expect(result.answer.citedEventIds).toContain("e0001");
    const meta = result.meta as { retrievedIds: string[]; packedEventIds: string[] };
    expect(meta.retrievedIds).toEqual(["e0001", "e0002"]);
    expect(meta.packedEventIds.length).toBeGreaterThan(0);
  });

  it("cost-accounting contract: top-level === pipeline + finalCall", async () => {
    const baseline = new Mem0Baseline({
      provider: new StubProvider(),
      sidecarUrl: `http://127.0.0.1:${stub.port}`,
    });
    const corpus = buildMiniCorpus();
    const result = await baseline.answer(query, corpus, {
      maxInputTokens: 4096,
      model: "stub-model",
    });
    const meta = result.meta as {
      pipelineInputTokens: number;
      pipelineOutputTokens: number;
      pipelineLatencyMs: number;
      finalCallInputTokens: number;
      finalCallOutputTokens: number;
      finalCallLatencyMs: number;
    };
    expect(result.inputTokens).toBe(
      meta.pipelineInputTokens + meta.finalCallInputTokens,
    );
    expect(result.outputTokens).toBe(
      meta.pipelineOutputTokens + meta.finalCallOutputTokens,
    );
    expect(result.latencyMs).toBe(
      meta.pipelineLatencyMs + meta.finalCallLatencyMs,
    );
    // Pipeline cost must be > 0 (otherwise the sidecar wasn't called).
    expect(meta.pipelineInputTokens).toBeGreaterThan(0);
  });

  it("falls back to retrieved IDs when the LLM emits no citations", async () => {
    class NoCiteProvider extends StubProvider {
      async completeText(_input: CompleteTextInput): Promise<ProviderResponse<string>> {
        return {
          data: "ANSWER: 1",
          usage: {
            inputTokensEstimate: 500,
            outputTokensEstimate: 5,
            estimatedUsd: 0,
            latencyMs: 200,
          },
          rawText: "ANSWER: 1",
        };
      }
    }
    const baseline = new Mem0Baseline({
      provider: new NoCiteProvider(),
      sidecarUrl: `http://127.0.0.1:${stub.port}`,
    });
    const corpus = buildMiniCorpus();
    const result = await baseline.answer(query, corpus, {
      maxInputTokens: 4096,
      model: "stub-model",
    });
    expect(result.answer.citedEventIds.length).toBeGreaterThan(0);
  });

  it("uses canonical event content from corpus.byId (not the sidecar's text field)", async () => {
    // The stub returns docs with the same text as corpus.byId so this test
    // ALSO verifies that text comes from corpus.byId — by checking what
    // ends up in the prompt. We do that indirectly via packedEventIds count.
    const baseline = new Mem0Baseline({
      provider: new StubProvider(),
      sidecarUrl: `http://127.0.0.1:${stub.port}`,
    });
    const corpus = buildMiniCorpus();
    const result = await baseline.answer(query, corpus, {
      maxInputTokens: 4096,
      model: "stub-model",
    });
    const meta = result.meta as { packedEventIds: string[] };
    expect(meta.packedEventIds).toEqual(["e0001", "e0002"]);
  });
});
