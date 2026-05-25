#!/usr/bin/env tsx
/**
 * Wrapper that runs the BABILong benchmark across the (task × context-length)
 * matrix. For each combination it:
 *
 *  1. Calls `loadBabilongTask(task, length)` from `src/eval/corpus/babilong.ts`
 *     to produce in-memory `events` and `queries`.
 *  2. Materialises them to `data/eval/corpus-babilong/task<N>-<label>/` as
 *     `events.jsonl` and `queries.json` (matching the runner's expected on-disk
 *     layout).
 *  3. Calls `runBenchmark` with that corpus dir.
 *  4. Aggregates per-(task × length) summary metadata for the final report.
 *
 * Each (task × length) becomes its own runId so cache + replay semantics are
 * preserved. The same `runBenchmark` engine used for PaySwift runs each cell.
 *
 * Usage:
 *   # Default: all combos against MockProvider (smoke)
 *   npx tsx scripts/run-babilong-bench.ts --systems csm,longctx,rag,hybrid --trials 1
 *
 *   # Specific tasks / lengths (subset for quick validation)
 *   npx tsx scripts/run-babilong-bench.ts --tasks 1,2 --lengths 0k,4k --trials 1
 *
 * Each per-(task,length) result lives at `data/eval/runs/babilong-task<N>-<label>/`.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CsmBaseline } from "../src/eval/baselines/csm.js";
import { HybridRagBaseline } from "../src/eval/baselines/hybridRag.js";
import { LongContextBaseline } from "../src/eval/baselines/longContext.js";
import type { BaselineRunner } from "../src/eval/baselines/types.js";
import { VanillaRagBaseline } from "../src/eval/baselines/vanillaRag.js";
import { loadBabilongTask } from "../src/eval/corpus/babilong.js";
import { runBenchmark } from "../src/eval/runner.js";
import { createProvider } from "../src/providers/index.js";

// --------------------------------------------------------------------------
// Defaults — matches the methodology decision (Tasks 1-3, 7 lengths, 30 samples/cell).
// --------------------------------------------------------------------------

const DEFAULT_TASKS: Array<1 | 2 | 3> = [1, 2, 3];
const DEFAULT_LENGTHS: Array<{ label: string; tokens: number }> = [
  { label: "0k", tokens: 0 },
  { label: "4k", tokens: 4_096 },
  { label: "8k", tokens: 8_192 },
  { label: "32k", tokens: 32_768 },
  { label: "128k", tokens: 131_072 },
  { label: "256k", tokens: 262_144 },
  { label: "1m", tokens: 1_048_576 },
];

const BABILONG_DIR = "data/eval/corpus-babilong";

// --------------------------------------------------------------------------
// CLI args
// --------------------------------------------------------------------------

interface Args {
  tasks: Array<1 | 2 | 3>;
  lengths: Array<{ label: string; tokens: number }>;
  systems: string[];
  trials: number;
  model: string;
  seed: number;
  /** Truncate to first N instances per (task × length) for fast smoke runs. */
  limit?: number;
}

function parseArgs(argv: string[]): Args {
  let tasks = DEFAULT_TASKS;
  let lengths = DEFAULT_LENGTHS;
  let systems = ["csm", "longctx", "rag", "hybrid"];
  let trials = 1;
  let model = process.env.CSM_OPENAI_MODEL ?? "gemma4:31b";
  let seed = 42;
  let limit: number | undefined;

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
      case "--lengths": {
        const labels = next!.split(",").map((s) => s.trim().toLowerCase());
        lengths = DEFAULT_LENGTHS.filter((l) => labels.includes(l.label));
        if (lengths.length === 0) {
          throw new Error(
            `No length labels matched. Valid: ${DEFAULT_LENGTHS.map((l) => l.label).join(",")}`,
          );
        }
        i++;
        break;
      }
      case "--systems":
        systems = next!.split(",").map((s) => s.trim()).filter(Boolean);
        i++;
        break;
      case "--trials":
        trials = Number.parseInt(next!, 10);
        i++;
        break;
      case "--model":
        model = next!;
        i++;
        break;
      case "--seed":
        seed = Number.parseInt(next!, 10);
        i++;
        break;
      case "--limit":
        limit = Number.parseInt(next!, 10);
        i++;
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown flag: ${a}`);
    }
  }

  return { tasks, lengths, systems, trials, model, seed, limit };
}

function printHelp(): void {
  console.log(`run-babilong-bench — run the BABILong sweep matrix

Usage:
  npx tsx scripts/run-babilong-bench.ts [--tasks 1,2,3] [--lengths 0k,4k,...] [--systems csm,...] [--trials N]

Defaults:
  --tasks    1,2,3
  --lengths  0k,4k,8k,32k,128k,256k,1m
  --systems  csm,longctx,rag,hybrid
  --trials   1
  --model    \$CSM_OPENAI_MODEL or gemma4:31b
  --seed     42
  --limit    (no limit; subset to first N queries per cell for smoke runs)

Output:
  Per (task × length): data/eval/runs/babilong-task<N>-<label>/

Notes:
  - Requires \`scripts/fetch-babilong.ts\` to have run successfully first
    (or manual placement of BABILong raw files under data/eval/corpus-babilong/raw/).
  - Each run is independent; cache is shared per the global content-hash design.
`);
}

// --------------------------------------------------------------------------
// System construction (mirrors the CLI's buildSystems)
// --------------------------------------------------------------------------

function buildSystems(wanted: string[]): BaselineRunner[] {
  const provider = createProvider();
  const set = new Set(wanted);
  const out: BaselineRunner[] = [];
  if (set.has("csm")) out.push(new CsmBaseline({ provider }));
  if (set.has("longctx")) out.push(new LongContextBaseline({ provider }));
  if (set.has("rag")) out.push(new VanillaRagBaseline({ provider }));
  if (set.has("hybrid")) out.push(new HybridRagBaseline({ provider }));
  if (out.length === 0) {
    throw new Error(
      `No systems matched ${JSON.stringify(wanted)}. Valid: csm,longctx,rag,hybrid`,
    );
  }
  return out;
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.error(
    `BABILong sweep: tasks=${args.tasks.join(",")}  lengths=${args.lengths.map((l) => l.label).join(",")}  systems=[${args.systems.join(",")}]  trials=${args.trials}  model=${args.model}`,
  );

  const summary: Array<{
    task: number;
    label: string;
    runId: string;
    events: number;
    queries: number;
    error?: string;
  }> = [];

  for (const task of args.tasks) {
    for (const length of args.lengths) {
      const runId = `babilong-task${task}-${length.label}`;
      const corpusDir = join(BABILONG_DIR, `task${task}-${length.label}`);
      const outputDir = join("data", "eval", "runs", runId);

      try {
        // 1. Load BABILong task (this is what may 404 if raw files missing).
        const { events, queries } = await loadBabilongTask(task, length.tokens, {
          seed: args.seed,
          subsampleTo: args.limit ?? 30,
        });

        // 2. Materialise to disk so the runner can pick them up.
        await mkdir(corpusDir, { recursive: true });
        await writeFile(
          join(corpusDir, "events.jsonl"),
          `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
          "utf8",
        );
        await writeFile(
          join(corpusDir, "queries.json"),
          `${JSON.stringify({ version: 1, queries }, null, 2)}\n`,
          "utf8",
        );

        // 3. Build systems + call runBenchmark.
        const systems = buildSystems(args.systems);

        // BABILong context length IS the corpus size for that variant.
        // We sweep model context internally? No — for BABILong, the haystack length
        // is built into the task variant; we just need one corpus size that fits
        // everything. Use the events' total token count as the target.
        const totalTokens = events.reduce((s, e) => s + e.tokenCount, 0);
        const corpusSizes = [Math.max(totalTokens, 100_000)];
        // Model contexts — fixed sweep that probes the model's effective window
        // across BABILong's pre-padded haystacks.
        const modelContexts = [1024, 4096, 8192, 32_768, 131_072];

        console.error(
          `\n[task ${task} × ${length.label}]  events=${events.length}  queries=${queries.length}  runId=${runId}`,
        );

        const result = await runBenchmark({
          runId,
          corpusDir,
          corpusSizes,
          modelContexts,
          trials: args.trials,
          model: args.model,
          outputDir,
          systems,
          seed: args.seed,
          onProgress: (tick) => {
            if (tick.cellIndex % 10 === 0 || tick.cellIndex === tick.totalCells) {
              process.stderr.write(
                `\r  ${tick.cellIndex}/${tick.totalCells}  done=${tick.cellsCompleted}  skipped=${tick.cellsSkipped}  early=${tick.earlyStopGroups}  `,
              );
            }
          },
        });
        process.stderr.write("\n");

        summary.push({
          task,
          label: length.label,
          runId,
          events: events.length,
          queries: queries.length,
        });
        console.error(
          `[task ${task} × ${length.label}]  done: ${result.results.length} cells, ${result.summaries.length} groups, ${result.earlyStopMap.length} early-stop pairs`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[task ${task} × ${length.label}]  ERROR: ${msg}`);
        summary.push({
          task,
          label: length.label,
          runId,
          events: 0,
          queries: 0,
          error: msg,
        });
      }
    }
  }

  // Write top-level summary so users can navigate.
  await mkdir(join("data", "eval", "runs"), { recursive: true });
  const indexPath = join("data", "eval", "runs", "babilong-index.json");
  await writeFile(
    indexPath,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), sweeps: summary },
      null,
      2,
    ),
    "utf8",
  );

  console.error(`\nWrote ${indexPath}`);
  const errors = summary.filter((s) => s.error).length;
  if (errors > 0) {
    console.error(
      `${errors} sweep(s) failed — most likely missing raw BABILong files; run scripts/fetch-babilong.ts and retry, or place files manually under ${BABILONG_DIR}/raw/.`,
    );
    process.exit(1);
  }
}

// Guard against running with missing raw data.
if (!existsSync(BABILONG_DIR)) {
  console.error(
    `Missing ${BABILONG_DIR}. Run 'npx tsx scripts/fetch-babilong.ts' first (or place BABILong raw files manually).`,
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
