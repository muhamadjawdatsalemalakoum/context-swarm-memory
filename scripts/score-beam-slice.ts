#!/usr/bin/env tsx
/**
 * BEAM-slice retrieval scorer + REPLAY entry point — EVAL SIDE.
 *
 * Reads a run's `payloads.jsonl` (written by `scripts/run-beam-slice.ts`)
 * plus the raw BEAM gold (via `src/eval/retrievalScore.ts`, the one
 * gold-touching module) and writes `retrieval-scores.json` + a Markdown
 * table. Because every metric is recomputed from the saved payloads, this
 * IS the replay mode: changing `--ks`, facet thresholds, or category
 * filters never costs another LLM call.
 *
 * FIREWALL: this process imports ONLY `src/eval/retrievalScore.ts` and
 * node builtins — no CSM core, no providers, no bridge. Its outputs are
 * never read by retrieval logic (`tests/beamLeakageFirewall.test.ts`).
 *
 * Usage:
 *   npx tsx scripts/score-beam-slice.ts --run-id <id> --split 100k
 *     [--ks 10,24,32] [--include-abstention] [--slice-dir d] [--runs-dir d]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_KS,
  aggregateByCategory,
  buildBeamEventIndex,
  loadBeamGold,
  readPayloadRows,
  scorePayloadRow,
  type CategoryAggregate,
  type RowScore,
} from "../src/eval/retrievalScore.js";

interface CliArgs {
  runId: string;
  split: string;
  ks: number[];
  includeAbstention: boolean;
  sliceDir?: string;
  runsDir: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    runId: "",
    split: "100k",
    ks: [...DEFAULT_KS],
    includeAbstention: false,
    runsDir: resolve(process.cwd(), "data", "eval", "runs"),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = argv[i + 1];
    const take = (): string => {
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`Missing value for ${a}`);
      }
      i++;
      return next;
    };
    if (a === "--run-id") args.runId = take();
    else if (a === "--split") args.split = take().toLowerCase();
    else if (a === "--ks")
      args.ks = take()
        .split(",")
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
    else if (a === "--include-abstention") args.includeAbstention = true;
    else if (a === "--slice-dir") args.sliceDir = resolve(take());
    else if (a === "--runs-dir") args.runsDir = resolve(take());
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: npx tsx scripts/score-beam-slice.ts --run-id <id> --split 100k " +
          "[--ks 10,24,32] [--include-abstention] [--slice-dir d] [--runs-dir d]\n",
      );
      process.exit(0);
    } else throw new Error(`Unknown arg: ${a}. Use --help.`);
  }
  if (!args.runId) throw new Error("--run-id is required");
  return args;
}

function fmt(x: number): string {
  return x.toFixed(3);
}

function ci(agg: { ci95: [number, number] }): string {
  return `[${fmt(agg.ci95[0])}, ${fmt(agg.ci95[1])}]`;
}

function buildMarkdown(
  runId: string,
  split: string,
  ks: number[],
  aggregates: CategoryAggregate[],
  skipped: Array<{ queryId: string; reason: string }>,
  mockRun: boolean,
): string {
  const lines: string[] = [];
  lines.push(`# BEAM-slice retrieval scores — ${runId} (${split})`);
  lines.push("");
  if (mockRun) {
    lines.push(
      "> **MOCK-PROVIDER RUN.** Plumbing validation only — these numbers say " +
        "nothing about real CSM retrieval quality.",
    );
    lines.push("");
  }
  lines.push(
    "Metric: gold-facet retrieval coverage (documented lexical proxy — BEAM " +
      "carries no sub-conversation evidence refs; see " +
      "docs/experiments/EXP-T3-beam-slice.md). `oracle` = coverage over the " +
      "full unit (lexical ceiling). Bootstrap 95% CIs, seed 42.",
  );
  lines.push("");
  const kCols = ks.map((k) => `cov@${k}`).join(" | ");
  lines.push(
    `| category | n | ${kCols} | packed | retrieved | oracle | ret.n | packed.n | retr.n | in.tok | lat.ms |`,
  );
  lines.push(
    `|---|---:|${ks.map(() => "---:").join("|")}|---:|---:|---:|---:|---:|---:|---:|---:|`,
  );
  for (const agg of aggregates) {
    const kCells = ks
      .map((k) => `${fmt(agg.coverageAtK[`@${k}`]!.mean)} ${ci(agg.coverageAtK[`@${k}`]!)}`)
      .join(" | ");
    lines.push(
      `| ${agg.category} | ${agg.n} | ${kCells} | ` +
        `${fmt(agg.packedCoverage.mean)} ${ci(agg.packedCoverage)} | ` +
        `${fmt(agg.retrievedCoverage.mean)} ${ci(agg.retrievedCoverage)} | ` +
        `${fmt(agg.oracleCoverage.mean)} ${ci(agg.oracleCoverage)} | ` +
        `${agg.meanReturnedCount.toFixed(1)} | ${agg.meanPackedCount.toFixed(1)} | ` +
        `${agg.meanRetrievedCount.toFixed(1)} | ` +
        `${Math.round(agg.meanInputTokens)} | ${Math.round(agg.meanLatencyMs)} |`,
    );
  }
  if (skipped.length > 0) {
    lines.push("");
    lines.push(`Skipped ${skipped.length} rows: ` +
      skipped.map((s) => `${s.queryId} (${s.reason})`).join(", "));
  }
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runDir = join(args.runsDir, args.runId);
  const payloadsPath = join(runDir, "payloads.jsonl");

  const rows = readPayloadRows(payloadsPath);
  const gold = loadBeamGold(args.split, { sliceDir: args.sliceDir });
  const index = buildBeamEventIndex(args.split, { sliceDir: args.sliceDir });

  // Detect mock runs from the run config so reports self-label.
  let mockRun = false;
  try {
    const config = JSON.parse(readFileSync(join(runDir, "config.json"), "utf8")) as {
      providerName?: string;
    };
    mockRun = config.providerName === "mock";
  } catch {
    // No config — leave unlabeled.
  }

  const scores: RowScore[] = [];
  const skipped: Array<{ queryId: string; reason: string }> = [];
  for (const row of rows) {
    const goldRecord = gold.get(row.queryId);
    if (!goldRecord) {
      skipped.push({ queryId: row.queryId, reason: "no gold record" });
      continue;
    }
    if (!args.includeAbstention && goldRecord.category === "abstention") {
      skipped.push({ queryId: row.queryId, reason: "abstention excluded" });
      continue;
    }
    const score = scorePayloadRow(row, goldRecord, index, args.ks);
    if (!score) {
      skipped.push({ queryId: row.queryId, reason: "no facets" });
      continue;
    }
    scores.push(score);
  }

  const aggregates = aggregateByCategory(scores, args.ks);
  const output = {
    runId: args.runId,
    split: args.split,
    ks: args.ks,
    scoredRows: scores.length,
    skipped,
    mockRun,
    aggregates,
    perQuery: scores,
    scoredAtIso: new Date().toISOString(),
    metric:
      "gold-facet retrieval coverage (lexical proxy; facets from rubric/ordering_tested/time_points/gold_answers)",
  };

  const jsonPath = join(runDir, "retrieval-scores.json");
  const mdPath = join(runDir, "retrieval-scores.md");
  writeFileSync(jsonPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  const md = buildMarkdown(args.runId, args.split, args.ks, aggregates, skipped, mockRun);
  writeFileSync(mdPath, md, "utf8");

  process.stdout.write(md);
  process.stdout.write(`\nWrote ${jsonPath}\nWrote ${mdPath}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(
      `score-beam-slice failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exitCode = 1;
  });
}
