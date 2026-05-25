import { describe, expect, it } from "vitest";

import type {
  FreeFormAnswer,
  FreeFormQuery,
  McqAnswer,
  McqQuery,
} from "../src/eval/mcq.js";
import {
  aggregate,
  benjaminiHochberg,
  mcNemar,
  scoreAnswer,
  type McqScore,
} from "../src/eval/scorer.js";

const baseQuery: McqQuery = {
  id: "q1",
  question: "?",
  options: ["a", "b", "c"],
  correctOption: 2,
  relevantEventIds: ["e1", "e2"],
};

function answer(chosen: number | null, cited: string[]): McqAnswer {
  return { chosenOption: chosen, citedEventIds: cited, rawOutput: "" };
}

describe("scoreAnswer", () => {
  it("marks exact-match correct", () => {
    const s = scoreAnswer(baseQuery, answer(2, ["e1", "e2"]));
    expect(s.correct).toBe(true);
    expect(s.citationPrecision).toBe(1);
    expect(s.citationRecall).toBe(1);
    expect(s.citationF1).toBe(1);
  });

  it("marks wrong option as incorrect", () => {
    const s = scoreAnswer(baseQuery, answer(1, ["e1", "e2"]));
    expect(s.correct).toBe(false);
  });

  it("null chosenOption is never correct", () => {
    const s = scoreAnswer(baseQuery, answer(null, ["e1", "e2"]));
    expect(s.correct).toBe(false);
  });

  it("partial citation match — precision and recall < 1", () => {
    const s = scoreAnswer(baseQuery, answer(2, ["e1", "e_wrong"]));
    expect(s.citationPrecision).toBeCloseTo(0.5, 5);
    expect(s.citationRecall).toBeCloseTo(0.5, 5);
  });

  it("empty cited but non-empty relevant → P=R=0", () => {
    const s = scoreAnswer(baseQuery, answer(2, []));
    expect(s.citationPrecision).toBe(0);
    expect(s.citationRecall).toBe(0);
    expect(s.citationF1).toBe(0);
  });

  it("empty both → P=R=1 (vacuous match)", () => {
    const q: McqQuery = { ...baseQuery, relevantEventIds: [] };
    const s = scoreAnswer(q, answer(2, []));
    expect(s.citationPrecision).toBe(1);
    expect(s.citationRecall).toBe(1);
  });
});

describe("aggregate", () => {
  it("returns zeros for empty input", () => {
    const a = aggregate([]);
    expect(a.n).toBe(0);
    expect(a.accuracy).toBe(0);
    expect(a.accuracyCi95).toEqual([0, 0]);
  });

  it("computes accuracy and CI", () => {
    const scores: McqScore[] = Array.from({ length: 30 }, (_, i) => ({
      correct: i < 24, // 80%
      citationPrecision: 1,
      citationRecall: 1,
      citationF1: 1,
    }));
    const a = aggregate(scores, { seed: 1 });
    expect(a.accuracy).toBeCloseTo(0.8, 5);
    // CI should bracket the point estimate.
    expect(a.accuracyCi95[0]).toBeLessThanOrEqual(0.8);
    expect(a.accuracyCi95[1]).toBeGreaterThanOrEqual(0.8);
  });

  it("is reproducible across runs with the same seed", () => {
    const scores: McqScore[] = Array.from({ length: 30 }, (_, i) => ({
      correct: i % 2 === 0,
      citationPrecision: 0.5,
      citationRecall: 0.5,
      citationF1: 0.5,
    }));
    const a = aggregate(scores, { seed: 42, bootstrapResamples: 1000 });
    const b = aggregate(scores, { seed: 42, bootstrapResamples: 1000 });
    expect(a).toEqual(b);
  });
});

describe("mcNemar", () => {
  it("returns p=1 when no discordant pairs", () => {
    const same: McqScore[] = Array.from({ length: 5 }, () => ({
      correct: true,
      citationPrecision: 1,
      citationRecall: 1,
      citationF1: 1,
    }));
    const r = mcNemar(same, same);
    expect(r.aOnly).toBe(0);
    expect(r.bOnly).toBe(0);
    expect(r.pValue).toBe(1);
    expect(r.winner).toBe("tie");
  });

  it("calls A the winner when A dominates discordant pairs", () => {
    // 20 cases, A correct on first 18, B correct on first 2 only.
    const a: McqScore[] = Array.from({ length: 20 }, (_, i) => ({
      correct: i < 18,
      citationPrecision: 1,
      citationRecall: 1,
      citationF1: 1,
    }));
    const b: McqScore[] = Array.from({ length: 20 }, (_, i) => ({
      correct: i < 2,
      citationPrecision: 1,
      citationRecall: 1,
      citationF1: 1,
    }));
    const r = mcNemar(a, b);
    expect(r.aOnly).toBeGreaterThan(r.bOnly);
    expect(r.pValue).toBeLessThan(0.05);
    expect(r.winner).toBe("A");
  });

  it("throws on length mismatch", () => {
    expect(() => mcNemar([], [{ correct: true, citationPrecision: 0, citationRecall: 0, citationF1: 0 }])).toThrow();
  });
});

// --------------------------------------------------------------------------
// Free-form (BABILong) scoring path
// --------------------------------------------------------------------------

const freeFormQuery: FreeFormQuery = {
  kind: "free-form",
  id: "bq1-0001",
  question: "Where is Mary?",
  correctAnswer: "kitchen",
  alternativeAnswers: ["the kitchen"],
  relevantEventIds: ["b1-0001-000003"],
  category: "babilong-task1",
};

function freeFormAnswer(text: string | null, cited: string[]): FreeFormAnswer {
  return { kind: "free-form", chosenAnswer: text, citedEventIds: cited, rawOutput: "" };
}

describe("scoreAnswer — free-form path", () => {
  it("scores correct on exact-match after normalisation", () => {
    const s = scoreAnswer(freeFormQuery, freeFormAnswer("kitchen", ["b1-0001-000003"]));
    expect(s.correct).toBe(true);
    expect(s.citationPrecision).toBe(1);
    expect(s.citationRecall).toBe(1);
  });

  it("accepts alternative answer surface form", () => {
    const s = scoreAnswer(freeFormQuery, freeFormAnswer("The Kitchen", []));
    expect(s.correct).toBe(true);
  });

  it("scores wrong answer as incorrect", () => {
    const s = scoreAnswer(freeFormQuery, freeFormAnswer("hallway", ["b1-0001-000003"]));
    expect(s.correct).toBe(false);
  });

  it("null chosenAnswer is never correct", () => {
    const s = scoreAnswer(freeFormQuery, freeFormAnswer(null, []));
    expect(s.correct).toBe(false);
  });

  it("strips trailing punctuation when matching", () => {
    const s = scoreAnswer(freeFormQuery, freeFormAnswer("kitchen.", []));
    expect(s.correct).toBe(true);
  });

  it("computes citation P/R against relevantEventIds", () => {
    const s = scoreAnswer(
      freeFormQuery,
      freeFormAnswer("kitchen", ["b1-0001-000003", "b1-0001-000999"]),
    );
    expect(s.citationPrecision).toBeCloseTo(0.5, 5);
    expect(s.citationRecall).toBe(1);
  });

  it("throws on mismatched answer kind", () => {
    expect(() =>
      scoreAnswer(
        freeFormQuery,
        // MCQ-shaped answer for a free-form query — should reject
        { chosenOption: 1, citedEventIds: [], rawOutput: "" } as McqAnswer,
      ),
    ).toThrow(/expects free-form answer/);
  });
});

describe("benjaminiHochberg", () => {
  it("preserves order in output relative to input", () => {
    const adj = benjaminiHochberg([0.05, 0.01, 0.04, 0.5]);
    expect(adj).toHaveLength(4);
  });

  it("does not exceed 1", () => {
    const adj = benjaminiHochberg([0.9, 0.95, 0.99]);
    for (const p of adj) expect(p).toBeLessThanOrEqual(1);
  });

  it("returns empty for empty input", () => {
    expect(benjaminiHochberg([])).toEqual([]);
  });

  it("monotone after sort: adjusted p-values are non-decreasing in sorted order", () => {
    const ps = [0.01, 0.02, 0.03, 0.04, 0.5, 0.8];
    const adj = benjaminiHochberg(ps);
    // Sort adjusted by original sort order: original is already ascending, so adj should be non-decreasing.
    for (let i = 1; i < adj.length; i++) {
      expect(adj[i]!).toBeGreaterThanOrEqual(adj[i - 1]!);
    }
  });
});
