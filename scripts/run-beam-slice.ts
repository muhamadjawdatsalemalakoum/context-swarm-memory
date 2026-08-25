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
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  CsmBaseline,
  resolveRouterHybrid,
  resolveShardDescriptors,
} from "../src/eval/baselines/csm.js";
import {
  BEAM_LOSING_CATEGORIES,
  loadBeamDocuments,
  loadBeamRetrievalQueries,
  selectBeamQueries,
  type BeamRetrievalQuery,
} from "../src/eval/corpus/beam.js";
import { execSync } from "node:child_process";

import { envFlag, envPositiveInt } from "../src/utils/env.js";
import { loadLocalEnv } from "../src/utils/loadEnv.js";
import { resolveProviderModel } from "../src/providers/LlmProvider.js";
import {
  buildCorpus,
  createBridgeProvider,
  DEFAULT_BRIDGE_MAX_OUTPUT_TOKENS,
  DEFAULT_BRIDGE_MODEL_CONTEXT,
  executeAmbRetrieve,
  resolveBridgeModel,
  resolveLeanReturn,
  scopeDocuments,
  type AmbBridgeOptions,
  type AmbDocument,
} from "./amb-csm-retrieve.js";
import {
  loadOrBuildPreferenceProfile,
  preferenceProfileActive,
} from "./amb-preference-profile.js";
import {
  factFoldActive,
  loadOrBuildFactRegistry,
} from "./amb-fact-registry.js";
import {
  resolveProbeBatch,
  resolveProbeLocalKeep,
  resolveProbeShrink,
} from "../src/core/ask.js";

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
  // OpenRouter dev path (2026-08-23): base URL + model make an arm run through
  // the OpenAI-compatible endpoint distinguishable in its manifest — an arm
  // whose provider config is invisible is the F7/F11 failure again.
  "CSM_OPENAI_BASE_URL",
  "CSM_OPENAI_MODEL",
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
  // Arm-defining levers. Absent from the echo until 2026-07-31, which is why
  // reading an old manifest could not distinguish "flag was off" from "flag was
  // never recorded" — see docs/experiments/EXP-system-audit-2026-07.md.
  "CSM_AGENT_MODEL",
  "CSM_ROUTER_HYBRID",
  "CSM_SHARD_DESCRIPTORS",
  "CSM_SIGNALS_RANKER",
  "CSM_PROBE_FULL_SCAN",
  "CSM_COVERAGE",
  "CSM_RETRIEVAL_UNITS",
  "CSM_VIRTUAL_SHARDS",
  "CSM_RECALL_BUDGET",
  "CSM_MAX_PROBE_SHARDS",
  "CSM_MAX_RECALL_SHARDS",
  "CSM_AMB_ID_REPAIR",
  "CSM_AMB_LEAN_K",
  "CSM_AMB_LEAN_EXCERPT_CHARS",
  "CSM_AMB_LEAN_PROFILE_DEDUPE",
  "CSM_PROBE_SHRINK",
  "CSM_PROBE_BATCH",
  "CSM_PROBE_LOCAL_KEEP",
  "CSM_PROBE_INDEX_CHARS",
  "CSM_AMB_LEGACY_VOCAB",
  "CSM_AMB_PREFERENCE_PROFILE",
  "CSM_AMB_OBSERVE_MEMORY",
  "CSM_AMB_FACT_MEMORY",
  "CSM_AMB_SYNTH_MEMORY",
  "CSM_AMB_COVERAGE_RERANK",
  "CSM_AMB_ORDERED_CAPSULE",
  "CSM_AMB_SESSION_DIGESTS",
  "CSM_AMB_FACT_FOLD",
  "CSM_AMB_FACT_CHUNK_TOKENS",
  "CSM_AMB_FACT_SINGLE_PASS_TOKENS",
  "CSM_AMB_FACT_CHUNK_OUTPUT",
  "CSM_AMB_FACT_MAX_OUTPUT",
  "CSM_AMB_FACT_MAP_CONCURRENCY",
  "CSM_AMB_LEGACY_INTENT",
  "CSM_HYBRID_RERANK",
  "CSM_EMBED_ALWAYS_K",
  "CSM_EMBED_ALWAYS_MIN_COS",
  "CSM_EMBED_ALWAYS_BEATS_BEST",
  "CSM_AMB_SPLIT",
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
    model: resolveBridgeModel(),
    modelContext: envPositiveInt(process.env.CSM_AMB_MODEL_CONTEXT, {
      name: "CSM_AMB_MODEL_CONTEXT",
      fallback: DEFAULT_BRIDGE_MODEL_CONTEXT,
    }),
    maxOutputTokens: envPositiveInt(process.env.CSM_AMB_MAX_OUTPUT_TOKENS, {
      name: "CSM_AMB_MAX_OUTPUT_TOKENS",
      fallback: DEFAULT_BRIDGE_MAX_OUTPUT_TOKENS,
    }),
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
  /** Text of CSM's synthesised (`csm-*`) documents, which no corpus can supply.
   *  Written alongside payloads.jsonl; consumed by scripts/answer-arms.ts. */
  const synthDocsPath = join(runDir, "synthesized-docs.jsonl");
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
  // RESOLVED lever values, not just the raw env.
  //
  // `envEcho` records only variables that were SET, so "absent" used to be
  // readable as "off". The 2026-08-01 default flips break that reading:
  // absent now means ON for the router, descriptors, probe batching and the
  // lean transform. Recording what actually APPLIED keeps every manifest
  // self-describing across default changes — the F7/F11 failure was exactly
  // an invisible config difference, and a silently inverted default would
  // reproduce it in the opposite direction.
  const resolvedLevers = {
    routerHybrid: resolveRouterHybrid(),
    shardDescriptors: resolveShardDescriptors(),
    probeBatch: resolveProbeBatch(provider.name),
    probeShrink: resolveProbeShrink(),
    probeLocalKeep: resolveProbeLocalKeep(),
    preferenceProfile: preferenceProfileActive(),
    // Added 2026-08-25 (pre-flight audit): factFold defaulted ON that day and
    // idRepair has defaulted ON since F12 -- an unset var in a manifest must
    // never be ambiguous across a default flip.
    factFold: factFoldActive(),
    idRepair: envFlag(process.env.CSM_AMB_ID_REPAIR, { name: "CSM_AMB_ID_REPAIR", fallback: true }),
    leanReturn: resolveLeanReturn(),
  };
  // Provenance (audit P4/F7): the F11 false conclusion happened because a
  // config delta was invisible in the manifests. Echo the code version and a
  // content hash of exactly the documents/queries this run consumed, so any
  // two runs can be diffed for same-config-ness without trusting memory.
  let gitSha: string | null = null;
  try {
    gitSha = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    // Not fatal: a run outside a git checkout still gets content hashes.
  }
  const docsHash = createHash("sha256");
  for (const d of documents) docsHash.update(`${d.id}\u0000${d.content}\u0000`);
  const queriesHash = createHash("sha256");
  // questionSha256, never the question text: this runner is gold-blind by
  // contract (beamLeakageFirewall) and the digest is already the canonical
  // per-question identity the bridge telemetry uses.
  for (const q of selected) queriesHash.update(`${q.id}\u0000${q.questionSha256}\u0000`);
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
        resolvedLevers,
        gitSha,
        documentsSha256: docsHash.digest("hex"),
        documentCount: documents.length,
        selectedQueriesSha256: queriesHash.digest("hex"),
        selectedQueryCount: selected.length,
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
  /**
   * Model for WRITE-TIME extractors.
   *
   * `bridgeOpts.model` is CSM_AMB_MODEL — a model id for the RETRIEVAL stages,
   * defaulting to `gemini-3.5-flash`. Write-time extractors call
   * `provider.completeText` directly, so handing them that id sends a Gemini
   * model name to whatever provider is actually active.
   *
   * `resolveProviderModel` is the single source of truth for provider-scoped
   * model resolution (src/providers/LlmProvider.ts). Undefined means "this
   * provider has no configured model", which correctly lets the provider apply
   * its own default instead of borrowing another provider's id.
   */
  const writeTimeModel = resolveProviderModel(provider.name);

  const prefEnabled = preferenceProfileActive();
  const prefProfiles = new Map<string, Promise<string | undefined>>();
  const getPreferenceProfile = (
    userId: string,
    corpus: ReturnType<typeof buildCorpus>,
  ): Promise<string | undefined> => {
    if (!prefEnabled) return Promise.resolve(undefined);
    const hit = prefProfiles.get(userId);
    if (hit) return hit;
    // Disk cache + build are the SHARED helper in
    // scripts/amb-preference-profile.ts (also used by the warm AMB server), so
    // slice-harness and server runs hit the same cache entries. Key:
    // split | unit | write-time model | prompt version.
    const built: Promise<string | undefined> = loadOrBuildPreferenceProfile({
      baseline,
      eventContents: corpus.events.map((e) => e.content),
      split: opts.split,
      userId,
      model: writeTimeModel,
      onProgress: (msg) => process.stdout.write(`    [pref] unit ${userId} ${msg}
`),
    })
      .then((r) => {
        process.stdout.write(
          r.fromCache
            ? `    [pref] unit ${userId} profile from cache
`
            : `    [pref] unit ${userId} profile ready (${r.outputTokens} out-tok, ${r.chunks} chunk(s))
`,
        );
        return r.text as string | undefined;
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
  const factEnabled = factFoldActive();
  const factRegistries = new Map<string, Promise<string | undefined>>();
  const getFactRegistry = (
    userId: string,
    corpus: ReturnType<typeof buildCorpus>,
  ): Promise<string | undefined> => {
    if (!factEnabled) return Promise.resolve(undefined);
    const hit = factRegistries.get(userId);
    if (hit) return hit;
    const built: Promise<string | undefined> = loadOrBuildFactRegistry({
      baseline,
      eventContents: corpus.events.map((e) => e.content),
      split: opts.split,
      userId,
      model: writeTimeModel,
      onProgress: (msg) => process.stdout.write(`    [fact] unit ${userId} ${msg}` + String.fromCharCode(10)),
    })
      .then((r) => {
        process.stdout.write(
          (r.fromCache
            ? `    [fact] unit ${userId} registry from cache`
            : `    [fact] unit ${userId} registry ready (${r.outputTokens} out-tok, ${r.chunks} chunk(s))`) + String.fromCharCode(10),
        );
        return r.text as string | undefined;
      })
      .catch((err) => {
        process.stdout.write(`    [fact] unit ${userId} FAILED: ${String(err).slice(0, 120)}` + String.fromCharCode(10));
        return undefined;
      });
    factRegistries.set(userId, built);
    return built;
  };

    const runOne = async (task: SliceTask): Promise<void> => {
      const q = task.query;
      const corpus = getCorpus(task.userId);
      const t0 = Date.now();
      const preferenceProfile = await getPreferenceProfile(q.userId, corpus);
      const factRegistry = await getFactRegistry(q.userId, corpus);
      const payload = await executeAmbRetrieve({
        baseline,
        providerName: provider.name,
        corpus,
        request: { query: q.question, k: requestedK, user_id: q.userId },
        opts: bridgeOpts,
        preferenceProfile,
        factRegistry,
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
      // Persist EXACTLY what cannot be reconstructed.
      //
      // A payload row stores ids, not text, because a real event's text is
      // recoverable from the corpus by id. CSM's SYNTHESISED documents — the
      // evidence capsule, the organized memory, the preference profile — have
      // ids (`csm-*`) that exist in no corpus, so their text was recoverable
      // from nowhere and was simply lost.
      //
      // The consequence was silent and total: `scripts/answer-arms.ts` renders
      // a document by looking its id up in the corpus and falls back to the
      // string `(id <x> unavailable)`. MEASURED over every arm on disk, 414
      // synthesised documents were rendered as that placeholder — 3.4%-9.5% of
      // each arm's answer-visible characters, and 100% of any lever that lives
      // inside the capsule. It also manufactured the "fold, never append"
      // result: arm G burned 1.35 unrenderable slots per query against arm H's
      // 1.00, so arm H simply carried ~0.35 more real evidence documents.
      //
      // See docs/experiments/EXP-capsule-render-gap.md.
      const synth = payload.documents.filter((d) => d.id.startsWith("csm-"));
      appendChain = appendChain.then(async () => {
        if (synth.length > 0) {
          await appendFile(
            synthDocsPath,
            synth
              .map((d) => `${JSON.stringify({ queryId: q.id, id: d.id, content: d.content })}\n`)
              .join(""),
            "utf8",
          );
        }
        await appendFile(payloadsPath, `${JSON.stringify(row)}\n`, "utf8");
      });
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
