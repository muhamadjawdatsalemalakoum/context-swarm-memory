import type { LlmProvider, StageModels } from "../providers/LlmProvider.js";
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
import { probeShard } from "./probe.js";
import { recallShard } from "./recall.js";
import { synthesizeMemoryPacket, packetFromSingleRecall, emptyPacket } from "./synthesize.js";
import { DEFAULT_RECALL_BUDGET } from "./tokenBudget.js";
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

  const stageModels = resolveStageModels(opts.models);
  const runId = newRunId();
  const startedAt = nowIso();
  const t0 = Date.now();

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
  const candidates: CandidateScore[] = selectCandidates({
    query,
    directory,
    maxCandidates: budget.maxCandidateShards,
  });

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
    });
  }

  const probedCandidates = candidates.slice(0, budget.maxProbeShards);
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

  const probeOutputs = await runJobs(probeJobs, parallelProbes);

  const probes: ProbeResult[] = [];
  for (const o of probeOutputs) {
    if (!o) continue;
    accumulate(o.usage);
    probes.push(o.result);
  }

  // Recall trigger:
  // - Honor probe's `needs_full_recall` when set, OR
  // - Force recall if probe says it knows with high confidence and useful answer value.
  //   (Models like Gemma 4 sometimes say `knows=true` but `needs_full_recall=false`
  //    out of conservatism; we don't want to silently drop a known-relevant shard.)
  let recallTargets = probes
    .filter((p) => {
      if (!p.knows) return false;
      if (p.estimatedAnswerValue === "none") return false;
      const explicit = p.needsFullRecall && p.confidence >= recallConfidenceMin;
      const inferred =
        p.confidence >= 0.7 &&
        (p.estimatedAnswerValue === "high" || p.estimatedAnswerValue === "medium") &&
        (p.memoryType === "direct" || p.memoryType === "adjacent" || p.memoryType === "conflicting");
      return explicit || inferred;
    })
    .sort((a, b) => scoreProbe(b) - scoreProbe(a))
    .slice(0, budget.maxRecallShards);

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
        budget.maxRecallShards,
      );
    }
  }

  const recallSnapshots = await Promise.all(
    recallTargets.map((p) => storage.loadSnapshot(p.shardId, p.snapshotId)),
  );

  const recallJobs = recallTargets.map((p, ix) => () => {
    const snap = recallSnapshots[ix];
    if (!snap) return Promise.resolve(null);
    return recallShard({
      provider,
      userQuery: query,
      snapshot: snap,
      relevantEventIdsHint: p.relevantEventIds,
      maxRecallTokensPerShard: budget.maxRecallTokensPerShard,
      model: stageModels.recall,
    }).then(({ result, usage }) => ({ result, usage }));
  });

  const recallOutputs = await runJobs(recallJobs, parallelProbes);

  const recalls: RecallResult[] = [];
  for (const o of recallOutputs) {
    if (!o) continue;
    accumulate(o.usage);
    recalls.push(o.result);
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
