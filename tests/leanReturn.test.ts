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
 * off the output must be byte-identical (same object references) to the legacy
 * payload — that identity is what makes the default arm a true control.
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

  it("is the IDENTITY (same references) with every knob off — the control arm", () => {
    const out = buildLeanDocs(events, "postgres", OFF);
    expect(out).toHaveLength(events.length);
    for (let i = 0; i < events.length; i++) expect(out[i]).toBe(events[i]);
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
