import { estimateTokens } from "../../core/tokenBudget.js";
import type { LlmProvider } from "../../providers/LlmProvider.js";
import { buildPrompt, parseAnswer } from "../answer.js";
import { callLlmCached } from "../cachedLlm.js";
import type { Corpus } from "../corpus.js";
import { embed, EMBED_MODEL_NAME, topKCosine } from "../embed.js";
import type { Query } from "../mcq.js";
import type {
  BaselineResult,
  BaselineRunContext,
  BaselineRunner,
} from "./types.js";

/**
 * Vanilla RAG baseline: embed every event, top-K cosine retrieval over the
 * query embedding, pack the survivors into the prompt as `[id] content`
 * lines, then ask the LLM to pick an MCQ option.
 *
 * Uses `embed` (disk-cached per content hash), so the corpus is only ever
 * embedded once per (content, model) combo across runs. Retrieval is the
 * pure-vector commodity comparison — no BM25, no reranker. Hybrid lives
 * in `hybridRag.ts`.
 *
 * Should beat long-context at large corpus sizes because it actually
 * retrieves the relevant events instead of truncating them away.
 */
export class VanillaRagBaseline implements BaselineRunner {
  readonly name = "rag";

  constructor(
    private opts: {
      provider: LlmProvider;
      k?: number;
      embeddingModel?: string;
    },
  ) {}

  async answer(
    query: Query,
    corpus: Corpus,
    ctx: BaselineRunContext,
  ): Promise<BaselineResult> {
    const k = this.opts.k ?? 10;
    const embeddingModel = this.opts.embeddingModel ?? EMBED_MODEL_NAME;

    // 1. Embed every event in the sampled corpus. Disk-cached per content
    //    hash so this is free on repeat runs.
    const events = corpus.events;
    const eventVecs = await embed(
      events.map((e) => e.content),
      embeddingModel,
    );

    // 2. Embed the query (single-element batch).
    const [queryVec] = await embed([query.question], embeddingModel);
    if (!queryVec) {
      throw new Error("vanillaRag: failed to embed query");
    }

    // 3. Top-K by cosine similarity over the query vector.
    const topK = topKCosine(queryVec, eventVecs, k);

    // 4. Build context lines for each retrieved event in similarity order.
    const retrievedEvents = topK.map((hit) => {
      const ev = events[hit.index];
      if (!ev) {
        throw new Error(
          `vanillaRag: topKCosine returned out-of-range index ${hit.index}`,
        );
      }
      return ev;
    });
    const lines = retrievedEvents.map((ev) => `[${ev.id}] ${ev.content}\n`);

    // 5. Truncate to fit the input-token budget. Reserve 512 for the MCQ
    //    scaffolding (question + 40 options + instructions) per the runner
    //    contract on `BaselineRunContext`. Drop trailing (lowest-similarity)
    //    events first so the highest-scoring hits stay in the prompt.
    const contextBudget = Math.max(0, ctx.maxInputTokens - 512);
    const keptLines: string[] = [];
    const keptEvents: typeof retrievedEvents = [];
    let runningTokens = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const ev = retrievedEvents[i]!;
      const lineTokens = estimateTokens(line);
      if (runningTokens + lineTokens > contextBudget) break;
      keptLines.push(line);
      keptEvents.push(ev);
      runningTokens += lineTokens;
    }
    const contextString = keptLines.join("");
    const contextTokens = runningTokens;

    // 6. Format the prompt (MCQ or free-form, via dispatcher) and call the
    //    cached LLM wrapper.
    const { system, prompt } = buildPrompt(query, contextString);
    const llm = await callLlmCached({
      provider: this.opts.provider,
      model: ctx.model,
      system,
      prompt,
      maxOutputTokens: ctx.maxOutputTokens ?? 256,
      temperature: ctx.temperature ?? 0,
      seed: ctx.seed ?? 42,
    });

    // 7. Parse and apply citation fallback. If the model produced a usable
    //    answer but didn't echo any event IDs, fall back to the retrieved
    //    set — the system DID use those events even if the model didn't
    //    list them.
    const parsed = parseAnswer(query, llm.response);
    const hasAnswer =
      parsed.kind === "free-form"
        ? parsed.chosenAnswer !== null
        : parsed.chosenOption !== null;
    if (hasAnswer && parsed.citedEventIds.length === 0) {
      parsed.citedEventIds = keptEvents.map((ev) => ev.id);
    }

    const retrievedEventIds = retrievedEvents.map((ev) => ev.id);

    return {
      answer: parsed,
      inputTokens: llm.inputTokens,
      outputTokens: llm.outputTokens,
      latencyMs: llm.latencyMs,
      model: ctx.model,
      meta: {
        k,
        retrievedEventIds,
        embeddingModel,
        contextTokens,
      },
    };
  }
}
