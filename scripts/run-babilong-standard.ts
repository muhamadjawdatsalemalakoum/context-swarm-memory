#!/usr/bin/env tsx
/**
 * Run CSM on BABILong as an external, recognized benchmark.
 *
 * Unlike the generic sweep runner, this keeps BABILong's native unit intact:
 * each benchmark row is one independent haystack plus one question. We load
 * each sampled row, build a one-instance corpus, run the selected system(s),
 * and score free-form exact match programmatically. No LLM judge is used.
 */

import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CsmBaseline } from "../src/eval/baselines/csm.js";
import { HybridRagBaseline } from "../src/eval/baselines/hybridRag.js";
import { LongContextBaseline } from "../src/eval/baselines/longContext.js";
import type { BaselineRunner } from "../src/eval/baselines/types.js";
import { VanillaRagBaseline } from "../src/eval/baselines/vanillaRag.js";
import type { Corpus } from "../src/eval/corpus.js";
import { loadBabilongTask } from "../src/eval/corpus/babilong.js";
import type { FreeFormQuery } from "../src/eval/mcq.js";
import { aggregate, scoreAnswer, type McqScore } from "../src/eval/scorer.js";
import {
  createProvider,
  GEMINI_DEFAULT_MODEL,
  selectProviderName,
} from "../src/providers/index.js";

interface Args {
  tasks: Array<1 | 2 | 3>;
  lengths: string[];
  systems: string[];
  limit: number;
  seed: number;
  model: string;
  modelContext: number;
  runId: string;
}

interface ResultRow extends McqScore {
  benchmark: "BABILong";
  task: number;
  length: string;
  system: string;
  queryId: string;
  queryKind: "free-form";
  chosenAnswer: string | null;
  correctAnswer: string;
  citedEventIds: string[];
  relevantEventIds: string[];
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  model: string;
  modelContext: number;
  meta: Record<string, unknown>;
  timestampIso: string;
  error?: string;
}

const LENGTH_TOKENS: Record<string, number> = {
  "0K": 0,
  "4K": 4096,
  "8K": 8192,
  "32K": 32_768,
  "128K": 131_072,
  "256K": 262_144,
  "1M": 1_048_576,
};

function parseArgs(argv: string[]): Args {
  let tasks: Array<1 | 2 | 3> = [1, 2];
  let lengths = ["4K", "8K"];
  let systems = ["csm"];
  let limit = 30;
  let seed = 42;
  const provider = selectProviderName();
  let model =
    (provider === "gemini" ? process.env.CSM_GEMINI_MODEL : undefined) ??
    process.env.CSM_OPENAI_MODEL ??
    process.env.CSM_MODEL ??
    (provider === "gemini" ? GEMINI_DEFAULT_MODEL : "gemma4:31b");
  let modelContext = 4096;
  let runId = `babilong-standard-${new Date().toISOString().replace(/[:.]/g, "-")}`;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = argv[i + 1];
    switch (a) {
      case "--tasks":
        tasks = next!
          .split(",")
          .map((s) => Number.parseInt(s.trim(), 10) as 1 | 2 | 3)
          .filter((n) => [1, 2, 3].includes(n));
        i++;
        break;
      case "--lengths":
        lengths = next!
          .split(",")
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean);
        i++;
        break;
      case "--systems":
        systems = next!.split(",").map((s) => s.trim()).filter(Boolean);
        i++;
        break;
      case "--limit":
        limit = Number.parseInt(next!, 10);
        i++;
        break;
      case "--seed":
        seed = Number.parseInt(next!, 10);
        i++;
        break;
      case "--model":
        model = next!;
        i++;
        break;
      case "--model-context":
        modelContext = parseHumanSize(next!);
        i++;
        break;
      case "--run-id":
        runId = next!;
        i++;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown flag: ${a}`);
    }
  }

  for (const l of lengths) {
    if (LENGTH_TOKENS[l] === undefined) {
      throw new Error(`Unknown BABILong length ${l}. Valid: ${Object.keys(LENGTH_TOKENS).join(",")}`);
    }
  }
  if (limit <= 0 || !Number.isFinite(limit)) throw new Error("--limit must be positive.");
  return { tasks, lengths, systems, limit, seed, model, modelContext, runId };
}

function printHelp(): void {
  console.log(`Usage:
  npx tsx scripts/run-babilong-standard.ts [--tasks 1,2] [--lengths 4K,8K] [--systems csm] [--limit 30]

Runs BABILong row-wise: one public haystack + one free-form question per scored row.
Defaults use CSM only, tasks 1 and 2, lengths 4K and 8K, 30 rows per cell, 4K physical model context.`);
}

function buildSystems(wanted: string[]): BaselineRunner[] {
  const provider = createProvider();
  const set = new Set(wanted);
  const out: BaselineRunner[] = [];
  if (set.has("csm")) out.push(new CsmBaseline({ provider }));
  if (set.has("longctx")) out.push(new LongContextBaseline({ provider }));
  if (set.has("rag")) out.push(new VanillaRagBaseline({ provider }));
  if (set.has("hybrid")) out.push(new HybridRagBaseline({ provider }));
  if (out.length === 0) {
    throw new Error(`No systems matched. Valid here: csm,longctx,rag,hybrid`);
  }
  return out;
}

function corpusForQuery(allEvents: Corpus["events"], query: FreeFormQuery, seed: number): Corpus {
  const shardId = query.shardHints?.[0];
  if (!shardId) throw new Error(`BABILong query ${query.id} is missing shardHints[0].`);
  const events = allEvents.filter((event) => event.shardId === shardId);
  const byId = new Map(events.map((event) => [event.id, event]));
  const byShard = new Map([[shardId, events]]);
  const totalTokens = events.reduce((sum, event) => sum + event.tokenCount, 0);
  return {
    events,
    coreEvents: events.filter((event) => event.isCore),
    fillerEvents: events.filter((event) => !event.isCore),
    totalTokens,
    byShard,
    byId,
    targetTokens: totalTokens,
    sampleSeed: seed,
  };
}

async function loadSeen(path: string): Promise<Set<string>> {
  const seen = new Set<string>();
  if (!existsSync(path)) return seen;
  const text = await readFile(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const row = JSON.parse(trimmed) as ResultRow;
    if (!row.error) seen.add(rowKey(row.system, row.task, row.length, row.queryId));
  }
  return seen;
}

function rowKey(system: string, task: number, length: string, queryId: string): string {
  return `${system}|${task}|${length}|${queryId}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const outDir = join("data", "eval", "runs", args.runId);
  const resultsPath = join(outDir, "results.jsonl");
  await mkdir(outDir, { recursive: true });
  await writeFile(
    join(outDir, "config.json"),
    `${JSON.stringify({ ...args, benchmark: "BABILong" }, null, 2)}\n`,
    "utf8",
  );

  const systems = buildSystems(args.systems);
  const seen = await loadSeen(resultsPath);
  const rows: ResultRow[] = [];

  console.error(
    `BABILong standard run: runId=${args.runId} systems=[${systems.map((s) => s.name).join(",")}] tasks=${args.tasks.join(",")} lengths=${args.lengths.join(",")} limit=${args.limit} model=${args.model} ctx=${args.modelContext}`,
  );

  for (const task of args.tasks) {
    for (const length of args.lengths) {
      const loaded = await loadBabilongTask(task, LENGTH_TOKENS[length]!, {
        seed: args.seed,
        sampleSize: args.limit,
      });
      console.error(
        `[task ${task} ${length}] rows=${loaded.queries.length} events=${loaded.events.length}`,
      );

      for (const system of systems) {
        for (const query of loaded.queries) {
          const key = rowKey(system.name, task, length, query.id);
          if (seen.has(key)) continue;
          const corpus = corpusForQuery(loaded.events, query, args.seed);
          const timestampIso = new Date().toISOString();
          try {
            const baseline = await system.answer(query, corpus, {
              maxInputTokens: args.modelContext,
              model: args.model,
              maxOutputTokens: 256,
              temperature: 0,
              seed: args.seed,
            });
            const score = scoreAnswer(query, baseline.answer);
            const row: ResultRow = {
              benchmark: "BABILong",
              task,
              length,
              system: system.name,
              queryId: query.id,
              queryKind: "free-form",
              chosenAnswer:
                baseline.answer.kind === "free-form"
                  ? baseline.answer.chosenAnswer
                  : null,
              correctAnswer: query.correctAnswer,
              citedEventIds: baseline.answer.citedEventIds,
              relevantEventIds: query.relevantEventIds,
              ...score,
              inputTokens: baseline.inputTokens,
              outputTokens: baseline.outputTokens,
              latencyMs: baseline.latencyMs,
              model: args.model,
              modelContext: args.modelContext,
              meta: baseline.meta ?? {},
              timestampIso,
            };
            rows.push(row);
            await appendFile(resultsPath, `${JSON.stringify(row)}\n`, "utf8");
          } catch (err) {
            const row: ResultRow = {
              benchmark: "BABILong",
              task,
              length,
              system: system.name,
              queryId: query.id,
              queryKind: "free-form",
              chosenAnswer: null,
              correctAnswer: query.correctAnswer,
              citedEventIds: [],
              relevantEventIds: query.relevantEventIds,
              correct: false,
              citationPrecision: 0,
              citationRecall: 0,
              citationF1: 0,
              inputTokens: 0,
              outputTokens: 0,
              latencyMs: 0,
              model: args.model,
              modelContext: args.modelContext,
              meta: {},
              timestampIso,
              error: err instanceof Error ? err.message : String(err),
            };
            rows.push(row);
            await appendFile(resultsPath, `${JSON.stringify(row)}\n`, "utf8");
          }
        }
      }
    }
  }

  const allRows = await readRows(resultsPath);
  const summary = summarize(allRows, args.seed);
  await writeFile(join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(join(outDir, "report.md"), renderReport(args.runId, summary), "utf8");
  console.error(`Wrote ${outDir}`);
}

async function readRows(path: string): Promise<ResultRow[]> {
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf8");
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ResultRow);
}

function summarize(rows: ResultRow[], seed: number): unknown {
  const groups = new Map<string, ResultRow[]>();
  for (const row of rows) {
    const key = `${row.system}|task${row.task}|${row.length}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return {
    generatedAt: new Date().toISOString(),
    cells: [...groups.entries()].map(([key, group]) => {
      const [system, task, length] = key.split("|");
      const scores = group.map((row) => ({
        correct: row.correct,
        citationPrecision: row.citationPrecision,
        citationRecall: row.citationRecall,
        citationF1: row.citationF1,
      }));
      return {
        system,
        task,
        length,
        errors: group.filter((row) => row.error).length,
        ...aggregate(scores, { seed }),
        meanInputTokens: mean(group.map((row) => row.inputTokens)),
        meanOutputTokens: mean(group.map((row) => row.outputTokens)),
        meanLatencyMs: mean(group.map((row) => row.latencyMs)),
      };
    }),
  };
}

function renderReport(runId: string, summary: unknown): string {
  const cells = (summary as { cells: Array<Record<string, unknown>> }).cells;
  const lines = [
    `# BABILong External Benchmark: ${runId}`,
    "",
    "Recognized external benchmark: BABILong short-answer reasoning-in-a-haystack. Scoring is exact-match after normalisation; no LLM judge.",
    "",
    "| System | Task | Length | N | Accuracy | Citation F1 | Errors | Mean input toks |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const c of cells) {
    lines.push(
      `| ${c.system} | ${c.task} | ${c.length} | ${c.n} | ${pct(c.accuracy as number)} | ${(c.meanCitationF1 as number).toFixed(3)} | ${c.errors} | ${Math.round(c.meanInputTokens as number)} |`,
    );
  }
  lines.push(
    "",
    "Note: BABILong rows from Hugging Face do not expose supporting-fact indices through the dataset-server rows API, so citation metrics use the loader's lexical fallback. Accuracy is the primary comparable BABILong metric.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function parseHumanSize(s: string): number {
  const m = s.match(/^([\d.]+)\s*([KkMmBbGg]?)$/);
  if (!m) return Number.NaN;
  const n = Number.parseFloat(m[1]!);
  const suffix = m[2]!.toLowerCase();
  if (suffix === "k") return Math.round(n * 1_000);
  if (suffix === "m") return Math.round(n * 1_000_000);
  if (suffix === "b" || suffix === "g") return Math.round(n * 1_000_000_000);
  return Math.round(n);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
