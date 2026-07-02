import { describe, it, expect } from "vitest";
import {
  rankVocab,
  estReturnTokens,
  greedyCoverageOrder,
  coverageRerankAndPack,
  resolveRerankParams,
} from "../src/eval/ambReturnRank.js";

const TEXT: Record<string, string> = {
  e1: "onlyfoo onlyfoo onlyfoo",
  e2: "onlyfoo barbar",
  e3: "onlyfoo barbar bazbaz quxqux extraone extratwo widgets",
  eq: "apple banana",
  enq: "cherry datepalm elderberry",
};
const get = (id: string): string => TEXT[id] ?? "";

describe("greedyCoverageOrder", () => {
  it("front-loads the highest-marginal-coverage event even if it was last", () => {
    const out = greedyCoverageOrder(["e1", "e2", "e3"], get, "zzz", 1, 0);
    expect(out[0]).toBe("e3"); // most distinct vocabulary
  });

  it("is deterministic and does not mutate the input", () => {
    const ids = ["e1", "e2", "e3"];
    const a = greedyCoverageOrder(ids, get, "barbar", 4, 0.5);
    const b = greedyCoverageOrder(ids, get, "barbar", 4, 0.5);
    expect(a).toEqual(b);
    expect(ids).toEqual(["e1", "e2", "e3"]); // unmutated
  });

  it("query weighting promotes a query-bearing event over a higher-diversity one", () => {
    // enq has 3 new terms, eq has 2 (one is the query term "apple").
    expect(greedyCoverageOrder(["enq", "eq"], get, "apple", 1, 0)[0]).toBe("enq"); // diversity
    expect(greedyCoverageOrder(["enq", "eq"], get, "apple", 4, 0)[0]).toBe("eq"); // query-weighted
  });
});

describe("coverageRerankAndPack", () => {
  const params = (budget: number) => resolveRerankParams({ reasoning: false, budgetTokens: budget, maxCount: 64 });

  it("packs to the token budget (always >= 1, never over once >1)", () => {
    const ids = ["e1", "e2", "e3"];
    const tiny = coverageRerankAndPack(ids, get, "zzz", params(5));
    expect(tiny.length).toBe(1); // one event always fits
    const big = coverageRerankAndPack(ids, get, "zzz", params(100000));
    expect(big.length).toBe(3);
    // budget respected: dropping the last kept event would be under budget
    const mid = coverageRerankAndPack(ids, get, "zzz", params(20));
    const used = mid.reduce((s, id) => s + estReturnTokens(get(id)), 0);
    const withoutLast = mid.slice(0, -1).reduce((s, id) => s + estReturnTokens(get(id)), 0);
    expect(withoutLast).toBeLessThanOrEqual(20);
    expect(mid.length).toBeGreaterThanOrEqual(1);
    expect(used).toBeGreaterThan(0);
  });

  it("respects the maxCount safety cap", () => {
    const ids = ["e1", "e2", "e3"];
    const capped = coverageRerankAndPack(ids, get, "zzz", { queryWeight: 4, normPow: 0.5, budgetTokens: 100000, maxCount: 2 });
    expect(capped.length).toBe(2);
  });
});

describe("resolveRerankParams", () => {
  it("uses per-token normalization for reasoning, sqrt otherwise", () => {
    expect(resolveRerankParams({ reasoning: true, budgetTokens: 16000 }).normPow).toBe(1);
    expect(resolveRerankParams({ reasoning: false, budgetTokens: 16000 }).normPow).toBe(0.5);
  });
});

describe("rankVocab / estReturnTokens", () => {
  it("drops stopwords and short tokens, lowercases", () => {
    const v = rankVocab("The Quick brown fox an a");
    expect(v.has("quick")).toBe(true);
    expect(v.has("brown")).toBe(true);
    expect(v.has("the")).toBe(false); // stopword
    expect(v.has("an")).toBe(false); // < 3 chars
  });

  it("estimates tokens at char/4", () => {
    expect(estReturnTokens("abcdefgh")).toBe(2);
  });
});
