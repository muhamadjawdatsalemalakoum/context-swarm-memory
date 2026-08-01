/**
 * Intent-gate split (readiness plan P2) — CSM_AMB_LEGACY_INTENT.
 *
 * The Observation and fact-registry gates ship two paths: a DEFAULT
 * plain-language core (no benchmark-derived additions) and a LEGACY path that
 * byte-preserves the regexes validated on the four BEAM tier query sets, so
 * old arms stay reproducible. Pinned here:
 *   - default summary intent = verbs + head-noun summary/overview only; the
 *     ordering/timeline phrase list is legacy-only;
 *   - default aggregation intent drops the two measured-leak guards
 *     ("(?<!items )in total", the how-much duration exclusion) — those fire
 *     differently ONLY under legacy;
 *   - the flag itself goes through env.ts (garbage throws, never defaults).
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  aggregationQueryIntent,
  legacyIntentActive,
  observationQueryIntent,
} from "../scripts/amb-csm-retrieve.js";
import { EnvConfigError } from "../src/utils/env.js";

afterEach(() => {
  delete process.env.CSM_AMB_LEGACY_INTENT;
});

describe("legacyIntentActive", () => {
  it("defaults OFF and rejects garbage", () => {
    expect(legacyIntentActive()).toBe(false);
    process.env.CSM_AMB_LEGACY_INTENT = "1";
    expect(legacyIntentActive()).toBe(true);
    process.env.CSM_AMB_LEGACY_INTENT = "sure";
    expect(() => legacyIntentActive()).toThrow(EnvConfigError);
  });
});

describe("observationQueryIntent", () => {
  it("verb core fires on both paths", () => {
    for (const legacy of [false, true]) {
      process.env.CSM_AMB_LEGACY_INTENT = legacy ? "1" : "0";
      expect(observationQueryIntent("Summarize our database discussions")).toBe(true);
      expect(observationQueryIntent("give me a recap of the migration")).toBe(true);
      expect(observationQueryIntent("a summary of how we chose the queue")).toBe(true);
    }
  });

  it("noun-modifier usages never fire (head-noun lookahead)", () => {
    for (const legacy of [false, true]) {
      process.env.CSM_AMB_LEGACY_INTENT = legacy ? "1" : "0";
      expect(observationQueryIntent("how can I reduce summary generation time")).toBe(false);
      expect(observationQueryIntent("open the design overview document")).toBe(false);
    }
  });

  it("ordering/timeline phrases are LEGACY-only", () => {
    const q = "walk me through my progress in order (mention 8 items in total)";
    expect(observationQueryIntent(q)).toBe(false);
    expect(observationQueryIntent("reconstruct the timeline of the outage")).toBe(false);
    process.env.CSM_AMB_LEGACY_INTENT = "1";
    expect(observationQueryIntent(q)).toBe(true);
    expect(observationQueryIntent("reconstruct the timeline of the outage")).toBe(true);
  });

  it("purpose idiom 'in order to' stays silent even under legacy", () => {
    process.env.CSM_AMB_LEGACY_INTENT = "1";
    expect(observationQueryIntent("what did we install in order to run the tests")).toBe(false);
  });
});

describe("aggregationQueryIntent", () => {
  it("plain aggregation grammar fires on both paths", () => {
    for (const legacy of [false, true]) {
      process.env.CSM_AMB_LEGACY_INTENT = legacy ? "1" : "0";
      expect(
        aggregationQueryIntent("how many databases did we evaluate across the two projects"),
      ).toBe(true);
      expect(aggregationQueryIntent("what was the total delay combining both incidents")).toBe(
        true,
      );
    }
  });

  it("the two measured-leak guards apply ONLY under legacy", () => {
    const formatInstruction = "list my milestones (mention 8 items in total)";
    const duration = "how much time did I spend across the sessions";
    // Default core: no guards, both fire.
    expect(aggregationQueryIntent(formatInstruction)).toBe(true);
    expect(aggregationQueryIntent(duration)).toBe(true);
    // Legacy: guards suppress both.
    process.env.CSM_AMB_LEGACY_INTENT = "1";
    expect(aggregationQueryIntent(formatInstruction)).toBe(false);
    expect(aggregationQueryIntent(duration)).toBe(false);
  });

  it("non-aggregation queries stay silent on both paths", () => {
    for (const legacy of [false, true]) {
      process.env.CSM_AMB_LEGACY_INTENT = legacy ? "1" : "0";
      expect(aggregationQueryIntent("what is the current API rate limit")).toBe(false);
      expect(aggregationQueryIntent("which vector store did we pick")).toBe(false);
    }
  });
});
