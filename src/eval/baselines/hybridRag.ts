import { estimateTokens } from "../../core/tokenBudget.js";
import type { LlmProvider } from "../../providers/LlmProvider.js";
import { buildPrompt, parseAnswer } from "../answer.js";
import { callLlmCached } from "../cachedLlm.js";
import type { BenchEvent, Corpus } from "../corpus.js";
import { embed, EMBED_MODEL_NAME, topKCosine } from "../embed.js";
import type { Query } from "../mcq.js";
import { rerank, rerankerEnabled, rerankerModelName } from "../rerank.js";
import type {
  BaselineRunContext,
  BaselineResult,
  BaselineRunner,
} from "./types.js";

/**
 * Hybrid RAG baseline: BM25 (lexical) + dense embeddings (semantic), fused
 * via Reciprocal Rank Fusion (RRF). The lexical signal catches keyword-exact
 * matches that pure embeddings miss; embeddings catch paraphrase / synonym
 * matches BM25 misses. RRF is rank-based, so the two scoring scales never
 * have to be reconciled.
 *
 * Pipeline per query:
 *   1. BM25 over corpus events → top kBm25
 *   2. Cosine over disk-cached embeddings → top kVector
 *   3. RRF fuse (k=60) → top kFinal
 *   4. Format MCQ prompt with [<id>] context, truncate to budget
 *   5. callLlmCached → parseMcqOutput
 */
export class HybridRagBaseline implements BaselineRunner {
  readonly name = "hybrid";

  constructor(
    private opts: {
      provider: LlmProvider;
      kBm25?: number;
      kVector?: number;
      kFinal?: number;
      embeddingModel?: string;
      /**
       * Run a cross-encoder reranker over the RRF top-K before truncating to
       * the answer-prompt budget. Phase γ upgrade — defaults to env-controlled
       * (`CSM_HYBRID_RERANK=1`) so existing cached runs (headline-10q et al.)
       * remain byte-identical replays. Set explicitly here to override the
       * env, e.g. for a test that pins reranker-on behavior.
       */
      useReranker?: boolean;
      /** Cross-encoder model name. Defaults to env or MiniLM. */
      rerankerModel?: string;
    },
  ) {}

  async answer(
    query: Query,
    corpus: Corpus,
    ctx: BaselineRunContext,
  ): Promise<BaselineResult> {
    const kBm25 = this.opts.kBm25 ?? 20;
    const kVector = this.opts.kVector ?? 20;
    const kFinal = this.opts.kFinal ?? 10;
    const embeddingModel = this.opts.embeddingModel ?? EMBED_MODEL_NAME;

    const events = corpus.events;

    // 1. BM25 retrieval.
    const bm25Top = bm25Search(query.question, events, kBm25);
    const bm25TopIds = bm25Top.map((r) => events[r.index]!.id);

    // 2. Dense vector retrieval (disk-cached).
    const eventVecs = await embed(
      events.map((e) => e.content),
      embeddingModel,
    );
    const queryVecs = await embed([query.question], embeddingModel);
    const queryVec = queryVecs[0]!;
    const vectorTop = topKCosine(queryVec, eventVecs, kVector);
    const vectorTopIds = vectorTop.map((r) => events[r.index]!.id);

    // 3. Reciprocal Rank Fusion (k=60). Rank is 1-indexed.
    const RRF_K = 60;
    const fusedScores = new Map<number, number>();
    bm25Top.forEach((r, rank) => {
      const prev = fusedScores.get(r.index) ?? 0;
      fusedScores.set(r.index, prev + 1 / (RRF_K + (rank + 1)));
    });
    vectorTop.forEach((r, rank) => {
      const prev = fusedScores.get(r.index) ?? 0;
      fusedScores.set(r.index, prev + 1 / (RRF_K + (rank + 1)));
    });
    // RRF fuse to top-K candidates. When the reranker is enabled below, we
    // hand it a SLIGHTLY-LARGER pool (kFinal * 2, capped at the fused set
    // size) so the cross-encoder can promote latent matches the bi-encoders
    // ranked lower. Without reranking, kFinal directly is fine.
    const useReranker = this.opts.useReranker ?? rerankerEnabled();
    const fusedAll = [...fusedScores.entries()]
      .map(([index, score]) => ({ index, score }))
      .sort((a, b) => b.score - a.score);
    const rerankPoolSize = useReranker
      ? Math.min(fusedAll.length, kFinal * 2)
      : kFinal;
    let fused = fusedAll.slice(0, rerankPoolSize);

    // 3b. Optional: cross-encoder rerank. The 2025 standard for hybrid RAG —
    //     bi-encoders are noisy, the reranker sees (query, doc) pairs via
    //     cross-attention. Falls back to RRF order if the model fails to
    //     load. After reranking, truncate to kFinal.
    let rerankerScores: Array<{ index: number; score: number }> | null = null;
    if (useReranker && fused.length > 0) {
      const docs = fused.map((r) => events[r.index]!.content);
      const rerankerModel = this.opts.rerankerModel ?? rerankerModelName();
      const scored = await rerank(query.question, docs, rerankerModel);
      // scored[i].index is an index INTO `docs`, which mirrors `fused`. Map
      // back to event-index via fused[scored[i].index].index.
      const reordered = scored.map((r) => ({
        index: fused[r.index]!.index,
        score: r.score,
      }));
      rerankerScores = reordered.map((r) => ({
        index: r.index,
        score: r.score,
      }));
      fused = reordered.slice(0, kFinal);
    } else {
      fused = fused.slice(0, kFinal);
    }
    const fusedTopIds = fused.map((r) => events[r.index]!.id);

    // 4. Build context string, truncate to fit token budget. Reserve 512
    //    tokens for the MCQ scaffolding (question + options + instructions).
    const budget = Math.max(0, ctx.maxInputTokens - 512);
    const contextLines: string[] = [];
    let tokenSum = 0;
    for (const r of fused) {
      const ev = events[r.index]!;
      const line = `[${ev.id}] ${ev.content}\n`;
      const lineTokens = estimateTokens(line);
      if (tokenSum + lineTokens > budget) break;
      contextLines.push(line);
      tokenSum += lineTokens;
    }
    const contextString = contextLines.join("");
    const contextTokens = tokenSum;

    // 5. LLM call (cached). Prompt + system come from the shared dispatcher
    //    so MCQ and free-form queries are wrapped uniformly.
    const { system, prompt } = buildPrompt(query, contextString);
    const llmResult = await callLlmCached({
      provider: this.opts.provider,
      model: ctx.model,
      system,
      prompt,
      maxOutputTokens: ctx.maxOutputTokens ?? 256,
      temperature: ctx.temperature ?? 0,
      seed: ctx.seed ?? 42,
    });

    const parsed = parseAnswer(query, llmResult.response);

    // 6. Citation fallback: if the model produced a usable answer but cited
    //    nothing, attribute it to the top-kFinal fused IDs so downstream
    //    citation P/R isn't penalised purely by silence.
    const hasAnswer =
      parsed.kind === "free-form"
        ? parsed.chosenAnswer !== null
        : parsed.chosenOption !== null;
    if (hasAnswer && parsed.citedEventIds.length === 0) {
      parsed.citedEventIds = [...fusedTopIds];
    }

    return {
      answer: parsed,
      inputTokens: llmResult.inputTokens,
      outputTokens: llmResult.outputTokens,
      latencyMs: llmResult.latencyMs,
      model: ctx.model,
      meta: {
        kBm25,
        kVector,
        kFinal,
        bm25TopIds,
        vectorTopIds,
        fusedTopIds,
        contextTokens,
        rerankerUsed: useReranker,
        rerankerScores,
      },
    };
  }
}

// --------------------------------------------------------------------------
// BM25 — inline implementation. Tokenize, build inverted index, score.
// --------------------------------------------------------------------------

const BM25_K1 = 1.5;
const BM25_B = 0.75;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

/**
 * Score every event's BM25 against the query, return top-k by score
 * (descending). Indexes refer to positions in `events`.
 */
function bm25Search(
  query: string,
  events: readonly BenchEvent[],
  k: number,
): Array<{ index: number; score: number }> {
  const N = events.length;
  if (N === 0) return [];

  // Tokenize all docs once.
  const docTokens: string[][] = events.map((e) => tokenize(e.content));
  const docLengths: number[] = docTokens.map((toks) => toks.length);
  const totalLen = docLengths.reduce((s, l) => s + l, 0);
  const avgdl = totalLen / N;

  // Inverted index: term → { docFreq, postings: Map<docIndex, termFreq> }.
  const index = new Map<
    string,
    { df: number; postings: Map<number, number> }
  >();
  for (let i = 0; i < N; i++) {
    const seen = new Set<string>();
    for (const tok of docTokens[i]!) {
      let entry = index.get(tok);
      if (!entry) {
        entry = { df: 0, postings: new Map() };
        index.set(tok, entry);
      }
      entry.postings.set(i, (entry.postings.get(i) ?? 0) + 1);
      if (!seen.has(tok)) {
        entry.df += 1;
        seen.add(tok);
      }
    }
  }

  // Score each doc against the query terms.
  const queryTokens = tokenize(query);
  const scores = new Float64Array(N);
  for (const qt of queryTokens) {
    const entry = index.get(qt);
    if (!entry) continue;
    // IDF with the BM25+ floor (max(epsilon, log(...))) replaced by the
    // standard ln((N - df + 0.5) / (df + 0.5) + 1) form, which is always
    // non-negative and avoids the negative-IDF edge case for very common
    // terms.
    const idf = Math.log((N - entry.df + 0.5) / (entry.df + 0.5) + 1);
    for (const [docIdx, tf] of entry.postings) {
      const dl = docLengths[docIdx]!;
      const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / avgdl);
      scores[docIdx] += idf * ((tf * (BM25_K1 + 1)) / denom);
    }
  }

  const ranked: Array<{ index: number; score: number }> = [];
  for (let i = 0; i < N; i++) {
    if (scores[i]! > 0) ranked.push({ index: i, score: scores[i]! });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, k);
}
