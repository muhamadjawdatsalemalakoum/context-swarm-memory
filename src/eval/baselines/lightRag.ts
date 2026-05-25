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
 * LightRAG baseline — Phase γ.
 *
 * Dual-level (entity + relation) graph RAG (Guo et al., arXiv:2410.05779,
 * EMNLP 2025). ~6,000× retrieval-cost reduction vs full Microsoft GraphRAG;
 * Ollama-first design. Wraps the Python LightRAG sidecar (services/lightrag-
 * sidecar/) via HTTP. Same protocol shape as Mem0 + HippoRAG baselines.
 *
 * **Citation roundtrip — marker-block trick**: LightRAG's chunker may split or
 * merge our `BenchEvent` content, so we wrap each event in
 * `<<<EVT id=eXXXX>>>...<<<END>>>` markers at insert time. The Python sidecar
 * regex-extracts the IDs from retrieved chunks and returns them as
 * `retrievedDocs[i].idx`. The Node client then maps back to canonical event
 * content via `corpus.byId` for the answer prompt.
 *
 * **Indexing cost** (single 4090 + Gemma 4 31B):
 *   - 100K corpus: ~6 h
 *   - 1M corpus:   ~62 h
 *   - 10M corpus:  ~620 h — NOT recommended on consumer hardware
 * LightRAG runs three LLM passes during indexing (entity extraction, relation
 * extraction, optional community summaries), which is why it's slower than
 * HippoRAG.
 *
 * **Query modes** (via `extras.mode`):
 *   - `"naive"`: pure vector retrieval (simplest, no graph traversal)
 *   - `"local"`: entity-neighborhood graph traversal
 *   - `"global"`: community-summary retrieval
 *   - `"hybrid"`: local + global (LightRAG default, our default)
 *   - `"mix"`: hybrid + reranker (requires the sidecar to have a reranker loaded)
 */
export interface LightRagBaselineOptions {
  provider: LlmProvider;
  /** Default `http://127.0.0.1:8002`. Override via `CSM_LIGHTRAG_SIDECAR_URL`. */
  sidecarUrl?: string;
  /** Default `gemma4-31b`. */
  llmModel?: string;
  /** Default `nomic-embed-text` (or whatever the sidecar is configured for). */
  embeddingModel?: string;
  /** Default 10. */
  topK?: number;
  /** Default `"hybrid"`. One of: naive / local / global / hybrid / mix. */
  mode?: "naive" | "local" | "global" | "hybrid" | "mix";
  /** Default 24 h (LightRAG indexing can be very long). */
  requestTimeoutMs?: number;
}

const MCQ_SCAFFOLDING_TOKENS = 512;

export class LightRagBaseline implements BaselineRunner {
  readonly name = "lightrag";
  private indexedCorpora = new Set<string>();

  constructor(private opts: LightRagBaselineOptions) {}

  async answer(
    query: Query,
    corpus: Corpus,
    ctx: BaselineRunContext,
  ): Promise<BaselineResult> {
    const sidecarUrl =
      this.opts.sidecarUrl ??
      process.env.CSM_LIGHTRAG_SIDECAR_URL ??
      "http://127.0.0.1:8002";
    const llmModel = this.opts.llmModel ?? "gemma4-31b";
    const embeddingModel = this.opts.embeddingModel ?? "nomic-embed-text";
    const topK = this.opts.topK ?? 10;
    const mode = this.opts.mode ?? "hybrid";
    // LightRAG indexing is the slowest of the three Phase γ baselines.
    // 24 h cap covers 1M-token corpora at Gemma 4 31B throughput.
    const requestTimeoutMs = this.opts.requestTimeoutMs ?? 86_400_000;

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

    // 2. Query with the configured mode.
    const queryResp = await fetchJson<QueryResponse>(
      `${sidecarUrl}/query`,
      {
        corpusId,
        question: query.question,
        k: topK,
        extras: { mode },
      },
      300_000,
    );
    const retrieved = queryResp.retrievedDocs ?? [];
    const retrievedIds = retrieved.map((d) => d.idx);
    const queryCostInputTokens = queryResp.cost?.inputTokens ?? 0;
    const queryCostOutputTokens = queryResp.cost?.outputTokens ?? 0;
    const queryLatencyMs = queryResp.cost?.latencyMs ?? 0;

    // 3. Build context with canonical event text.
    const budget = Math.max(0, ctx.maxInputTokens - MCQ_SCAFFOLDING_TOKENS);
    const { contextString, contextTokens, packedEventIds } = buildContextString(
      retrievedIds,
      corpus.byId,
      budget,
    );

    // 4. Final MCQ call.
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
        mode,
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

// -- Helpers ------------------------------------------------------------------

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
        `lightrag sidecar HTTP ${resp.status} at ${url}: ${text.slice(0, 200)}`,
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
  return `lightrag-${corpus.events.length}ev-${hash.toString(16).padStart(8, "0")}`;
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
