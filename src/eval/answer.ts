/**
 * Format + parse dispatchers shared by every baseline. Each baseline
 * still owns its own retrieval/truncation logic; this file isolates the
 * "build LLM prompt for a query" and "parse LLM output for a query"
 * boilerplate so baselines don't have to branch on query kind themselves.
 */

import {
  formatFreeFormPrompt,
  formatMcqPrompt,
  isFreeFormQuery,
  isMcqQuery,
  parseFreeFormOutput,
  parseMcqOutput,
  type Answer,
  type Query,
} from "./mcq.js";

export interface BuiltPrompt {
  system: string;
  prompt: string;
}

/**
 * Build the LLM prompt for any query kind. Baselines pass in the retrieved
 * context string they've assembled; the dispatcher chooses MCQ-format or
 * free-form-format wrapping based on `query.kind`.
 *
 * System prompt is kept empty for both — the user-prompt itself includes all
 * the instructions. This keeps cache keys narrow.
 */
export function buildPrompt(query: Query, retrievedContext: string): BuiltPrompt {
  const system = "";
  if (isMcqQuery(query)) {
    return { system, prompt: formatMcqPrompt(query, retrievedContext) };
  }
  if (isFreeFormQuery(query)) {
    return { system, prompt: formatFreeFormPrompt(query, retrievedContext) };
  }
  throw new Error("buildPrompt: unknown query kind");
}

/**
 * Parse an LLM's raw output against the appropriate format for the query
 * kind. Returns the discriminated `Answer` type — MCQ or free-form.
 */
export function parseAnswer(query: Query, rawOutput: string): Answer {
  if (isMcqQuery(query)) {
    return parseMcqOutput(rawOutput, query.options.length);
  }
  if (isFreeFormQuery(query)) {
    return parseFreeFormOutput(rawOutput);
  }
  throw new Error("parseAnswer: unknown query kind");
}
