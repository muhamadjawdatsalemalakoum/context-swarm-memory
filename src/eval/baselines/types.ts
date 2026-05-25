import type { Corpus } from "../corpus.js";
import type { Answer, Query } from "../mcq.js";

/**
 * Per-call context the runner passes to every baseline. Captures both the
 * model identity and the input-token budget the baseline must respect.
 *
 * Baselines that retrieve (RAG, hybrid, CSM) must truncate to fit
 * `maxInputTokens`. The long-context baseline truncates by packing as many
 * raw events as fit.
 */
export interface BaselineRunContext {
  /**
   * Maximum INPUT tokens the LLM call may use (system + prompt combined).
   * The Phase C sweep moves this across {1024, 4096, 8192, 32768, 131072}.
   * Baselines should reserve ~512 tokens for the MCQ scaffolding (question,
   * 40 options, instructions) and pack retrieved/truncated context into the
   * remainder.
   */
  maxInputTokens: number;
  /** Provider model name, e.g. "gemma4:31b". Forwarded to the LLM call. */
  model: string;
  /** Default 0. Anything above is non-deterministic and breaks cache. */
  temperature?: number;
  /** Default 42. Pinned for reproducibility. */
  seed?: number;
  /**
   * Maximum OUTPUT tokens. The MCQ contract is just "ANSWER: N\nCITATIONS:..."
   * so a small budget suffices. Default 256 leaves slack for verbose models.
   */
  maxOutputTokens?: number;
}

/**
 * What a baseline returns after answering one query. The runner aggregates
 * these into the scoring matrix. The `answer` field is a discriminated
 * `Answer` union (MCQ or free-form) matching the query's `kind`.
 *
 * ## Cost-accounting contract — read this before touching the fields below
 *
 * `inputTokens`, `outputTokens`, and `latencyMs` MUST represent the TOTAL
 * cost of producing the answer for one query — including every internal
 * LLM call the baseline made (probes, recalls, synthesis, anything), not
 * just the final answering call.
 *
 * Single-call baselines (longContext, vanillaRag, hybridRag) satisfy this
 * trivially. Multi-call baselines (CSM) must SUM their per-stage costs
 * explicitly in the return block. The per-stage breakdown lives in `meta`.
 *
 * This rule exists because of a real shipping bug — CSM was reporting only
 * the final MCQ call's cost (~2k tokens) when the actual total was ~10k.
 * Comparing that against single-call RAG's 5.8k would have been apples to
 * oranges — and was caught one step before publishing. See
 * `docs/COST_ACCOUNTING.md` for the full story, the fix, and the test that
 * pins this contract down (`tests/cost-accounting.test.ts`).
 */
export interface BaselineResult {
  answer: Answer;
  /**
   * TOTAL input tokens across every LLM call this baseline made to produce
   * the answer. Single-call baselines: from the provider's usage report.
   * Multi-call baselines: explicit sum of all stages. See doc above.
   */
  inputTokens: number;
  /**
   * TOTAL output tokens across every LLM call. Same rule as `inputTokens`.
   */
  outputTokens: number;
  /**
   * TOTAL wall-clock latency across every LLM call this baseline made.
   * For cached calls, report the original latency. Same rule as `inputTokens`.
   */
  latencyMs: number;
  /** Model identifier echoed for traceability. */
  model: string;
  /**
   * Baseline-specific telemetry. Kept loosely typed so each baseline can stash
   * whatever's useful (retrieval hit-count, BM25/vector contributions, and —
   * critically — per-stage cost breakdown for multi-call baselines. Use
   * `pipelineInputTokens` / `finalCallInputTokens` (and analogous for output
   * tokens / latency) so the reporter can show both totals and the split.
   */
  meta?: Record<string, unknown>;
}

/**
 * The single interface all four baselines (longctx, vanilla RAG, hybrid RAG,
 * CSM) implement. Lets the runner treat them uniformly.
 */
export interface BaselineRunner {
  /** Short identifier — appears in result files and graphs. */
  readonly name: string;
  /** Answer one query against one corpus sample. Accepts any `Query` kind. */
  answer(
    query: Query,
    corpus: Corpus,
    ctx: BaselineRunContext,
  ): Promise<BaselineResult>;
}
