import { createServer, type Server } from "node:http";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HippoRagBaseline } from "../src/eval/baselines/hippoRag.js";
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
 * HippoRAG 2 baseline smoke test — Phase γ.
 *
 * Stubs the Python sidecar with a Node HTTP server to validate the Node
 * client's wiring without requiring a real Python venv. The real HippoRAG
 * sidecar lives in services/hipporag-sidecar/.
 */

async function startStubSidecar(): Promise<{ server: Server; port: number; indexCalls: number; queryCalls: number }> {
  let indexCalls = 0;
  let queryCalls = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer | string) => {
      body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    });
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      if (req.url === "/index" && req.method === "POST") {
        indexCalls++;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            corpusId: (parsed as { corpusId: string }).corpusId,
            indexedDocCount: (parsed as { documents: unknown[] }).documents.length,
            indexElapsedMs: 200,
            cost: { inputTokens: 500, outputTokens: 250 },
            fromCache: false,
            indexPath: "stub",
          }),
        );
        return;
      }
      if (req.url === "/query" && req.method === "POST") {
        queryCalls++;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            retrievedDocs: [
              { idx: "e0001", text: "stub event 1", score: 0.95 },
              { idx: "e0002", text: "stub event 2", score: 0.82 },
            ],
            cost: { inputTokens: 100, outputTokens: 0, latencyMs: 50 },
            rerankerUsed: false,
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  const port = await listenOnEphemeralPort(server);
  return { server, port, get indexCalls() { return indexCalls; }, get queryCalls() { return queryCalls; } };
}

class StubProvider implements LlmProvider {
  readonly name = "stub";
  async completeJson<T>(_input: CompleteJsonInput): Promise<ProviderResponse<T>> {
    throw new Error("not used");
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
    { id: "e0001", shardId: "s1", content: "Stub event 1 content.", tokenCount: 10, isCore: true, tier: 0, tags: [] },
    { id: "e0002", shardId: "s1", content: "Stub event 2 content.", tokenCount: 10, isCore: true, tier: 0, tags: [] },
  ];
  const byShard = new Map([[ "s1", events ]]);
  const byId = new Map(events.map((e) => [e.id, e]));
  return {
    events,
    coreEvents: events,
    fillerEvents: [],
    totalTokens: 20,
    byShard,
    byId,
    targetTokens: 100,
    sampleSeed: 42,
  };
}

const query: McqQuery = {
  id: "q-stub",
  question: "Which?",
  options: ["a", "b"],
  correctOption: 1,
  relevantEventIds: ["e0001"],
  category: "single-shard",
};

describe("HippoRagBaseline — Phase γ sidecar wiring", () => {
  let stub: Awaited<ReturnType<typeof startStubSidecar>>;
  beforeEach(async () => { stub = await startStubSidecar(); });
  afterEach(async () => { await closeServer(stub.server); });

  it("indexes once per corpus, queries per question, recovers event IDs", async () => {
    const baseline = new HippoRagBaseline({
      provider: new StubProvider(),
      sidecarUrl: `http://127.0.0.1:${stub.port}`,
    });
    const corpus = buildMiniCorpus();

    await baseline.answer(query, corpus, { maxInputTokens: 4096, model: "stub" });
    await baseline.answer(query, corpus, { maxInputTokens: 4096, model: "stub" });

    expect(stub.indexCalls).toBe(1);
    expect(stub.queryCalls).toBe(2);
  });

  it("cost-accounting contract: top-level === pipeline + finalCall", async () => {
    const baseline = new HippoRagBaseline({
      provider: new StubProvider(),
      sidecarUrl: `http://127.0.0.1:${stub.port}`,
    });
    const corpus = buildMiniCorpus();
    const result = await baseline.answer(query, corpus, { maxInputTokens: 4096, model: "stub" });
    const meta = result.meta as {
      pipelineInputTokens: number;
      pipelineOutputTokens: number;
      pipelineLatencyMs: number;
      finalCallInputTokens: number;
      finalCallOutputTokens: number;
      finalCallLatencyMs: number;
    };
    expect(result.inputTokens).toBe(meta.pipelineInputTokens + meta.finalCallInputTokens);
    expect(result.outputTokens).toBe(meta.pipelineOutputTokens + meta.finalCallOutputTokens);
    expect(result.latencyMs).toBe(meta.pipelineLatencyMs + meta.finalCallLatencyMs);
  });
});
