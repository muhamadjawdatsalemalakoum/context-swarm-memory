import { describe, expect, it } from "vitest";

import {
  formatFreeFormPrompt,
  formatMcqPrompt,
  isFreeFormQuery,
  isMcqQuery,
  normaliseFreeFormAnswer,
  normalizeCitationId,
  parseCitationList,
  parseFreeFormOutput,
  parseMcqOutput,
  validateMcqQuery,
  validateQuery,
  type FreeFormQuery,
  type McqQuery,
} from "../src/eval/mcq.js";

const sampleQuery: McqQuery = {
  id: "q1",
  question: "What did the team decide about the database?",
  options: Array.from({ length: 40 }, (_, i) => `Option ${i + 1}`),
  correctOption: 7,
  relevantEventIds: ["e042", "e156"],
};

describe("parseMcqOutput — happy path", () => {
  it("extracts ANSWER + CITATIONS lines", () => {
    const out = parseMcqOutput(
      "ANSWER: 7\nCITATIONS: e042, e156",
      40,
    );
    expect(out.chosenOption).toBe(7);
    expect(out.citedEventIds).toEqual(["e042", "e156"]);
    expect(out.parseError).toBeUndefined();
  });

  it("is case-insensitive", () => {
    const out = parseMcqOutput("answer: 12\ncitations: e1", 40);
    expect(out.chosenOption).toBe(12);
    expect(out.citedEventIds).toEqual(["e1"]);
  });

  it("handles `none` citations", () => {
    const out = parseMcqOutput("ANSWER: 3\nCITATIONS: none", 40);
    expect(out.chosenOption).toBe(3);
    expect(out.citedEventIds).toEqual([]);
  });

  it("handles `=` separator (alt format)", () => {
    const out = parseMcqOutput("ANSWER = 5", 40);
    expect(out.chosenOption).toBe(5);
  });

  it("tolerates verbose prose around the ANSWER line", () => {
    const out = parseMcqOutput(
      "After reading the events, I believe the answer is:\n\nANSWER: 22\n\nThis is supported by:\nCITATIONS: e1, e2, e3",
      40,
    );
    expect(out.chosenOption).toBe(22);
    expect(out.citedEventIds).toEqual(["e1", "e2", "e3"]);
  });
});

describe("parseMcqOutput — fallback parsing", () => {
  it("falls back to first in-range integer when ANSWER is missing", () => {
    const out = parseMcqOutput("I think 12 is best.", 40);
    expect(out.chosenOption).toBe(12);
    // No parse error because we found *something*.
    expect(out.parseError).toBeUndefined();
  });

  it("skips out-of-range integers in fallback", () => {
    const out = parseMcqOutput("Maybe 99 or 5?", 40);
    expect(out.chosenOption).toBe(5);
  });

  it("secondary fallback: prefers 'Option N' over incidental integers", () => {
    // Real failure mode from the iter1b bench: model ran out of budget on q02
    // before reaching 'ANSWER:' but its reasoning said 'Option 11 is listed'.
    // The first integer in the text is '1.1' from "Hono v4 on Bun 1.1" — the
    // primary fallback (any integer) picks 1, which is wrong. The "Option N"
    // secondary fallback must win because it's a stronger committal signal.
    const out = parseMcqOutput(
      "The runtime was Bun 1.1 with Hono v4. Looking at the options, Option 11 is listed.",
      40,
    );
    expect(out.chosenOption).toBe(11);
  });

  it("secondary fallback: picks LAST 'Option N' mention when multiple", () => {
    const out = parseMcqOutput(
      "First I considered Option 5, then Option 7, but the answer is Option 11.",
      40,
    );
    // The pattern matches "Option 5", "Option 7", "answer is 11" and "Option 11".
    // Last is "Option 11" → pick 11.
    expect(out.chosenOption).toBe(11);
  });

  it("secondary fallback matches 'choice N' and 'answer N' too", () => {
    expect(parseMcqOutput("My choice 23 is final.", 40).chosenOption).toBe(23);
    expect(parseMcqOutput("So the answer 7 is best.", 40).chosenOption).toBe(7);
  });
});

describe("parseMcqOutput — failure modes", () => {
  it("returns null + parseError when no usable number found", () => {
    const out = parseMcqOutput("I don't know", 40);
    expect(out.chosenOption).toBeNull();
    expect(out.parseError).toContain("No ANSWER pattern");
  });

  it("returns null when ANSWER value is out of range", () => {
    const out = parseMcqOutput("ANSWER: 99", 40);
    expect(out.chosenOption).toBeNull();
    expect(out.parseError).toContain("out of range");
  });

  it("handles empty / null-ish input gracefully", () => {
    const out = parseMcqOutput("", 40);
    expect(out.chosenOption).toBeNull();
    expect(out.parseError).toBeDefined();
  });
});

describe("formatMcqPrompt", () => {
  it("includes context, question, all 40 options, and response instructions", () => {
    const prompt = formatMcqPrompt(sampleQuery, "Some retrieved events here.");
    expect(prompt).toContain("Some retrieved events here.");
    expect(prompt).toContain("What did the team decide");
    expect(prompt).toContain("1. Option 1");
    expect(prompt).toContain("40. Option 40");
    expect(prompt).toContain("ANSWER:");
    expect(prompt).toContain("CITATIONS:");
  });

  it("respects custom option count", () => {
    const tiny: McqQuery = { ...sampleQuery, options: ["a", "b", "c"], correctOption: 2 };
    const prompt = formatMcqPrompt(tiny, "ctx");
    expect(prompt).toContain("from 1 to 3");
    expect(prompt).not.toContain("4. ");
  });
});

describe("validateMcqQuery", () => {
  it("accepts a well-formed query", () => {
    expect(() => validateMcqQuery(sampleQuery)).not.toThrow();
  });

  it("throws when correctOption is out of range", () => {
    const bad = { ...sampleQuery, correctOption: 99 };
    expect(() => validateMcqQuery(bad)).toThrow(/out of range/);
  });

  it("throws when correctOption is zero", () => {
    const bad = { ...sampleQuery, correctOption: 0 };
    expect(() => validateMcqQuery(bad)).toThrow();
  });

  it("throws on missing fields", () => {
    const bad = { id: "x", question: "?" };
    expect(() => validateMcqQuery(bad)).toThrow();
  });
});

// --------------------------------------------------------------------------
// Free-form query path (BABILong-style)
// --------------------------------------------------------------------------

const sampleFreeForm: FreeFormQuery = {
  kind: "free-form",
  id: "bq1-0001",
  question: "Where is Mary?",
  correctAnswer: "kitchen",
  alternativeAnswers: ["the kitchen"],
  relevantEventIds: ["b1-0001-000003"],
  category: "babilong-task1",
};

describe("normaliseFreeFormAnswer", () => {
  it("lowercases + trims", () => {
    expect(normaliseFreeFormAnswer("  KITCHEN  ")).toBe("kitchen");
  });

  it("strips trailing punctuation", () => {
    expect(normaliseFreeFormAnswer("kitchen.")).toBe("kitchen");
    expect(normaliseFreeFormAnswer("kitchen!")).toBe("kitchen");
  });

  it("strips leading 'the'", () => {
    expect(normaliseFreeFormAnswer("the kitchen")).toBe("kitchen");
  });

  it("collapses internal whitespace", () => {
    expect(normaliseFreeFormAnswer("kitchen   floor")).toBe("kitchen floor");
  });
});

describe("formatFreeFormPrompt", () => {
  it("includes context, question, and ANSWER/CITATIONS instructions", () => {
    const prompt = formatFreeFormPrompt(sampleFreeForm, "Mary went to the kitchen.");
    expect(prompt).toContain("Mary went to the kitchen");
    expect(prompt).toContain("Where is Mary?");
    expect(prompt).toContain("ANSWER:");
    expect(prompt).toContain("CITATIONS:");
  });
});

describe("parseFreeFormOutput", () => {
  it("extracts ANSWER text + CITATIONS", () => {
    const out = parseFreeFormOutput("ANSWER: kitchen\nCITATIONS: b1-0001-000003");
    expect(out.chosenAnswer).toBe("kitchen");
    expect(out.citedEventIds).toEqual(["b1-0001-000003"]);
    expect(out.parseError).toBeUndefined();
  });

  it("handles `none` citations", () => {
    const out = parseFreeFormOutput("ANSWER: kitchen\nCITATIONS: none");
    expect(out.chosenAnswer).toBe("kitchen");
    expect(out.citedEventIds).toEqual([]);
  });

  it("falls back to first non-empty line when ANSWER is missing", () => {
    const out = parseFreeFormOutput("kitchen\nCITATIONS: e1");
    expect(out.chosenAnswer).toBe("kitchen");
  });

  it("returns null + parseError on empty input", () => {
    const out = parseFreeFormOutput("");
    expect(out.chosenAnswer).toBeNull();
    expect(out.parseError).toBeDefined();
  });

  it("is case-insensitive on ANSWER label", () => {
    const out = parseFreeFormOutput("answer: hallway");
    expect(out.chosenAnswer).toBe("hallway");
  });
});

describe("validateQuery (dispatcher)", () => {
  it("accepts a free-form query", () => {
    const q = validateQuery(sampleFreeForm);
    expect(q.kind).toBe("free-form");
  });

  it("accepts an MCQ query with kind:'mcq' tag", () => {
    const tagged = { ...sampleQuery, kind: "mcq" };
    const q = validateQuery(tagged);
    expect(q.kind === undefined || q.kind === "mcq").toBe(true);
  });

  it("accepts a legacy MCQ query without kind field", () => {
    const q = validateQuery(sampleQuery);
    expect(q.kind === undefined || q.kind === "mcq").toBe(true);
  });
});

describe("type guards", () => {
  it("isMcqQuery true on legacy and tagged MCQ", () => {
    expect(isMcqQuery(sampleQuery)).toBe(true);
    expect(isMcqQuery({ ...sampleQuery, kind: "mcq" } as McqQuery)).toBe(true);
  });

  it("isMcqQuery false on free-form", () => {
    expect(isMcqQuery(sampleFreeForm)).toBe(false);
  });

  it("isFreeFormQuery true on free-form, false on MCQ", () => {
    expect(isFreeFormQuery(sampleFreeForm)).toBe(true);
    expect(isFreeFormQuery(sampleQuery)).toBe(false);
  });
});

describe("normalizeCitationId — strip wrapper punctuation", () => {
  it("leaves a bare id untouched", () => {
    expect(normalizeCitationId("e0002")).toBe("e0002");
  });

  it("strips square brackets (the LightRAG/context-echo case)", () => {
    expect(normalizeCitationId("[e0002]")).toBe("e0002");
  });

  it("strips parens, backticks, asterisks, quotes", () => {
    expect(normalizeCitationId("(e0002)")).toBe("e0002");
    expect(normalizeCitationId("`e0002`")).toBe("e0002");
    expect(normalizeCitationId("**e0002**")).toBe("e0002");
    expect(normalizeCitationId('"e0002"')).toBe("e0002");
  });

  it("strips a single dangling bracket from a split token", () => {
    // "[e0002, e0003]" splits on the comma into "[e0002" and " e0003]".
    expect(normalizeCitationId("[e0002")).toBe("e0002");
    expect(normalizeCitationId("e0003]")).toBe("e0003");
  });

  it("keeps internal hyphens (LightRAG filler ids like f3-0155-v002-v002)", () => {
    expect(normalizeCitationId("[f3-0155-v002-v002]")).toBe("f3-0155-v002-v002");
  });

  it("strips trailing sentence punctuation the model appends (e0009]. → e0009)", () => {
    expect(normalizeCitationId("e0009].")).toBe("e0009");
    expect(normalizeCitationId("e0009.")).toBe("e0009");
    expect(normalizeCitationId("e0009:")).toBe("e0009");
  });
});

describe("parseCitationList — split + normalise", () => {
  it("splits and strips brackets on each token", () => {
    expect(parseCitationList("[e0002], [e0003]")).toEqual(["e0002", "e0003"]);
  });

  it("handles a bracketed comma-list captured as one token", () => {
    expect(parseCitationList("[e0002, e0003]")).toEqual(["e0002", "e0003"]);
  });

  it("returns [] for none/empty", () => {
    expect(parseCitationList("none")).toEqual([]);
    expect(parseCitationList("   ")).toEqual([]);
  });
});

describe("parseMcqOutput — bracketed citations (regression for citation-F1 bug)", () => {
  it("recovers ids the model wrapped in brackets so they exact-match ground truth", () => {
    // Before the fix this returned ["[e0002]", "[e0003]"] and scored citationF1=0
    // against relevantEventIds ["e0002","e0003",...] despite citing the right events.
    const out = parseMcqOutput("ANSWER: 7\nCITATIONS: [e0002], [e0003]", 40);
    expect(out.chosenOption).toBe(7);
    expect(out.citedEventIds).toEqual(["e0002", "e0003"]);
  });

  it("free-form parser strips brackets too", () => {
    const out = parseFreeFormOutput("ANSWER: yes\nCITATIONS: [e0002]; (e0003)");
    expect(out.citedEventIds).toEqual(["e0002", "e0003"]);
  });
});
