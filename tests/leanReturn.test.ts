/**
 * Lean-return payload transform (token plan L1).
 *
 * Measured motivation, official 1M artifact (700 rows): the answer-visible
 * payload averages 125K chars/query, of which 22.6% is the SAME ~1.1K-char
 * `Context:` user-profile preamble repeated on ~24.8 returned turns, and 93.4%
 * of capsule snippets appear verbatim inside the returned raw turns. CSM is the
 * most token-expensive system on the BEAM ladder as a result (~28.2K
 * answer-visible at 1M vs Hindsight's 17.9K).
 *
 * The transform is RENDERING-ONLY: selection is untouched, and with every knob
 * EXPLICITLY off the output must be byte-identical (same object references) to
 * the legacy payload — that identity is what made the paired gate's control arm
 * a true control, and it is still pinned below against `k: 0`.
 *
 * SHIPPED DEFAULT: `CSM_AMB_LEAN_K` is 0 (OFF), so "unset" IS the identity.
 * It was flipped to 16 on 2026-08-01 and reverted the same day: K=16 cost
 * -0.0009 on the three categories it was gated on (instruction_following /
 * preference_following / knowledge_update @1M) for -32% payload, but on
 * abstention / information_extraction / preference_following @500K, lean-OFF
 * beat it in ALL THREE (ALL +0.0306, 9W/5L, MDE 0.0965). Below MDE, but the
 * sign is consistent and the mechanism is plain — so the global flip was
 * unjustified generalisation from a 3-category result. K=16 remains a
 * measured, explicitly-selectable token lever.
 */
import { describe, expect, it } from "vitest";

import {
  buildLeanDocs,
  resolveLeanReturn,
  splitContextPrefix,
  type LeanReturnOptions,
} from "../scripts/amb-csm-retrieve.js";
import type { BenchEvent } from "../src/eval/corpus.js";

const PROFILE = "Context: Jordan, 34, prefers concise answers and Postgres.\n\n";
const OTHER_PROFILE = "Context: A different user profile entirely.\n\n";

function ev(id: string, content: string): BenchEvent {
  return {
    id,
    shardId: "s0",
    content,
    tokenCount: Math.ceil(content.length / 4),
    isCore: true,
    tier: 0,
    tags: [],
  };
}

/** The legacy payload: every knob explicitly off. NOT what `resolveLeanReturn`
 *  returns from an empty env any more — see the `resolveLeanReturn` block. */
const OFF: LeanReturnOptions = { k: 0, excerptChars: 0, profileDedupe: false };

describe("splitContextPrefix", () => {
  it("splits the documentToEvents preamble from the turn body", () => {
    const split = splitContextPrefix(PROFILE + "[Turn 3] user: hello");
    expect(split).not.toBeNull();
    expect(split!.prefix).toBe(PROFILE);
    expect(split!.body).toBe("[Turn 3] user: hello");
  });

  it("returns null for content with no preamble", () => {
    expect(splitContextPrefix("[Turn 3] user: hello")).toBeNull();
    // Starts with the marker but never closes it — not a preamble.
    expect(splitContextPrefix("Context: dangling")).toBeNull();
  });
});

describe("buildLeanDocs", () => {
  const events = [
    ev("d#turn-0", PROFILE + "we discussed the postgres migration at length"),
    ev("d#turn-1", PROFILE + "then we chose aurora over rds for the database"),
    ev("e#turn-0", OTHER_PROFILE + "a different user's turn about the weather"),
    ev("f#turn-0", "a bare turn that never carried a preamble"),
  ];

  // Byte-identity is still the claim; it is now pinned against the EXPLICIT-off
  // configuration (`k: 0`) rather than against "unset", because unset now
  // resolves to k=16. This is the arm the paired gate scored as the control.
  it("is the IDENTITY (same references) with every knob EXPLICITLY off — the control arm", () => {
    const out = buildLeanDocs(events, "postgres", OFF);
    expect(out).toHaveLength(events.length);
    for (let i = 0; i < events.length; i++) expect(out[i]).toBe(events[i]);
  });

  // Companion to the identity test above: what K=16 — the measured token
  // lever, opt-in since the 2026-08-01 revert — actually does to a payload. It
  // is a pure prefix slice: the docs it keeps are the same objects,
  // byte-for-byte, so the -32% payload saving comes entirely from dropping the
  // tail, never from rewriting kept turns. Resolved through the env so the
  // opt-in path stays covered, not by hand-building the options object.
  it("explicit k=16 is a prefix slice — kept docs are untouched references", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      ev(`g#turn-${i}`, PROFILE + `turn number ${i} about the postgres migration`),
    );
    const lean16 = resolveLeanReturn({ CSM_AMB_LEAN_K: "16" } as NodeJS.ProcessEnv);
    const out = buildLeanDocs(many, "postgres", lean16);
    expect(out).toHaveLength(16);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(many[i]);
    // …and the cut keeps the best-ranked head, i.e. it drops from the tail.
    expect(out.map((d) => d.id)).toEqual(many.slice(0, 16).map((d) => d.id));
    // Under the explicit-off legacy config the same input is untruncated.
    expect(buildLeanDocs(many, "postgres", OFF)).toHaveLength(20);
  });

  it("k caps the raw-turn count, keeping the best-ranked head", () => {
    const out = buildLeanDocs(events, "postgres", { ...OFF, k: 2 });
    expect(out.map((d) => d.id)).toEqual(["d#turn-0", "d#turn-1"]);
  });

  it("profileDedupe keeps each DISTINCT preamble on its first doc only", () => {
    const out = buildLeanDocs(events, "postgres", { ...OFF, profileDedupe: true });
    expect(out[0]!.content.startsWith("Context:")).toBe(true); // first of PROFILE
    expect(out[1]!.content.startsWith("Context:")).toBe(false); // duplicate stripped
    expect(out[1]!.content).toBe("then we chose aurora over rds for the database");
    expect(out[2]!.content.startsWith("Context:")).toBe(true); // first of OTHER_PROFILE
    expect(out[3]!.content).toBe(events[3]!.content); // never had one
  });

  it("profileDedupe loses NO information — every distinct preamble survives once", () => {
    const out = buildLeanDocs(events, "postgres", { ...OFF, profileDedupe: true });
    const joined = out.map((d) => d.content).join("\n");
    expect(joined).toContain(PROFILE.trim());
    expect(joined).toContain(OTHER_PROFILE.trim());
    // …and the duplicated copies are actually gone.
    expect(joined.split("Jordan, 34").length - 1).toBe(1);
  });

  it("excerptChars excerpts the BODY, never the kept preamble", () => {
    const out = buildLeanDocs(events, "postgres migration", {
      k: 0,
      excerptChars: 40,
      profileDedupe: true,
    });
    // First doc keeps the full preamble plus a ≤40-char (+ellipses) body
    // centred on the query terms.
    expect(out[0]!.content.startsWith(PROFILE)).toBe(true);
    const body0 = out[0]!.content.slice(PROFILE.length);
    expect(body0.length).toBeLessThanOrEqual(40 + 8); // window + ellipsis slack
    expect(body0).toContain("postgres");
    // Crucially the excerpt was NOT centred inside the preamble text.
    expect(body0).not.toContain("Jordan");
    // Stripped doc is just the excerpted body.
    expect(out[1]!.content.length).toBeLessThanOrEqual(40 + 8);
  });

  it("all three knobs compose", () => {
    const out = buildLeanDocs(events, "postgres", {
      k: 2,
      excerptChars: 30,
      profileDedupe: true,
    });
    expect(out).toHaveLength(2);
    expect(out[0]!.content.startsWith(PROFILE)).toBe(true);
    expect(out[1]!.content.startsWith("Context:")).toBe(false);
  });
});

describe("resolveLeanReturn", () => {
  // Was "defaults fully OFF — the shipped payload is unchanged until gated on".
  // The default flipped on 2026-08-01; the legacy fully-OFF payload is still
  // reachable and still pinned, just via an explicit 0 instead of via "unset".
  it("explicit CSM_AMB_LEAN_K=0 still resolves to the fully-OFF legacy payload", () => {
    expect(
      resolveLeanReturn({ CSM_AMB_LEAN_K: "0" } as NodeJS.ProcessEnv),
    ).toEqual({
      k: 0,
      excerptChars: 0,
      profileDedupe: false,
    });
  });

  // Unset resolves to the identity transform: score outranks payload while
  // category margins on the ladder are ~0.05 and lean costs ~0.03 on the
  // categories that want their specific turns kept.
  it("defaults fully OFF — the shipped payload is unchanged until gated on", () => {
    expect(resolveLeanReturn({} as NodeJS.ProcessEnv)).toEqual({
      k: 0,
      excerptChars: 0,
      profileDedupe: false,
    });
  });

  it("reads the three knobs through the env primitive (typos throw)", () => {
    expect(
      resolveLeanReturn({
        CSM_AMB_LEAN_K: "12",
        CSM_AMB_LEAN_EXCERPT_CHARS: "360",
        CSM_AMB_LEAN_PROFILE_DEDUPE: "1",
      } as NodeJS.ProcessEnv),
    ).toEqual({ k: 12, excerptChars: 360, profileDedupe: true });
    expect(() =>
      resolveLeanReturn({ CSM_AMB_LEAN_K: "twelve" } as NodeJS.ProcessEnv),
    ).toThrow(/CSM_AMB_LEAN_K/);
  });
});
