/**
 * Fact-registry FOLD (`CSM_AMB_FACT_FOLD`) — the R2 mechanism arm.
 *
 * Contract pinned here:
 *  - the flag defaults OFF and garbage throws (env.ts invariant);
 *  - the cache key mirrors the preference-profile scheme exactly
 *    (split | unit | write-time model | prompt version, sha256 first 16) so
 *    the two write-time artifacts stay operationally alike;
 *  - the fold block LICENSES commitment — the measured requirement from the
 *    1M knowledge_update diagnosis (hedged-correct answers score 0.5, crisp
 *    commitment scores 1.0) — and carries the registry verbatim;
 *  - fold never triggers the reduced raw-doc cut: that count-slice is the
 *    measured breadth killer and belongs to REPLACE mode only (pinned by
 *    reading the bridge source, since the gate is an internal expression).
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  factFoldActive,
  factRegistryCachePath,
  renderFactFoldBlock,
  FACT_PROMPT_VERSION,
} from "../scripts/amb-fact-registry.js";
import { EnvConfigError } from "../src/utils/env.js";

afterEach(() => {
  delete process.env.CSM_AMB_FACT_FOLD;
  delete process.env.CSM_AMB_FACT_CACHE_DIR;
});

describe("factFoldActive", () => {
  // DEFAULT FLIPPED OFF -> ON on 2026-08-25 after the full guard file: 500K
  // knowledge_update certified on two readers, abstention guard a wash, the
  // PF/CR composition guard positive, answer tokens neutral.
  it("defaults ON, keeps explicit off byte-reachable, rejects garbage", () => {
    expect(factFoldActive()).toBe(true);
    process.env.CSM_AMB_FACT_FOLD = "0";
    expect(factFoldActive()).toBe(false);
    process.env.CSM_AMB_FACT_FOLD = "1";
    expect(factFoldActive()).toBe(true);
    process.env.CSM_AMB_FACT_FOLD = "definitely";
    expect(() => factFoldActive()).toThrow(EnvConfigError);
  });
});

describe("factRegistryCachePath", () => {
  it("is deterministic and distinguishes split, unit and model", () => {
    const a = factRegistryCachePath({ split: "1m", userId: "19", model: "m1" });
    expect(a).toBe(factRegistryCachePath({ split: "1m", userId: "19", model: "m1" }));
    expect(a).not.toBe(factRegistryCachePath({ split: "500k", userId: "19", model: "m1" }));
    expect(a).not.toBe(factRegistryCachePath({ split: "1m", userId: "21", model: "m1" }));
    expect(a).not.toBe(factRegistryCachePath({ split: "1m", userId: "19", model: "m2" }));
    // undefined model keys as the literal "default", never collides silently.
    expect(factRegistryCachePath({ split: "1m", userId: "19", model: undefined })).not.toBe(a);
    expect(a).toContain("1m-u19-");
  });

  it("honours the test-dir override", () => {
    process.env.CSM_AMB_FACT_CACHE_DIR = "C:/tmp/fact-cache-test";
    expect(
      factRegistryCachePath({ split: "1m", userId: "1", model: "m" }).replaceAll("\\", "/"),
    ).toContain("/tmp/fact-cache-test");
  });
});

describe("renderFactFoldBlock", () => {
  it("licenses commitment, binds qualifiers, and carries the registry verbatim", () => {
    const registry = "typing speed: 75 wpm -> 78 wpm; LATEST: 78 wpm (during recorded sessions)";
    const block = renderFactFoldBlock(registry);
    expect(block).toContain("CURRENT VALUES");
    expect(block).toContain("LATEST value IS the current one");
    expect(block).toContain("do not hedge");
    expect(block).toContain("qualifier");
    expect(block).toContain(registry);
    // Provenance line every capsule artifact carries.
    expect(block).toContain("no gold answers or rubric used");
  });
});

describe("fold never reaches the reduced raw-doc cut", () => {
  it("the ids gate uses factReplace, not factActive", () => {
    const src = readFileSync("scripts/amb-csm-retrieve.ts", "utf8");
    expect(src).toContain("const factReplace = factActive && !factFold;");
    expect(src).toContain("synthActive || obsActive || factReplace");
    // The replacement branch itself is also gated on replace mode.
    expect(src).toContain("if (factReplace) {");
    expect(src).not.toContain("synthActive || obsActive || factActive");
  });
});
