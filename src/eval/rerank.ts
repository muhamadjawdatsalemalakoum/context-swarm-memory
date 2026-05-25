/**
 * Cross-encoder reranker for hybrid RAG. Optional: when `CSM_HYBRID_RERANK=1`,
 * the `HybridRagBaseline` passes its RRF top-K through a cross-encoder before
 * truncating to the answer-prompt budget.
 *
 * **Why a reranker?** Bi-encoders (BM25 + cosine) score query and doc
 * independently, then fuse — cheap but lossy. A cross-encoder sees the
 * (query, doc) pair together via cross-attention, so it can reason about
 * fine-grained relevance that single-vector retrieval misses. Reported gains
 * on standard IR benchmarks: +5-15 nDCG@10 over bi-encoder alone. Cost:
 * ~50ms per (query, doc) pair on CPU with the default 22M-param MiniLM.
 *
 * **Why MiniLM as default?** `Xenova/ms-marco-MiniLM-L-6-v2` is the well-
 * tested Transformers.js cross-encoder. 22M params, ~80 MB download, runs on
 * CPU. BGE-reranker-v2-m3 (568M, the 2024 SOTA per multiple leaderboards) is
 * the upgrade target — swap in via
 * `CSM_RERANKER_MODEL=Xenova/bge-reranker-base` (or another community port)
 * when available. The hybrid RAG path falls back gracefully if the model
 * fails to load (logs a warning, returns the input order unchanged).
 *
 * **Why opt-in?** Existing `headline-10q` replays cache responses keyed on
 * the input prompt. Inserting a reranker changes the retrieved doc order →
 * changes the prompt → invalidates cache. Opt-in keeps replays byte-identical
 * for pre-Phase β runs while making the upgrade available for new measurement.
 */

export const RERANKER_DEFAULT_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";

/** Read once at module load; honor `CSM_RERANKER_MODEL` env override. */
export function rerankerModelName(): string {
  return process.env.CSM_RERANKER_MODEL?.trim() || RERANKER_DEFAULT_MODEL;
}

/** Whether the hybrid RAG baseline should run the reranker. Default off. */
export function rerankerEnabled(): boolean {
  const v = process.env.CSM_HYBRID_RERANK?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// Lazy-loaded pipeline (one per process).
type CrossEncoderOutput = Array<{ label: string; score: number }>;
type CrossEncoderPipeline = (
  inputs: { text: string; text_pair: string } | Array<{ text: string; text_pair: string }>,
) => Promise<CrossEncoderOutput | CrossEncoderOutput[]>;

let pipelinePromise: Promise<CrossEncoderPipeline | null> | null = null;

async function getRerankerPipeline(
  modelName: string,
): Promise<CrossEncoderPipeline | null> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      try {
        const tx = await import("@huggingface/transformers");
        // Cross-encoders are exposed as `text-classification` in Transformers.js;
        // the pipeline accepts `{text, text_pair}` for pairwise inputs and
        // returns the model's relevance score under the highest-score label.
        const pipe = (await tx.pipeline(
          "text-classification",
          modelName,
        )) as unknown as CrossEncoderPipeline;
        return pipe;
      } catch (err) {
        // Log once and return null so the hybrid RAG path falls back to the
        // input order. We don't want a model-load failure to break the entire
        // bench — the un-reranked hybrid RAG still produces meaningful results.
        // eslint-disable-next-line no-console
        console.warn(
          `[rerank] failed to load model ${modelName}: ${(err as Error).message}. ` +
            `Falling back to bi-encoder ordering. Set CSM_HYBRID_RERANK=0 to silence.`,
        );
        return null;
      }
    })();
  }
  return pipelinePromise;
}

/**
 * Score `(query, doc)` pairs with the cross-encoder and return the input
 * indexes sorted by descending relevance.
 *
 * Returns the **input order unchanged** if the model fails to load.
 *
 * @param query  Free-form query string.
 * @param documents  Candidate document strings (typically RRF top-K).
 * @param modelName  Override the default model (defaults to env or MiniLM).
 */
export async function rerank(
  query: string,
  documents: string[],
  modelName: string = rerankerModelName(),
): Promise<Array<{ index: number; score: number }>> {
  if (documents.length === 0) return [];
  const pipe = await getRerankerPipeline(modelName);
  if (!pipe) {
    // Fallback: return input order with zero scores so the caller can detect
    // the no-rerank case via score === 0 if needed.
    return documents.map((_doc, index) => ({ index, score: 0 }));
  }
  // Batch the pairs in one call when the model supports array input. The
  // Transformers.js text-classification pipeline accepts an array of pair
  // objects and returns a parallel array of outputs.
  const pairs = documents.map((doc) => ({ text: query, text_pair: doc }));
  let raw: CrossEncoderOutput | CrossEncoderOutput[];
  try {
    raw = await pipe(pairs);
  } catch (err) {
    // Mid-call failure (e.g., input too long for the model). Same fallback.
    // eslint-disable-next-line no-console
    console.warn(
      `[rerank] inference failed: ${(err as Error).message}. ` +
        `Falling back to input order for this query.`,
    );
    return documents.map((_doc, index) => ({ index, score: 0 }));
  }

  // Normalize: text-classification returns either an array (batch) or a
  // single result depending on the pipeline implementation. Coerce to array.
  const scored: Array<{ index: number; score: number }> = [];
  if (Array.isArray(raw) && raw.length > 0 && Array.isArray(raw[0])) {
    // Array-of-arrays form: one CrossEncoderOutput per pair.
    const batch = raw as CrossEncoderOutput[];
    for (let i = 0; i < batch.length; i++) {
      const top = batch[i]![0];
      scored.push({ index: i, score: top?.score ?? 0 });
    }
  } else if (Array.isArray(raw)) {
    // Flat array form: one element per pair (most likely with our shape).
    const flat = raw as CrossEncoderOutput;
    for (let i = 0; i < flat.length; i++) {
      scored.push({ index: i, score: flat[i]?.score ?? 0 });
    }
  } else {
    // Single result for a single pair input; we passed an array, this is
    // unexpected. Defensive fallback.
    return documents.map((_doc, index) => ({ index, score: 0 }));
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}
