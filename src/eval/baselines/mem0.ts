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
 * Mem0 baseline — Phase γ.
 *
 * Wraps the Python Mem0 sidecar (services/mem0-sidecar/) via HTTP. The
 * sidecar handles indexing (`memory.add` per event) and retrieval
 * (`memory.search`); this Node client converts our corpus + query to the
 * sidecar's protocol shape, recovers event IDs through metadata roundtrip,
 * builds the same `[<id>] <content>` context other baselines use, and
 * routes the final MCQ call through `callLlmCached` so the cost-accounting
 * contract holds end-to-end.
 *
 * **Why a sidecar?** Mem0's Python lib has richer LLM/embedding/vector-store
 * config than its Node SDK. Plus pattern uniformity across the three
 * Phase γ baselines (HippoRAG + LightRAG + Mem0) — one launcher, one
 * cost-accounting story.
 *
 * **Citation roundtrip**: Mem0 distills input messages into facts at ingest.
 * The original text is NOT preserved in Mem0's returned `memory` field. We
 * rely on `metadata.eventId` (set at index time) for the ID, and look up the
 * canonical event text from `corpus.byId` for the context block. This
 * matches what other baselines pack into their prompts and keeps the
 * cross-system comparison fair.
 */
export interface Mem0BaselineOptions {
  provider: LlmProvider;
  /** Default `http://127.0.0.1:8003`. Override via `CSM_MEM0_SIDECAR_URL` env. */
  sidecarUrl?: string;
  /** Default `gemma4-31b` (the normalised post-Phase β.1 name). */
  llmModel?: string;
  /** Default `nomic-embed-text`. */
  embeddingModel?: string;
  /** Default 10. */
  topK?: number;
  /** Default 30000 ms; bumped to 4 h for long-running indexing endpoints. */
  requestTimeoutMs?: number;
}

const MCQ_SCAFFOLDING_TOKENS = 512;

export class Mem0Baseline implements BaselineRunner {
  readonly name = "mem0";

  // Track which corpora we've already indexed in this process — avoids
  // re-POSTing /index for every query in the same sweep cell. The sidecar
  // is also idempotent server-side via its manifest check.
  private indexedCorpora = new Set<string>();

  constructor(private opts: Mem0BaselineOptions) {}

  async answer(
    query: Query,
    corpus: Corpus,
    ctx: BaselineRunContext,
  ): Promise<BaselineResult> {
    const sidecarUrl =
      this.opts.sidecarUrl ??
      process.env.CSM_MEM0_SIDECAR_URL ??
      "http://127.0.0.1:8003";
    const llmModel = this.opts.llmModel ?? "gemma4-31b";
    const embeddingModel = this.opts.embeddingModel ?? "nomic-embed-text";
    const topK = this.opts.topK ?? 10;
    const requestTimeoutMs = this.opts.requestTimeoutMs ?? 30_000;

    const corpusId = computeCorpusId(corpus, llmModel, embeddingModel);

    // 1. Ensure indexed (idempotent — both client-side via Set and server-
    //    side via manifest check).
    let indexCostInputTokens = 0;
    let indexCostOutputTokens = 0;
    let indexLatencyMs = 0;
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
    }

    // 2. Query Mem0 for top-K relevant docs.
    const queryResp = await fetchJson<QueryResponse>(
      `${sidecarUrl}/query`,
      {
        corpusId,
        question: query.question,
        k: topK,
      },
      requestTimeoutMs,
    );
    const retrieved = queryResp.retrievedDocs ?? [];
    const retrievedIds = retrieved.map((d) => d.idx);
    const queryCostInputTokens = queryResp.cost?.inputTokens ?? 0;
    const queryCostOutputTokens = queryResp.cost?.outputTokens ?? 0;
    const queryLatencyMs = queryResp.cost?.latencyMs ?? 0;

    // 3. Build the MCQ context string using canonical event text from the
    //    corpus (NOT Mem0's distilled facts — fairness control).
    const budget = Math.max(0, ctx.maxInputTokens - MCQ_SCAFFOLDING_TOKENS);
    const { contextString, contextTokens, packedEventIds } = buildContextString(
      retrievedIds,
      corpus.byId,
      budget,
    );

    // 4. Final MCQ call through the cache.
    const { system, prompt } = buildPrompt(query, contextString);
    const llm = await callLlmCached({
      provider: this.opts.provider,
      model: ctx.model,
      system,
      prompt,
      maxOutputTokens: ctx.maxOutputTokens ?? 256,
      temperature: ctx.temperature ?? 0,
      seed: ctx.seed ?? 42,
      // Mem0 baseline benefits from the same thinking-off as CSM's answer
      // stage — the MCQ output shape (`ANSWER: N` + citations) doesn't need
      // a 2-3K-token reasoning trace.
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

    // 6. Sum costs across pipeline + final call (the cost-accounting contract).
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
        indexFromCache: this.indexedCorpora.has(corpusId),
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
        `mem0 sidecar HTTP ${resp.status} at ${url}: ${text.slice(0, 200)}`,
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
  // Use Node's crypto via dynamic import-less hash since we already have the
  // pieces. Simple deterministic concat → hash.
  const parts = [
    corpus.sampleSeed,
    corpus.targetTokens,
    corpus.events.length,
    llmModel,
    embeddingModel,
  ].join("|");
  // FNV-1a 32-bit — good enough for cache-keying; no crypto dep needed for ID.
  let hash = 0x811c9dc5;
  for (let i = 0; i < parts.length; i++) {
    hash ^= parts.charCodeAt(i);
    hash = (hash >>> 0) * 0x01000193;
    hash = hash >>> 0;
  }
  return `mem0-${corpus.events.length}ev-${hash.toString(16).padStart(8, "0")}`;
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
