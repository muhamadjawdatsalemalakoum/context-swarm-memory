import { estimateTokens } from "../../core/tokenBudget.js";
import type { LlmProvider } from "../../providers/LlmProvider.js";
import { buildPrompt, parseAnswer } from "../answer.js";
import { callLlmCached } from "../cachedLlm.js";
import type { Corpus } from "../corpus.js";
import type { Query } from "../mcq.js";
import type {
  BaselineResult,
  BaselineRunContext,
  BaselineRunner,
} from "./types.js";

/** Tokens reserved for the MCQ scaffolding (question + 40 options + the
 *  "Respond with..." instructions). The remainder of `maxInputTokens` is
 *  available for packed events. */
const MCQ_SCAFFOLDING_TOKENS = 512;

/**
 * **Strawman baseline** for the Phase C context-scaling study.
 *
 * The long-context baseline treats the LLM's context window as the entire
 * memory: it sorts the corpus by event id and stuffs as many raw events as
 * fit into `ctx.maxInputTokens` (after reserving ~512 tokens for the MCQ
 * scaffolding). No retrieval, no summarisation, no routing.
 *
 * It exists as a comparison point that is **expected to fail** at corpus
 * sizes larger than the model's window — at 10K corpus / 128K window it
 * should be ~perfect (the whole corpus fits), and at 1B corpus / 1K window
 * it should be near-random (a few packed events out of millions). The
 * crossover curve is the headline finding of the study.
 *
 * Packing order — **representative (seeded shuffle), not id-sorted.** Long-context
 * has no retrieval, so the events it can fit into the window are an arbitrary,
 * relevance-agnostic slice of the corpus. The previous id-ascending sort
 * accidentally FRONT-LOADED the gold-bearing core events (ids `e0xxx` sort before
 * all filler `fx-`), which made long-context corpus-size-INVARIANT — it always
 * packed the same ~18 core events and never even reached the filler, masking the
 * true scaling behaviour (RQ1). We instead pack a DETERMINISTIC seeded shuffle of
 * the corpus: as the corpus grows, the fixed window covers a vanishing fraction,
 * so the scattered gold events fall outside it and accuracy honestly degrades.
 * (Contiguous-by-timestamp packing would be even harsher: the gold core clusters
 * mid-timeline — Feb–Apr 2026 — while filler spans Sep 2025–Apr 2027, so any
 * recent/oldest window hits ~0% core. A uniform shuffle is the fairer, more
 * charitable model of "no retrieval, fits only a slice.") The seed is fixed, so
 * the shuffle (and thus the cache key) is stable across runs.
 */
const LONGCTX_PACK_SEED = 0x6c6f6e67; // "long" — fixed for cache stability

/** Deterministic in-place-free Fisher–Yates shuffle seeded by a mulberry32 PRNG. */
function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const a = [...items];
  let s = seed >>> 0;
  const rand = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

export class LongContextBaseline implements BaselineRunner {
  readonly name = "longctx";

  constructor(private opts: { provider: LlmProvider }) {}

  async answer(
    query: Query,
    corpus: Corpus,
    ctx: BaselineRunContext,
  ): Promise<BaselineResult> {
    const availableBudget = Math.max(
      0,
      ctx.maxInputTokens - MCQ_SCAFFOLDING_TOKENS,
    );

    // Representative (relevance-agnostic) packing — see class docstring. A fixed
    // seed keeps the shuffle (and cache key) stable across runs.
    const packOrder = seededShuffle(corpus.events, LONGCTX_PACK_SEED);

    let packed = "";
    let packedTokens = 0;
    let eventsIncluded = 0;
    for (const event of packOrder) {
      const line = `[${event.id}] ${event.content}\n`;
      const lineTokens = estimateTokens(line);
      if (packedTokens + lineTokens > availableBudget) break;
      packed += line;
      packedTokens += lineTokens;
      eventsIncluded += 1;
    }

    const { system, prompt } = buildPrompt(query, packed);

    const llmResult = await callLlmCached({
      provider: this.opts.provider,
      model: ctx.model,
      system,
      prompt,
      maxOutputTokens: ctx.maxOutputTokens ?? 256,
      temperature: ctx.temperature ?? 0,
      seed: ctx.seed ?? 42,
    });

    const answer = parseAnswer(query, llmResult.response);

    return {
      answer,
      inputTokens: llmResult.inputTokens,
      outputTokens: llmResult.outputTokens,
      latencyMs: llmResult.latencyMs,
      model: ctx.model,
      meta: {
        eventsIncluded,
        eventsTotal: corpus.events.length,
        truncated: eventsIncluded < corpus.events.length,
        packedTokens,
      },
    };
  }
}
