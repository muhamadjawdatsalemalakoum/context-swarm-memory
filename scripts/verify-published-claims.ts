/**
 * Verify the published benchmark evidence bundle.
 *
 * This is intentionally narrow: it checks the canonical v0.2 result rows that
 * back the README/SOTA claims and recomputes the headline metrics directly from
 * results.jsonl. It does not call an LLM and does not need a GPU.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { mcNemar, type McqScore } from "../src/eval/scorer.js";

interface ResultRow {
  corpusSize?: number;
  citationF1: number;
  citationPrecision: number;
  citationRecall: number;
  correct: boolean;
  length?: string;
  modelContext?: number;
  queryId: string;
  system: string;
  task?: number;
}

interface ExpectedMetric {
  corpusSize?: number;
  correct: number;
  f1: number;
  length?: string;
  modelContext?: number;
  n: number;
  runId: string;
  system: string;
  task?: number;
}

interface BeamComparisonSummary {
  systems: {
    csm: {
      correct: number;
      score: number;
      total_queries: number;
    };
    hindsight: {
      correct: number;
      score: number;
      total_queries: number;
    };
  };
  csm_token_telemetry: {
    final_rows_accounted: number;
    unique_query_hashes: number;
    summary: {
      csm_internal_total_tokens: {
        avg: number;
        sum: number;
      };
    };
  };
  deltas: {
    correct: number;
    score: number;
  };
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
    "b90603ab20782d8530bbcab0fff24ed3a80cccf004152cfa82b50640a11da841",
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
  "data/eval/runs/gemma-scaling-csm-v2-wave1/config.json":
    "a6f58aa4af86422836007476497248c505553602e4f17a11fd559dadced675f9",
  "data/eval/runs/gemma-scaling-csm-v2-wave1/results.jsonl":
    "0121deb0182c78d7abd8beef1b1e54db5f9b57d4c0248e2fd8c3acc3f21f0ce5",
  "data/eval/runs/gemma-scaling-csm-v2-wave1/summary.json":
    "2693f76a07aab49f5d78121179b9092c72a1e80018a2f5a6f7cd9eb937ad3f2e",
  "data/eval/runs/gemini35-160k-30q-v2-wave1/config.json":
    "3e7b3a2037d10f70bea1f72a275820a131ded1901ff6c0daf9469ff2b09700be",
  "data/eval/runs/gemini35-160k-30q-v2-wave1/results.jsonl":
    "bac622132c740644fd994b55ecc5d86d7ac297a171e05d98411ab2652b2873a8",
  "data/eval/runs/gemini35-160k-30q-v2-wave1/summary.json":
    "e95e614aaa14783cc72f1dda9dc153a8f83dbe3b8fbbee7e2c193ed19f878e01",
  "data/eval/runs/babilong-csm-gemini35-4k8k-t1t2-30q-v1/config.json":
    "a9270620fa34e90370f51526c8732140d99d69d7335bebb4d8a296f39ec657b9",
  "data/eval/runs/babilong-csm-gemini35-4k8k-t1t2-30q-v1/results.jsonl":
    "e83d52eec2341e63dcfc7d2bfb73abc8095bdc6a81ced9091a00b4155888d725",
  "data/eval/runs/babilong-csm-gemini35-4k8k-t1t2-30q-v1/summary.json":
    "ded09ef523091f4cdcb86ce5dede9d1cb6397e70273119161a82b9521cdb5517",
  "data/eval/runs/babilong-csm-gemini35-4k8k-t1t2-30q-v1/report.md":
    "4888eb8b98b7aaebe63aac2d4a6701059434045d627c9006c951d28ecb66cc61",
  "data/eval/runs/babilong-csm-gemini35-4k8k-t1t2-30q-v2-entitybridge/config.json":
    "3855fde8617dc4d09001cf48bce0639ab8342ff7fcfcf97f0e47bbf82453e22d",
  "data/eval/runs/babilong-csm-gemini35-4k8k-t1t2-30q-v2-entitybridge/results.jsonl":
    "dd82b1edee5176ef70ea0af1f2b1445af91d53bd18222ae3d4ae9f474be8a89d",
  "data/eval/runs/babilong-csm-gemini35-4k8k-t1t2-30q-v2-entitybridge/summary.json":
    "635d43d08eb6409295462a2d10c51f1240e32497ccdf0b2e2e4a7b459de3d89e",
  "data/eval/runs/babilong-csm-gemini35-4k8k-t1t2-30q-v2-entitybridge/report.md":
    "42ea7ef23e87643c9b76167fc83887116b9582b23b9ae00ff8cbc830f8efa55a",
  "data/eval/runs/babilong-csm-gemini35-4k8k-t1t2-30q-v3-wave1/config.json":
    "076513df4ec8384e2e0205fb197189e2f54cb47d59919d915323417ce85a603a",
  "data/eval/runs/babilong-csm-gemini35-4k8k-t1t2-30q-v3-wave1/results.jsonl":
    "89781ba7e8d64492f655f3bdb871a97bc04a5212ceb5fc5aa6e89e52b49a0fcf",
  "data/eval/runs/babilong-csm-gemini35-4k8k-t1t2-30q-v3-wave1/summary.json":
    "0c63d204440759c267f0e7d9fb3f6a8f91e671b35ca7845867b4e16300e8b749",
  // Official AMB-runner BEAM 100K rerun (2026-06-10) — committed evidence.
  "data/eval/runs/amb-beam-100k-official-v1/RUN_MANIFEST.md":
    "2df6713d86922aedc928efd94c406864f26bba2bc595ef81a94448ea400dd063",
  "data/eval/runs/amb-beam-100k-official-v1/csm-token-telemetry.jsonl":
    "c60d1c5b92a28b8b095a9dbab2ccbc5a3c966f1907c4eca28f8181f115aec013",
  "data/eval/runs/sota-combined/amb-beam-100k-csm-vs-hindsight.json":
    "45d2f8a36b624c2f4a54a1026181d37a8072d7fe5341b2b7947fba54262db645",
  // Repinned 2026-06-10 when hashing moved to LF-normalized bytes (this CSV
  // was originally hashed with CRLF rows; git content unchanged since 9ed3ba0).
  "data/eval/runs/sota-combined/amb-beam-100k-csm-vs-hindsight-category-deltas.csv":
    "f3fd2fed94720a1c2d3d2b4d1a69cdc94342dc5aeb13f7a322e37119d45faa03",
  "data/eval/external/babilong-leaderboard-v0_results.csv":
    "584b7daf5f8cfcab96a005dabe6e6df189acd545a093dfc48f223af15ca6e196",
  "data/eval/external/babilong-leaderboard-v0_SOURCE.md":
    "87418e7d69d57c7beb3c94cfa14630b0a2f97b01348d3dca384180d8fe69a658",
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
  // 2026-06-10 Gemma re-measurement on the post-wave defaults (README
  // headline CSM rows; baselines remain from scaling-rq1/scaling-1m/v020).
  {
    runId: "gemma-scaling-csm-v2-wave1",
    system: "csm",
    corpusSize: 100_000,
    modelContext: 8_000,
    n: 30,
    correct: 28,
    f1: 0.47,
  },
  {
    runId: "gemma-scaling-csm-v2-wave1",
    system: "csm",
    corpusSize: 1_000_000,
    modelContext: 8_000,
    n: 30,
    correct: 27,
    f1: 0.465,
  },
  // 2026-06-10 re-measurement of the CSM rows on the post-wave defaults
  // (coverage mode on, parallel pipeline). README showcases these; the v1
  // CSM rows above remain pinned as the superseded artifact of record.
  {
    runId: "gemini35-160k-30q-v2-wave1",
    system: "csm",
    corpusSize: 100_000,
    modelContext: 160_000,
    n: 30,
    correct: 30,
    f1: 0.488,
  },
  {
    runId: "gemini35-160k-30q-v2-wave1",
    system: "csm",
    corpusSize: 1_000_000,
    modelContext: 160_000,
    n: 30,
    correct: 28,
    f1: 0.505,
  },
  {
    runId: "gemini35-160k-30q-v2-wave1",
    system: "csm",
    corpusSize: 2_000_000,
    modelContext: 160_000,
    n: 30,
    correct: 30,
    f1: 0.479,
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
  {
    runId: "babilong-csm-gemini35-4k8k-t1t2-30q-v1",
    system: "csm",
    task: 1,
    length: "4K",
    n: 30,
    correct: 30,
    f1: 0.293,
  },
  {
    runId: "babilong-csm-gemini35-4k8k-t1t2-30q-v1",
    system: "csm",
    task: 1,
    length: "8K",
    n: 30,
    correct: 30,
    f1: 0.237,
  },
  {
    runId: "babilong-csm-gemini35-4k8k-t1t2-30q-v1",
    system: "csm",
    task: 2,
    length: "4K",
    n: 30,
    correct: 3,
    f1: 0.025,
  },
  {
    runId: "babilong-csm-gemini35-4k8k-t1t2-30q-v1",
    system: "csm",
    task: 2,
    length: "8K",
    n: 30,
    correct: 0,
    f1: 0.01,
  },
  {
    runId: "babilong-csm-gemini35-4k8k-t1t2-30q-v2-entitybridge",
    system: "csm",
    task: 1,
    length: "4K",
    n: 30,
    correct: 30,
    f1: 0.276,
  },
  {
    runId: "babilong-csm-gemini35-4k8k-t1t2-30q-v2-entitybridge",
    system: "csm",
    task: 1,
    length: "8K",
    n: 30,
    correct: 30,
    f1: 0.22,
  },
  {
    runId: "babilong-csm-gemini35-4k8k-t1t2-30q-v2-entitybridge",
    system: "csm",
    task: 2,
    length: "4K",
    n: 30,
    correct: 18,
    f1: 0.026,
  },
  {
    runId: "babilong-csm-gemini35-4k8k-t1t2-30q-v2-entitybridge",
    system: "csm",
    task: 2,
    length: "8K",
    n: 30,
    correct: 16,
    f1: 0.005,
  },
  // 2026-06-10 post-wave pipeline (coverage chronicle + date-stamped digests).
  {
    runId: "babilong-csm-gemini35-4k8k-t1t2-30q-v3-wave1",
    system: "csm",
    task: 1,
    length: "4K",
    n: 30,
    correct: 30,
    f1: 0.265,
  },
  {
    runId: "babilong-csm-gemini35-4k8k-t1t2-30q-v3-wave1",
    system: "csm",
    task: 1,
    length: "8K",
    n: 30,
    correct: 29,
    f1: 0.225,
  },
  {
    runId: "babilong-csm-gemini35-4k8k-t1t2-30q-v3-wave1",
    system: "csm",
    task: 2,
    length: "4K",
    n: 30,
    correct: 22,
    f1: 0.013,
  },
  {
    runId: "babilong-csm-gemini35-4k8k-t1t2-30q-v3-wave1",
    system: "csm",
    task: 2,
    length: "8K",
    n: 30,
    correct: 25,
    f1: 0.004,
  },
];

function sha256(path: string): string {
  // Normalize CRLF -> LF before hashing: with core.autocrlf=true a Windows
  // checkout materializes these text artifacts with CRLF while macOS/Linux
  // (and CI) see LF, so raw-byte hashes are OS-dependent. All pinned hashes
  // were computed over LF bytes; normalization keeps them valid everywhere
  // while still catching real content changes.
  const raw = readFileSync(join(process.cwd(), path));
  const normalized = raw.toString("utf8").replaceAll("\r\n", "\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function loadRows(
  runId: string,
  system: string,
  filters: { corpusSize?: number; length?: string; modelContext?: number; task?: number } = {},
): ResultRow[] {
  const path = join(process.cwd(), "data", "eval", "runs", runId, "results.jsonl");
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ResultRow)
    .filter((row) => row.system === system)
    .filter((row) => filters.corpusSize === undefined || row.corpusSize === filters.corpusSize)
    .filter((row) => filters.task === undefined || row.task === filters.task)
    .filter((row) => filters.length === undefined || row.length === filters.length)
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
    (expected.task === undefined ? "" : `/task${expected.task}`) +
    (expected.length === undefined ? "" : `/${expected.length}`) +
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
  aFilters: Parameters<typeof loadRows>[2] = {},
  bFilters: Parameters<typeof loadRows>[2] = {},
): void {
  const a = new Map(loadRows(aRun, aSystem, aFilters).map((row) => [row.queryId, row]));
  const b = new Map(loadRows(bRun, bSystem, bFilters).map((row) => [row.queryId, row]));
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

function assertBeamComparison(): void {
  const summary = JSON.parse(
    readFileSync(
      join(
        process.cwd(),
        "data",
        "eval",
        "runs",
        "sota-combined",
        "amb-beam-100k-csm-vs-hindsight.json",
      ),
      "utf8",
    ),
  ) as BeamComparisonSummary;
  assertEqual(summary.systems.csm.total_queries, 400, "BEAM CSM row count");
  assertEqual(summary.systems.hindsight.total_queries, 400, "BEAM Hindsight row count");
  assertEqual(summary.systems.csm.correct, 342, "BEAM CSM correct count");
  assertEqual(summary.systems.hindsight.correct, 326, "BEAM Hindsight correct count");
  assertNear(summary.systems.csm.score, 0.7575731005977905, "BEAM CSM score");
  assertNear(summary.systems.hindsight.score, 0.7336577408538804, "BEAM Hindsight score");
  assertEqual(summary.deltas.correct, 16, "BEAM correct delta");
  assertNear(summary.deltas.score, 0.023915359743910125, "BEAM score delta");
  assertEqual(
    summary.csm_token_telemetry.final_rows_accounted,
    400,
    "BEAM CSM telemetry rows",
  );
  assertEqual(
    summary.csm_token_telemetry.unique_query_hashes,
    400,
    "BEAM CSM telemetry unique query hashes",
  );
  assertEqual(
    summary.csm_token_telemetry.summary.csm_internal_total_tokens.sum,
    9_420_450,
    "BEAM CSM internal total token sum",
  );
  assertNear(
    summary.csm_token_telemetry.summary.csm_internal_total_tokens.avg,
    23_551.125,
    "BEAM CSM internal total token average",
  );
  console.log(
    "PASS BEAM May local comparison artifact (superseded by the official rerun): 342/400 vs 326/400",
  );
}

interface OfficialTelemetryRow {
  bridge_mode: string;
  csm_internal_input_tokens: number;
  csm_internal_output_tokens: number;
  query_sha256: string;
}

interface OfficialBeamRow {
  context_tokens: number;
  correct: boolean;
  retrieve_time_ms: number;
  score: number;
}

interface OfficialBeamOutput {
  answer_llm: string;
  correct: number;
  judge_llm: string;
  memory_provider: string;
  oracle: boolean;
  results: OfficialBeamRow[];
  total_queries: number;
}

const OFFICIAL_BEAM_OUTPUT_PATH =
  "data/eval/runs/amb-beam-100k-official-v1/amb-outputs/beam/csm-official-rerun-100k/rag/100k.json";
const OFFICIAL_BEAM_OUTPUT_SHA256 =
  "ba3882587b8e23be1c7e49d7f70cc664d0d7ba7bc9ce42640bfd06667e4a78be";

/**
 * Verify the 2026-06-10 official-runner BEAM 100K rerun — the run behind the
 * published 0.743110 / 337-400 / 3.47s / 27.0K headline.
 *
 * The telemetry sidecar is committed and always checked. The raw AMB-runner
 * output (51 MB) is gitignored — its gz copy ships with upstream PR #19 — so
 * it is verified end-to-end whenever it exists in the working tree and
 * reported as an explicit SKIP otherwise.
 */
function assertOfficialBeamRerun(): void {
  const telemetry = readFileSync(
    join(
      process.cwd(),
      "data/eval/runs/amb-beam-100k-official-v1/csm-token-telemetry.jsonl",
    ),
    "utf8",
  )
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as OfficialTelemetryRow);
  assertEqual(telemetry.length, 400, "official rerun telemetry row count");
  assertEqual(
    new Set(telemetry.map((row) => row.query_sha256)).size,
    400,
    "official rerun telemetry unique query hashes",
  );
  assertEqual(
    telemetry.every((row) => row.bridge_mode === "retrieve-only"),
    true,
    "official rerun bridge mode",
  );
  assertEqual(
    Number(mean(telemetry.map((row) => row.csm_internal_input_tokens)).toFixed(1)),
    8804.9,
    "official rerun mean CSM-internal input tokens",
  );
  assertEqual(
    Number(mean(telemetry.map((row) => row.csm_internal_output_tokens)).toFixed(1)),
    624.7,
    "official rerun mean CSM-internal output tokens",
  );
  console.log(
    "PASS BEAM official rerun telemetry: 400 queries, avg CSM-internal 8,805 in / 625 out tokens (reported separately)",
  );

  const outputPath = join(process.cwd(), OFFICIAL_BEAM_OUTPUT_PATH);
  if (!existsSync(outputPath)) {
    console.log(
      "SKIP BEAM official rerun raw output (not in working tree; LF-sha256 " +
        `${OFFICIAL_BEAM_OUTPUT_SHA256.slice(0, 12)}…, ` +
        "see docs/AMB_BEAM_100K_OFFICIAL_RERUN.md)",
    );
    return;
  }
  assertEqual(
    sha256(OFFICIAL_BEAM_OUTPUT_PATH),
    OFFICIAL_BEAM_OUTPUT_SHA256,
    `${OFFICIAL_BEAM_OUTPUT_PATH} sha256`,
  );
  const output = JSON.parse(readFileSync(outputPath, "utf8")) as OfficialBeamOutput;
  assertEqual(output.memory_provider, "csm", "official rerun provider");
  assertEqual(output.oracle, false, "official rerun oracle flag");
  assertEqual(
    output.answer_llm,
    "gemini:gemini-3.1-pro-preview",
    "official rerun answer model",
  );
  assertEqual(
    output.judge_llm,
    "gemini:gemini-2.5-flash-lite",
    "official rerun judge model",
  );
  assertEqual(output.total_queries, 400, "official rerun total_queries");
  assertEqual(output.results.length, 400, "official rerun row count");
  assertEqual(
    output.results.filter((row) => row.correct).length,
    337,
    "official rerun recomputed correct count",
  );
  assertEqual(output.correct, 337, "official rerun correct field");
  assertNear(
    mean(output.results.map((row) => row.score)),
    0.743110,
    "official rerun recomputed mean score",
  );
  assertEqual(
    Number(mean(output.results.map((row) => row.retrieve_time_ms)).toFixed(1)),
    3467.3,
    "official rerun recomputed mean retrieve ms",
  );
  assertEqual(
    Number(mean(output.results.map((row) => row.context_tokens)).toFixed(1)),
    27026.2,
    "official rerun recomputed mean answer-context tokens",
  );
  console.log(
    "PASS BEAM official rerun (unmodified AMB runner): CSM 337/400, score 0.743110, avg retrieve 3.47s, avg answer context 27.0K",
  );
}

interface LadderTier {
  contextTokens: number;
  correct: number;
  meanScore: number;
  name: string;
  retrieveMs: number;
  sha256: string;
  split: string;
  total: number;
}

/**
 * Verify the 2026-06-18 full BEAM ladder (100K -> 500K -> 1M -> 10M), all
 * produced by the unmodified AMB runner on the frozen CSM pipeline (src/
 * identical to 599dfc0). Each tier's raw output is large and gitignored, so
 * — exactly like assertOfficialBeamRerun — it is LF-sha256-pinned and its
 * headline numbers are recomputed from the rows whenever the file exists in
 * the working tree, and reported as an explicit SKIP otherwise. Numbers back
 * docs/AMB_BEAM_LADDER_2026_06_18.md.
 */
const BEAM_LADDER: LadderTier[] = [
  { split: "100k", name: "amb-beam-100k-official-v2", total: 400, correct: 335, meanScore: 0.736688, retrieveMs: 4466.1, contextTokens: 27026.2, sha256: "7831c20d7074ed5ee65d6754a20e5af79400a830b3618dfe7b247cc0ca068e98" },
  { split: "500k", name: "amb-beam-500k-official-v1", total: 700, correct: 497, meanScore: 0.658934, retrieveMs: 7510.5, contextTokens: 26617.8, sha256: "5a033dc623fdb776ff491e638690e1190471d3dc5fe949b7764204f18e8f1a6d" },
  { split: "1m", name: "amb-beam-1m-official-v1", total: 700, correct: 445, meanScore: 0.569334, retrieveMs: 5596.2, contextTokens: 28192.3, sha256: "07f0b87eb3349e8f75ac8452a2f41399c58792d29a65f616a22f67cce28697ac" },
  { split: "10m", name: "amb-beam-10m-official-v1", total: 200, correct: 122, meanScore: 0.561572, retrieveMs: 11915.1, contextTokens: 32512.1, sha256: "5a6ba9d83233ee7da908c4f86a2f4044888c1ae4d427f61bd56fce49d85f8b90" },
];

function assertBeamLadder(): void {
  for (const tier of BEAM_LADDER) {
    const rel = `data/eval/runs/${tier.name}/amb-outputs/beam/${tier.name}/rag/${tier.split}.json`;
    const abs = join(process.cwd(), rel);
    if (!existsSync(abs)) {
      console.log(
        `SKIP BEAM ladder ${tier.split} (raw output not in working tree; LF-sha256 ${tier.sha256.slice(0, 12)}…, see docs/AMB_BEAM_LADDER_2026_06_18.md)`,
      );
      continue;
    }
    assertEqual(sha256(rel), tier.sha256, `${rel} sha256`);
    const output = JSON.parse(readFileSync(abs, "utf8")) as OfficialBeamOutput;
    assertEqual(output.memory_provider, "csm", `ladder ${tier.split} provider`);
    assertEqual(output.oracle, false, `ladder ${tier.split} oracle flag`);
    assertEqual(output.answer_llm, "gemini:gemini-3.1-pro-preview", `ladder ${tier.split} answer model`);
    assertEqual(output.judge_llm, "gemini:gemini-2.5-flash-lite", `ladder ${tier.split} judge model`);
    assertEqual(output.results.length, tier.total, `ladder ${tier.split} row count`);
    assertEqual(
      output.results.filter((row) => row.correct).length,
      tier.correct,
      `ladder ${tier.split} recomputed correct count`,
    );
    assertNear(
      mean(output.results.map((row) => row.score)),
      tier.meanScore,
      `ladder ${tier.split} recomputed mean score`,
    );
    assertEqual(
      Number(mean(output.results.map((row) => row.retrieve_time_ms)).toFixed(1)),
      tier.retrieveMs,
      `ladder ${tier.split} recomputed mean retrieve ms`,
    );
    assertEqual(
      Number(mean(output.results.map((row) => row.context_tokens)).toFixed(1)),
      tier.contextTokens,
      `ladder ${tier.split} recomputed mean answer-context tokens`,
    );
    console.log(
      `PASS BEAM ladder ${tier.split}: CSM ${tier.correct}/${tier.total}, score ${tier.meanScore.toFixed(4)}, retrieve ${(tier.retrieveMs / 1000).toFixed(2)}s, answer ctx ${Math.round(tier.contextTokens / 100) / 10}K`,
    );
  }
}

function main(): void {
  for (const [path, expected] of Object.entries(HASHES)) {
    assertEqual(sha256(path), expected, `${path} sha256`);
    console.log(`PASS hash ${path}`);
  }

  for (const expected of EXPECTED) {
    assertMetrics(expected);
  }

  // Archival pairings from the May (v0.2) rows — kept as the earlier-run
  // record the README's calibration language refers to.
  assertMcNemar(
    "CSM (v0.2 archival) vs LightRAG @100K",
    "v020-30q-embedfloor",
    "csm",
    "lightrag-30q",
    "lightrag",
    6,
    0,
    0.0313,
  );
  assertMcNemar(
    "CSM (v0.2 archival) vs long-context @1M",
    "scaling-1m",
    "csm",
    "scaling-1m",
    "longctx",
    19,
    0,
    0.0,
  );

  // Current-pipeline pairings (2026-06-10 wave rerun) — these back the
  // README/site headline claims "27-9 (18-0 discordant, p<0.0001)" and
  // "vs LightRAG 6-2, p=0.289".
  assertMcNemar(
    "CSM (June wave) vs long-context @1M",
    "gemma-scaling-csm-v2-wave1",
    "csm",
    "scaling-1m",
    "longctx",
    18,
    0,
    0.0,
    { corpusSize: 1_000_000 },
  );
  assertMcNemar(
    "CSM (June wave) vs LightRAG @100K",
    "gemma-scaling-csm-v2-wave1",
    "csm",
    "lightrag-30q",
    "lightrag",
    6,
    2,
    0.2891,
    { corpusSize: 100_000 },
  );

  assertBeamComparison();
  assertOfficialBeamRerun();
  assertBeamLadder();
}

main();
