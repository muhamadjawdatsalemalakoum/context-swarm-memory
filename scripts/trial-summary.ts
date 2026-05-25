import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Row {
  citationF1: number;
  correct: boolean;
  corpusSize: number;
  latencyMs: number;
  modelContext: number;
  outputTokens: number;
  inputTokens: number;
  queryId: string;
  system: string;
  trial: number;
}

interface TrialStats {
  accuracy: number;
  citationF1: number;
  inputTokens: number;
  latencyMs: number;
  n: number;
  outputTokens: number;
}

const runId = process.argv[2];
if (!runId) {
  console.error("usage: npx tsx scripts/trial-summary.ts <runId>");
  process.exit(2);
}

const runDir = join("data", "eval", "runs", runId);
const resultsPath = join(runDir, "results.jsonl");
if (!existsSync(resultsPath)) {
  console.error(`missing ${resultsPath}`);
  process.exit(1);
}

const rows = readFileSync(resultsPath, "utf8")
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line) as Row);

const groups = new Map<string, Row[]>();
for (const row of rows) {
  const key = [row.system, row.corpusSize, row.modelContext].join("|");
  const bucket = groups.get(key) ?? [];
  bucket.push(row);
  groups.set(key, bucket);
}

const lines: string[] = [];
lines.push(`# Trial summary: ${runId}\n`);
lines.push("| System | Corpus | Context | Trials | Accuracy mean +- sd | Citation F1 mean +- sd | Mean latency/query | Mean input tokens |");
lines.push("|---|---:|---:|---:|---:|---:|---:|---:|");

for (const [key, groupRows] of [...groups.entries()].sort()) {
  const [system, corpusSizeRaw, modelContextRaw] = key.split("|");
  const byTrial = new Map<number, Row[]>();
  for (const row of groupRows) {
    const bucket = byTrial.get(row.trial) ?? [];
    bucket.push(row);
    byTrial.set(row.trial, bucket);
  }
  const trialStats = [...byTrial.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, trialRows]) => summarizeTrial(trialRows));
  const accuracy = trialStats.map((s) => s.accuracy);
  const f1 = trialStats.map((s) => s.citationF1);
  const latency = trialStats.map((s) => s.latencyMs);
  const inputTokens = trialStats.map((s) => s.inputTokens);
  lines.push(
    `| ${system} | ${fmtSize(Number(corpusSizeRaw))} | ${fmtSize(Number(modelContextRaw))} | ${trialStats.length} | ` +
      `${formatMeanSd(accuracy, true)} | ${formatMeanSd(f1)} | ${Math.round(mean(latency) / 1000)} s | ${Math.round(mean(inputTokens))} |`,
  );
}

const out = lines.join("\n") + "\n";
writeFileSync(join(runDir, "trial-summary.md"), out, "utf8");
console.log(out);
console.log(`wrote ${join(runDir, "trial-summary.md")}`);

function summarizeTrial(rows: Row[]): TrialStats {
  return {
    n: rows.length,
    accuracy: rows.filter((r) => r.correct).length / rows.length,
    citationF1: mean(rows.map((r) => r.citationF1)),
    inputTokens: mean(rows.map((r) => r.inputTokens)),
    outputTokens: mean(rows.map((r) => r.outputTokens)),
    latencyMs: mean(rows.map((r) => r.latencyMs)),
  };
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function sd(xs: number[]): number {
  if (xs.length <= 1) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1));
}

function formatMeanSd(xs: number[], pct = false): string {
  const m = mean(xs);
  const s = sd(xs);
  if (pct) return `${(m * 100).toFixed(1)}% +- ${(s * 100).toFixed(1)}pp`;
  return `${m.toFixed(3)} +- ${s.toFixed(3)}`;
}

function fmtSize(n: number): string {
  if (n >= 1_000_000_000) return `${Math.round(n / 1_000_000_000)}B`;
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}
