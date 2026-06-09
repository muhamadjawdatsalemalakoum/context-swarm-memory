/**
 * Unit tests for the gold-touching eval module (src/eval/retrievalScore.ts)
 * on the synthetic BEAM fixture. Tests are eval-side and exempt from the
 * leakage firewall.
 */

import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  aggregateByCategory,
  aggregateMetric,
  buildBeamEventIndex,
  facetTerms,
  loadBeamGold,
  parsePayloadLine,
  scorePayloadRow,
  stripFacetPrefix,
  textSupportsFacet,
  type PayloadRow,
} from "../src/eval/retrievalScore.js";

const FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "beam",
);

function payloadRow(overrides: Partial<PayloadRow>): PayloadRow {
  return {
    queryId: "u1_summarization_0",
    category: "summarization",
    userId: "u1",
    questionSha256: "x",
    requestedK: 24,
    returnedEventIds: [],
    packedEventIds: [],
    csmRetrievedEventIds: [],
    evidenceCapsule: false,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
    probeCount: null,
    recallCount: null,
    ...overrides,
  };
}

describe("facet primitives", () => {
  it("retrieval_score_strip_facet_prefix", () => {
    expect(stripFacetPrefix("LLM response should contain: the pump scheduler")).toBe(
      "the pump scheduler",
    );
    expect(stripFacetPrefix("LLM response should state: X")).toBe("X");
    expect(stripFacetPrefix("LLM response should mention: Y")).toBe("Y");
    expect(stripFacetPrefix("1st: nutrient pump scheduler")).toBe(
      "nutrient pump scheduler",
    );
    expect(stripFacetPrefix("23rd: things")).toBe("things");
    expect(stripFacetPrefix("plain fact")).toBe("plain fact");
  });

  it("retrieval_score_facet_terms_distinctive", () => {
    const terms = facetTerms(
      "LLM response should contain: ESP32 microcontroller with MicroPython firmware",
    );
    // Prefix words are stop-worded/stripped; distinctive tokens survive.
    expect(terms).toContain("esp32");
    expect(terms).toContain("microcontroller");
    expect(terms).toContain("micropython");
    expect(terms).toContain("firmware");
    expect(terms).not.toContain("llm");
    expect(terms).not.toContain("should");
    expect(terms).not.toContain("with");
    // Digit-bearing short tokens are kept (dates/counts/versions).
    expect(facetTerms("on day 14 use v2")).toContain("14");
    expect(facetTerms("on day 14 use v2")).toContain("v2");
  });

  it("retrieval_score_text_supports_facet_rules", () => {
    const terms = ["peristaltic", "pump", "dashboard"];
    expect(
      textSupportsFacet("I swapped to a peristaltic pump and a dashboard", terms),
    ).toBe(true);
    // 1/3 terms < 50% → no.
    expect(textSupportsFacet("the pump is loud", terms)).toBe(false);
    // 2/3 ≥ 50% and ≥2 matches → yes.
    expect(textSupportsFacet("peristaltic pump arrived", terms)).toBe(true);
    // Single-term facet needs that one term.
    expect(textSupportsFacet("micropython rules", ["micropython"])).toBe(true);
    expect(textSupportsFacet("python rules", ["micropython"])).toBe(false);
    // Empty terms → never supported.
    expect(textSupportsFacet("anything", [])).toBe(false);
    // Word boundaries: "art" must not match inside "start".
    expect(textSupportsFacet("start the engine", ["art", "engine"])).toBe(false);
  });
});

describe("gold loading (eval side only)", () => {
  it("retrieval_score_load_gold_facets_with_sources", () => {
    const gold = loadBeamGold("100k", { sliceDir: FIXTURE_DIR });
    expect(gold.size).toBe(5);

    const summarization = gold.get("u1_summarization_0")!;
    expect(summarization.category).toBe("summarization");
    expect(summarization.facets.length).toBe(4);
    expect(summarization.facetSources.every((s) => s === "rubric")).toBe(true);
    expect(summarization.facets[0]).toBe(
      "nutrient pump scheduler as the first milestone",
    );

    const ordering = gold.get("u1_event_ordering_0")!;
    // 1 rubric item + 4 ordering_tested topics.
    expect(ordering.facets.length).toBe(5);
    expect(ordering.facetSources.filter((s) => s === "ordering_tested").length).toBe(4);
    expect(ordering.facets).toContain("nutrient pump scheduler");

    // No rubric → falls back to gold_answers sentences.
    const extraction = gold.get("u2_information_extraction_0")!;
    expect(extraction.facetSources.every((s) => s === "gold_answer")).toBe(true);
    expect(extraction.facets.length).toBe(2);

    const temporal = gold.get("u2_temporal_reasoning_0")!;
    expect(temporal.facetSources).toContain("time_points");
  });
});

describe("payload scoring", () => {
  const index = buildBeamEventIndex("100k", { sliceDir: FIXTURE_DIR });
  const gold = loadBeamGold("100k", { sliceDir: FIXTURE_DIR });

  it("retrieval_score_coverage_at_k_monotonic_and_correct", () => {
    const summarizationGold = gold.get("u1_summarization_0")!;
    // Top-1 covers only the scheduler facet; the full list covers all 4.
    const row = payloadRow({
      returnedEventIds: [
        "u1_s0_0#turn-0", // scheduler
        "u1_s0_0#turn-2", // esp32/micropython
        "u1_s0_1#turn-0", // pH calibration
        "u1_s1_2#turn-0", // peristaltic + dashboard
      ],
      packedEventIds: ["u1_s0_0#turn-0"],
      csmRetrievedEventIds: [
        "u1_s0_0#turn-0",
        "u1_s0_0#turn-2",
        "u1_s0_1#turn-0",
        "u1_s1_2#turn-0",
      ],
    });
    const score = scorePayloadRow(row, summarizationGold, index, [1, 2, 24])!;
    expect(score.facetCount).toBe(4);
    expect(score.coverageAtK["@1"]).toBeCloseTo(1 / 4);
    expect(score.coverageAtK["@2"]).toBeCloseTo(2 / 4);
    expect(score.coverageAtK["@24"]).toBeCloseTo(1.0);
    expect(score.packedCoverage).toBeCloseTo(1 / 4);
    expect(score.retrievedCoverage).toBeCloseTo(1.0);
    // Oracle over the whole unit is the lexical ceiling — 1.0 here.
    expect(score.oracleCoverage).toBeCloseTo(1.0);
    expect(score.normalizedAtK["@24"]).toBeCloseTo(1.0);
  });

  it("retrieval_score_empty_retrieval_zero_coverage", () => {
    const score = scorePayloadRow(
      payloadRow({}),
      gold.get("u1_summarization_0")!,
      index,
      [10],
    )!;
    expect(score.coverageAtK["@10"]).toBe(0);
    expect(score.packedCoverage).toBe(0);
    expect(score.oracleCoverage).toBeCloseTo(1.0);
  });

  it("retrieval_score_unknown_event_ids_ignored", () => {
    const score = scorePayloadRow(
      payloadRow({ returnedEventIds: ["nope#turn-0", "u1_s1_2#turn-0"] }),
      gold.get("u1_summarization_0")!,
      index,
      [10],
    )!;
    expect(score.coverageAtK["@10"]).toBeCloseTo(1 / 4);
  });

  it("retrieval_score_null_when_no_facets", () => {
    const emptyGold = {
      queryId: "x",
      category: "summarization",
      userId: "u1",
      question: "q",
      facets: [],
      facetSources: [],
    };
    expect(scorePayloadRow(payloadRow({}), emptyGold, index)).toBeNull();
  });

  it("retrieval_score_parse_payload_line_robust", () => {
    expect(parsePayloadLine("")).toBeNull();
    expect(parsePayloadLine("{torn json")).toBeNull();
    expect(parsePayloadLine('{"harness":{}}')).toBeNull(); // no queryId
    const row = parsePayloadLine(
      JSON.stringify({
        harness: {
          queryId: "u1_summarization_0",
          category: "summarization",
          userId: "u1",
          questionSha256: "abc",
          requestedK: 24,
        },
        raw_response: {
          returnedEventIds: ["a", "b"],
          evidenceCapsule: true,
          inputTokens: 100,
          outputTokens: 5,
          latencyMs: 42,
          meta: {
            packedEventIds: ["a"],
            csmRetrievedEventIds: ["a", "b", "c"],
            probeCount: 3,
            recallCount: 1,
          },
        },
      }),
    )!;
    expect(row.queryId).toBe("u1_summarization_0");
    expect(row.returnedEventIds).toEqual(["a", "b"]);
    expect(row.packedEventIds).toEqual(["a"]);
    expect(row.csmRetrievedEventIds.length).toBe(3);
    expect(row.evidenceCapsule).toBe(true);
    expect(row.probeCount).toBe(3);
  });

  it("retrieval_score_aggregate_deterministic_ci", () => {
    const values = [0.25, 0.5, 0.75, 1.0, 0.5];
    const a = aggregateMetric(values, { seed: 42, bootstrapResamples: 2000 });
    const b = aggregateMetric(values, { seed: 42, bootstrapResamples: 2000 });
    expect(a).toEqual(b);
    expect(a.mean).toBeCloseTo(0.6);
    expect(a.ci95[0]).toBeLessThanOrEqual(a.mean);
    expect(a.ci95[1]).toBeGreaterThanOrEqual(a.mean);
    expect(aggregateMetric([])).toEqual({ n: 0, mean: 0, ci95: [0, 0] });
  });

  it("retrieval_score_aggregate_by_category_means", () => {
    const summarizationGold = gold.get("u1_summarization_0")!;
    const orderingGold = gold.get("u1_event_ordering_0")!;
    const fullIds = [
      "u1_s0_0#turn-0",
      "u1_s0_0#turn-2",
      "u1_s0_1#turn-0",
      "u1_s1_2#turn-0",
    ];
    const scores = [
      scorePayloadRow(
        payloadRow({ returnedEventIds: fullIds, inputTokens: 100, latencyMs: 10 }),
        summarizationGold,
        index,
        [10],
      )!,
      scorePayloadRow(
        payloadRow({
          queryId: "u1_event_ordering_0",
          returnedEventIds: fullIds.slice(0, 2),
          inputTokens: 300,
          latencyMs: 30,
        }),
        orderingGold,
        index,
        [10],
      )!,
    ];
    const aggs = aggregateByCategory(scores, [10], { bootstrapResamples: 500 });
    expect(aggs.map((a) => a.category)).toEqual([
      "event_ordering",
      "summarization",
    ]);
    const summarizationAgg = aggs.find((a) => a.category === "summarization")!;
    expect(summarizationAgg.n).toBe(1);
    expect(summarizationAgg.coverageAtK["@10"]!.mean).toBeCloseTo(1.0);
    expect(summarizationAgg.meanInputTokens).toBe(100);
  });
});
