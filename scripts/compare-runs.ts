#!/usr/bin/env tsx
/**
 * Compare two bench runs side-by-side.
 *
 * Usage:
 *   npx tsx scripts/compare-runs.ts <baseline-runId> <new-runId>
 *
 * Reads `summary.json` from each run dir. The actual `summary.json` shape is:
 *   { cells: [{ system, corpusSize, modelContext, accuracy, meanInputTokens,
 *               meanLatencyMs, meanCitationF1, ... }], ... }
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface SummaryCell {
  system: string;
  corpusSize: number;
  modelContext: number;
  accuracy: number;
  accuracyCi95?: [number, number];
  meanLatencyMs: number;
  meanInputTokens: number;
  meanCitationF1: number;
  meanCitationPrecision: number;
  meanCitationRecall: number;
  n: number;
  earlyStopped: boolean;
}

interface RunSummary {
  runId: string;
  cells: SummaryCell[];
  systemNames: string[];
}

function loadSummary(runId: string): RunSummary {
  const path = join("data", "eval", "runs", runId, "summary.json");
  if (!existsSync(path)) {
    throw new Error(`summary.json not found for run "${runId}" at ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as RunSummary;
}

function bySystem(s: RunSummary): Map<string, SummaryCell> {
  // For multi-cell summaries (multiple corpus sizes / contexts), key by system
  // when all cells share one corpus size + context. With our 100K/8K bench
  // that's always one row per system.
  const m = new Map<string, SummaryCell>();
  for (const c of s.cells) m.set(c.system, c);
  return m;
}

function fmt(n: number | undefined, decimals = 2): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  return n.toFixed(decimals);
}

function delta(neu: number | undefined, old: number | undefined, decimals = 2): string {
  if (neu === undefined || old === undefined) return "—";
  const diff = neu - old;
  const sign = diff > 0 ? "+" : "";
  return `${sign}${diff.toFixed(decimals)}`;
}

function pctDelta(neu: number | undefined, old: number | undefined): string {
  if (neu === undefined || old === undefined || old === 0) return "—";
  const pct = ((neu - old) / old) * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

const [baselineId, newId] = process.argv.slice(2);
if (!baselineId || !newId) {
  console.error("Usage: tsx scripts/compare-runs.ts <baseline-runId> <new-runId>");
  process.exit(2);
}

const baseline = loadSummary(baselineId);
const next = loadSummary(newId);
const b = bySystem(baseline);
const n = bySystem(next);

console.log(`\n# Bench comparison\n`);
console.log(`baseline : ${baselineId}`);
console.log(`new      : ${newId}\n`);

const systems = Array.from(new Set([...b.keys(), ...n.keys()])).sort();

console.log("| system    | accuracy (old → new)          | latency s (old → new)        | input tokens (old → new)     | citF1 (old → new)             |");
console.log("|-----------|-------------------------------|------------------------------|------------------------------|--------------------------------|");

for (const system of systems) {
  const bc = b.get(system);
  const nc = n.get(system);

  const accOld = bc?.accuracy;
  const accNew = nc?.accuracy;
  const latOld = bc ? bc.meanLatencyMs / 1000 : undefined;
  const latNew = nc ? nc.meanLatencyMs / 1000 : undefined;
  const inOld = bc?.meanInputTokens;
  const inNew = nc?.meanInputTokens;
  const f1Old = bc?.meanCitationF1;
  const f1New = nc?.meanCitationF1;

  console.log(
    `| ${system.padEnd(9)} ` +
      `| ${fmt(accOld)} → ${fmt(accNew)} (${delta(accNew, accOld)}) ` +
      `| ${fmt(latOld, 1)} → ${fmt(latNew, 1)} (${pctDelta(latNew, latOld)}) ` +
      `| ${fmt(inOld, 0)} → ${fmt(inNew, 0)} (${pctDelta(inNew, inOld)}) ` +
      `| ${fmt(f1Old)} → ${fmt(f1New)} (${delta(f1New, f1Old)}) |`,
  );
}

console.log(
  `\nDelta sign convention: positive = better for accuracy/F1, more cost for latency/tokens.\n` +
    `Percent delta on latency/tokens means "${newId} is X% bigger than ${baselineId}".\n`,
);
