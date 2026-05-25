import { estimateTokens } from "../../core/tokenBudget.js";
import type { LlmProvider } from "../../providers/LlmProvider.js";
import { buildPrompt, parseAnswer } from "../answer.js";
import { callLlmCached } from "../cachedLlm.js";
import type { BenchEvent, Corpus } from "../corpus.js";
import type { Query } from "../mcq.js";
import type {
  BaselineRunContext,
  BaselineResult,
  BaselineRunner,
} from "./types.js";

/**
 * HippoRAG 2 baseline — Phase γ.
 *
 * The cited multi-hop QA SOTA (Gutiérrez et al., arXiv:2502.14802, ICML 2025).
 * MuSiQue F1=48.6, 2WikiMultiHopQA F1=71.0, HotpotQA F1=75.5 — beats RAPTOR,
 * Microsoft GraphRAG, NV-Embed-v2 on the same multi-hop evaluation.
 *
 * Wraps the Python HippoRAG sidecar (services/hipporag-sidecar/) via HTTP.
 * Sidecar handles indexing (LLM-driven OpenIE triple extraction → knowledge
 * graph + entity embeddings + chunk embeddings) and retrieval (Personalized
 * PageRank seeded by query-entity matches). This Node client follows the
 * SAME shape as Mem0Baseline — protocol uniformity is the whole point of
 * Phase γ's sidecar architecture.
 *
 * **Citation roundtrip**: HippoRAG's retrieve() returns retrieved doc TEXTS
 * (not IDs). The Python sidecar maps text → idx via the `id_to_text` lookup
 * built at index time, so the Node client gets back proper `BenchEvent.id`s.
 *
 * **Indexing cost** (real-world, single 4090 + Gemma 4 31B):
 *   - 100K corpus: ~3 h
 *   - 1M corpus: ~31 h
 *   - 10M corpus: ~310 h (~13 days) — NOT recommended at this scale
 * This is the OpenIE LLM pass; HippoRAG's authors used GPT-4o-mini at much
 * higher throughput. Cap headline sweep at 1M; document the ceiling clearly.
 */
export interface HippoRagBaselineOptions {
  provider: LlmProvider;
  /** Default `http://127.0.0.1:8001`. Override via `CSM_HIPPORAG_SIDECAR_URL`. */
  sidecarUrl?: string;
  /** Default `gemma4-31b`. */
  llmModel?: string;
  /** Default `BAAI/bge-base-en-v1.5` (110M, runs CPU-friendly). */
  embeddingModel?: string;
  /** Default 10. */
  topK?: number;
  /** Default 4 h (HippoRAG indexing can be very long). */
  requestTimeoutMs?: number;
}

const MCQ_SCAFFOLDING_TOKENS = 512;

export class HippoRagBaseline implements BaselineRunner {
  readonly name = "hipporag";
  private indexedCorpora = new Set<string>();

  constructor(private opts: HippoRagBaselineOptions) {}

  async answer(
    query: Query,
    corpus: Corpus,
    ctx: BaselineRunContext,
  ): Promise<BaselineResult> {
    const sidecarUrl =
      this.opts.sidecarUrl ??
      process.env.CSM_HIPPORAG_SIDECAR_URL ??
      "http://127.0.0.1:8001";
    const llmModel = this.opts.llmModel ?? "gemma4-31b";
    const embeddingModel = this.opts.embeddingModel ?? "BAAI/bge-base-en-v1.5";
    const topK = this.opts.topK ?? 10;
    // HippoRAG indexing is long. 4 h cap covers 1M-token corpora; user must
    // bump higher for ≥ 10M which we don't recommend on a single 4090.
    const requestTimeoutMs = this.opts.requestTimeoutMs ?? 14_400_000;

    const corpusId = computeCorpusId(corpus, llmModel, embeddingModel);

    // 1. Ensure indexed.
    let indexCostInputTokens = 0;
    let indexCostOutputTokens = 0;
    let indexLatencyMs = 0;
    let indexFromCache = false;
    if (!this.indexedCorpora.has(corpusId)) {
      const indexResp = await fetchJson<IndexResponse>(
        `${sidecarUrl}/index`,
        {
          corpusId,
          documents: corpus.events.map((e) => ({ idx: e.id, text: e.content })),
          llmModel,
          embeddingModel,
        },
        requestTimeoutMs,
      );
      this.indexedCorpora.add(corpusId);
      indexCostInputTokens = indexResp.cost?.inputTokens ?? 0;
      indexCostOutputTokens = indexResp.cost?.outputTokens ?? 0;
      indexLatencyMs = indexResp.indexElapsedMs ?? 0;
      indexFromCache = indexResp.fromCache;
    } else {
      indexFromCache = true;
    }

    // 2. Query.
    const queryResp = await fetchJson<QueryResponse>(
      `${sidecarUrl}/query`,
      { corpusId, question: query.question, k: topK },
      300_000, // 5 min cap on a single retrieval (PPR is fast; LLM in entity-match is bounded)
    );
    const retrieved = queryResp.retrievedDocs ?? [];
    const retrievedIds = retrieved.map((d) => d.idx);
    const queryCostInputTokens = queryResp.cost?.inputTokens ?? 0;
    const queryCostOutputTokens = queryResp.cost?.outputTokens ?? 0;
    const queryLatencyMs = queryResp.cost?.latencyMs ?? 0;

    // 3. Build context with canonical event text (consistent with Mem0 + RAG).
    const budget = Math.max(0, ctx.maxInputTokens - MCQ_SCAFFOLDING_TOKENS);
    const { contextString, contextTokens, packedEventIds } = buildContextString(
      retrievedIds,
      corpus.byId,
      budget,
    );

    // 4. Final MCQ call (same `disableThinking: true` cost optimisation as Mem0+CSM).
    const { system, prompt } = buildPrompt(query, contextString);
    const llm = await callLlmCached({
      provider: this.opts.provider,
      model: ctx.model,
      system,
      prompt,
      maxOutputTokens: ctx.maxOutputTokens ?? 256,
      temperature: ctx.temperature ?? 0,
      seed: ctx.seed ?? 42,
      disableThinking: true,
    });

    // 5. Parse + citation fallback.
    const parsed = parseAnswer(query, llm.response);
    const hasAnswer =
      parsed.kind === "free-form"
        ? parsed.chosenAnswer !== null
        : parsed.chosenOption !== null;
    if (hasAnswer && parsed.citedEventIds.length === 0) {
      parsed.citedEventIds = packedEventIds.length
        ? [...packedEventIds]
        : [...retrievedIds];
    }

    const pipelineInputTokens = indexCostInputTokens + queryCostInputTokens;
    const pipelineOutputTokens = indexCostOutputTokens + queryCostOutputTokens;
    const pipelineLatencyMs = indexLatencyMs + queryLatencyMs;

    return {
      answer: parsed,
      inputTokens: pipelineInputTokens + llm.inputTokens,
      outputTokens: pipelineOutputTokens + llm.outputTokens,
      latencyMs: pipelineLatencyMs + llm.latencyMs,
      model: ctx.model,
      meta: {
        sidecarUrl,
        corpusId,
        topK,
        retrievedIds,
        packedEventIds,
        contextTokens,
        pipelineInputTokens,
        pipelineOutputTokens,
        pipelineLatencyMs,
        finalCallInputTokens: llm.inputTokens,
        finalCallOutputTokens: llm.outputTokens,
        finalCallLatencyMs: llm.latencyMs,
        indexFromCache,
      },
    };
  }
}

// -- Helpers (same shape as Mem0Baseline) ------------------------------------

interface IndexResponse {
  corpusId: string;
  indexedDocCount: number;
  indexElapsedMs: number;
  cost?: { inputTokens?: number; outputTokens?: number };
  fromCache: boolean;
  indexPath: string;
}

interface QueryResponse {
  retrievedDocs: Array<{ idx: string; text: string; score: number }>;
  cost?: { inputTokens?: number; outputTokens?: number; latencyMs?: number };
  rerankerUsed: boolean;
}

async function fetchJson<T>(
  url: string,
  body: unknown,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "<unreadable>");
      throw new Error(
        `hipporag sidecar HTTP ${resp.status} at ${url}: ${text.slice(0, 200)}`,
      );
    }
    return (await resp.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function computeCorpusId(
  corpus: Corpus,
  llmModel: string,
  embeddingModel: string,
): string {
  const parts = [
    corpus.sampleSeed,
    corpus.targetTokens,
    corpus.events.length,
    llmModel,
    embeddingModel,
  ].join("|");
  let hash = 0x811c9dc5;
  for (let i = 0; i < parts.length; i++) {
    hash ^= parts.charCodeAt(i);
    hash = (hash >>> 0) * 0x01000193;
    hash = hash >>> 0;
  }
  return `hipporag-${corpus.events.length}ev-${hash.toString(16).padStart(8, "0")}`;
}

function buildContextString(
  retrievedIds: string[],
  byId: Map<string, BenchEvent>,
  budgetTokens: number,
): {
  contextString: string;
  contextTokens: number;
  packedEventIds: string[];
} {
  const lines: string[] = [];
  const packed: string[] = [];
  let used = 0;
  for (const id of retrievedIds) {
    const ev = byId.get(id);
    if (!ev) continue;
    const line = `[${ev.id}] ${ev.content}\n`;
    const lineTokens = estimateTokens(line);
    if (used + lineTokens > budgetTokens) break;
    lines.push(line);
    packed.push(ev.id);
    used += lineTokens;
  }
  return {
    contextString: lines.join(""),
    contextTokens: used,
    packedEventIds: packed,
  };
}
