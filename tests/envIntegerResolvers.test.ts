import { describe, expect, it } from "vitest";

import { resolveCoverageMaxEntries, resolveCoverageRecallTokens, resolveCoverageStarvationFloor } from "../src/core/coverage.js";
import { resolveUnitSize } from "../src/core/retrievalUnit.js";
import { resolveRecallBudget, resolveShardCount } from "../src/core/tokenBudget.js";
import {
  resolveEntityBridgeK,
  resolveEntityBridgeMax,
  resolveLexicalBridgeK,
  resolveLexicalBridgeMax,
  resolveShardExpandK,
  resolveShardExpandMax,
} from "../src/eval/baselines/csm.js";
import { resolveGeminiCacheMode } from "../src/providers/GeminiProvider.js";
import { selectProviderName } from "../src/providers/LlmProvider.js";
import { EnvConfigError } from "../src/utils/env.js";

/**
 * Invariant 5, pinned for every integer/enum `CSM_*` resolver outside env.ts.
 *
 * The 2026-09-05 audit found twelve hand-parsed readers that silently fell back
 * to their default on garbage — the same class that once let
 * `CSM_ROUTER_HYBRID=off` turn the router ON — and five tests that PINNED the
 * silent behaviour. This table is the single place that says what "unset" means
 * for each and asserts that anything else throws an `EnvConfigError` naming the
 * variable. Add a row when you add a resolver; a resolver that is not here is a
 * resolver nobody checked.
 */
const coverage = { kind: "coverage", facets: {} } as unknown as Parameters<typeof resolveCoverageRecallTokens>[0];

const INTEGER_RESOLVERS: Array<{
  name: string;
  read: (raw: string | undefined) => number;
  unset: number;
  zeroAllowed: boolean;
}> = [
  { name: "CSM_RECALL_BUDGET", read: (v) => resolveRecallBudget(1200, { CSM_RECALL_BUDGET: v }), unset: 1200, zeroAllowed: false },
  { name: "CSM_MAX_PROBE_SHARDS", read: (v) => resolveShardCount("CSM_MAX_PROBE_SHARDS", 8, { CSM_MAX_PROBE_SHARDS: v }), unset: 8, zeroAllowed: false },
  { name: "CSM_MAX_RECALL_SHARDS", read: (v) => resolveShardCount("CSM_MAX_RECALL_SHARDS", 4, { CSM_MAX_RECALL_SHARDS: v }), unset: 4, zeroAllowed: false },
  { name: "CSM_COVERAGE_RECALL_TOKENS", read: (v) => resolveCoverageRecallTokens(coverage, 1200, v), unset: 3200, zeroAllowed: false },
  { name: "CSM_COVERAGE_MAX_ENTRIES", read: (v) => resolveCoverageMaxEntries(coverage, v, false), unset: 24, zeroAllowed: false },
  { name: "CSM_COVERAGE_STARVATION_FLOOR", read: (v) => resolveCoverageStarvationFloor(v), unset: 4, zeroAllowed: true },
  { name: "CSM_RETRIEVAL_UNITS", read: (v) => resolveUnitSize(v), unset: 0, zeroAllowed: true },
  { name: "CSM_SHARD_EXPAND_K", read: (v) => resolveShardExpandK(v), unset: 3, zeroAllowed: true },
  { name: "CSM_SHARD_EXPAND_MAX", read: (v) => resolveShardExpandMax(v), unset: 16, zeroAllowed: true },
  { name: "CSM_LEXICAL_BRIDGE_K", read: (v) => resolveLexicalBridgeK(v), unset: 0, zeroAllowed: true },
  { name: "CSM_LEXICAL_BRIDGE_MAX", read: (v) => resolveLexicalBridgeMax(v), unset: 20, zeroAllowed: true },
  { name: "CSM_ENTITY_BRIDGE_K", read: (v) => resolveEntityBridgeK(v), unset: 6, zeroAllowed: true },
  { name: "CSM_ENTITY_BRIDGE_MAX", read: (v) => resolveEntityBridgeMax(v), unset: 24, zeroAllowed: true },
];

describe("invariant 5 — integer CSM_* resolvers", () => {
  it("unset and empty resolve to the documented default", () => {
    for (const r of INTEGER_RESOLVERS) {
      expect(r.read(undefined), `${r.name} unset`).toBe(r.unset);
      expect(r.read(""), `${r.name} empty`).toBe(r.unset);
      expect(r.read("   "), `${r.name} whitespace`).toBe(r.unset);
    }
  });

  it("a valid integer is honoured verbatim", () => {
    for (const r of INTEGER_RESOLVERS) {
      expect(r.read("7"), r.name).toBe(7);
      expect(r.read(" 7 "), `${r.name} padded`).toBe(7);
    }
  });

  it("zero is either a meaningful 'off' or an error — never a silent default", () => {
    for (const r of INTEGER_RESOLVERS) {
      if (r.zeroAllowed) expect(r.read("0"), r.name).toBe(0);
      else expect(() => r.read("0"), r.name).toThrow(EnvConfigError);
    }
  });

  it("garbage, fractions and negatives THROW an EnvConfigError naming the variable", () => {
    for (const r of INTEGER_RESOLVERS) {
      for (const bad of ["abc", "6O", "4x", "on", "3.5", "1e3", "-1"]) {
        expect(() => r.read(bad), `${r.name}=${bad}`).toThrow(EnvConfigError);
        expect(() => r.read(bad), `${r.name}=${bad} names itself`).toThrow(new RegExp(r.name));
      }
    }
  });
});

describe("invariant 5 — enum CSM_* resolvers", () => {
  it("CSM_GEMINI_CACHE rejects unknown modes instead of warning and defaulting", () => {
    expect(resolveGeminiCacheMode(undefined)).toBe("off");
    expect(resolveGeminiCacheMode("Implicit-Observe")).toBe("implicit-observe");
    expect(() => resolveGeminiCacheMode("banana")).toThrow(EnvConfigError);
  });

  it("CSM_PROVIDER rejects a typo instead of silently running the whole CLI on MockProvider", () => {
    expect(selectProviderName({ CSM_PROVIDER: "gemini" })).toBe("gemini");
    expect(selectProviderName({ CSM_PROVIDER: "  Agent-SDK " })).toBe("agent-sdk");
    // Unset still auto-detects from the base URL, ending at "mock" when there is nothing to detect.
    expect(selectProviderName({})).toBe("mock");
    expect(selectProviderName({ CSM_OPENAI_BASE_URL: "http://localhost:11434/v1" })).toBe("ollama");
    // But a present, unrecognised value is an error — previously "gemni" ran everything on the mock.
    expect(() => selectProviderName({ CSM_PROVIDER: "gemni" })).toThrow(EnvConfigError);
    expect(() => selectProviderName({ CSM_PROVIDER: "gemni" })).toThrow(/CSM_PROVIDER/);
  });
});
