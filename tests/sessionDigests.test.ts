/**
 * Session arc index (CSM_AMB_SESSION_DIGESTS) — the absence lever.
 *
 * Diagnosis it answers (1M event_ordering, n=70): 85% of the deficit is
 * milestone ABSENCE — retrieval concentrates into ~2.86 of ~10 sessions while
 * rubrics put one milestone per session-phase. Contract pinned here:
 *  - flag defaults OFF and garbage throws;
 *  - one card per SESSION (structural s<digits> key from the shard id; whole
 *    shard id as fallback so generic corpora degrade, never break);
 *  - cards are in session order by earliest turn, each with a turn range;
 *  - every line quotes verbatim content anchored by a real event id;
 *  - deterministic: same corpus, same bytes;
 *  - salience is corpus-derived (cross-session df), no vocabulary tables.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  buildCorpus,
  buildSessionDigests,
  sessionDigestsActive,
  sessionKeyOfShard,
  type AmbDocument,
} from "../scripts/amb-csm-retrieve.js";
import { EnvConfigError } from "../src/utils/env.js";

afterEach(() => {
  delete process.env.CSM_AMB_SESSION_DIGESTS;
});

const doc = (id: string, content: string): AmbDocument => ({
  id,
  content,
  user_id: "u1",
  timestamp: null,
});

function corpus() {
  return buildCorpus([
    doc(
      "7_s1_2",
      "[Turn 40] User: The kubernetes autoscaler for payments keeps flapping.\n" +
        "[Turn 41] Assistant: Raise the replica floor.\n" +
        "[Turn 42] User: Set the payments floor to six replicas.",
    ),
    doc(
      "7_s0_0",
      "[Turn 1] User: Planning my sourdough starter schedule this week.\n" +
        "[Turn 2] Assistant: Feed it twice daily.\n" +
        "[Turn 3] User: The hydration ratio is eighty percent now.",
    ),
    doc(
      "7_s0_1",
      "[Turn 10] User: Also my sourdough loaf collapsed again.\n[Turn 11] Assistant: Try colder proofing.",
    ),
  ]);
}

describe("sessionDigestsActive / sessionKeyOfShard", () => {
  it("defaults OFF and rejects garbage", () => {
    expect(sessionDigestsActive()).toBe(false);
    process.env.CSM_AMB_SESSION_DIGESTS = "1";
    expect(sessionDigestsActive()).toBe(true);
    process.env.CSM_AMB_SESSION_DIGESTS = "sure";
    expect(() => sessionDigestsActive()).toThrow(EnvConfigError);
  });

  it("extracts the structural session segment, falls back to the shard id", () => {
    expect(sessionKeyOfShard("7_s0_1")).toBe("s0");
    expect(sessionKeyOfShard("10_s4_16")).toBe("s4");
    expect(sessionKeyOfShard("conv-01")).toBe("conv-01");
  });
});

describe("buildSessionDigests", () => {
  it("emits one card per session, session-ordered, turn-anchored, verbatim", () => {
    const text = buildSessionDigests(corpus());
    // Both s0 docs merge into ONE session card; s1 gets its own.
    expect(text.match(/^\[session /gm)).toHaveLength(2);
    const s0 = text.indexOf("[session s0 | turns 1-11]");
    const s1 = text.indexOf("[session s1 | turns 40-42]");
    expect(s0).toBeGreaterThan(-1);
    expect(s1).toBeGreaterThan(-1);
    expect(s0).toBeLessThan(s1); // earliest-turn order
    // Lines carry real event ids and verbatim content.
    expect(text).toContain("[7_s0_0#turn-");
    expect(text).toContain("sourdough");
    expect(text).toContain("kubernetes autoscaler");
  });

  it("is deterministic", () => {
    expect(buildSessionDigests(corpus())).toBe(buildSessionDigests(corpus()));
  });

  it("caps sessions and lines", () => {
    const text = buildSessionDigests(corpus(), { maxSessions: 1, linesPerSession: 1 });
    expect(text.match(/^\[session /gm)).toHaveLength(1);
    expect(text).toContain("[session s0");
    expect(text.match(/^  - \[/gm)).toHaveLength(1);
  });

  it("returns empty for an empty corpus", () => {
    expect(buildSessionDigests(buildCorpus([]))).toBe("");
  });
});
