import { describe, expect, it } from "vitest";

import { classifyQueryIntent } from "../src/core/coverage.js";

/**
 * T1 coverage — intent-classifier fixtures.
 *
 * Conservative-classifier principle: a false NEGATIVE degrades to today's
 * behaviour (point lookup); a false POSITIVE changes LLM inputs. So the
 * point-negative block below is as load-bearing as the positives — it pins
 * exactly which existing PaySwift queries keep byte-identical pipelines when
 * coverage mode is on.
 */
describe("coverage intent classifier", () => {
  it("classifies summary-shaped queries as coverage", () => {
    const queries = [
      "Summarize everything we decided about the architecture.",
      "Give me an overview of the security discussions.",
      "Provide a comprehensive recap of the project across our conversations.",
      // q27 verbatim (PaySwift): retrospective evaluation.
      "In hindsight, why was the early adoption of Bun considered a mistake by the team?",
      // q23 verbatim (PaySwift): impact narrative.
      "What was the financial impact of the March data leak on April's burn?",
      "What led up to the decision to drop Bun?",
      "How did the pricing model evolve over the quarter?",
      "Tell me the history of the webhook retry design.",
    ];
    for (const q of queries) {
      const intent = classifyQueryIntent(q);
      expect(intent.kind, q).toBe("coverage");
      expect(intent.facets.summary, q).toBe(true);
      expect(intent.cues.length, q).toBeGreaterThan(0);
    }
  });

  it("classifies ordering-shaped queries as coverage", () => {
    const queries = [
      "In what order did the incidents happen?",
      "Which came first, the data leak or the webhook storm?",
      "List the migration steps in chronological order.",
      "Walk me through the timeline of the Bun migration.",
      "What happened first, the LOI or the sandbox testing?",
      "Did the PCI attestation come before or after the pricing decision?",
    ];
    for (const q of queries) {
      const intent = classifyQueryIntent(q);
      expect(intent.kind, q).toBe("coverage");
      expect(intent.facets.ordering, q).toBe(true);
    }
  });

  it("classifies temporal-arithmetic queries as coverage (and NOT aggregation)", () => {
    const queries = [
      "How many days passed between the Bun crash and the Node migration?",
      "How long did the migration take?",
      "What was the duration between when the leak was discovered and when the postmortem closed?",
      "How much time elapsed between the two incidents?",
    ];
    for (const q of queries) {
      const intent = classifyQueryIntent(q);
      expect(intent.kind, q).toBe("coverage");
      expect(intent.facets.temporalArithmetic, q).toBe(true);
      // "how many days" must NOT be misread as enumeration.
      if (/how many days/i.test(q)) expect(intent.facets.aggregation, q).toBe(false);
    }
  });

  it("classifies aggregation-shaped queries as coverage", () => {
    const queries = [
      "How many distinct customers signed LOIs?",
      "What is the total number of incidents in March?",
      "How often did the team revisit the pricing debate?",
      "List all the decisions made in Phase 1.",
    ];
    for (const q of queries) {
      const intent = classifyQueryIntent(q);
      expect(intent.kind, q).toBe("coverage");
      expect(intent.facets.aggregation, q).toBe(true);
    }
  });

  it("keeps point lookups point-shaped (no false positives on PaySwift)", () => {
    const queries = [
      // q04 verbatim — the starvation class is recovered by the starvation
      // trigger in ask(), NOT by misclassifying it as coverage.
      "What database technology backs the core service?",
      // q03 verbatim.
      "What repository structure did the team choose for the codebase?",
      // q17 verbatim.
      "What is the final pricing model PaySwift launched with?",
      // q11-shaped.
      "Which integration partner from the dental-SaaS vertical signed the first LOI?",
      // q19 verbatim — deliberate conservative choice: bare "why did" stays
      // point (overlaps the bridge's abstention-risk class); the starvation
      // net covers its multi-event needs. Documented in EXP-T1-coverage.md.
      "Why did the team switch the API runtime from Bun to Node 22 LTS in March?",
      "Who owns the SRE on-call rotation?",
      "What did we decide about OpenClaw?",
      // "different" alone must not trigger aggregation (bridge divergence).
      "Why did the team choose a different database for analytics?",
    ];
    for (const q of queries) {
      const intent = classifyQueryIntent(q);
      expect(intent.kind, q).toBe("point");
      expect(intent.cues, q).toEqual([]);
    }
  });

  it("is deterministic", () => {
    const q = "Summarize the timeline of incidents — how many days between them?";
    const a = classifyQueryIntent(q);
    const b = classifyQueryIntent(q);
    expect(a).toEqual(b);
    // Multi-facet query fires multiple facets.
    expect(a.facets.summary).toBe(true);
    expect(a.facets.ordering).toBe(true);
    expect(a.facets.temporalArithmetic).toBe(true);
  });
});
