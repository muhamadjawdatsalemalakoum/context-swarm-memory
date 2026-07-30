/**
 * Tests for the BEAM answer judge (`src/eval/beamJudge.ts`).
 *
 * The load-bearing case is `reproduces_official_ordering_score_exactly`: the
 * claim that BEAM scores event_ordering as (1 + Kendall tau-b)/2 was
 * reverse-engineered from the official score distribution, not read from AMB
 * source. This test pins the arithmetic so a future refactor cannot quietly
 * break the reconstruction — and so the claim stays falsifiable.
 */
import { describe, expect, it } from "vitest";

import {
  categoryOf,
  judgeModeFor,
  kendallTauB,
  orderingScoreFromPositions,
  rubricFractionScore,
  rubricItemText,
  literalItemPositions,
  parseVerdicts,
  parseOrderingPositions,
  agreementReport,
  pairedDelta,
  minimumDetectableEffect,
  splitAssignment,
} from "../src/eval/beamJudge.js";

describe("categoryOf / judgeModeFor", () => {
  it("parses multi-word categories out of BEAM query ids", () => {
    expect(categoryOf("1_abstention_0")).toBe("abstention");
    expect(categoryOf("12_multi_session_reasoning_3")).toBe("multi_session_reasoning");
    expect(categoryOf("4_event_ordering_0")).toBe("event_ordering");
  });

  it("routes only event_ordering to the rank-correlation judge", () => {
    expect(judgeModeFor("event_ordering")).toBe("ordering");
    expect(judgeModeFor("summarization")).toBe("rubric-fraction");
    expect(judgeModeFor("abstention")).toBe("rubric-fraction");
  });
});

describe("kendallTauB", () => {
  it("is +1 for identical orderings and -1 for reversed", () => {
    expect(kendallTauB([0, 1, 2, 3], [0, 1, 2, 3])).toBeCloseTo(1, 12);
    expect(kendallTauB([0, 1, 2, 3], [3, 2, 1, 0])).toBeCloseTo(-1, 12);
  });

  it("returns 0 when one ranking is constant (no order information)", () => {
    expect(kendallTauB([0, 1, 2], [5, 5, 5])).toBe(0);
  });

  it("applies the tie correction (tau-b, not tau-a)", () => {
    // x has no ties, y ties the last two. n0 = 3, n1 = 0, n2 = 1.
    // pairs: (0,1) concordant, (0,2) concordant, (1,2) tied in y.
    // tau_b = (2 - 0) / sqrt(3 * 2) = 2/sqrt(6)
    expect(kendallTauB([0, 1, 2], [0, 1, 1])).toBeCloseTo(2 / Math.sqrt(6), 12);
  });
});

describe("orderingScoreFromPositions", () => {
  it("reproduces the official score for 4_event_ordering_0 exactly", () => {
    // The answer discusses the rubric items in gold-index order
    // [1,3,4,5,8,7,6,2,9] (1-based). That is 9 discordant pairs of 36, so
    // tau = 1 - 2*(9/36) = 0.5 and the score is (1 + 0.5)/2 = 0.75 — the
    // value in the official artifact.
    const answerOrderOfGoldItems = [1, 3, 4, 5, 8, 7, 6, 2, 9];
    // positions[i] = where gold item i appears in the answer.
    const positions = answerOrderOfGoldItems.map((goldRank) => goldRank);
    expect(orderingScoreFromPositions(positions)).toBeCloseTo(0.75, 12);
  });

  it("scores a perfectly ordered answer 1 and a reversed one 0", () => {
    expect(orderingScoreFromPositions([1, 2, 3, 4])).toBeCloseTo(1, 12);
    expect(orderingScoreFromPositions([4, 3, 2, 1])).toBeCloseTo(0, 12);
  });

  it("produces the sqrt-denominator signature seen in official scores", () => {
    // Absent items form one tie group after the present ones, which is what
    // makes official scores land on values like 0.5 + 1/sqrt(k).
    const s = orderingScoreFromPositions([1, 2, null, null]);
    expect(Number.isFinite(s)).toBe(true);
    expect(s).toBeGreaterThan(0.5);
    expect(s).toBeLessThanOrEqual(1);
  });

  it("falls back to coverage when the rubric has a single item", () => {
    expect(orderingScoreFromPositions([1])).toBe(1);
    expect(orderingScoreFromPositions([null])).toBe(0);
  });
});

describe("rubricFractionScore", () => {
  it("averages per-criterion credit, reproducing official fractions", () => {
    expect(rubricFractionScore([1, 1, 1, 0.5])).toBeCloseTo(0.875, 12); // 3.5/4
    expect(rubricFractionScore([1, 1, 1, 1, 1, 1, 1, 0.5])).toBeCloseTo(0.9375, 12); // 7.5/8
  });

  it("EXCLUDES unparsable criteria rather than scoring them 0", () => {
    // This is the exact bug the module replaces: the old gate turned a missing
    // reference into a 0, flooring 160/400 official rows.
    expect(rubricFractionScore([1, null, 1])).toBeCloseTo(1, 12);
    expect(rubricFractionScore([null, null])).toBeNull();
  });
});

describe("rubricItemText", () => {
  it("strips the BEAM boilerplate lead-in", () => {
    expect(rubricItemText("LLM response should contain: 8 weeks")).toBe("8 weeks");
    expect(rubricItemText("LLM response should state: from March 10 till April 28")).toBe(
      "from March 10 till April 28",
    );
    expect(rubricItemText("Moral dilemma debate")).toBe("Moral dilemma debate");
  });
});

describe("literalItemPositions (the zero-LLM null model)", () => {
  it("orders items by first appearance and reports null for absent ones", () => {
    const answer = "First we discussed the budget tracker, then the deployment deadline.";
    const pos = literalItemPositions(answer, [
      "LLM response should contain: budget tracker",
      "LLM response should contain: deployment deadline",
      "LLM response should contain: quantum entanglement",
    ]);
    expect(pos[0]).not.toBeNull();
    expect(pos[1]).not.toBeNull();
    expect(pos[2]).toBeNull();
    expect(pos[0]!).toBeLessThan(pos[1]!);
  });
});

describe("parsers", () => {
  it("extracts JSON from a chatty or fenced completion", () => {
    expect(parseVerdicts('```json\n{"verdicts":[1,0.5]}\n```', 2).values).toEqual([1, 0.5]);
    expect(parseVerdicts('Sure! {"verdicts":[0,1]} done', 2).values).toEqual([0, 1]);
  });

  it("reports length mismatch instead of guessing", () => {
    const r = parseVerdicts('{"verdicts":[1]}', 3);
    expect(r.values).toBeNull();
    expect(r.error).toBe("length-mismatch");
  });

  it("snaps verdicts to the official {0, 0.5, 1} ladder", () => {
    expect(parseVerdicts('{"verdicts":[0.9,0.6,0.2,-1,7]}', 5).values).toEqual([
      1, 0.5, 0.5, 0, 1,
    ]);
  });

  it("preserves nulls in ordering positions", () => {
    expect(parseOrderingPositions('{"positions":[1,null,3]}', 3).values).toEqual([1, null, 3]);
  });

  it("returns an error rather than a score when there is no JSON", () => {
    expect(parseVerdicts("I cannot grade this.", 2).error).toBe("no-json");
  });
});

describe("agreement statistics", () => {
  it("counts unscored rows as excluded, never as agreement", () => {
    const ag = agreementReport([1, null, 0.5], [1, 0.5, 0.5]);
    expect(ag.n).toBe(2);
    expect(ag.excluded).toBe(1);
    expect(ag.mae).toBeCloseTo(0, 12);
  });

  it("reports a perfect correlation for identical score vectors", () => {
    const ag = agreementReport([0, 0.5, 1], [0, 0.5, 1]);
    expect(ag.pearson).toBeCloseTo(1, 12);
    expect(ag.spearman).toBeCloseTo(1, 12);
    expect(ag.bias).toBeCloseTo(0, 12);
    expect(ag.binaryAgreement).toBeCloseTo(1, 12);
  });
});

describe("pairedDelta / MDE", () => {
  it("is deterministic under a fixed seed", () => {
    const a = [0, 0.5, 1, 0.5];
    const b = [0.5, 0.5, 1, 1];
    const x = pairedDelta(a, b, { resamples: 500, seed: 7 });
    const y = pairedDelta(a, b, { resamples: 500, seed: 7 });
    expect(x).toEqual(y);
    expect(x.meanDelta).toBeCloseTo(0.25, 12);
    expect(x.wins).toBe(2);
    expect(x.ties).toBe(2);
  });

  it("shrinks the minimum detectable effect as n grows", () => {
    const small = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 0.2 : -0.2));
    const large = Array.from({ length: 400 }, (_, i) => (i % 2 === 0 ? 0.2 : -0.2));
    expect(minimumDetectableEffect(large)).toBeLessThan(minimumDetectableEffect(small));
  });
});

describe("splitAssignment", () => {
  it("is deterministic and splits roughly in half", () => {
    const ids = Array.from({ length: 400 }, (_, i) => `q_${i}`);
    const first = ids.map(splitAssignment);
    expect(ids.map(splitAssignment)).toEqual(first);
    const train = first.filter((s) => s === "train").length;
    expect(train).toBeGreaterThan(150);
    expect(train).toBeLessThan(250);
  });
});
