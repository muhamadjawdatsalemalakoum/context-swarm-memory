/**
 * Verify the published benchmark evidence bundle.
 *
 * This is intentionally narrow: it checks the canonical v0.2 result rows that
 * back the README/SOTA claims and recomputes the headline metrics directly from
 * results.jsonl. It does not call an LLM and does not need a GPU.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { mcNemar, type McqScore } from "../src/eval/scorer.js";

interface ResultRow {
  corpusSize?: number;
  citationF1: number;
  citationPrecision: number;
  citationRecall: number;
  correct: boolean;
  modelContext?: number;
  queryId: string;
  system: string;
}

interface ExpectedMetric {
  corpusSize?: number;
  correct: number;
  f1: number;
  modelContext?: number;
  n: number;
  runId: string;
  system: string;
}

const HASHES: Record<string, string> = {
  "data/eval/runs/v020-30q-embedfloor/config.json":
    "4fb52aa5d24bf12dfd8743a7265f43bf734cf7e006ebc3207907f7cf4b07aa47",
  "data/eval/runs/v020-30q-embedfloor/results.jsonl":
    "3e9c94879b60bef16fabbdf0346a431a32c54027a2cdc4a9a2a89d7aabb96b53",
  "data/eval/runs/lightrag-30q/config.json":
    "a2c8d6e267c896a7153ed21f2e7d0198b101b952ead65b109fe5cdc8f404ac2e",
  "data/eval/runs/lightrag-30q/results.jsonl":
    "274dd423048855841beac8d63b14600559d39a685451d6b2e788a46303048366",
  "data/eval/runs/scaling-rq1/config.json":
    "88d3a061ac5b8787f9e7e5f74e69b29b461d4387ca2605b77becaabb91cfd105",
  "data/eval/runs/scaling-rq1/results.jsonl":
    "610b61162a3f8c995ec43f070c928c580858648ca9e981f4182b3df4ffc94655",
  "data/eval/runs/scaling-1m/config.json":
    "bf4be983f5615471758dba6e72223e2da9649afdbeaf5f2be8877f156fc0ec15",
  "data/eval/runs/scaling-1m/results.jsonl":
    "22d95028bdea311050184f06c7504cfa0d05ceae08eff6d1a7cd296547064c14",
  "data/eval/runs/gemini35-160k-30q-v1/config.json":
    "3e56839cf19795723a84fee0a5e90e90121fb631d2aec92596f4ff8ef8f9c2ed",
  "data/eval/runs/gemini35-160k-30q-v1/results.jsonl":
    "2f0e38651686dfea902f7f2b8c427952830f30ea81cc700d6640fb0283db738d",
  "data/eval/runs/gemini35-160k-30q-v1/summary.json":
    "5aed175548f19a6f86cebf1833623bc6338de95aefa4671a23dc184b884c8f5e",
  "data/eval/runs/gemini35-160k-30q-v1/trial-summary.md":
    "7c468a0446f19810d79e20395560be24ee9e6b6fc7c29807dc3768d0b184c785",
  "data/eval/runs/gemini35-160k-30q-v1/report.md":
    "134115a5cab0737e18ff72172283c06d5ff92743355c822129a0352e1d66da1c",
};

const EXPECTED: ExpectedMetric[] = [
  { runId: "v020-30q-embedfloor", system: "csm", n: 30, correct: 30, f1: 0.505 },
  { runId: "v020-30q-embedfloor", system: "rag", n: 30, correct: 29, f1: 0.446 },
  { runId: "v020-30q-embedfloor", system: "hybrid", n: 30, correct: 28, f1: 0.455 },
  { runId: "lightrag-30q", system: "lightrag", n: 30, correct: 24, f1: 0.265 },
  { runId: "scaling-rq1", system: "csm", n: 30, correct: 27, f1: 0.524 },
  { runId: "scaling-rq1", system: "rag", n: 30, correct: 29, f1: 0.446 },
  { runId: "scaling-rq1", system: "longctx", n: 30, correct: 11, f1: 0.067 },
  { runId: "scaling-1m", system: "csm", n: 30, correct: 28, f1: 0.46 },
  { runId: "scaling-1m", system: "rag", n: 30, correct: 25, f1: 0.336 },
  { runId: "scaling-1m", system: "longctx", n: 30, correct: 9, f1: 0.033 },
  {
    runId: "gemini35-160k-30q-v1",
    system: "csm",
    corpusSize: 100_000,
    modelContext: 160_000,
    n: 30,
    correct: 28,
    f1: 0.517,
  },
  {
    runId: "gemini35-160k-30q-v1",
    system: "csm",
    corpusSize: 1_000_000,
    modelContext: 160_000,
    n: 30,
    correct: 29,
    f1: 0.523,
  },
  {
    runId: "gemini35-160k-30q-v1",
    system: "csm",
    corpusSize: 2_000_000,
    modelContext: 160_000,
    n: 30,
    correct: 28,
    f1: 0.515,
  },
  {
    runId: "gemini35-160k-30q-v1",
    system: "longctx",
    corpusSize: 100_000,
    modelContext: 160_000,
    n: 30,
    correct: 30,
    f1: 0.559,
  },
  {
    runId: "gemini35-160k-30q-v1",
    system: "longctx",
    corpusSize: 1_000_000,
    modelContext: 160_000,
    n: 30,
    correct: 27,
    f1: 0.163,
  },
  {
    runId: "gemini35-160k-30q-v1",
    system: "longctx",
    corpusSize: 2_000_000,
    modelContext: 160_000,
    n: 30,
    correct: 15,
    f1: 0.086,
  },
  {
    runId: "gemini35-160k-30q-v1",
    system: "rag",
    corpusSize: 100_000,
    modelContext: 160_000,
    n: 30,
    correct: 28,
    f1: 0.447,
  },
  {
    runId: "gemini35-160k-30q-v1",
    system: "rag",
    corpusSize: 1_000_000,
    modelContext: 160_000,
    n: 30,
    correct: 26,
    f1: 0.345,
  },
  {
    runId: "gemini35-160k-30q-v1",
    system: "rag",
    corpusSize: 2_000_000,
    modelContext: 160_000,
    n: 30,
    correct: 26,
    f1: 0.334,
  },
  {
    runId: "gemini35-160k-30q-v1",
    system: "hybrid",
    corpusSize: 100_000,
    modelContext: 160_000,
    n: 30,
    correct: 27,
    f1: 0.447,
  },
  {
    runId: "gemini35-160k-30q-v1",
    system: "hybrid",
    corpusSize: 1_000_000,
    modelContext: 160_000,
    n: 30,
    correct: 27,
    f1: 0.386,
  },
  {
    runId: "gemini35-160k-30q-v1",
    system: "hybrid",
    corpusSize: 2_000_000,
    modelContext: 160_000,
    n: 30,
    correct: 27,
    f1: 0.386,
  },
];

function sha256(path: string): string {
  return createHash("sha256")
    .update(readFileSync(join(process.cwd(), path)))
    .digest("hex");
}

function loadRows(
  runId: string,
  system: string,
  filters: { corpusSize?: number; modelContext?: number } = {},
): ResultRow[] {
  const path = join(process.cwd(), "data", "eval", "runs", runId, "results.jsonl");
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ResultRow)
    .filter((row) => row.system === system)
    .filter((row) => filters.corpusSize === undefined || row.corpusSize === filters.corpusSize)
    .filter((row) => filters.modelContext === undefined || row.modelContext === filters.modelContext)
    .sort((a, b) => a.queryId.localeCompare(b.queryId));
}

function score(row: ResultRow): McqScore {
  return {
    correct: row.correct,
    citationF1: row.citationF1,
    citationPrecision: row.citationPrecision,
    citationRecall: row.citationRecall,
  };
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function assertNear(actual: number, expected: number, label: string): void {
  if (Math.abs(actual - expected) > 0.0005) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function assertMetrics(expected: ExpectedMetric): void {
  const rows = loadRows(expected.runId, expected.system, expected);
  const label =
    `${expected.runId}/${expected.system}` +
    (expected.corpusSize === undefined ? "" : `/${expected.corpusSize}`) +
    (expected.modelContext === undefined ? "" : `/${expected.modelContext}`);
  assertEqual(rows.length, expected.n, `${label} row count`);
  assertEqual(
    rows.filter((r) => r.correct).length,
    expected.correct,
    `${label} correct count`,
  );
  assertNear(
    Number(mean(rows.map((r) => r.citationF1)).toFixed(3)),
    expected.f1,
    `${label} citation F1`,
  );
  console.log(
    `PASS metric ${label}: ` +
      `${expected.correct}/${expected.n}, citation F1 ${expected.f1.toFixed(3)}`,
  );
}

function assertMcNemar(
  label: string,
  aRun: string,
  aSystem: string,
  bRun: string,
  bSystem: string,
  expectedAOnly: number,
  expectedBOnly: number,
  expectedP: number,
): void {
  const a = new Map(loadRows(aRun, aSystem).map((row) => [row.queryId, row]));
  const b = new Map(loadRows(bRun, bSystem).map((row) => [row.queryId, row]));
  const queryIds = [...a.keys()].filter((q) => b.has(q)).sort();
  const result = mcNemar(
    queryIds.map((q) => score(a.get(q)!)),
    queryIds.map((q) => score(b.get(q)!)),
  );
  assertEqual(result.aOnly, expectedAOnly, `${label} A-only wins`);
  assertEqual(result.bOnly, expectedBOnly, `${label} B-only wins`);
  assertNear(Number(result.pValue.toFixed(4)), expectedP, `${label} p-value`);
  console.log(
    `PASS McNemar ${label}: ${result.aOnly}/${result.bOnly}, p=${result.pValue.toFixed(4)}`,
  );
}

function main(): void {
  for (const [path, expected] of Object.entries(HASHES)) {
    assertEqual(sha256(path), expected, `${path} sha256`);
    console.log(`PASS hash ${path}`);
  }

  for (const expected of EXPECTED) {
    assertMetrics(expected);
  }

  assertMcNemar(
    "CSM vs LightRAG @100K",
    "v020-30q-embedfloor",
    "csm",
    "lightrag-30q",
    "lightrag",
    6,
    0,
    0.0313,
  );
  assertMcNemar(
    "CSM vs long-context @1M",
    "scaling-1m",
    "csm",
    "scaling-1m",
    "longctx",
    19,
    0,
    0.0,
  );
}

main();
