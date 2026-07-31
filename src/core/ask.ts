import type { LlmProvider, ProviderUsage, StageModels } from "../providers/LlmProvider.js";
import { resolveStageModels } from "../providers/LlmProvider.js";
import type { StorageReader } from "../storage/jsonlStorage.js";
import type {
  AskRunCost,
  AskRunResult,
  CandidateScore,
  ProbeResult,
  QueryRunRecord,
  RecallResult,
} from "./types.js";
import { selectCandidates } from "./router.js";
import { selectCandidatesHybrid, type RouterIndex } from "./routerEmbed.js";
import { probeShard } from "./probe.js";
import { recallShard } from "./recall.js";
import { resolveSignalsRanker } from "./digestSelection.js";
import { synthesizeMemoryPacket, packetFromSingleRecall, emptyPacket } from "./synthesize.js";
import {
  attachCoverage,
  classifyQueryIntent,
  resolveCoverageMode,
  resolveCoverageRecallTokens,
} from "./coverage.js";
import type { MemoryShardSnapshot } from "./types.js";
import {
  DEFAULT_RECALL_BUDGET,
  resolveRecallBudget,
  resolveShardCount,
} from "./tokenBudget.js";
import { select } from "./selection.js";
import { envFlag } from "../utils/env.js";
import { newRunId } from "../utils/ids.js";
import { nowIso } from "../utils/time.js";

export interface AskOptions {
  provider: LlmProvider;
  /** Read-only storage interface. `JsonlStorage` satisfies this; the CSM
   *  benchmark baseline uses an in-memory adapter that synthesises shards
   *  from a pre-built `Corpus`. */
  storage: StorageReader;
  query: string;
  budget?: typeof DEFAULT_RECALL_BUDGET;
  recallConfidenceMin?: number;
  /** Per-pipeline-stage model overrides. Falls back through env. */
  models?: StageModels;
  /** When false (default), append a query-run record. Tests may set this to true. */
  skipQueryLog?: boolean;
  /** Run probes in parallel via Promise.all. Default true. With local Ollama,
   *  the server effectively serializes; with hosted models or two loaded models
   *  this gives real parallelism. Disable for deterministic cost ordering in tests. */
  parallelProbes?: boolean;
  /** Pre-built hybrid router index (content-derived descriptors +
   *  local-embedding centroids). When absent/null, candidate selection is
   *  byte-identical to Phase 0. */
  routerIndex?: RouterIndex | null;
}

/** ask — the full read-only query path.
 *  Routes → probes → recalls (only when probe says needs_full_recall) → synthesizes →
 *  logs a query-run record. NEVER touches snapshots, manifests, directory, or chronicle.
 *
 *  Efficiency baked in:
 *  - Skip the entire pipeline when no candidates score positively.
 *  - Parallel probes by default.
 *  - Recall context is scoped to probe-identified events when present.
 *  - Skip the synthesizer LLM call when 0 or 1 recalls returned (free win:
 *    that's the most expensive call in the pipeline).
 */
export async function ask(opts: AskOptions): Promise<AskRunResult> {
  const {
    provider,
    storage,
    query,
    budget = DEFAULT_RECALL_BUDGET,
    recallConfidenceMin = 0.45,
    skipQueryLog = false,
    parallelProbes = true,
  } = opts;

  const stageModels = resolveStageModels(opts.models, process.env, provider.name);
  const runId = newRunId();
  const startedAt = nowIso();
  const t0 = Date.now();

  // T1 coverage mode (CSM_COVERAGE, default OFF — when unset, coverageIntent
  // is null, recallTokensPerShard equals the budget default, and every LLM
  // input below is byte-identical to the pre-coverage pipeline). Coverage-
  // shaped queries (summaries / event ordering / temporal arithmetic /
  // aggregation) get a bigger recall event digest, and after synthesis the
  // deterministic chronicle assembler attaches a date-ordered, fully-cited
  // timeline to the packet (zero extra LLM calls, zero extra storage loads).
  const coverageIntent = resolveCoverageMode() ? classifyQueryIntent(query) : null;
  const baseRecallTokens = coverageIntent
    ? resolveCoverageRecallTokens(coverageIntent, budget.maxRecallTokensPerShard)
    : budget.maxRecallTokensPerShard;
  // Optional CSM_RECALL_BUDGET override (default OFF → baseRecallTokens unchanged).
  // Lets the token-cut A/B run a smaller recall budget (e.g. 600) under Signals.
  const recallTokensPerShard = resolveRecallBudget(baseRecallTokens);

  // Shard-COUNT overrides. Fixed counts assume a fixed shard size; when shard
  // size changes (CSM_VIRTUAL_SHARDS) these must move inversely or the harvest
  // starves. Both default to the frozen values, so unset is byte-identical.
  const maxProbeShards = resolveShardCount(
    "CSM_MAX_PROBE_SHARDS",
    budget.maxProbeShards,
  );
  const maxRecallShards = resolveShardCount(
    "CSM_MAX_RECALL_SHARDS",
    budget.maxRecallShards,
  );

  // Signals digest ranker (CSM_SIGNALS_RANKER, default OFF — when unset, every
  // recall digest below is byte-identical to the blind builder). When ON, recall
  // reorders events by query salience and uses salient intra-event truncation so
  // answer-bearing evidence that blind head-truncation would drop survives.
  const useSignalsRanker = resolveSignalsRanker();

  const cost: AskRunCost = {
    inputTokensEstimate: 0,
    outputTokensEstimate: 0,
    estimatedUsd: 0,
    latencyMs: 0,
  };

  const accumulate = (u: { inputTokensEstimate: number; outputTokensEstimate: number; estimatedUsd: number }) => {
    cost.inputTokensEstimate += u.inputTokensEstimate;
    cost.outputTokensEstimate += u.outputTokensEstimate;
    cost.estimatedUsd += u.estimatedUsd;
  };

  const directory = await storage.loadDirectory();
  // Hybrid when an index is supplied, byte-identical Phase-0 path otherwise
  // (docs/experiments/EXP-T2-router.md §5).
  const candidates: CandidateScore[] = opts.routerIndex
    ? await selectCandidatesHybrid({
        query, directory, index: opts.routerIndex,
        maxCandidates: Math.max(maxProbeShards, budget.maxCandidateShards) })
    : selectCandidates({ query, directory, maxCandidates: Math.max(maxProbeShards, budget.maxCandidateShards) });

  // Short-circuit: nothing to ask.
  if (candidates.length === 0) {
    return await finalize({
      query,
      runId,
      startedAt,
      finishedAtFn: nowIso,
      latencyStart: t0,
      candidates,
      probes: [],
      recalls: [],
      packet: emptyPacket(query),
      cost,
      provider,
      storage,
      skipQueryLog,
      recallTokensPerShard,
      coverageEscalated: coverageIntent !== null,
    });
  }

  const probedCandidates = candidates.slice(0, maxProbeShards);
  const snapshotsByCandidate = await Promise.all(
    probedCandidates.map((c) => storage.loadSnapshot(c.entry.id, c.entry.snapshotId)),
  );

  // Thunks (not promises): the work starts only when runJobs calls each one, so
  // serial mode genuinely runs one probe at a time. (Previously `.map()` created
  // all promises eagerly, so `runSerially` awaited already-running work — a no-op.)
  const probeJobs = probedCandidates.map((cand, ix) => () => {
    const snap = snapshotsByCandidate[ix];
    if (!snap) return Promise.resolve(null);
    return probeShard({ provider, userQuery: query, snapshot: snap, model: stageModels.probe }).then(
      ({ result, usage }) => ({ result, usage }),
    );
  });

  // Eager recalls (parallel mode only). Two tiers:
  //
  // 1. The router's top candidate is ALWAYS recalled (router-trust safety net
  //    below), and its recall input depends only on its OWN probe's
  //    relevant_event_ids hint — so that recall launches the moment probe #0
  //    resolves instead of waiting for the whole probe barrier. Schedule-only;
  //    always on. (Verified token-identical serial vs parallel.)
  //
  // 2. With CSM_EAGER_RECALLS=1, any other shard whose probe qualifies for
  //    recall (same predicate as the selection below) also starts eagerly,
  //    capped at maxRecallShards-1 starts. After all probes resolve, the TRUE
  //    score-ordered selection is computed exactly as before; eager calls for
  //    shards that did not make the selection are awaited, their token usage
  //    accumulated honestly, and their results DISCARDED — so every downstream
  //    LLM input is identical to the non-eager path. The only cost is the
  //    occasional discarded call, surfaced as `discardedRecalls`.
  type RecallOutput = { result: RecallResult; usage: ProviderUsage } | null;
  interface EagerEntry {
    promise: Promise<RecallOutput>;
    error: unknown;
  }
  const eagerRecalls = new Map<string, EagerEntry>();
  const eagerEnabled = resolveEagerRecalls();
  // Count of ACTUAL tier-2 recall starts. Handlers run on the single JS
  // thread, so increment-then-check is race-free. (The map itself registers
  // every probed candidate up front for reconciliation lookup — map size is
  // NOT the started count.)
  let eagerStartedOthers = 0;
  let probeOutputs: Array<{ result: ProbeResult; usage: ProviderUsage } | null>;

  if (parallelProbes && maxRecallShards > 0) {
    const probePromises = probeJobs.map((job) => job());
    probePromises.forEach((probePromise, ix) => {
      const cand = probedCandidates[ix];
      const snap = snapshotsByCandidate[ix];
      if (!cand || !snap) return;
      const isTop = ix === 0;
      if (!isTop && !eagerEnabled) return;

      const entry: EagerEntry = { promise: Promise.resolve(null), error: null };
      entry.promise = probePromise
        .then((o): Promise<RecallOutput> | RecallOutput => {
          if (!o) return null;
          // Top-1 starts unconditionally (it is always selected). Others
          // start only if they pass the same predicate the selection uses,
          // and only while eager slots remain (top-1 has a reserved slot, so
          // others get maxRecallShards-1).
          if (!isTop) {
            if (!probeQualifiesForRecall(o.result, recallConfidenceMin)) return null;
            if (eagerStartedOthers >= maxRecallShards - 1) return null;
            eagerStartedOthers++;
          }
          return recallShard({
            provider,
            userQuery: query,
            snapshot: snap,
            relevantEventIdsHint: o.result.relevantEventIds,
            maxRecallTokensPerShard: recallTokensPerShard,
            model: stageModels.recall,
            useSignalsRanker,
          }).then(({ result, usage }) => ({ result, usage }));
        })
        // Capture instead of rejecting NOW: a rejection with no handler
        // attached in the same tick would crash as unhandledRejection while
        // the probe barrier is still settling. The error is rethrown when the
        // entry is consumed as a selected recall (preserving old failure
        // semantics) and swallowed when the entry is discarded (the old path
        // would never have made that call).
        .catch((err): RecallOutput => {
          entry.error = err;
          return null;
        });
      eagerRecalls.set(cand.entry.id, entry);
    });
    probeOutputs = await Promise.all(probePromises);
  } else if (parallelProbes) {
    probeOutputs = await runJobs(probeJobs, true);
  } else {
    probeOutputs = await runJobs(probeJobs, false);
  }

  const probes: ProbeResult[] = [];
  for (const o of probeOutputs) {
    if (!o) continue;
    accumulate(o.usage);
    probes.push(o.result);
  }

  // Recall selection is a score → sort → cut, i.e. the exact shape that produced
  // the router query-independence bug (see src/core/selection.ts). It is if
  // anything MORE tie-prone: `scoreProbe` maps two small enums (confidence ×
  // estimatedAnswerValue) onto a handful of discrete values, so several probes
  // routinely share a score and the cut lands inside a tie run.
  //
  // Tiebreak is deliberately "stable", NOT the module default "key-asc":
  // `probes` is in router-candidate order, so insertion order here CARRIES
  // SIGNAL (router rank). Sorting ties by shardId would replace a meaningful
  // order with an alphabetical one — the very failure being guarded against.
  // The win from routing through `select` is that the tie policy is now stated
  // and tested rather than inherited from sort stability, and that degeneracy
  // is reported instead of silent.
  const recallSelection = select(
    probes.filter((p) => probeQualifiesForRecall(p, recallConfidenceMin)),
    {
      score: scoreProbe,
      key: (p) => p.shardId,
      limit: maxRecallShards,
      tieBreak: "stable",
    },
  );
  let recallTargets = [...recallSelection.selected];

  // Router-trust safety net: ALWAYS recall the router's top-1 candidate, even
  // if its probe was rejected.
  //
  // Why: the 8B probe model is a false-negative bottleneck. On q11 ("Which
  // integration partner from the dental-SaaS vertical signed the first LOI?")
  // the router correctly picked `s-customers` as the #1 candidate, but the e4b
  // probe said `knows: false` because the small model couldn't bridge query
  // terms like "dental-SaaS" to the shard's actual ChairSync events. With
  // probe-only gating, the pipeline returned 0 packed events and the answering
  // model had to guess.
  //
  // The router has access to the full directory and tag union; its top-1
  // signal is more reliable than a single 8B probe call against a truncated
  // event index. Forcing a recall on the router's top candidate gives the
  // stronger 31B recall LLM the final say on whether the shard has the answer.
  // Cost: +1 31B recall call (~30s) only when the probe was a false negative.
  // Benefit: CSM never returns empty context when the router did its job.
  const topRouterShardId = candidates[0]?.entry.id;
  if (
    topRouterShardId &&
    !recallTargets.some((p) => p.shardId === topRouterShardId)
  ) {
    const topProbe = probes.find((p) => p.shardId === topRouterShardId);
    if (topProbe) {
      // Prepend so the router's top is recalled first; trim from the end if
      // we exceeded the recall budget.
      recallTargets = [topProbe, ...recallTargets].slice(
        0,
        maxRecallShards,
      );
    }
  }

  const recallSnapshots = await Promise.all(
    recallTargets.map((p) => storage.loadSnapshot(p.shardId, p.snapshotId)),
  );

  const recallJobs = recallTargets.map((p, ix) => () => {
    // Reuse an eager in-flight recall when one exists for this shard. An
    // eager entry can have resolved null without making a call (probe failed
    // the predicate / no output) — e.g. the forced top-1 whose probe was
    // rejected. Fall through to a fresh call in that case ONLY when the
    // entry made no call; a null from a captured error must rethrow instead.
    const eager = eagerRecalls.get(p.shardId);
    if (eager) {
      return eager.promise.then((o) => {
        if (eager.error) throw eager.error;
        if (o) return o;
        const snap = recallSnapshots[ix];
        if (!snap) return null;
        return recallShard({
          provider,
          userQuery: query,
          snapshot: snap,
          relevantEventIdsHint: p.relevantEventIds,
          maxRecallTokensPerShard: recallTokensPerShard,
          model: stageModels.recall,
          useSignalsRanker,
        }).then(({ result, usage }) => ({ result, usage }));
      });
    }
    const snap = recallSnapshots[ix];
    if (!snap) return Promise.resolve(null);
    return recallShard({
      provider,
      userQuery: query,
      snapshot: snap,
      relevantEventIdsHint: p.relevantEventIds,
      maxRecallTokensPerShard: recallTokensPerShard,
      model: stageModels.recall,
      useSignalsRanker,
    }).then(({ result, usage }) => ({ result, usage }));
  });

  const recallOutputs = await runJobs(recallJobs, parallelProbes);

  const recalls: RecallResult[] = [];
  for (const o of recallOutputs) {
    if (!o) continue;
    accumulate(o.usage);
    recalls.push(o.result);
  }

  // Discard pass: eager recalls for shards the score-ordered selection did
  // NOT pick are awaited (usually already settled — they started earlier than
  // the barrier calls), their spend accumulated honestly, their results
  // dropped. Errors here are swallowed: the non-eager path would never have
  // made the call at all.
  let discardedRecalls = 0;
  if (eagerRecalls.size > 0) {
    const selected = new Set(recallTargets.map((p) => p.shardId));
    for (const [shardId, entry] of eagerRecalls) {
      if (selected.has(shardId)) continue;
      const o = await entry.promise;
      if (o) {
        accumulate(o.usage);
        discardedRecalls++;
      }
    }
  }

  // Skip the LLM synthesizer call when ≤1 recall: deterministic packet, zero tokens.
  let packet;
  if (recalls.length === 0) {
    packet = emptyPacket(query);
  } else if (recalls.length === 1) {
    packet = packetFromSingleRecall(query, recalls[0]!);
  } else {
    const synth = await synthesizeMemoryPacket({
      provider,
      userQuery: query,
      recalls,
      model: stageModels.synth,
    });
    accumulate(synth.usage);
    packet = synth.packet;
  }

  // T1 coverage attach (no-op when CSM_COVERAGE is off). Deterministic and
  // read-only: reuses the snapshots already loaded for probing (zero extra
  // storage reads), adds zero LLM calls, and returns a new packet with a
  // date-ordered cited timeline (plus, for temporal-arithmetic queries, a
  // deterministic date-difference claim). Fires on coverage-shaped intents
  // and as a starvation net for under-cited point queries.
  if (coverageIntent) {
    packet = attachCoverage({
      query,
      intent: coverageIntent,
      packet,
      snapshots: snapshotsByCandidate.filter(
        (s): s is MemoryShardSnapshot => Boolean(s),
      ),
      probeFootholdEventIds: probes.flatMap((p) => p.relevantEventIds),
    });
  }

  return await finalize({
    query,
    runId,
    startedAt,
    finishedAtFn: nowIso,
    latencyStart: t0,
    candidates,
    probes,
    recalls,
    packet,
    cost,
    provider,
    storage,
    skipQueryLog,
    discardedRecalls,
    recallTokensPerShard,
    coverageEscalated: coverageIntent !== null,
  });
}

async function finalize(args: {
  query: string;
  runId: string;
  startedAt: string;
  finishedAtFn: () => string;
  latencyStart: number;
  candidates: CandidateScore[];
  probes: ProbeResult[];
  recalls: RecallResult[];
  packet: AskRunResult["memoryPacket"];
  cost: AskRunCost;
  provider: LlmProvider;
  storage: StorageReader;
  skipQueryLog: boolean;
  discardedRecalls?: number;
  recallTokensPerShard: number;
  coverageEscalated: boolean;
}): Promise<AskRunResult> {
  args.cost.latencyMs = Date.now() - args.latencyStart;
  const finishedAt = args.finishedAtFn();
  const result: AskRunResult = {
    query: args.query,
    candidates: args.candidates,
    probes: args.probes,
    recalls: args.recalls,
    memoryPacket: args.packet,
    cost: args.cost,
    mutated: false,
    runId: args.runId,
    startedAt: args.startedAt,
    finishedAt,
    discardedRecalls: args.discardedRecalls ?? 0,
    recallTokensPerShard: args.recallTokensPerShard,
    coverageEscalated: args.coverageEscalated,
  };
  if (!args.skipQueryLog && args.storage.appendQueryRun) {
    const record: QueryRunRecord = {
      runId: args.runId,
      query: args.query,
      startedAt: args.startedAt,
      finishedAt,
      candidateIds: args.candidates.map((c) => c.entry.id),
      probedIds: args.probes.map((p) => p.shardId),
      recalledIds: args.recalls.map((r) => r.shardId),
      packetSummary: args.packet.summary,
      cost: args.cost,
      mutated: false,
      providerName: args.provider.name,
    };
    await args.storage.appendQueryRun(record);
  }
  return result;
}

/** Run an array of job thunks either in parallel (Promise.all) or strictly
 *  serially. In serial mode each thunk is invoked only after the previous one
 *  resolves, so the work truly runs one-at-a-time. Callers MUST pass thunks
 *  (`() => Promise<T>`), not already-started promises, for serialization to hold.
 *  Exported for tests (concurrency regression for the parallelProbes flag). */
export async function runJobs<T>(jobs: Array<() => Promise<T>>, parallel: boolean): Promise<T[]> {
  if (parallel) return Promise.all(jobs.map((job) => job()));
  const out: T[] = [];
  for (const job of jobs) out.push(await job());
  return out;
}

/** Recall trigger:
 *  - Honor probe's `needs_full_recall` when set, OR
 *  - Force recall if the probe says it knows with high confidence and useful
 *    answer value. (Models sometimes say `knows=true` but
 *    `needs_full_recall=false` out of conservatism; we don't want to silently
 *    drop a known-relevant shard.)
 *  Shared by the post-barrier selection AND the eager tier-2 starts so the
 *  two can never disagree. */
export function probeQualifiesForRecall(
  p: ProbeResult,
  recallConfidenceMin: number,
): boolean {
  if (!p.knows) return false;
  if (p.estimatedAnswerValue === "none") return false;
  const explicit = p.needsFullRecall && p.confidence >= recallConfidenceMin;
  const inferred =
    p.confidence >= 0.7 &&
    (p.estimatedAnswerValue === "high" || p.estimatedAnswerValue === "medium") &&
    (p.memoryType === "direct" || p.memoryType === "adjacent" || p.memoryType === "conflicting");
  return explicit || inferred;
}

/** Tier-2 eager recalls are opt-in until the discard-rate is measured at the
 *  30-query scale (the tier-1 top-1 speculation is always on — it is provably
 *  schedule-only). */
export function resolveEagerRecalls(raw = process.env.CSM_EAGER_RECALLS): boolean {
  return envFlag(raw, { name: "CSM_EAGER_RECALLS", fallback: false });
}

function scoreProbe(p: ProbeResult): number {
  const valueWeight =
    p.estimatedAnswerValue === "high"
      ? 1.0
      : p.estimatedAnswerValue === "medium"
        ? 0.6
        : p.estimatedAnswerValue === "low"
          ? 0.3
          : 0.0;
  const typeWeight =
    p.memoryType === "direct"
      ? 1.0
      : p.memoryType === "adjacent"
        ? 0.6
        : p.memoryType === "conflicting"
          ? 0.5
          : p.memoryType === "vague"
            ? 0.2
            : 0.0;
  return p.confidence * 0.6 + valueWeight * 0.25 + typeWeight * 0.15;
}
