/**
 * Mock-mode end-to-end smoke for the BEAM-slice harness: runner (retrieval
 * side) → payloads.jsonl → scorer (eval side), all on the synthetic fixture.
 * No network, no API keys, no real BEAM rows.
 *
 * Embedding-dependent augmentation stages are stubbed off
 * (CSM_EMBED_FLOOR_K=0 etc., the cost-accounting.test.ts precedent) so the
 * suite never loads the MiniLM model. The mock-mode artifact run on the
 * REAL fetched slice (see EXP-T3-beam-slice.md) keeps them on.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runBeamSlice } from "../scripts/run-beam-slice.js";
import {
  aggregateByCategory,
  buildBeamEventIndex,
  loadBeamGold,
  readPayloadRows,
  scorePayloadRow,
} from "../src/eval/retrievalScore.js";

const FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "beam",
);

describe("beam slice mock-mode end-to-end", () => {
  let runDir: string;

  beforeAll(async () => {
    vi.stubEnv("CSM_AMB_ALLOW_MOCK", "1");
    vi.stubEnv("CSM_PROVIDER", "mock");
    vi.stubEnv("CSM_EMBED_FLOOR_K", "0");
    vi.stubEnv("CSM_SHARD_EXPAND_K", "0");
    vi.stubEnv("CSM_LEXICAL_BRIDGE_K", "0");
    vi.stubEnv("CSM_ENTITY_BRIDGE_K", "0");
    runDir = await mkdtemp(join(tmpdir(), "beam-slice-e2e-"));
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("beam_e2e_mock_run_writes_payloads_and_scores", async () => {
    const result = await runBeamSlice({
      split: "100k",
      runId: "beam-slice-e2e-test",
      categories: ["summarization", "event_ordering", "temporal_reasoning"],
      sliceDir: FIXTURE_DIR,
      outputDir: runDir,
      requestedK: 24,
      seed: 42,
      onProgress: () => {},
    });

    expect(result.providerName).toBe("mock");
    expect(result.queriesPlanned).toBe(3);
    expect(result.queriesRun).toBe(3);
    expect(result.unitsTouched).toBe(2);
    expect(existsSync(result.payloadsPath)).toBe(true);
    expect(existsSync(result.configPath)).toBe(true);

    // Config echoes tuning env, never key material.
    const config = JSON.parse(await readFile(result.configPath, "utf8")) as {
      providerName: string;
      envEcho: Record<string, string>;
    };
    expect(config.providerName).toBe("mock");
    expect(config.envEcho.CSM_AMB_ALLOW_MOCK).toBe("1");
    expect(JSON.stringify(config).toUpperCase().includes("API_KEY")).toBe(false);

    // Payload rows are gold-free: only ids/counters/telemetry.
    const rows = readPayloadRows(result.payloadsPath);
    expect(rows.length).toBe(3);
    const raw = await readFile(result.payloadsPath, "utf8");
    for (const banned of ["gold_answers", "gold_ids", "rubric", "ordering_tested"]) {
      expect(raw.includes(banned), `payloads contain "${banned}"`).toBe(false);
    }
    for (const row of rows) {
      expect(row.userId === "u1" || row.userId === "u2").toBe(true);
      expect(row.requestedK).toBe(24);
      // Mock pipeline still returns SOME event ids (keyword path).
      expect(Array.isArray(row.returnedEventIds)).toBe(true);
    }

    // Eval side scores the payloads (same artifacts the CLI uses).
    const gold = loadBeamGold("100k", { sliceDir: FIXTURE_DIR });
    const index = buildBeamEventIndex("100k", { sliceDir: FIXTURE_DIR });
    const scores = rows
      .map((row) => scorePayloadRow(row, gold.get(row.queryId)!, index))
      .filter((s): s is NonNullable<typeof s> => s !== null);
    expect(scores.length).toBe(3);
    for (const s of scores) {
      for (const k of ["@10", "@24", "@32"]) {
        expect(s.coverageAtK[k]).toBeGreaterThanOrEqual(0);
        expect(s.coverageAtK[k]).toBeLessThanOrEqual(1);
      }
      expect(s.oracleCoverage).toBeGreaterThan(0); // fixture facets ARE in the unit
    }
    const aggs = aggregateByCategory(scores, [10, 24, 32], {
      bootstrapResamples: 200,
    });
    expect(aggs.length).toBe(3);
    expect(aggs.every((a) => a.n === 1)).toBe(true);
  });

  it("beam_e2e_resume_skips_completed_queries", async () => {
    const again = await runBeamSlice({
      split: "100k",
      runId: "beam-slice-e2e-test",
      categories: ["summarization", "event_ordering", "temporal_reasoning"],
      sliceDir: FIXTURE_DIR,
      outputDir: runDir,
      requestedK: 24,
      seed: 42,
      onProgress: () => {},
    });
    expect(again.queriesRun).toBe(0);
    expect(again.queriesSkippedResume).toBe(3);
    const rows = readPayloadRows(join(runDir, "payloads.jsonl"));
    expect(rows.length).toBe(3); // no duplicates appended
  });

  it("beam_e2e_mock_guard_refuses_without_optin", async () => {
    vi.stubEnv("CSM_AMB_ALLOW_MOCK", "");
    try {
      await expect(
        runBeamSlice({
          split: "100k",
          runId: "beam-slice-e2e-guard",
          sliceDir: FIXTURE_DIR,
          outputDir: await mkdtemp(join(tmpdir(), "beam-slice-guard-")),
          onProgress: () => {},
        }),
      ).rejects.toThrow(/mock provider/i);
    } finally {
      vi.stubEnv("CSM_AMB_ALLOW_MOCK", "1");
    }
  });
});
