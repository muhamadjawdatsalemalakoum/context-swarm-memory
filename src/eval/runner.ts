import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { stableStringify } from "../utils/json.js";
import { nowIso } from "../utils/time.js";

import type { BaselineRunner } from "./baselines/types.js";
import {
  EARLY_STOP_ACCURACY,
  loadAllEvents,
  sampleFromEvents,
  type BenchEvent,
  type Corpus,
} from "./corpus.js";
import { QueryZ, type Query } from "./mcq.js";
import { z } from "zod";
import { aggregate, scoreAnswer, type McqScore } from "./scorer.js";

/**
 * Configuration for one benchmark sweep run.
 *
 * The runner walks `systems × modelContexts × corpusSizes × queries × trials`
 * cells, with **adaptive early-stop**: once a `(system, modelContext)` cell's
 * accuracy at some `corpusSize` drops below `earlyStopThreshold`, all larger
 * corpus sizes for that pair are skipped (the system has already failed).
 *
 * Resumable: existing rows in `results.jsonl` are loaded on startup and the
 * matching cells are skipped — re-runs only cover new ground.
 */
export interface BenchmarkConfig {
  /** Identifier for this run; used as the output directory name. */
  runId: string;
  /** Directory holding `events.jsonl` and `queries.json`. */
  corpusDir: string;
  /** Corpus token sizes to sweep (typically `CORPUS_SIZE_SWEEP`). */
  corpusSizes: number[];
  /** Model context-window points to sweep (typically `MODEL_CONTEXT_SWEEP`). */
  modelContexts: number[];
  trials: number;
  /** Provider model identifier (e.g. `"gemma4:31b"`). */
  model: string;
  /** Where to write `config.json`, `results.jsonl`, `summary.json`. */
  outputDir: string;
  earlyStopThreshold?: number;
  maxOutputTokens?: number;
  seed?: number;
  /** Tokens reserved for the MCQ scaffolding inside the model context. */
  reserveScaffoldingTokens?: number;
  /** If set, only run these query IDs (useful for pilot/smoke runs). */
  queryIdsFilter?: string[];
}

export interface RunBenchmarkOptions extends BenchmarkConfig {
  systems: BaselineRunner[];
  /** Optional progress callback — fired before each cell starts. */
  onProgress?: (tick: ProgressTick) => void;
}

export interface ProgressTick {
  cellIndex: number;
  totalCells: number;
  system: string;
  corpusSize: number;
  modelContext: number;
  queryId: string;
  trial: number;
  cellsCompleted: number;
  cellsSkipped: number;
  earlyStopGroups: number;
}

export interface CellResult {
  system: string;
  corpusSize: number;
  modelContext: number;
  trial: number;
  queryId: string;
  /** "mcq" or "free-form"; absent on legacy rows defaults to "mcq". */
  queryKind?: "mcq" | "free-form";
  /** Populated for MCQ queries. */
  chosenOption?: number | null;
  /** Populated for MCQ queries. */
  correctOption?: number;
  /** Populated for free-form queries. */
  chosenAnswer?: string | null;
  /** Populated for free-form queries. */
  correctAnswer?: string;
  citedEventIds: string[];
  relevantEventIds: string[];
  correct: boolean;
  citationPrecision: number;
  citationRecall: number;
  citationF1: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  meta: Record<string, unknown>;
  timestampIso: string;
  error?: string;
}

export interface CellSummary {
  system: string;
  corpusSize: number;
  modelContext: number;
  n: number;
  accuracy: number;
  accuracyCi95: [number, number];
  meanCitationPrecision: number;
  meanCitationRecall: number;
  meanCitationF1: number;
  meanInputTokens: number;
  meanLatencyMs: number;
  earlyStopped: boolean;
}

export interface RunOutput {
  config: BenchmarkConfig & { systemNames: string[] };
  results: CellResult[];
  summaries: CellSummary[];
  earlyStopMap: Array<{ system: string; modelContext: number; failedAtCorpus: number }>;
}

/**
 * Drive one full benchmark sweep. Writes incrementally to disk so a crash
 * leaves a partial-but-resumable state. Returns the assembled summaries.
 */
export async function runBenchmark(opts: RunBenchmarkOptions): Promise<RunOutput> {
  const config = normaliseConfig(opts);

  const events = await loadAllEvents(config.corpusDir);
  const queries = await loadQueries(
    join(config.corpusDir, "queries.json"),
    config.queryIdsFilter,
  );

  await mkdir(config.outputDir, { recursive: true });
  const configPath = join(config.outputDir, "config.json");
  const resultsPath = join(config.outputDir, "results.jsonl");
  const summaryPath = join(config.outputDir, "summary.json");

  const systemNames = opts.systems.map((s) => s.name);
  await writeFile(configPath, stableStringify({ ...config, systemNames }), "utf8");

  // Resume: re-load any rows already on disk and skip their cells.
  const previousResults = await loadExistingResults(resultsPath);
  const seen = new Set<string>();
  for (const r of previousResults) {
    // A row that recorded a transient `error` is NOT a completed cell — skip it
    // here so resume RE-RUNS it instead of baking the error in as a wrong answer.
    if (r.error) continue;
    seen.add(cellKey(r.system, r.modelContext, r.corpusSize, r.trial, r.queryId));
  }

  // Adaptive early-stop bookkeeping: failedAt[system][ctx] = first corpus_size
  // where the cell aggregate dropped below threshold. Skip larger sizes for
  // the same (system, ctx) combination.
  const failedAt = new Map<string, Map<number, number>>();
  for (const s of opts.systems) failedAt.set(s.name, new Map<number, number>());

  // Seed early-stop state from existing results so resumed runs don't re-run
  // cells we already know have failed.
  reconstructEarlyStops(previousResults, failedAt, config.earlyStopThreshold);

  // Cache `Corpus` samples per (corpusSize, seed) so we don't re-shuffle for
  // every (system × ctx) pass at the same size.
  const corpusCache = new Map<number, Corpus>();
  const getCorpus = (size: number): Corpus => {
    const cached = corpusCache.get(size);
    if (cached) return cached;
    const sample = sampleFromEvents(events, {
      targetTokens: size,
      seed: config.seed,
    });
    corpusCache.set(size, sample);
    return sample;
  };

  const results: CellResult[] = [...previousResults];
  let cellsCompleted = previousResults.length;
  let cellsSkipped = 0;
  let cellIndex = 0;

  const totalCells =
    opts.systems.length *
    config.modelContexts.length *
    config.corpusSizes.length *
    queries.length *
    config.trials;

  for (const system of opts.systems) {
    for (const modelCtx of config.modelContexts) {
      const sysFailed = failedAt.get(system.name)!;

      for (const corpusSize of config.corpusSizes) {
        // Skip if a smaller corpus already failed this (system, ctx).
        const failedSize = sysFailed.get(modelCtx);
        if (failedSize !== undefined && corpusSize >= failedSize) {
          cellsSkipped += queries.length * config.trials;
          cellIndex += queries.length * config.trials;
          continue;
        }

        const corpus = getCorpus(corpusSize);
        const cellScores: McqScore[] = [];

        for (let trial = 0; trial < config.trials; trial++) {
          for (const query of queries) {
            cellIndex++;
            const key = cellKey(
              system.name,
              modelCtx,
              corpusSize,
              trial,
              query.id,
            );

            // Resumed: already have this exact row. Re-use score for early-stop check.
            if (seen.has(key)) {
              const existing = results.find(
                (r) =>
                  r.system === system.name &&
                  r.modelContext === modelCtx &&
                  r.corpusSize === corpusSize &&
                  r.trial === trial &&
                  r.queryId === query.id,
              );
              if (existing) {
                cellScores.push({
                  correct: existing.correct,
                  citationPrecision: existing.citationPrecision,
                  citationRecall: existing.citationRecall,
                  citationF1: existing.citationF1,
                });
              }
              continue;
            }

            opts.onProgress?.({
              cellIndex,
              totalCells,
              system: system.name,
              corpusSize,
              modelContext: modelCtx,
              queryId: query.id,
              trial,
              cellsCompleted,
              cellsSkipped,
              earlyStopGroups: countEarlyStops(failedAt),
            });

            const ctx = {
              maxInputTokens: modelCtx,
              model: config.model,
              maxOutputTokens: config.maxOutputTokens,
              temperature: 0,
              seed: config.seed + trial,
            };

            try {
              const baseline = await system.answer(query, corpus, ctx);
              const score = scoreAnswer(query, baseline.answer);
              const queryKind: "mcq" | "free-form" =
                query.kind === "free-form" ? "free-form" : "mcq";
              const cell: CellResult = {
                system: system.name,
                corpusSize,
                modelContext: modelCtx,
                trial,
                queryId: query.id,
                queryKind,
                citedEventIds: baseline.answer.citedEventIds,
                relevantEventIds: query.relevantEventIds,
                correct: score.correct,
                citationPrecision: score.citationPrecision,
                citationRecall: score.citationRecall,
                citationF1: score.citationF1,
                inputTokens: baseline.inputTokens,
                outputTokens: baseline.outputTokens,
                latencyMs: baseline.latencyMs,
                meta: baseline.meta ?? {},
                timestampIso: nowIso(),
              };
              if (queryKind === "mcq" && baseline.answer.kind !== "free-form") {
                cell.chosenOption = baseline.answer.chosenOption;
                cell.correctOption = (query as { correctOption: number }).correctOption;
              } else if (queryKind === "free-form" && baseline.answer.kind === "free-form") {
                cell.chosenAnswer = baseline.answer.chosenAnswer;
                cell.correctAnswer = (query as { correctAnswer: string }).correctAnswer;
              }
              await appendFile(resultsPath, `${JSON.stringify(cell)}\n`, "utf8");
              results.push(cell);
              cellScores.push(score);
              cellsCompleted++;
            } catch (err) {
              // Don't abort the whole sweep on a single cell error — log it
              // and let aggregates penalise the system naturally (cell missing
              // from scores → smaller n; rerun later via resume to fill gap).
              const queryKind: "mcq" | "free-form" =
                query.kind === "free-form" ? "free-form" : "mcq";
              const cell: CellResult = {
                system: system.name,
                corpusSize,
                modelContext: modelCtx,
                trial,
                queryId: query.id,
                queryKind,
                citedEventIds: [],
                relevantEventIds: query.relevantEventIds,
                correct: false,
                citationPrecision: 0,
                citationRecall: 0,
                citationF1: 0,
                inputTokens: 0,
                outputTokens: 0,
                latencyMs: 0,
                meta: {},
                timestampIso: nowIso(),
                error: err instanceof Error ? err.message : String(err),
              };
              if (queryKind === "mcq") {
                cell.chosenOption = null;
                cell.correctOption = (query as { correctOption: number }).correctOption;
              } else {
                cell.chosenAnswer = null;
                cell.correctAnswer = (query as { correctAnswer: string }).correctAnswer;
              }
              await appendFile(resultsPath, `${JSON.stringify(cell)}\n`, "utf8");
              results.push(cell);
              cellScores.push({
                correct: false,
                citationPrecision: 0,
                citationRecall: 0,
                citationF1: 0,
              });
              cellsCompleted++;
            }
          }
        }

        // Adaptive early-stop check: aggregate this cell.
        const cellAggregate = aggregate(cellScores, {
          seed: config.seed,
          // Smaller bootstrap inside the loop — full 10K only for the final summary.
          bootstrapResamples: 200,
        });
        if (cellAggregate.accuracy < config.earlyStopThreshold) {
          sysFailed.set(modelCtx, corpusSize);
        }
      }
    }
  }

  const summaries = computeSummaries(results, config, failedAt);
  const earlyStopMap: RunOutput["earlyStopMap"] = [];
  for (const [system, ctxMap] of failedAt) {
    for (const [modelContext, failedAtCorpus] of ctxMap) {
      earlyStopMap.push({ system, modelContext, failedAtCorpus });
    }
  }

  await writeFile(
    summaryPath,
    stableStringify({
      runId: config.runId,
      generatedAt: nowIso(),
      cells: summaries,
      earlyStops: earlyStopMap,
      systemNames,
    }),
    "utf8",
  );

  return {
    config: { ...config, systemNames },
    results,
    summaries,
    earlyStopMap,
  };
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function normaliseConfig(opts: BenchmarkConfig): Required<
  Omit<BenchmarkConfig, "queryIdsFilter">
> & { queryIdsFilter?: string[] } {
  return {
    runId: opts.runId,
    corpusDir: opts.corpusDir,
    corpusSizes: [...opts.corpusSizes].sort((a, b) => a - b),
    modelContexts: [...opts.modelContexts].sort((a, b) => a - b),
    trials: opts.trials,
    model: opts.model,
    outputDir: opts.outputDir,
    earlyStopThreshold: opts.earlyStopThreshold ?? EARLY_STOP_ACCURACY,
    // Gemma 31b's chain-of-thought on a 40-option MCQ commonly consumes
    // 2000–3500 tokens of reasoning BEFORE reaching the ANSWER line. At 2048
    // the model was hitting length-stop mid-reasoning, never emitting
    // "ANSWER: N". 4096 gives consistent headroom; the parser's "Option N"
    // secondary fallback recovers the answer even when budget is exhausted
    // before the ANSWER tail. Wall-clock at 18 tok/s ≈ 3.8 min per final call
    // — slow but tractable for the iter-1 small bench.
    maxOutputTokens: opts.maxOutputTokens ?? 4096,
    seed: opts.seed ?? 42,
    reserveScaffoldingTokens: opts.reserveScaffoldingTokens ?? 512,
    queryIdsFilter: opts.queryIdsFilter,
  };
}

function cellKey(
  system: string,
  ctx: number,
  size: number,
  trial: number,
  qid: string,
): string {
  return `${system}|${ctx}|${size}|${trial}|${qid}`;
}

async function loadQueries(
  path: string,
  filter?: string[],
): Promise<Query[]> {
  if (!existsSync(path)) {
    throw new Error(`Queries file not found: ${path}`);
  }
  const text = await readFile(path, "utf8");
  // Permissive schema: legacy queries.json rows lack `kind`. We inject
  // `kind: "mcq"` if missing so the discriminated union dispatches correctly.
  const QueriesFileZ = z.object({
    version: z.literal(1),
    queries: z.array(
      z.preprocess((q) => {
        if (q && typeof q === "object" && !("kind" in (q as Record<string, unknown>))) {
          return { ...(q as Record<string, unknown>), kind: "mcq" };
        }
        return q;
      }, QueryZ),
    ),
  });
  const data = QueriesFileZ.parse(JSON.parse(text));
  let queries: Query[] = data.queries;
  if (filter && filter.length > 0) {
    const set = new Set(filter);
    queries = queries.filter((q) => set.has(q.id));
  }
  // Validate correctOption ranges via the schema's runtime check — already done.
  return queries;
}

async function loadExistingResults(path: string): Promise<CellResult[]> {
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf8");
  // Last-wins dedupe by cell key: when a previously-errored cell is re-run on
  // resume, a fresh row is appended, so the file can hold two rows for one cell.
  // Keeping the latest prevents summaries from double-counting and ensures the
  // successful re-run supersedes the stale error row.
  const byKey = new Map<string, CellResult>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const row = JSON.parse(trimmed) as CellResult;
      byKey.set(
        cellKey(row.system, row.modelContext, row.corpusSize, row.trial, row.queryId),
        row,
      );
    } catch {
      // Skip corrupted lines (partial write from prior crash). Resume re-fills them.
    }
  }
  return [...byKey.values()];
}

function reconstructEarlyStops(
  previous: CellResult[],
  failedAt: Map<string, Map<number, number>>,
  threshold: number,
): void {
  // Group existing results by (system, ctx, size) and replay the early-stop
  // decision so a resumed run honours prior failures.
  const grouped = groupBy(previous, (r) =>
    `${r.system}|${r.modelContext}|${r.corpusSize}`,
  );
  for (const [key, rows] of grouped) {
    const [system, ctxStr, sizeStr] = key.split("|");
    if (!system || !ctxStr || !sizeStr) continue;
    const ctx = Number(ctxStr);
    const size = Number(sizeStr);
    const correct = rows.filter((r) => r.correct).length;
    const accuracy = correct / rows.length;
    if (accuracy < threshold) {
      const m = failedAt.get(system) ?? new Map<number, number>();
      const existing = m.get(ctx);
      if (existing === undefined || size < existing) m.set(ctx, size);
      failedAt.set(system, m);
    }
  }
}

function computeSummaries(
  results: CellResult[],
  config: BenchmarkConfig,
  failedAt: Map<string, Map<number, number>>,
): CellSummary[] {
  const grouped = groupBy(
    results,
    (r) => `${r.system}|${r.modelContext}|${r.corpusSize}`,
  );
  const summaries: CellSummary[] = [];
  for (const [, rows] of grouped) {
    const first = rows[0]!;
    const scores: McqScore[] = rows.map((r) => ({
      correct: r.correct,
      citationPrecision: r.citationPrecision,
      citationRecall: r.citationRecall,
      citationF1: r.citationF1,
    }));
    const agg = aggregate(scores, {
      seed: config.seed ?? 42,
      bootstrapResamples: 10_000,
    });
    const meanInputTokens =
      rows.reduce((s, r) => s + r.inputTokens, 0) / rows.length;
    const meanLatencyMs =
      rows.reduce((s, r) => s + r.latencyMs, 0) / rows.length;
    const failedSize = failedAt.get(first.system)?.get(first.modelContext);
    summaries.push({
      system: first.system,
      corpusSize: first.corpusSize,
      modelContext: first.modelContext,
      n: scores.length,
      accuracy: agg.accuracy,
      accuracyCi95: agg.accuracyCi95,
      meanCitationPrecision: agg.meanCitationPrecision,
      meanCitationRecall: agg.meanCitationRecall,
      meanCitationF1: agg.meanCitationF1,
      meanInputTokens,
      meanLatencyMs,
      earlyStopped:
        failedSize !== undefined && first.corpusSize > failedSize,
    });
  }
  // Sort for stable output: system → modelContext → corpusSize.
  summaries.sort((a, b) => {
    if (a.system !== b.system) return a.system < b.system ? -1 : 1;
    if (a.modelContext !== b.modelContext)
      return a.modelContext - b.modelContext;
    return a.corpusSize - b.corpusSize;
  });
  return summaries;
}

function groupBy<T, K>(items: T[], key: (x: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = out.get(k);
    if (arr) arr.push(it);
    else out.set(k, [it]);
  }
  return out;
}

function countEarlyStops(failedAt: Map<string, Map<number, number>>): number {
  let n = 0;
  for (const m of failedAt.values()) n += m.size;
  return n;
}

/**
 * Recompute summaries from an existing `results.jsonl` without running any
 * cells. Used by `csm bench replay`.
 */
export async function replayResults(opts: {
  outputDir: string;
}): Promise<RunOutput> {
  const configPath = join(opts.outputDir, "config.json");
  const resultsPath = join(opts.outputDir, "results.jsonl");
  if (!existsSync(configPath)) {
    throw new Error(`Missing config.json at ${configPath}`);
  }
  if (!existsSync(resultsPath)) {
    throw new Error(`Missing results.jsonl at ${resultsPath}`);
  }
  const configRaw = JSON.parse(await readFile(configPath, "utf8")) as
    BenchmarkConfig & { systemNames: string[] };
  const results = await loadExistingResults(resultsPath);

  const failedAt = new Map<string, Map<number, number>>();
  for (const name of configRaw.systemNames) {
    failedAt.set(name, new Map<number, number>());
  }
  reconstructEarlyStops(
    results,
    failedAt,
    configRaw.earlyStopThreshold ?? EARLY_STOP_ACCURACY,
  );

  const summaries = computeSummaries(results, configRaw, failedAt);
  const earlyStopMap: RunOutput["earlyStopMap"] = [];
  for (const [system, ctxMap] of failedAt) {
    for (const [modelContext, failedAtCorpus] of ctxMap) {
      earlyStopMap.push({ system, modelContext, failedAtCorpus });
    }
  }
  // Overwrite summary.json with the replayed numbers.
  await writeFile(
    join(opts.outputDir, "summary.json"),
    stableStringify({
      runId: configRaw.runId,
      generatedAt: nowIso(),
      cells: summaries,
      earlyStops: earlyStopMap,
      systemNames: configRaw.systemNames,
      replay: true,
    }),
    "utf8",
  );
  return { config: configRaw, results, summaries, earlyStopMap };
}
