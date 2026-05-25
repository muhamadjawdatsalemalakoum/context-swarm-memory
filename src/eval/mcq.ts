import { z } from "zod";

/**
 * Multiple-choice query format for the CSM benchmark (PaySwift corpus).
 *
 * Each query has N answer options (target: 40), exactly one of which is correct.
 * Systems output a number selecting their chosen option. Scoring is exact-match
 * (programmatic, no LLM-as-judge).
 */
export interface McqQuery {
  /** Discriminator. Defaults to "mcq" for back-compat with existing queries.json. */
  kind?: "mcq";
  id: string;
  question: string;
  /** Length N (typically 40). Index 0 = option 1 (we use 1-indexed externally). */
  options: string[];
  /** 1-indexed: must be in [1, options.length]. */
  correctOption: number;
  /** Ground truth event IDs that the answer should be supported by. */
  relevantEventIds: string[];
  /** Optional categorisation for stratified analysis. */
  category?: "single-shard" | "multi-shard" | "adversarial";
  /** Optional hint about which shard(s) the answer lives in (used for ablations). */
  shardHints?: string[];
}

/**
 * Free-form short-answer query format (BABILong, RULER, etc).
 *
 * Each query expects a single short string answer. Scoring is exact-match
 * after normalisation (whitespace strip + lowercase). `alternativeAnswers`
 * lets us accept multiple correct surface forms (e.g. "kitchen" or "the kitchen").
 *
 * This format preserves comparability with published BABILong baselines —
 * we deliberately do NOT convert these to MCQ.
 */
export interface FreeFormQuery {
  /** Discriminator. Required for free-form queries (no default). */
  kind: "free-form";
  id: string;
  question: string;
  /** The canonical ground-truth answer string. */
  correctAnswer: string;
  /** Optional additional surface forms accepted as correct. */
  alternativeAnswers?: string[];
  /** Ground truth event IDs (facts) that the answer should be supported by. */
  relevantEventIds: string[];
  /** Optional categorisation (e.g. BABILong task name: "task1", "task2", "task3"). */
  category?: string;
  /** Optional hint about which shard(s) the answer lives in. */
  shardHints?: string[];
}

/**
 * Discriminated union of every query kind the benchmark supports.
 * Existing PaySwift queries (which lack a `kind` field) are treated as `mcq`
 * via the Zod default below.
 */
export type Query = McqQuery | FreeFormQuery;

/**
 * Output from one baseline runner answering one MCQ query.
 */
export interface McqAnswer {
  kind?: "mcq";
  /** 1-indexed option chosen by the LLM, or `null` if output couldn't be parsed. */
  chosenOption: number | null;
  /** Event IDs the system claims support its answer (for citation P/R). */
  citedEventIds: string[];
  /** Raw LLM output text (kept for debugging and for the wins/losses analysis). */
  rawOutput: string;
  /** Populated when `chosenOption === null`. */
  parseError?: string;
}

/**
 * Output from one baseline runner answering one free-form (BABILong-style) query.
 */
export interface FreeFormAnswer {
  kind: "free-form";
  /** Normalised short answer string the LLM produced, or `null` if unparseable. */
  chosenAnswer: string | null;
  /** Event IDs the system claims support its answer. */
  citedEventIds: string[];
  /** Raw LLM output text (kept for debugging). */
  rawOutput: string;
  /** Populated when `chosenAnswer === null`. */
  parseError?: string;
}

/**
 * Discriminated union of every answer kind a baseline can return.
 */
export type Answer = McqAnswer | FreeFormAnswer;

const McqQueryZ = z.object({
  // Optional discriminator with default — preserves back-compat with existing queries.json.
  kind: z.literal("mcq").default("mcq"),
  id: z.string().min(1),
  question: z.string().min(1),
  options: z.array(z.string().min(1)).min(2),
  correctOption: z.number().int().positive(),
  relevantEventIds: z.array(z.string()),
  category: z.enum(["single-shard", "multi-shard", "adversarial"]).optional(),
  shardHints: z.array(z.string()).optional(),
});

const FreeFormQueryZ = z.object({
  kind: z.literal("free-form"),
  id: z.string().min(1),
  question: z.string().min(1),
  correctAnswer: z.string().min(1),
  alternativeAnswers: z.array(z.string()).optional(),
  relevantEventIds: z.array(z.string()),
  category: z.string().optional(),
  shardHints: z.array(z.string()).optional(),
});

/** Discriminated-union schema for any query the runner can score. */
export const QueryZ = z.discriminatedUnion("kind", [McqQueryZ, FreeFormQueryZ]);

/**
 * Schema for the on-disk MCQ queries.json file (PaySwift format).
 * Free-form corpora ship their own file format; see corpus/babilong.ts.
 */
export const McqQueriesFileZ = z.object({
  version: z.literal(1),
  queries: z.array(McqQueryZ),
});

/**
 * Schema for an on-disk free-form queries file (BABILong tasks etc).
 */
export const FreeFormQueriesFileZ = z.object({
  version: z.literal(1),
  queries: z.array(FreeFormQueryZ),
});

/**
 * Validate one MCQ query and assert correctOption is in range.
 * Throws on invalid input — these are our test fixtures, fail loud.
 */
export function validateMcqQuery(input: unknown): McqQuery {
  const parsed = McqQueryZ.parse(input);
  if (parsed.correctOption < 1 || parsed.correctOption > parsed.options.length) {
    throw new Error(
      `Query ${parsed.id}: correctOption ${parsed.correctOption} ` +
        `out of range 1..${parsed.options.length}`
    );
  }
  return parsed;
}

/**
 * Validate one query of any kind. Dispatches on `kind`.
 */
export function validateQuery(input: unknown): Query {
  // Tolerate inputs without `kind` for back-compat (existing queries.json).
  if (input && typeof input === "object" && !("kind" in input) && "options" in input) {
    return validateMcqQuery(input);
  }
  const parsed = QueryZ.parse(input);
  if (parsed.kind === "mcq") {
    return validateMcqQuery(parsed);
  }
  return parsed;
}

/**
 * Type guards.
 */
export function isMcqQuery(q: Query): q is McqQuery {
  return q.kind === undefined || q.kind === "mcq";
}

export function isFreeFormQuery(q: Query): q is FreeFormQuery {
  return q.kind === "free-form";
}

/**
 * Build the LLM prompt for one MCQ query, given the retrieved context the
 * baseline assembled.
 *
 * Output contract requested from the model:
 *
 *   ANSWER: <single number from 1 to N>
 *   CITATIONS: <comma-separated event IDs, or "none">
 *
 * The parser (`parseMcqOutput`) tolerates extra text around these lines so
 * verbose models (Gemma sometimes is) don't penalise the system unfairly.
 */
export function formatMcqPrompt(
  query: McqQuery,
  retrievedContext: string
): string {
  const optionsBlock = query.options
    .map((opt, i) => `${i + 1}. ${opt}`)
    .join("\n");

  return `You are answering a multiple-choice question about a project's history.

CONTEXT (retrieved events from the project memory):
${retrievedContext}

QUESTION: ${query.question}

OPTIONS:
${optionsBlock}

Instructions:
- Identify the relevant fact(s) in the CONTEXT.
- Match those facts against the OPTIONS to find the single best one.
- Some options may describe true but secondary project facts; choose the option that directly answers the QUESTION's focus, not merely any true statement from the CONTEXT.
- If multiple options share partial facts, choose the most complete option supported by the CONTEXT.
- DO NOT enumerate every option in your reasoning. Keep any reasoning under three sentences.
- End your response with EXACTLY these two final lines (no text after them):

ANSWER: <a single number from 1 to ${query.options.length}>
CITATIONS: <comma-separated event IDs from the context that support your answer, or "none">`;
}

/**
 * Build the LLM prompt for one free-form query.
 *
 * Output contract:
 *   ANSWER: <short answer text>
 *   CITATIONS: <comma-separated event IDs, or "none">
 *
 * The parser tolerates extra prose around these lines.
 */
export function formatFreeFormPrompt(
  query: FreeFormQuery,
  retrievedContext: string,
): string {
  return `You are answering a question about a sequence of facts.

CONTEXT (retrieved facts):
${retrievedContext}

QUESTION: ${query.question}

Respond with EXACTLY two lines, no other text:
ANSWER: <one short word or phrase>
CITATIONS: <comma-separated event IDs from the context that support your answer, or "none">`;
}

/** Normalise a free-form answer string for exact-match comparison. */
export function normaliseFreeFormAnswer(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[.!?,;:]+$/g, "")
    .replace(/^the\s+/, "")
    .replace(/\s+/g, " ");
}

/**
 * Strip wrapper punctuation the answering model sometimes puts around a cited
 * id — `[e0002]`, `(e0002)`, `` `e0002` ``, `**e0002**`, quotes — so the token
 * exact-matches the bare ids in `relevantEventIds`. Without this, a model that
 * echoes its context's bracketed style (e.g. the LightRAG sidecar packs
 * `[e0002] …`) scores zero citation overlap despite citing the right events,
 * while a model that emits bare ids scores fine — an artifact of formatting,
 * not of retrieval quality. Internal hyphens (`f3-0155-v002-v002`) are kept.
 */
export function normalizeCitationId(token: string): string {
  // Strip wrapper + trailing sentence punctuation (`.`, `!`, `?`, `:`) the model
  // sometimes appends — e.g. "e0009]." → "e0009". Event ids never start/end with
  // these, and internal hyphens (f3-0155-v002-v002) are untouched.
  return token
    .trim()
    .replace(/^[\s\[\](){}`'"*.!?:]+|[\s\[\](){}`'"*.!?:]+$/g, "")
    .trim();
}

/**
 * Parse a `CITATIONS: …` payload into clean event ids: split on `,`/`;`,
 * strip wrapper punctuation per {@link normalizeCitationId}, drop blanks/"none".
 */
export function parseCitationList(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === "none") return [];
  return trimmed
    .split(/[,;]/)
    .map((s) => normalizeCitationId(s))
    .filter((s) => s.length > 0 && s.toLowerCase() !== "none");
}

/**
 * Parse an LLM's raw output for a free-form query.
 * Returns the answer string verbatim (not yet normalised); the scorer
 * normalises on both sides before comparing.
 */
export function parseFreeFormOutput(rawOutput: string): FreeFormAnswer {
  const text = rawOutput ?? "";
  let chosenAnswer: string | null = null;
  let parseError: string | undefined;

  const answerMatch = text.match(/ANSWER\s*[:=]\s*([^\n\r]+)/i);
  if (answerMatch) {
    const raw = answerMatch[1]!.trim();
    if (raw.length > 0) {
      chosenAnswer = raw;
    } else {
      parseError = "ANSWER line was empty";
    }
  } else {
    // Fallback: take the first non-empty line as the answer.
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length > 0 && !/^citations\s*[:=]/i.test(trimmed)) {
        chosenAnswer = trimmed;
        break;
      }
    }
    if (chosenAnswer === null) parseError = "No ANSWER line found";
  }

  // Citations: reuse the same regex as parseMcqOutput.
  const citedEventIds: string[] = [];
  const citationsMatch = text.match(/CITATIONS\s*[:=]\s*([^\n\r]+)/i);
  if (citationsMatch) {
    citedEventIds.push(...parseCitationList(citationsMatch[1]!));
  }

  return {
    kind: "free-form",
    chosenAnswer,
    citedEventIds,
    rawOutput: text,
    parseError,
  };
}

/**
 * Parse an LLM's raw output for an MCQ query.
 *
 * Permissive parsing: tolerates extra text around the ANSWER and CITATIONS
 * lines (Gemma 4 occasionally adds a sentence of justification). Returns
 * `chosenOption: null` and a populated `parseError` when nothing usable is
 * found — the runner records that as an automatic miss.
 */
export function parseMcqOutput(
  rawOutput: string,
  numOptions: number
): McqAnswer {
  const text = rawOutput ?? "";
  let chosenOption: number | null = null;
  let parseError: string | undefined;

  // Primary: explicit "ANSWER: N" pattern, case-insensitive. When the model
  // does chain-of-thought it may produce multiple "ANSWER:" candidates inside
  // its reasoning — we want the LAST one, which is the conclusion line.
  const allAnswerMatches = [...text.matchAll(/ANSWER\s*[:=]\s*(\d+)/gi)];
  const answerMatch = allAnswerMatches.length > 0
    ? allAnswerMatches[allAnswerMatches.length - 1]
    : null;
  if (answerMatch) {
    const n = Number.parseInt(answerMatch[1]!, 10);
    if (n >= 1 && n <= numOptions) {
      chosenOption = n;
    } else {
      parseError = `ANSWER value ${n} out of range 1..${numOptions}`;
    }
  } else {
    // Secondary fallback: "Option N" / "option N" / "Choice N" patterns —
    // thinking models that ran out of budget before reaching the ANSWER tail
    // typically said "Option N is correct" or "the answer is Option N" inside
    // their reasoning. Prefer the LAST such mention (most committed). Much
    // more reliable than scanning for any integer, which catches incidental
    // numbers like "21 CFR Part 11" or "Bun 1.1" → wrong option.
    const optionMatches = [...text.matchAll(/\b(?:option|choice|answer)\s+(\d+)\b/gi)];
    if (optionMatches.length > 0) {
      const last = optionMatches[optionMatches.length - 1]!;
      const n = Number.parseInt(last[1]!, 10);
      if (n >= 1 && n <= numOptions) {
        chosenOption = n;
      }
    }
    // Tertiary fallback (last resort): first standalone integer in 1..numOptions.
    if (chosenOption === null) {
      const numbers = text.match(/\b\d+\b/g) ?? [];
      for (const s of numbers) {
        const n = Number.parseInt(s, 10);
        if (n >= 1 && n <= numOptions) {
          chosenOption = n;
          break;
        }
      }
    }
    if (chosenOption === null) {
      parseError = `No ANSWER pattern, no "Option N" mention, and no integer in 1..${numOptions} found`;
    }
  }

  // Citations: extract from the LAST "CITATIONS: ..." line (same CoT logic).
  const citedEventIds: string[] = [];
  const allCitationsMatches = [...text.matchAll(/CITATIONS\s*[:=]\s*([^\n\r]+)/gi)];
  const citationsMatch = allCitationsMatches.length > 0
    ? allCitationsMatches[allCitationsMatches.length - 1]
    : null;
  if (citationsMatch) {
    citedEventIds.push(...parseCitationList(citationsMatch[1]!));
  }

  return {
    chosenOption,
    citedEventIds,
    rawOutput: text,
    parseError,
  };
}
