import { describe, expect, it } from "vitest";

import {
  memoryPacketSchema,
  probeResultSchema,
  recallResultSchema,
} from "../src/core/schemas.js";

/**
 * Audit fix #4 regression tests.
 *
 * Real-bench failure (q01, csm-audit-fix-10q): the 31B recall LLM returned
 * 4 claims, the first 3 with `confidence: 0.8` (number) and the 4th with
 * `confidence: "0.8"` (string). Strict Zod validation dropped ALL 4 claims
 * and threw — meaning the entire recall call's output was wasted.
 *
 * After the fix:
 *  - `confidence` fields use `z.coerce.number()`, so "0.8" becomes 0.8.
 *  - `claims` / `key_claims` arrays validate items individually; bad items
 *    are dropped but good items survive.
 *
 * The combination means a partially-malformed LLM response now produces a
 * partially-correct parse, not a thrown error.
 */

describe("schemaRobustness — confidence type coercion", () => {
  it("coerces string confidence to number on probe", () => {
    const r = probeResultSchema.parse({
      knows: true,
      confidence: "0.8", // string instead of number — LLM common quirk
      memory_type: "direct",
      estimated_answer_value: "high",
      needs_full_recall: true,
      relevant_event_ids: ["e1"],
    });
    expect(r.confidence).toBe(0.8);
    expect(typeof r.confidence).toBe("number");
  });

  it("coerces string confidence on recall + per-claim", () => {
    const r = recallResultSchema.parse({
      shard_id: "s1",
      snapshot_id: "S001",
      confidence: "0.95",
      answer: "x",
      claims: [
        { claim: "a", support: ["e1"], confidence: 0.7 },
        { claim: "b", support: ["e2"], confidence: "0.8" },
      ],
      unknowns: [],
      conflicts: [],
    });
    expect(r.confidence).toBe(0.95);
    expect(r.claims).toHaveLength(2);
    expect(r.claims[0]!.confidence).toBe(0.7);
    expect(r.claims[1]!.confidence).toBe(0.8);
  });

  it("rejects out-of-range confidence even after coercion", () => {
    expect(() =>
      probeResultSchema.parse({
        knows: true,
        confidence: "1.5", // > 1 — schema must still reject
        memory_type: "direct",
        estimated_answer_value: "high",
        needs_full_recall: true,
        relevant_event_ids: [],
      }),
    ).toThrow();
  });

  it("rejects non-numeric strings (don't silently coerce gibberish)", () => {
    expect(() =>
      probeResultSchema.parse({
        knows: true,
        confidence: "abc",
        memory_type: "direct",
        estimated_answer_value: "high",
        needs_full_recall: true,
        relevant_event_ids: [],
      }),
    ).toThrow();
  });

  it("accepts probe responses that include legacy `likely_conflicts` and `reason` keys (back-compat)", () => {
    // Phase α dropped these two fields. Zod object schemas are strict by
    // default — `.parse()` ignores unknown keys (does not reject), so cached
    // responses written with the legacy keys continue to parse cleanly.
    // This pins that behavior so a future maintainer doesn't accidentally
    // tighten the schema to strict-key mode and break replays.
    const r = probeResultSchema.parse({
      knows: true,
      confidence: 0.8,
      memory_type: "direct",
      estimated_answer_value: "high",
      needs_full_recall: true,
      likely_conflicts: false,   // legacy — silently stripped
      reason: "legacy field",    // legacy — silently stripped
      relevant_event_ids: ["e1"],
    });
    expect(r.knows).toBe(true);
    expect(r.confidence).toBe(0.8);
    expect("likely_conflicts" in r).toBe(false);
    expect("reason" in r).toBe(false);
  });
});

describe("schemaRobustness — per-claim tolerance", () => {
  it("drops a malformed claim but keeps the rest (recall)", () => {
    const r = recallResultSchema.parse({
      shard_id: "s1",
      snapshot_id: "S001",
      confidence: 0.9,
      answer: "x",
      claims: [
        { claim: "good 1", support: ["e1"], confidence: 0.8 },
        { claim: "good 2", support: ["e2"], confidence: "0.7" }, // coerced
        { claim: "BAD", support: "not-an-array", confidence: 0.6 }, // support type wrong → drop
        { claim: "good 3", support: ["e3"], confidence: 0.5 },
      ],
      unknowns: [],
      conflicts: [],
    });
    // Three good claims survive; the malformed one is silently dropped.
    expect(r.claims).toHaveLength(3);
    expect(r.claims.map((c) => c.claim)).toEqual(["good 1", "good 2", "good 3"]);
  });

  it("drops malformed key_claim but keeps the rest (memory packet)", () => {
    const p = memoryPacketSchema.parse({
      query: "q",
      summary: "s",
      key_claims: [
        { claim: "a", sources: ["s1@S1:e1"], confidence: 0.9 },
        { confidence: 0.8 }, // missing claim and sources → drop
        { claim: "c", sources: ["s2@S1:e2"], confidence: "0.6" }, // coerced
      ],
      caveats: [],
      conflicts: [],
      recommended_main_context: "x",
    });
    expect(p.key_claims).toHaveLength(2);
    expect(p.key_claims.map((k) => k.claim)).toEqual(["a", "c"]);
  });

  it("an entirely malformed claims array drops to empty but recall still parses", () => {
    // Pre-fix this would throw — taking down the whole recall result.
    // Post-fix: claims becomes []; the rest of the response still flows.
    const r = recallResultSchema.parse({
      shard_id: "s1",
      snapshot_id: "S001",
      confidence: 0.9,
      answer: "x",
      claims: [
        { wrong: "shape" },
        null,
        "not even an object",
      ],
      unknowns: ["nothing in claims survived"],
      conflicts: [],
    });
    expect(r.claims).toHaveLength(0);
    expect(r.unknowns).toEqual(["nothing in claims survived"]);
  });
});
