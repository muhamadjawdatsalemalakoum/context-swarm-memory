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
 */
import { afterEach, describe, expect, it } from "vitest";

import { resolveEagerRecalls } from "../src/core/ask.js";
import { resolveCoverageMode } from "../src/core/coverage.js";
import { resolveSignalsRanker } from "../src/core/digestSelection.js";
import { resolveProbeFullScan } from "../src/core/probe.js";
import { resolveRouterHybrid, resolveShardDescriptors } from "../src/eval/baselines/csm.js";
import { rerankerEnabled } from "../src/eval/rerank.js";
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
  afterEach(() => {
    delete process.env.CSM_HYBRID_RERANK;
  });

  const FLAGS: Array<{ name: string; read: (v: string | undefined) => boolean; defaultOn: boolean }> = [
    { name: "CSM_EAGER_RECALLS", read: (v) => resolveEagerRecalls(v), defaultOn: false },
    { name: "CSM_PROBE_FULL_SCAN", read: (v) => resolveProbeFullScan(v), defaultOn: false },
    {
      name: "CSM_SIGNALS_RANKER",
      read: (v) => resolveSignalsRanker({ CSM_SIGNALS_RANKER: v }),
      defaultOn: false,
    },
    { name: "CSM_SHARD_DESCRIPTORS", read: (v) => resolveShardDescriptors(v), defaultOn: false },
    { name: "CSM_ROUTER_HYBRID", read: (v) => resolveRouterHybrid(v), defaultOn: false },
    { name: "CSM_HYBRID_RERANK", read: (v) => rerankerEnabled(v), defaultOn: false },
    { name: "CSM_COVERAGE", read: (v) => resolveCoverageMode(v), defaultOn: true },
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
    // but parsed as `!(0|false|no)`.
    expect(resolveRouterHybrid("off")).toBe(false);
    expect(resolveRouterHybrid("disabled")).toBe(false);
    expect(resolveRouterHybrid("n")).toBe(false);
    expect(resolveRouterHybrid("OFF")).toBe(false);
  });
});
