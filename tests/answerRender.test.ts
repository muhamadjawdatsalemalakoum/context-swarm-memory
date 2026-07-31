/**
 * REGRESSION GUARD — the answer gate must never grade an arm on a context that
 * arm did not actually return.
 *
 * `scripts/answer-arms.ts` renders each retrieved document by resolving its id
 * to text. Real event ids resolve through the corpus. CSM's SYNTHESISED
 * documents — `csm-evidence-capsule`, `csm-organized-memory`,
 * `csm-preference-profile` — have ids that exist in no corpus, and their text
 * was not persisted anywhere: `payloads.jsonl` stored `{id, contentChars}` only.
 *
 * The renderer's fallback was the string `(id <x> unavailable)`, so the hole was
 * invisible. MEASURED across every arm on disk: 414 synthesised documents were
 * rendered as that placeholder — 3.4%-9.5% of each arm's answer-visible
 * characters, and 100% of any lever whose effect lives inside the capsule
 * (CSM_AMB_ORDERED_CAPSULE, CSM_AMB_OBSERVE_MEMORY, CSM_AMB_FACT_MEMORY,
 * CSM_AMB_SYNTH_MEMORY, CSM_AMB_PREFERENCE_PROFILE).
 *
 * It also manufactured a published result. Arm G burned 1.35 unrenderable slots
 * per query against arm H's 1.00, so arm H simply carried ~0.35 more real
 * evidence documents — which was reported as "folding a signal into the capsule
 * beats appending it as a document".
 *
 * A gate that quietly drops part of the thing under test is worse than no gate,
 * because it still produces a number.
 */
import { describe, expect, it } from "vitest";

import { renderExcerpts, synthKey } from "../scripts/answer-arms.js";

const CORPUS = new Map<string, string>([
  ["10_s4_16#turn-11", "the user asked about Postgres"],
  ["10_s4_16#turn-12", "the assistant recommended Aurora"],
]);

const resolveCorpusOnly = (id: string): string | undefined => CORPUS.get(id);

describe("renderExcerpts", () => {
  it("renders resolvable documents in order, numbered from 1", () => {
    const out = renderExcerpts(
      "runX/q1",
      [{ id: "10_s4_16#turn-11" }, { id: "10_s4_16#turn-12" }],
      resolveCorpusOnly,
    );
    expect(out).toBe(
      "[excerpt 1]\nthe user asked about Postgres\n\n[excerpt 2]\nthe assistant recommended Aurora",
    );
  });

  it("THROWS on a synthesised id rather than emitting a placeholder", () => {
    // The exact defect: this used to render "(id csm-evidence-capsule unavailable)"
    // and carry on, producing a score for a context the arm never returned.
    expect(() =>
      renderExcerpts(
        "runX/q1",
        [{ id: "csm-evidence-capsule" }, { id: "10_s4_16#turn-11" }],
        resolveCorpusOnly,
      ),
    ).toThrow(/csm-evidence-capsule/);
  });

  it("names the run, the query and the count so the failure is actionable", () => {
    let message = "";
    try {
      renderExcerpts("r1mH/10_knowledge_update_1", [{ id: "csm-organized-memory" }], resolveCorpusOnly);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("r1mH/10_knowledge_update_1");
    expect(message).toContain("1 document(s) have no text");
    expect(message).toContain("synthesized-docs.jsonl");
  });

  it("renders synthesised documents once their text is supplied", () => {
    const synth = new Map<string, string>([
      [synthKey("q1", "csm-evidence-capsule"), "CHRONICLE: Mar-15-2024 chose Aurora"],
    ]);
    const resolveBoth = (id: string): string | undefined =>
      synth.get(synthKey("q1", id)) ?? CORPUS.get(id);

    const out = renderExcerpts(
      "runX/q1",
      [{ id: "csm-evidence-capsule" }, { id: "10_s4_16#turn-11" }],
      resolveBoth,
    );
    expect(out).toContain("CHRONICLE: Mar-15-2024 chose Aurora");
    expect(out).toContain("the user asked about Postgres");
    expect(out).not.toContain("unavailable");
  });

  it("keys synthesised text per query, so two queries cannot share a capsule", () => {
    // The capsule is rebuilt per query; a corpus-style id-only map would collide.
    expect(synthKey("q1", "csm-evidence-capsule")).not.toBe(
      synthKey("q2", "csm-evidence-capsule"),
    );
  });

  it("truncates to the char budget", () => {
    const long = new Map([["a", "x".repeat(500)]]);
    const out = renderExcerpts("runX/q1", [{ id: "a" }], (id) => long.get(id), 50);
    expect(out).toHaveLength(50);
  });
});
