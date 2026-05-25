/**
 * Scaling-SOTA report.
 *
 * This answers a different question than `sota-headline.ts`:
 * does a system become better, stay stable, or degrade as corpus size grows?
 *
 * Usage:
 *   npx tsx scripts/sota-scaling.ts
 *   npx tsx scripts/sota-scaling.ts scaling-rq1 scaling-1m lightrag-30q
 *
 * The report is intentionally honest about missing evidence. A SOTA system with
 * only one corpus-size row is listed as "needs multi-size run" rather than
 * silently treated as proven or disproven.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getPaths } from "../src/storage/paths.js";

interface SummaryCell {
  accuracy: number;
  corpusSize: number;
  meanCitationF1: number;
  meanCitationPrecision: number;
  meanCitationRecall: number;
  meanInputTokens: number;
  meanLatencyMs: number;
  modelContext: number;
  n: number;
  system: string;
}

interface RunConfig {
  model?: string;
  runId?: string;
}

interface RunSummary {
  cells: SummaryCell[];
  runId: string;
}

interface LoadedCell extends SummaryCell {
  model: string;
  runId: string;
}

const DEFAULT_RUN_IDS = [
  "scaling-rq1",
  "scaling-1m",
  "lightrag-30q",
  "gemini35-160k-30q-v1",
];

const SYSTEM_LABELS: Record<string, string> = {
  csm: "CSM",
  rag: "vanilla RAG",
  hybrid: "hybrid RAG",
  longctx: "long-context",
  lightrag: "LightRAG",
  mem0: "Mem0",
  hipporag: "HippoRAG 2",
};

const SOTA_SYSTEMS = new Set([
  "lightrag",
  "mem0",
  "hipporag",
  "graphiti",
  "graphrag",
  "apexmem",
  "lightmem",
  "shardmemo",
]);

function loadRun(runId: string): LoadedCell[] {
  const runDir = join(getPaths().data, "eval", "runs", runId);
  const summaryPath = join(runDir, "summary.json");
  const configPath = join(runDir, "config.json");
  if (!existsSync(summaryPath)) {
    throw new Error(`Missing summary.json for run "${runId}" at ${summaryPath}`);
  }
  const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as RunSummary;
  const config = existsSync(configPath)
    ? (JSON.parse(readFileSync(configPath, "utf8")) as RunConfig)
    : {};
  const model = config.model ?? "unknown-model";
  return summary.cells.map((cell) => ({ ...cell, model, runId }));
}

function fmtSize(n: number): string {
  if (n >= 1_000_000_000) return `${n / 1_000_000_000}B`;
  if (n >= 1_000_000) return `${n / 1_000_000}M`;
  if (n >= 1_000) return `${n / 1_000}K`;
  return String(n);
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function num(n: number): string {
  return n.toFixed(3);
}

function pp(delta: number): string {
  const sign = delta > 0 ? "+" : "";
  return `${sign}${(delta * 100).toFixed(1)}pp`;
}

function deltaNum(delta: number): string {
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta.toFixed(3)}`;
}

function trend(delta: number): "up" | "flat" | "down" {
  if (delta > 0.005) return "up";
  if (delta < -0.005) return "down";
  return "flat";
}

function verdict(rows: LoadedCell[]): string {
  if (rows.length < 2) return "needs multi-size run";
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const acc = trend(last.accuracy - first.accuracy);
  const precision = trend(last.meanCitationPrecision - first.meanCitationPrecision);
  const f1 = trend(last.meanCitationF1 - first.meanCitationF1);
  if (acc === "up" && precision === "up" && f1 === "up") {
    return "better and more grounded";
  }
  if (acc === "up" && precision === "up") {
    return "accuracy+precision up; recall/F1 check";
  }
  if (acc === "down" || precision === "down" || f1 === "down") {
    return "degrades on at least one grounding metric";
  }
  return "roughly stable";
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const arr = out.get(key);
    if (arr) arr.push(item);
    else out.set(key, [item]);
  }
  return out;
}

function dedupeCells(cells: LoadedCell[]): LoadedCell[] {
  const byKey = new Map<string, LoadedCell>();
  for (const cell of cells) {
    byKey.set(`${cell.model}|${cell.modelContext}|${cell.system}|${cell.corpusSize}`, cell);
  }
  return [...byKey.values()];
}

function renderTrack(track: string, cells: LoadedCell[]): string[] {
  const lines: string[] = [];
  lines.push(`## ${track}`);
  lines.push("");
  lines.push(
    "| System | Type | Corpus sizes | Accuracy first -> last | dAcc | Citation P first -> last | dP | Citation R first -> last | dR | Citation F1 first -> last | dF1 | Verdict |",
  );
  lines.push("|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|");

  const bySystem = groupBy(cells, (cell) => cell.system);
  const systems = [...bySystem.keys()].sort((a, b) => {
    if (a === "csm") return -1;
    if (b === "csm") return 1;
    return a.localeCompare(b);
  });

  for (const system of systems) {
    const rows = bySystem.get(system)!.sort((a, b) => a.corpusSize - b.corpusSize);
    const first = rows[0]!;
    const last = rows[rows.length - 1]!;
    const sizes = rows.map((row) => fmtSize(row.corpusSize)).join(" -> ");
    const type =
      system === "csm" ? "CSM" : SOTA_SYSTEMS.has(system) ? "SOTA" : "control";
    lines.push(
      `| ${SYSTEM_LABELS[system] ?? system} | ${type} | ${sizes} | ` +
        `${pct(first.accuracy)} -> ${pct(last.accuracy)} | ${pp(last.accuracy - first.accuracy)} | ` +
        `${pct(first.meanCitationPrecision)} -> ${pct(last.meanCitationPrecision)} | ${pp(last.meanCitationPrecision - first.meanCitationPrecision)} | ` +
        `${pct(first.meanCitationRecall)} -> ${pct(last.meanCitationRecall)} | ${pp(last.meanCitationRecall - first.meanCitationRecall)} | ` +
        `${num(first.meanCitationF1)} -> ${num(last.meanCitationF1)} | ${deltaNum(last.meanCitationF1 - first.meanCitationF1)} | ` +
        `${verdict(rows)} |`,
    );
  }
  lines.push("");
  const missingSota = systems
    .filter((system) => SOTA_SYSTEMS.has(system))
    .filter((system) => bySystem.get(system)!.length < 2);
  if (missingSota.length > 0) {
    lines.push(
      `SOTA gap: ${missingSota.map((s) => SYSTEM_LABELS[s] ?? s).join(", ")} needs at least two corpus sizes in this track before we can compare scaling slope.`,
    );
    lines.push("");
  }
  return lines;
}

function main(): void {
  const runIds = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_RUN_IDS;
  const cells = dedupeCells(runIds.flatMap(loadRun));
  const tracks = groupBy(
    cells,
    (cell) => `${cell.model} / ctx=${fmtSize(cell.modelContext)}`,
  );

  const lines: string[] = [];
  lines.push("# SOTA Scaling Report");
  lines.push("");
  lines.push(
    "Question: does CSM get better and more precise as corpus size grows, and do SOTA memory systems show the same behavior?",
  );
  lines.push("");
  lines.push(`Runs loaded: ${runIds.map((id) => `\`${id}\``).join(", ")}`);
  lines.push("");
  lines.push(
    "Interpretation: accuracy and citation precision can improve while citation recall/F1 falls. Treat that as a mixed result, not a clean win.",
  );
  lines.push("");

  for (const [track, trackCells] of [...tracks.entries()].sort()) {
    lines.push(...renderTrack(track, trackCells));
  }

  lines.push("## Required Next Evidence");
  lines.push("");
  lines.push(
    "- Run each SOTA comparator at the same corpus sizes as CSM, starting with 100K and 1M.",
  );
  lines.push(
    "- Report slopes for accuracy, citation precision, citation recall, and citation F1 separately.",
  );
  lines.push(
    "- Include indexing wall time, index tokens, and disk size so graph/agentic systems cannot hide setup cost.",
  );
  lines.push(
    "- Do not claim CSM gets better than SOTA with scale until at least one runnable SOTA comparator has multi-size rows.",
  );
  lines.push("");

  while (lines[lines.length - 1] === "") lines.pop();
  const outDir = join(getPaths().data, "eval", "runs", "sota-combined");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "scaling.md");
  writeFileSync(outPath, `${lines.join("\n")}\n`, "utf8");
  console.log(lines.join("\n"));
  console.log(`\n[sota-scaling] wrote ${outPath}`);
}

main();
