/**
 * REGRESSION GUARD — one vocabulary for configuration, and no silent defaults.
 *
 * CSM is configured by ~110 `CSM_*` variables that were each parsed by hand.
 * The 2026-07-31 system audit found six incompatible truthiness rules, and one
 * of them was inverted: `resolveRouterHybrid` was DEFAULT-OFF but parsed by
 * negation, so `CSM_ROUTER_HYBRID=off` turned the hybrid router **on** — as did
 * `disabled`, `OFF`, and `n`. The hybrid router is CSM's largest measured
 * retrieval win, so an A/B whose control arm was written `=off` would have run
 * the treatment in both arms and labelled one of them the baseline.
 *
 * These tests pin the primitive and the specific historical footguns.
 *
 * ── 2026-08-01 DEFAULT FLIPS ────────────────────────────────────────────────
 *
 * Four defaults flipped after paired gates at the BEAM 1M tier (see the
 * `FLAGS` table below for the per-flag evidence). "Unset" therefore no longer
 * means "off" for `CSM_ROUTER_HYBRID`, `CSM_SHARD_DESCRIPTORS`, or
 * `CSM_PROBE_BATCH` (hosted providers). The pre-flip behaviour is NOT
 * unpinned by that: every one of them is still asserted here against an
 * EXPLICIT `=0`, which is what a run reproducing a pre-flip configuration
 * writes. When a default flips, move the claim onto the explicit value — never
 * delete it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveEagerRecalls, resolveProbeBatch } from "../src/core/ask.js";
import { resolveCoverageMode } from "../src/core/coverage.js";
import { resolveSignalsRanker } from "../src/core/digestSelection.js";
import { resolveProbeFullScan } from "../src/core/probe.js";
import { resolveRouterHybrid, resolveShardDescriptors } from "../src/eval/baselines/csm.js";
import { rerankerEnabled } from "../src/eval/rerank.js";
import { factFoldActive } from "../scripts/amb-fact-registry.js";
import { preferenceProfileActive } from "../scripts/amb-preference-profile.js";
import { EnvConfigError, envFlag, envInt, envPositiveInt } from "../src/utils/env.js";

describe("envFlag", () => {
  it("accepts the full documented true vocabulary", () => {
    for (const v of ["1", "true", "yes", "y", "on", "enable", "enabled"]) {
      expect(envFlag(v, { name: "X", fallback: false })).toBe(true);
    }
  });

  it("accepts the full documented false vocabulary", () => {
    for (const v of ["0", "false", "no", "n", "off", "disable", "disabled"]) {
      expect(envFlag(v, { name: "X", fallback: true })).toBe(false);
    }
  });

  it("is case- and whitespace-insensitive", () => {
    // `resolveSignalsRanker` used to compare the RAW value, so a leading space
    // — trivially produced by a .env file or a shell — read as false.
    expect(envFlag(" 1 ", { name: "X", fallback: false })).toBe(true);
    expect(envFlag("TRUE", { name: "X", fallback: false })).toBe(true);
    expect(envFlag("\tOff\n", { name: "X", fallback: true })).toBe(false);
  });

  it("falls back only when unset or empty", () => {
    expect(envFlag(undefined, { name: "X", fallback: true })).toBe(true);
    expect(envFlag("", { name: "X", fallback: true })).toBe(true);
    expect(envFlag("   ", { name: "X", fallback: false })).toBe(false);
  });

  it("THROWS on an unrecognised value instead of silently defaulting", () => {
    // The whole point: a typo must stop the run, not quietly produce a
    // mislabelled benchmark row.
    expect(() => envFlag("ture", { name: "CSM_ROUTER_HYBRID", fallback: false })).toThrow(
      EnvConfigError,
    );
    expect(() => envFlag("2", { name: "CSM_X", fallback: false })).toThrow(/CSM_X/);
  });

  it("names the variable and the offending value in the error", () => {
    let message = "";
    try {
      envFlag("maybe", { name: "CSM_COVERAGE", fallback: true });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("CSM_COVERAGE");
    expect(message).toContain("maybe");
  });
});

describe("envInt", () => {
  it("parses integers and honours the fallback when unset", () => {
    expect(envInt("42", { name: "X", fallback: 7 })).toBe(42);
    expect(envInt(undefined, { name: "X", fallback: 7 })).toBe(7);
    expect(envInt("  ", { name: "X", fallback: 7 })).toBe(7);
  });

  it("rejects non-integers rather than reverting to the fallback", () => {
    // The old `parsePositiveInt` returned the fallback for "abc" and for
    // "3.5" — a mistyped budget silently ran at the default.
    expect(() => envInt("abc", { name: "X", fallback: 7 })).toThrow(EnvConfigError);
    expect(() => envInt("3.5", { name: "X", fallback: 7 })).toThrow(EnvConfigError);
    expect(() => envInt("1e3", { name: "X", fallback: 7 })).toThrow(EnvConfigError);
  });

  it("enforces range", () => {
    expect(() => envInt("-1", { name: "X", fallback: 7 })).toThrow(/\[0, /);
    expect(envInt("0", { name: "X", fallback: 7 })).toBe(0);
    expect(() => envPositiveInt("0", { name: "X", fallback: 7 })).toThrow(/\[1, /);
    expect(envPositiveInt("1", { name: "X", fallback: 7 })).toBe(1);
  });
});

describe("every CSM boolean flag now shares one vocabulary", () => {
  /**
   * Every resolver below takes its raw value as a DEFAULT PARAMETER sourced
   * from `process.env`, so `read(undefined)` only means "unset" if the ambient
   * variable is genuinely absent. Clear them around each case (and restore
   * whatever the developer's shell had) or a stray `CSM_ROUTER_HYBRID=1` in the
   * environment turns the default assertions into tautologies.
   */
  const AMBIENT = [
    "CSM_EAGER_RECALLS",
    "CSM_PROBE_FULL_SCAN",
    "CSM_SIGNALS_RANKER",
    "CSM_SHARD_DESCRIPTORS",
    "CSM_ROUTER_HYBRID",
    "CSM_HYBRID_RERANK",
    "CSM_COVERAGE",
    "CSM_PROBE_BATCH",
    // Both are FLAGS rows whose resolvers default their argument from
    // process.env; without clearing them the "unset default" assertions read
    // the developer's shell (audit 2026-09-05).
    "CSM_AMB_PREFERENCE_PROFILE",
    "CSM_AMB_FACT_FOLD",
  ] as const;
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = Object.fromEntries(AMBIENT.map((k) => [k, process.env[k]]));
    for (const k of AMBIENT) delete process.env[k];
  });

  afterEach(() => {
    for (const k of AMBIENT) {
      const prev = saved[k];
      if (prev === undefined) delete process.env[k];
      else process.env[k] = prev;
    }
  });

  /**
   * `defaultOn` is the SHIPPED default — what a fresh clone with no `.env`
   * runs — so it is a behavioural claim, not bookkeeping. Flipped 2026-08-01
   * on paired-gate evidence at the BEAM 1M tier:
   *
   *   CSM_ROUTER_HYBRID      false → TRUE. +0.365 answer score, 26W/5L; the
   *                          only lever measured on this system that converted
   *                          a retrieval gain into an answer gain.
   *   CSM_SHARD_DESCRIPTORS  false → TRUE. Flat as a standalone lever, but it
   *                          is the corpus-derived signal the hybrid router's
   *                          lexical leg consumes — the two ship together or
   *                          the router runs on a weaker signal.
   *   CSM_PROBE_BATCH        false → TRUE for HOSTED providers only (r1mJ vs
   *                          r1mI2, n=45: −21% internal input at +0.0315,
   *                          below MDE). Still FALSE for "ollama" and
   *                          "llama-server": the evidence is from one hosted
   *                          model family, and comparative one-pass shard
   *                          judgement is a harder task for a 4B-class local
   *                          model. Same provider-class split as
   *                          `resolveParallelProbes`.
   *
   * Both provider classes of `CSM_PROBE_BATCH` are listed because its resolver
   * now takes `(providerName, raw)` — the default is a FUNCTION of the
   * provider, and each branch needs its own pin.
   */
  const FLAGS: Array<{ name: string; read: (v: string | undefined) => boolean; defaultOn: boolean }> = [
    { name: "CSM_EAGER_RECALLS", read: (v) => resolveEagerRecalls(v), defaultOn: false },
    { name: "CSM_PROBE_FULL_SCAN", read: (v) => resolveProbeFullScan(v), defaultOn: false },
    {
      name: "CSM_SIGNALS_RANKER",
      read: (v) => resolveSignalsRanker({ CSM_SIGNALS_RANKER: v }),
      defaultOn: false,
    },
    { name: "CSM_SHARD_DESCRIPTORS", read: (v) => resolveShardDescriptors(v), defaultOn: true },
    { name: "CSM_ROUTER_HYBRID", read: (v) => resolveRouterHybrid(v), defaultOn: true },
    { name: "CSM_HYBRID_RERANK", read: (v) => rerankerEnabled(v), defaultOn: false },
    // CERTIFIED-CONFIG pins (2026-08-25 pre-flight audit). The profile default
    // was once flipped in a comment but not in code, and the docs repeated the
    // claim for three weeks — every certified full-n arm actually ran
    // profile-OFF. These rows make any future silent flip a test failure.
    {
      name: "CSM_AMB_PREFERENCE_PROFILE",
      read: (v) => preferenceProfileActive(v),
      defaultOn: false,
    },
    { name: "CSM_AMB_FACT_FOLD", read: (v) => factFoldActive(v), defaultOn: true },
    { name: "CSM_COVERAGE", read: (v) => resolveCoverageMode(v), defaultOn: true },
    {
      name: "CSM_PROBE_BATCH (hosted: gemini)",
      read: (v) => resolveProbeBatch("gemini", v),
      defaultOn: true,
    },
    {
      name: "CSM_PROBE_BATCH (local: ollama)",
      read: (v) => resolveProbeBatch("ollama", v),
      defaultOn: false,
    },
    {
      name: "CSM_PROBE_BATCH (local: llama-server)",
      read: (v) => resolveProbeBatch("llama-server", v),
      defaultOn: false,
    },
  ];

  it("agrees on every true value", () => {
    for (const flag of FLAGS) {
      for (const v of ["1", "true", "yes", "on", "enabled", " 1"]) {
        expect(flag.read(v), `${flag.name}=${JSON.stringify(v)}`).toBe(true);
      }
    }
  });

  it("agrees on every false value — including the ones that used to mean TRUE", () => {
    for (const flag of FLAGS) {
      for (const v of ["0", "false", "no", "off", "disabled", "OFF", "n"]) {
        expect(flag.read(v), `${flag.name}=${JSON.stringify(v)}`).toBe(false);
      }
    }
  });

  it("honours each flag's documented default when unset", () => {
    // Guards the flip in BOTH directions: an accidental revert of a default-ON
    // lever fails here, and so does a default silently turning ON without the
    // evidence line in the table above being updated to say why.
    for (const flag of FLAGS) {
      expect(flag.read(undefined), `${flag.name} unset`).toBe(flag.defaultOn);
      expect(flag.read(""), `${flag.name} empty`).toBe(flag.defaultOn);
    }
  });

  it("rejects typos on every flag", () => {
    for (const flag of FLAGS) {
      expect(() => flag.read("tru"), flag.name).toThrow(EnvConfigError);
    }
  });

  it("CSM_ROUTER_HYBRID=off is OFF (the audit's headline defect)", () => {
    // Before the fix this returned true, because the resolver was default-off
    // but parsed as `!(0|false|no)`. The flag is now default-ON, which makes
    // this case MORE load-bearing, not less: `=off` is the only way left to
    // get the pre-flip router, so if the negation ever came back, a control
    // arm written `=off` would silently run the treatment again.
    expect(resolveRouterHybrid("off")).toBe(false);
    expect(resolveRouterHybrid("disabled")).toBe(false);
    expect(resolveRouterHybrid("n")).toBe(false);
    expect(resolveRouterHybrid("OFF")).toBe(false);
  });

  it("the 2026-08-01 flips stay explicitly reversible (pre-flip arms reproduce)", () => {
    // These three used to make their "off" claim through UNSET. That claim is
    // not retired, it MOVED: an A/B arm reproducing a pre-flip configuration
    // now writes `=0`, and every recorded pre-flip run is only re-runnable if
    // the explicit off value keeps meaning off. Do not fold this into the
    // vocabulary sweep above — that one proves the words parse, this one
    // proves the pre-flip CONFIGURATION is still reachable.
    expect(resolveRouterHybrid("0")).toBe(false);
    expect(resolveShardDescriptors("0")).toBe(false);
    expect(resolveProbeBatch("gemini", "0")).toBe(false);
    // …and the flips are real when nothing is set: a fresh clone with no .env
    // runs the winning configuration rather than the one that lost the gate.
    expect(resolveRouterHybrid(undefined)).toBe(true);
    expect(resolveShardDescriptors(undefined)).toBe(true);
    expect(resolveProbeBatch("gemini", undefined)).toBe(true);
  });

  it("CSM_PROBE_BATCH's default is provider-class-scoped, and =1 overrides it", () => {
    // The local default is OFF because the −21%-input gate ran on ONE hosted
    // model family; batching asks a model to judge shards COMPARATIVELY in one
    // pass, which a 4B-class local model may do worse than N binary calls.
    // That is a deliberate refusal to extrapolate, not an oversight — so pin
    // both that local stays off unset, and that a local run can still opt in.
    expect(resolveProbeBatch("ollama", undefined)).toBe(false);
    expect(resolveProbeBatch("llama-server", undefined)).toBe(false);
    expect(resolveProbeBatch("ollama", "1")).toBe(true);
    expect(resolveProbeBatch("llama-server", "on")).toBe(true);
    // An explicit value beats the provider heuristic in the other direction too.
    expect(resolveProbeBatch("gemini", "off")).toBe(false);
    // Unknown/hosted provider names take the hosted branch (the heuristic is a
    // deny-list of local servers, not an allow-list of hosted ones).
    expect(resolveProbeBatch("openai", undefined)).toBe(true);
    expect(resolveProbeBatch("mock", undefined)).toBe(true);
    // A typo still stops the run rather than picking a provider-class default.
    expect(() => resolveProbeBatch("ollama", "tru")).toThrow(EnvConfigError);
  });
});

describe("CSM_AMB_ID_REPAIR default (audit F12)", () => {
  /**
   * Unresolvable ("bare") event ids occupy slots in the top-K cut and then
   * vanish at `.filter(Boolean)`. Measured on a 45-query BEAM 1M slice with the
   * repair off: 394 of 1,099 returned ids (35.9%) produced no document, 32 of 45
   * queries lost evidence, and the answer score was 0.6065 against 0.8037 with
   * it on. It is a bug fix, not a tuning lever, so it defaults ON — an opt-in
   * correctness fix is one every future run has to remember, and one already
   * did not.
   */
  it("defaults to ON when the variable is unset", () => {
    expect(envFlag(undefined, { name: "CSM_AMB_ID_REPAIR", fallback: true })).toBe(true);
    expect(envFlag("", { name: "CSM_AMB_ID_REPAIR", fallback: true })).toBe(true);
  });

  it("can still be turned off explicitly, for reproducing pre-fix runs", () => {
    for (const v of ["0", "false", "off", "no"]) {
      expect(envFlag(v, { name: "CSM_AMB_ID_REPAIR", fallback: true })).toBe(false);
    }
  });
});
