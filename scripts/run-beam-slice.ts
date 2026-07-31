#!/usr/bin/env tsx
/**
 * BEAM-slice retrieval runner — RETRIEVAL SIDE of the T3 harness.
 *
 * Drives CSM retrieval (the exact same `executeAmbRetrieve` core the AMB
 * bridge/server use) over a locally fetched BEAM slice and writes one
 * payload row per query to `data/eval/runs/<runId>/payloads.jsonl`.
 * Scoring lives in a SEPARATE process (`scripts/score-beam-slice.ts`);
 * this runner never imports the gold module and never sees gold answers,
 * rubrics, or hints — enforced by `tests/beamLeakageFirewall.test.ts`.
 *
 * Modes:
 *   - mock  : `CSM_AMB_ALLOW_MOCK=1` + no provider config → MockProvider.
 *             Plumbing/CI smoke; numbers are NOT meaningful retrieval
 *             quality (the bridge's integrity guard refuses mock without
 *             the env opt-in, same as AMB runs).
 *   - live  : real provider from env/.env (e.g. CSM_PROVIDER=gemini).
 *             Retrieval-only; no answer/judge model anywhere. See
 *             docs/experiments/EXP-T3-beam-slice.md for the written
 *             protocol (the orchestrator runs it; T3 does not).
 *
 * Replay note: rescoring at different k / thresholds needs NO rerun —
 * `score-beam-slice.ts` recomputes everything from payloads.jsonl.
 *
 * Usage:
 *   npx tsx scripts/run-beam-slice.ts --split 100k \
 *     --categories summarization,event_ordering --run-id beam-slice-<tag> \
 *     [--query-limit N] [--per-category-limit N] [--units 1,2,3] [--k 24]
 *     [--seed 42] [--slice-dir <dir>] [--no-resume]
 */

import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CsmBaseline } from "../src/eval/baselines/csm.js";
import {
  BEAM_LOSING_CATEGORIES,
  loadBeamDocuments,
  loadBeamRetrievalQueries,
  selectBeamQueries,
  type BeamRetrievalQuery,
} from "../src/eval/corpus/beam.js";
import { loadLocalEnv } from "../src/utils/loadEnv.js";
import {
  buildCorpus,
  createBridgeProvider,
  executeAmbRetrieve,
  scopeDocuments,
  type AmbBridgeOptions,
  type AmbDocument,
} from "./amb-csm-retrieve.js";

export interface RunBeamSliceOptions {
  split: string;
  runId: string;
  categories?: string[];
  userIds?: string[];
  perCategoryLimit?: number;
  queryLimit?: number;
  /** AMB-side requested k (the BEAM-100K run used CSM_AMB_RETURN_K=24). */
  requestedK?: number;
  seed?: number;
  sliceDir?: string;
  outputDir?: string;
  resume?: boolean;
  /** Queries retrieved concurrently WITHIN a unit. Defaults to 1, which is
   *  byte-for-byte the original serial behaviour — existing runs are
   *  unaffected unless you pass `--jobs`. Retrieval is network-bound (each
   *  query is an independent probe/recall/synth fan-out over the same
   *  in-memory corpus), so raising this is close to a linear wall-clock win
   *  until the provider rate-limits. Appends stay serialized, so
   *  payloads.jsonl is never interleaved; row ORDER becomes completion order,
   *  which the scorer does not depend on (it joins by queryId). */
  jobs?: number;
  onProgress?: (line: string) => void;
}

export interface RunBeamSliceResult {
  runDir: string;
  payloadsPath: string;
  configPath: string;
  queriesPlanned: number;
  queriesRun: number;
  queriesSkippedResume: number;
  unitsTouched: number;
  providerName: string;
  totalLatencyMs: number;
}

/** Env echo for the run config — tuning vars only, never key material. */
const ECHOED_ENV_VARS = [
  "CSM_PROVIDER",
  "CSM_AMB_MODEL",
  "CSM_MODEL",
  "CSM_GEMINI_MODEL",
  "CSM_AMB_MODEL_CONTEXT",
  "CSM_AMB_MAX_OUTPUT_TOKENS",
  "CSM_AMB_RETURN_K",
  "CSM_AMB_SUMMARY_RETURN_K",
  "CSM_AMB_REASONING_RETURN_K",
  "CSM_AMB_NEIGHBOR_WINDOW",
  "CSM_AMB_CAPSULE_COVERAGE_K",
  "CSM_AMB_CAPSULE_TOP_K",
  "CSM_AMB_CAPSULE_SUMMARY_SNIPPETS",
  "CSM_AMB_CAPSULE_REASONING_SNIPPETS",
  "CSM_AMB_ALLOW_MOCK",
  "CSM_EMBED_FLOOR_K",
  "CSM_SHARD_EXPAND_K",
  "CSM_LEXICAL_BRIDGE_K",
  "CSM_ENTITY_BRIDGE_K",
  "CSM_EAGER_RECALLS",
  "CSM_PARALLEL_PROBES",
  "CSM_PROBE_MODEL",
  "CSM_GEMINI_THINKING",
];

export async function runBeamSlice(
  opts: RunBeamSliceOptions,
): Promise<RunBeamSliceResult> {
  const log = opts.onProgress ?? ((line: string) => process.stdout.write(`${line}\n`));
  const seed = opts.seed ?? 42;
  const requestedK = opts.requestedK ?? 24;
  const categories = opts.categories ?? [...BEAM_LOSING_CATEGORIES];
  const resume = opts.resume ?? true;

  const provider = createBridgeProvider();
  const bridgeOpts: AmbBridgeOptions = {
    model:
      process.env.CSM_AMB_MODEL ?? process.env.CSM_MODEL ?? "gemini-3.5-flash",
    modelContext: parsePositiveInt(process.env.CSM_AMB_MODEL_CONTEXT, 8192),
    maxOutputTokens: parsePositiveInt(process.env.CSM_AMB_MAX_OUTPUT_TOKENS, 512),
    withInternalAnswer: false,
  };

  const [documents, allQueries] = await Promise.all([
    loadBeamDocuments(opts.split, { sliceDir: opts.sliceDir }),
    loadBeamRetrievalQueries(opts.split, { sliceDir: opts.sliceDir }),
  ]);
  const selected = selectBeamQueries(allQueries, {
    categories,
    userIds: opts.userIds,
    perCategoryLimit: opts.perCategoryLimit,
    queryLimit: opts.queryLimit,
    seed,
  });

  const runDir =
    opts.outputDir ?? resolve(process.cwd(), "data", "eval", "runs", opts.runId);
  await mkdir(runDir, { recursive: true });
  const payloadsPath = join(runDir, "payloads.jsonl");
  const configPath = join(runDir, "config.json");

  const doneIds = resume ? await readDoneQueryIds(payloadsPath) : new Set<string>();
  if (!resume && existsSync(payloadsPath)) {
    throw new Error(
      `${payloadsPath} exists and --no-resume was given. Pick a new --run-id or delete the run dir.`,
    );
  }

  const envEcho: Record<string, string> = {};
  for (const name of ECHOED_ENV_VARS) {
    const value = process.env[name];
    if (value !== undefined) envEcho[name] = value;
  }
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        harness: "beam-slice-retrieval-v1",
        runId: opts.runId,
        split: opts.split,
        categories,
        userIds: opts.userIds ?? null,
        perCategoryLimit: opts.perCategoryLimit ?? null,
        queryLimit: opts.queryLimit ?? null,
        requestedK,
        seed,
        resume,
        providerName: provider.name,
        bridgeOpts,
        envEcho,
        startedAtIso: new Date().toISOString(),
        note:
          "Retrieval-only BEAM slice run. Gold never enters this process; scoring is scripts/score-beam-slice.ts.",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  // Group by unit so each scoped corpus is built once.
  const byUnit = new Map<string, BeamRetrievalQuery[]>();
  for (const q of selected) {
    const bucket = byUnit.get(q.userId);
    if (bucket) bucket.push(q);
    else byUnit.set(q.userId, [q]);
  }

  const baseline = new CsmBaseline({ provider });
  let queriesRun = 0;
  let skipped = 0;
  let totalLatencyMs = 0;
  const startedAt = Date.now();
  const jobs = Math.max(1, opts.jobs ?? 1);
  /** Serializes payloads.jsonl appends across concurrent workers. */
  let appendChain: Promise<void> = Promise.resolve();

  log(
    `beam-slice run ${opts.runId}: split=${opts.split} provider=${provider.name} ` +
      `queries=${selected.length} units=${byUnit.size} k=${requestedK} jobs=${jobs} ` +
      `categories=${categories.join(",")}`,
  );

  // Flatten every pending query across every unit into ONE task list, so the
  // worker pool saturates globally instead of draining one unit at a time.
  // This matters because a category typically has only ~2 queries per unit —
  // per-unit concurrency alone caps the speedup at ~2x no matter how high
  // --jobs goes.
  interface SliceTask {
    userId: string;
    query: BeamRetrievalQuery;
  }
  const tasks: SliceTask[] = [];
  const unitDocs = new Map<string, AmbDocument[]>();

  for (const [userId, unitQueries] of byUnit) {
    const pending = unitQueries.filter((q) => !doneIds.has(q.id));
    skipped += unitQueries.length - pending.length;
    if (pending.length === 0) continue;

    const scoped: AmbDocument[] = scopeDocuments(documents, userId);
    if (scoped.length === 0) {
      log(`  unit ${userId}: 0 documents in scope — skipping ${pending.length} queries`);
      continue;
    }
    unitDocs.set(userId, scoped);
    for (const q of pending) tasks.push({ userId, query: q });
  }

  // Corpora are built lazily and memoized per unit. buildCorpus is pure CPU over
  // already-loaded documents, so the only cost of holding several at once is
  // memory, bounded by the number of distinct units in flight (<= jobs). The
  // check-then-set is safe without a lock because it contains no await.
  /**
   * ALWAYS-ON standing preference profile, built once per unit and memoized.
   * `CSM_AMB_PREFERENCE_PROFILE=1` enables it. Unlike the Observation and fact
   * registry it is not gated on query intent: preference_following /
   * instruction_following queries never mention the preference they test, so
   * there is nothing for a gate to match on. See
   * docs/experiments/EXP-preference-write-time.md.
   *
   * The build is an LLM pass over the unit, so it is amortised across every
   * query for that unit — the same exactly-once contract the other write-time
   * levers use.
   */
  const prefEnabled = /^(1|true|yes)$/i.test(process.env.CSM_AMB_PREFERENCE_PROFILE ?? "");
  const prefProfiles = new Map<string, Promise<string | undefined>>();
  const getPreferenceProfile = (
    userId: string,
    corpus: ReturnType<typeof buildCorpus>,
  ): Promise<string | undefined> => {
    if (!prefEnabled) return Promise.resolve(undefined);
    const hit = prefProfiles.get(userId);
    if (hit) return hit;
    const built = baseline
      .organizePreferencesScaled({
        eventContents: corpus.events.map((e) => e.content),
        model: bridgeOpts.model,
        // The 600K-token defaults are a Gemini-era setting; a 1M-tier unit is
        // ~1.6M tokens, so those produce 600K-token prompts that the sidecar
        // rejects outright. Size the map step to something any provider can
        // actually accept, and let it be tuned per stack.
        chunkTokens: parsePositiveInt(process.env.CSM_AMB_PREF_CHUNK_TOKENS, 100_000),
        singlePassTokens: parsePositiveInt(process.env.CSM_AMB_PREF_SINGLE_PASS_TOKENS, 120_000),
        chunkOutputTokens: parsePositiveInt(process.env.CSM_AMB_PREF_CHUNK_OUTPUT, 2000),
        finalOutputTokens: parsePositiveInt(process.env.CSM_AMB_PREF_MAX_OUTPUT, 2000),
        mapConcurrency: parsePositiveInt(process.env.CSM_AMB_PREF_MAP_CONCURRENCY, 4),
        onProgress: (msg) => process.stdout.write(`    [pref] unit ${userId} ${msg}
`),
      })
      .then((r) => {
        process.stdout.write(
          `    [pref] unit ${userId} profile ready (${r.outputTokens} out-tok, ${r.chunks} chunk(s))
`,
        );
        return r.text;
      })
      .catch((err) => {
        // A failed profile must not fail the query — it degrades to no profile,
        // and the omission is visible in the log rather than silent.
        process.stdout.write(`    [pref] unit ${userId} FAILED: ${String(err).slice(0, 120)}
`);
        return undefined;
      });
    prefProfiles.set(userId, built);
    return built;
  };

  const corpora = new Map<string, ReturnType<typeof buildCorpus>>();
  const getCorpus = (userId: string): ReturnType<typeof buildCorpus> => {
    const cached = corpora.get(userId);
    if (cached) return cached;
    const scoped = unitDocs.get(userId)!;
    const built = buildCorpus(scoped);
    corpora.set(userId, built);
    log(`  unit ${userId}: ${scoped.length} docs → ${built.events.length} events`);
    return built;
  };

  {
    // Appends are chained so two workers can never interleave a JSONL line.
    const runOne = async (task: SliceTask): Promise<void> => {
      const q = task.query;
      const corpus = getCorpus(task.userId);
      const t0 = Date.now();
      const preferenceProfile = await getPreferenceProfile(q.userId, corpus);
      const payload = await executeAmbRetrieve({
        baseline,
        providerName: provider.name,
        corpus,
        request: { query: q.question, k: requestedK, user_id: q.userId },
        opts: bridgeOpts,
        preferenceProfile,
      });
      const wallMs = Date.now() - t0;
      totalLatencyMs += wallMs;

      const row = {
        harness: {
          queryId: q.id,
          category: q.category,
          userId: q.userId,
          questionSha256: q.questionSha256,
          requestedK,
          split: opts.split,
          providerName: provider.name,
          model: bridgeOpts.model,
          wallMs,
          timestampIso: new Date().toISOString(),
        },
        documents: payload.documents.map((d) => ({
          id: d.id,
          contentChars: d.content.length,
        })),
        raw_response: payload.raw_response,
      };
      appendChain = appendChain.then(() =>
        appendFile(payloadsPath, `${JSON.stringify(row)}\n`, "utf8"),
      );
      await appendChain;
      queriesRun++;
      log(
        `    ${q.id} [${q.category}] docs=${payload.documents.length} ${wallMs}ms`,
      );
    };

    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++;
        if (index >= tasks.length) return;
        await runOne(tasks[index]!);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(jobs, tasks.length) }, () => worker()),
    );
  }

  const summary = {
    runId: opts.runId,
    queriesPlanned: selected.length,
    queriesRun,
    queriesSkippedResume: skipped,
    unitsTouched: byUnit.size,
    providerName: provider.name,
    totalLatencyMs,
    wallMs: Date.now() - startedAt,
    finishedAtIso: new Date().toISOString(),
  };
  await writeFile(
    join(runDir, "run-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
  log(
    `done: ran ${queriesRun}/${selected.length} (resume-skipped ${skipped}) in ${Math.round((Date.now() - startedAt) / 1000)}s → ${payloadsPath}`,
  );

  return {
    runDir,
    payloadsPath,
    configPath,
    queriesPlanned: selected.length,
    queriesRun,
    queriesSkippedResume: skipped,
    unitsTouched: byUnit.size,
    providerName: provider.name,
    totalLatencyMs,
  };
}

async function readDoneQueryIds(payloadsPath: string): Promise<Set<string>> {
  const done = new Set<string>();
  if (!existsSync(payloadsPath)) return done;
  const text = await readFile(payloadsPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as { harness?: { queryId?: string } };
      if (row.harness?.queryId) done.add(row.harness.queryId);
    } catch {
      // Ignore torn tail lines from an interrupted run; they get re-run.
    }
  }
  return done;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): RunBeamSliceOptions {
  const opts: RunBeamSliceOptions = {
    split: "100k",
    runId: "",
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
    if (a === "--split") opts.split = take().toLowerCase();
    else if (a === "--run-id") opts.runId = take();
    else if (a === "--categories")
      opts.categories = take().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--units")
      opts.userIds = take().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--per-category-limit")
      opts.perCategoryLimit = Number.parseInt(take(), 10);
    else if (a === "--query-limit") opts.queryLimit = Number.parseInt(take(), 10);
    else if (a === "--k") opts.requestedK = Number.parseInt(take(), 10);
    else if (a === "--jobs") opts.jobs = Number.parseInt(take(), 10);
    else if (a === "--seed") opts.seed = Number.parseInt(take(), 10);
    else if (a === "--slice-dir") opts.sliceDir = resolve(take());
    else if (a === "--no-resume") opts.resume = false;
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: npx tsx scripts/run-beam-slice.ts --split 100k --run-id <id> " +
          "[--categories a,b] [--units 1,2] [--per-category-limit N] " +
          "[--query-limit N] [--k 24] [--jobs N] [--seed 42] [--slice-dir d] [--no-resume]\n",
      );
      process.exit(0);
    } else throw new Error(`Unknown arg: ${a}. Use --help.`);
  }
  if (!opts.runId) throw new Error("--run-id is required");
  return opts;
}

async function main(): Promise<void> {
  // Same env contract as the bridge: pick up the repo .env when present;
  // shell-exported vars win. In a worktree without .env this is a no-op and
  // the bridge's mock guard applies (CSM_AMB_ALLOW_MOCK=1 to opt in).
  loadLocalEnv();
  const opts = parseArgs(process.argv.slice(2));
  await runBeamSlice(opts);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(
      `run-beam-slice failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exitCode = 1;
  });
}
