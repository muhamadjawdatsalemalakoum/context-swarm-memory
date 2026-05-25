#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import { ask } from "../core/ask.js";
import { applyCommitDecision, appendEventAndSnapshot, createShard, dryRunCommit } from "../core/commit.js";
import { SHARD_SYSTEM_PROMPT } from "../core/prompts.js";
import { recommendForFullness, shardHealthReport } from "../core/split.js";
import { CsmBaseline } from "../eval/baselines/csm.js";
import { HippoRagBaseline } from "../eval/baselines/hippoRag.js";
import { HybridRagBaseline } from "../eval/baselines/hybridRag.js";
import { LightRagBaseline } from "../eval/baselines/lightRag.js";
import { LongContextBaseline } from "../eval/baselines/longContext.js";
import { Mem0Baseline } from "../eval/baselines/mem0.js";
import type { BaselineRunner } from "../eval/baselines/types.js";
import { VanillaRagBaseline } from "../eval/baselines/vanillaRag.js";
import { CORPUS_SIZE_SWEEP, EARLY_STOP_ACCURACY, MODEL_CONTEXT_SWEEP } from "../eval/corpus.js";
import { generateAllGraphs, type ResultDataset, type ResultRow } from "../eval/plotter.js";
import { runEval } from "../eval/runEval.js";
import { replayResults, runBenchmark } from "../eval/runner.js";
import { GEMINI_DEFAULT_MODEL, createProvider, resolveStageModels, selectProviderName } from "../providers/index.js";
import { JsonlStorage } from "../storage/jsonlStorage.js";
import { newShardId } from "../utils/ids.js";
import { stableStringify } from "../utils/json.js";
import type { CommitDecision } from "../core/types.js";
import { type ParsedArgs, flagBool, flagString, parseArgs } from "./args.js";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printHelp();
    return 0;
  }

  const cmd = argv[0]!;
  const rest = argv.slice(1);

  try {
    switch (cmd) {
      case "init":
        return await cmdInit(rest);
      case "shard":
        return await cmdShard(rest);
      case "remember":
        return await cmdRemember(rest);
      case "ask":
        return await cmdAsk(rest);
      case "inspect":
        return await cmdInspect(rest);
      case "eval":
        return await cmdEval(rest);
      case "split":
        return await cmdSplit(rest);
      case "commit":
        return await cmdCommit(rest);
      case "provider":
        return await cmdProvider(rest);
      case "bench":
        return await cmdBench(rest);
      case "version":
      case "--version":
      case "-v":
        console.log("csm 0.2.0");
        return 0;
      default:
        console.error(`Unknown command: ${cmd}`);
        printHelp();
        return 2;
    }
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function printHelp(): void {
  console.log(`csm — Context Swarm Memory CLI

Usage:
  csm init                                Initialize storage in ./data
  csm shard create --name <name> [--id <id>] [--tags a,b,c] [--description ...]
  csm remember --shard <id> --text "..." [--tags a,b]
  csm ask "<query>" [--quiet] [--json] [--probe-model X] [--recall-model X] [--synth-model X]
  csm inspect directory
  csm inspect shard <shardId> [--snapshot <S001>] [--full]
  csm inspect chronicle [--limit N]
  csm inspect runs [--limit N]
  csm eval run [--json] [--probe-model X] [--recall-model X] [--synth-model X]
  csm split check [--shard <id>] [--json]
  csm commit dry-run --shard <id> --action write|update|freeze|no_op --content "..." [--memory-type fact] [--tags a,b]
  csm commit apply  --shard <id> --action write|update|freeze|no_op --content "..." [--memory-type fact] [--tags a,b]
  csm provider info                       Show effective provider, base URL, models
  csm provider ping [--model X]           Round-trip a tiny JSON request through the active provider
  csm bench run [--corpus DIR] [--systems csm,longctx,rag,hybrid] [--trials N] [--model M]
                [--corpus-sizes 10K,100K,1M,...] [--model-contexts 1K,8K,...] [--queries q1,q2]
                                          Sweep matrix benchmark; writes results.jsonl + summary.json
  csm bench fill-cache [...same flags as run...]
                                          Alias for 'bench run' — intended for the one-shot 4090 cache-warm
  csm bench replay <runId>                Recompute summary from cached results (no LLM calls)
  csm bench report <runId> [--headline-ctx 8K] [--headline-corpus 1M]
                                          Generate Vega-Lite specs (Graphs A–E) + report.md
  csm bench ablate <runId> --variant ...  (Phase C, not yet implemented)

Environment:
  CSM_HOME              Storage root (default: cwd)
  CSM_PROVIDER          mock | ollama | llama-server | openai | gemini | anthropic    (default: mock)
  CSM_OPENAI_BASE_URL   default https://api.openai.com/v1; for Ollama: http://localhost:11434/v1
  OPENAI_API_KEY        required for hosted OpenAI; "ollama" auto-applied for local
  GEMINI_API_KEY        required for CSM_PROVIDER=gemini (GOOGLE_API_KEY also accepted)
  CSM_GEMINI_MODEL      default Gemini model (default: gemini-3.5-flash)
  CSM_OPENAI_MODEL      default model when stage models aren't set
  CSM_PROBE_MODEL       e.g. gemma4:e4b   (cheap, runs per candidate shard)
  CSM_RECALL_MODEL      e.g. gemma4:31b   (heavier, only on selected shards)
  CSM_SYNTH_MODEL       e.g. gemma4:31b   (skipped automatically when ≤1 recall)

Quickstart with local Gemma 4 on a 4090:
  ollama pull gemma4:e4b
  ollama pull gemma4:31b
  export CSM_PROVIDER=ollama
  export CSM_PROBE_MODEL=gemma4:e4b
  export CSM_RECALL_MODEL=gemma4:31b
  export CSM_SYNTH_MODEL=gemma4:31b
  csm ask "What did we decide about OpenClaw?"
`);
}

async function cmdInit(_rest: string[]): Promise<number> {
  const storage = new JsonlStorage();
  const already = await storage.isInitialized();
  await storage.ensureLayout();
  if (!already) {
    await storage.appendChronicle({
      chronicleId: `c_${Date.now().toString(36)}_init`,
      type: "init",
      createdAt: new Date().toISOString(),
      reason: "Initialized CSM storage",
      actor: "user",
    });
  }
  console.log(`csm init: storage at ${storage.paths.data} (already initialized=${already})`);
  return 0;
}

async function cmdShard(rest: string[]): Promise<number> {
  if (rest[0] !== "create") {
    console.error(`Unknown shard subcommand: ${rest[0] ?? "<missing>"}. Try: csm shard create`);
    return 2;
  }
  const args = parseArgs(rest.slice(1));
  const name = flagString(args, "name");
  if (!name) {
    console.error("--name is required");
    return 2;
  }
  const id = flagString(args, "id") ?? newShardId(name);
  const description = flagString(args, "description") ?? `Memory shard: ${name}`;
  const tagsRaw = flagString(args, "tags") ?? "";
  const tags = tagsRaw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const summary = flagString(args, "summary") ?? `Initial summary for ${name}.`;

  const storage = new JsonlStorage();
  await storage.ensureLayout();
  const { entry, snapshot } = await createShard({
    storage,
    id,
    name,
    description,
    tags,
    systemPrompt: SHARD_SYSTEM_PROMPT,
    summary,
  });
  console.log(
    `Created shard ${entry.id} (snapshot ${snapshot.snapshotId}) with ${tags.length} tags.`,
  );
  return 0;
}

async function cmdRemember(rest: string[]): Promise<number> {
  const args = parseArgs(rest);
  const shardId = flagString(args, "shard");
  const text = flagString(args, "text");
  if (!shardId || !text) {
    console.error("--shard and --text are required");
    return 2;
  }
  const tagsRaw = flagString(args, "tags") ?? "";
  const tags = tagsRaw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const storage = new JsonlStorage();
  const { snapshot, entry } = await appendEventAndSnapshot({
    storage,
    shardId,
    event: { role: "user", content: text, tags },
    reason: `csm remember: user-supplied note`,
    actor: "user",
  });
  console.log(
    `remembered → ${shardId}@${snapshot.snapshotId} (events=${snapshot.events.length}, fullness=${entry.fullnessPct.toFixed(1)}%).`,
  );
  return 0;
}

async function cmdAsk(rest: string[]): Promise<number> {
  const args = parseArgs(rest);
  const query = args.positional.join(" ").trim();
  if (!query) {
    console.error('csm ask "your question"');
    return 2;
  }
  const quiet = flagBool(args, "quiet", false);
  const json = flagBool(args, "json", false);
  const stageModels = {
    probe: flagString(args, "probe-model"),
    recall: flagString(args, "recall-model"),
    synth: flagString(args, "synth-model"),
  };

  const storage = new JsonlStorage();
  if (!(await storage.isInitialized())) {
    console.error("Storage not initialized. Run: csm init");
    return 1;
  }
  const provider = createProvider();
  const result = await ask({ provider, storage, query, models: stageModels });

  if (json) {
    console.log(stableStringify(result));
    return 0;
  }

  if (!quiet) {
    console.log(`\n# csm ask\nquery: ${query}\nprovider: ${provider.name} (resolved=${selectProviderName()})`);

    console.log(`\nMemory candidates (top ${result.candidates.length}):`);
    for (const c of result.candidates) {
      console.log(
        `  - ${c.entry.id}  score=${c.score.toFixed(2)}  reasons=[${c.reasons.join(", ")}]`,
      );
    }

    console.log(`\nProbe results (${result.probes.length}):`);
    for (const p of result.probes) {
      console.log(
        `  - ${p.shardId}@${p.snapshotId}  knows=${p.knows} confidence=${p.confidence.toFixed(2)} type=${p.memoryType} value=${p.estimatedAnswerValue} recall=${p.needsFullRecall}`,
      );
      if (p.relevantEventIds.length) {
        console.log(`      events=[${p.relevantEventIds.join(", ")}]`);
      }
    }

    console.log(`\nRecall summaries (${result.recalls.length}):`);
    for (const r of result.recalls) {
      console.log(
        `  - ${r.shardId}@${r.snapshotId}  confidence=${r.confidence.toFixed(2)}\n      answer: ${r.answer}`,
      );
      for (const c of r.claims) {
        console.log(
          `      • ${c.claim}  [support=${c.support.join(",")}, conf=${c.confidence.toFixed(2)}]`,
        );
      }
    }
  }

  console.log(`\nMemory packet:`);
  console.log(`  query   : ${result.memoryPacket.query}`);
  console.log(`  summary :\n${indent(result.memoryPacket.summary, 4)}`);
  if (result.memoryPacket.keyClaims.length) {
    console.log(`  key claims:`);
    for (const k of result.memoryPacket.keyClaims) {
      console.log(`    - ${k.claim}  [sources=${k.sources.join(",")}, conf=${k.confidence.toFixed(2)}]`);
    }
  }
  if (result.memoryPacket.caveats.length) {
    console.log(`  caveats: ${result.memoryPacket.caveats.join(" | ")}`);
  }
  if (result.memoryPacket.conflicts.length) {
    console.log(`  conflicts: ${result.memoryPacket.conflicts.join(" | ")}`);
  }
  console.log(`  recommended_main_context:\n${indent(result.memoryPacket.recommendedMainContext, 4)}`);

  console.log(
    `\nrun=${result.runId} mutated=${result.mutated} cost: in=${result.cost.inputTokensEstimate}t out=${result.cost.outputTokensEstimate}t usd=${result.cost.estimatedUsd.toFixed(6)} latency=${result.cost.latencyMs}ms`,
  );
  return 0;
}

async function cmdInspect(rest: string[]): Promise<number> {
  const sub = rest[0];
  const args = parseArgs(rest.slice(1));
  const storage = new JsonlStorage();
  if (sub === "directory") {
    const dir = await storage.loadDirectory();
    if (dir.entries.length === 0) {
      console.log("(directory empty)");
      return 0;
    }
    for (const e of dir.entries) {
      console.log(
        `${e.id}  status=${e.status}  snap=${e.snapshotId}  fullness=${e.fullnessPct.toFixed(1)}%  tokens=${e.tokenCountEstimate}/${e.contextLimitEstimate}`,
      );
      console.log(`  name: ${e.name}`);
      console.log(`  desc: ${e.description}`);
      console.log(`  tags: ${e.tags.join(", ")}`);
      console.log(`  trust=${e.trustLevel}  staleness=${e.staleness}  updated=${e.updatedAt}`);
    }
    return 0;
  }
  if (sub === "shard") {
    const id = args.positional[0];
    if (!id) {
      console.error("csm inspect shard <shardId>");
      return 2;
    }
    const manifest = await storage.loadManifest(id);
    if (!manifest) {
      console.error(`Shard not found: ${id}`);
      return 1;
    }
    const snapshotId = flagString(args, "snapshot") ?? manifest.latestSnapshotId;
    const snap = await storage.loadSnapshot(id, snapshotId);
    if (!snap) {
      console.error(`Snapshot not found: ${id}/${snapshotId}`);
      return 1;
    }
    console.log(`Manifest:\n${stableStringify(manifest)}`);
    console.log(`Snapshot ${snapshotId}: events=${snap.events.length}`);
    if (flagBool(args, "full", false)) {
      console.log(stableStringify(snap));
    } else {
      for (const ev of snap.events) {
        console.log(
          `  - [${ev.eventId}] (${ev.role}) ${ev.content.slice(0, 200)}${ev.content.length > 200 ? "…" : ""}`,
        );
        if (ev.tags.length) console.log(`      tags=[${ev.tags.join(", ")}]`);
      }
    }
    return 0;
  }
  if (sub === "chronicle") {
    const limit = parseInt(flagString(args, "limit") ?? "20", 10);
    const events = await storage.readChronicle();
    const tail = events.slice(-limit);
    for (const e of tail) {
      console.log(
        `${e.createdAt}  ${e.type}  shard=${e.targetShardId ?? "-"}  ${e.oldSnapshotId ?? "-"}→${e.newSnapshotId ?? "-"}  by=${e.actor}  ${e.reason}`,
      );
    }
    return 0;
  }
  if (sub === "runs") {
    const limit = parseInt(flagString(args, "limit") ?? "20", 10);
    const runs = await storage.readQueryRuns();
    const tail = runs.slice(-limit);
    for (const r of tail) {
      console.log(
        `${r.startedAt}  run=${r.runId}  cands=${r.candidateIds.length} probes=${r.probedIds.length} recalls=${r.recalledIds.length}  query="${r.query.slice(0, 80)}"`,
      );
    }
    return 0;
  }
  console.error(`Unknown inspect target: ${sub ?? "<missing>"}`);
  return 2;
}

async function cmdEval(rest: string[]): Promise<number> {
  if (rest[0] !== "run") {
    console.error("csm eval run [--json]");
    return 2;
  }
  const args = parseArgs(rest.slice(1));
  const json = flagBool(args, "json", false);
  const stageModels = {
    probe: flagString(args, "probe-model"),
    recall: flagString(args, "recall-model"),
    synth: flagString(args, "synth-model"),
  };
  const report = await runEval(undefined, stageModels);
  if (json) {
    console.log(stableStringify(report));
    return 0;
  }
  console.log(`# eval report`);
  console.log(`router_recall@3 = ${(report.routerRecallAt3 * 100).toFixed(1)}%`);
  console.log(`packet_keyword_coverage = ${(report.packetKeywordCoverage * 100).toFixed(1)}%`);
  for (const c of report.cases) {
    console.log(`\n? ${c.query}`);
    console.log(`  expected top: ${c.expectTopShards.join(", ")}`);
    console.log(`  got top3    : ${c.topShards.join(", ")}  hit=${c.topShardHit}`);
    console.log(`  packet kws  : hit=[${c.packetKeywordsHit.join(", ")}] missed=[${c.packetKeywordsMissed.join(", ")}]`);
    console.log(`  cost        : in=${c.cost.inputTokensEstimate}t out=${c.cost.outputTokensEstimate}t latency=${c.cost.latencyMs}ms`);
  }
  return 0;
}

async function cmdSplit(rest: string[]): Promise<number> {
  if (rest[0] !== "check") {
    console.error("csm split check [--shard <id>] [--json]");
    return 2;
  }
  const args = parseArgs(rest.slice(1));
  const onlyShard = flagString(args, "shard");
  const json = flagBool(args, "json", false);
  const storage = new JsonlStorage();
  const dir = await storage.loadDirectory();
  let report = shardHealthReport(dir);
  if (onlyShard) report = report.filter((r) => r.shardId === onlyShard);
  if (json) {
    console.log(stableStringify(report));
    return 0;
  }
  if (report.length === 0) {
    console.log("(no shards)");
    return 0;
  }
  for (const r of report) {
    console.log(`${r.shardId}  ${r.recommendation.padEnd(20)}  ${r.fullnessPct.toFixed(1)}%  ${r.reason}`);
  }
  // Highlight ones that aren't healthy.
  const concerning = report.filter((r) => r.recommendation !== "continue" && r.recommendation !== "watch");
  if (concerning.length) {
    console.log(`\nNote: ${concerning.length} shard(s) above watch zone. No automatic action taken.`);
  }
  return 0;
}

async function cmdCommit(rest: string[]): Promise<number> {
  const sub = rest[0];
  if (sub !== "dry-run" && sub !== "apply") {
    console.error("csm commit dry-run|apply --shard <id> --action <write|update|freeze|no_op> --content \"...\"");
    return 2;
  }
  const args = parseArgs(rest.slice(1));
  const shard = flagString(args, "shard") ?? null;
  const action = (flagString(args, "action") ?? "no_op") as CommitDecision["action"];
  const content = flagString(args, "content") ?? "";
  const memoryType = (flagString(args, "memory-type") ?? "fact") as CommitDecision["memoryType"];
  const tagsRaw = flagString(args, "tags") ?? "";
  const tags = tagsRaw.split(",").map((t) => t.trim()).filter(Boolean);
  const decision: CommitDecision = {
    action,
    targetShardId: shard,
    memoryType,
    content,
    confidence: 0.7,
    requiresUserConfirmation: false,
    tags,
    source: "user_confirmation",
  };
  const storage = new JsonlStorage();
  if (sub === "dry-run") {
    const r = await dryRunCommit({ storage, decision });
    console.log(`would_mutate=${r.wouldMutate}  chronicle_type=${r.chronicleType}\n${r.description}`);
  } else {
    const r = await applyCommitDecision({ storage, decision });
    console.log(`applied=${r.applied}\n${r.description}`);
  }
  return 0;
}

async function cmdProvider(rest: string[]): Promise<number> {
  const sub = rest[0];
  if (sub === "info") {
    const resolved = selectProviderName();
    const stage = resolveStageModels();
    console.log(`provider          : ${resolved}`);
    const baseUrl =
      resolved === "gemini"
        ? (process.env.CSM_GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta (default)")
        : (process.env.CSM_OPENAI_BASE_URL ?? (resolved === "ollama" ? "http://localhost:11434/v1 (default)" : "https://api.openai.com/v1 (default)"));
    const defaultModel =
      resolved === "gemini"
        ? (process.env.CSM_GEMINI_MODEL ?? process.env.CSM_MODEL ?? "gemini-3.5-flash (default)")
        : (process.env.CSM_OPENAI_MODEL ?? process.env.CSM_MODEL ?? "(unset)");
    console.log(`base url          : ${baseUrl}`);
    console.log(`default model     : ${defaultModel}`);
    console.log(`stage:probe model : ${stage.probe ?? "(unset)"}`);
    console.log(`stage:recall model: ${stage.recall ?? "(unset)"}`);
    console.log(`stage:synth model : ${stage.synth ?? "(unset)"}`);
    console.log(`OPENAI_API_KEY    : ${process.env.OPENAI_API_KEY ? "(set)" : "(unset)"}`);
    console.log(`GEMINI_API_KEY    : ${process.env.GEMINI_API_KEY ? "(set)" : "(unset)"}`);
    console.log(`GOOGLE_API_KEY    : ${process.env.GOOGLE_API_KEY ? "(set)" : "(unset)"}`);
    return 0;
  }
  if (sub === "ping") {
    const args = parseArgs(rest.slice(1));
    const provider = createProvider();
    const model = flagString(args, "model") ?? process.env.CSM_OPENAI_MODEL;
    try {
      const t0 = Date.now();
      const r = await provider.completeJson<{ ok: boolean }>({
        system: "You return JSON only. Be brief.",
        prompt: 'Return exactly this JSON: {"ok": true}',
        schemaName: "Ping",
        maxOutputTokens: 50,
        temperature: 0,
        model,
        disableThinking: true,
      });
      console.log(`OK provider=${provider.name} model=${model ?? "(provider default)"} latency=${Date.now() - t0}ms`);
      console.log(`raw : ${r.rawText}`);
      console.log(`usage: in=${r.usage.inputTokensEstimate}t out=${r.usage.outputTokensEstimate}t`);
      return 0;
    } catch (err) {
      console.error(`ping FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  console.error("csm provider info | csm provider ping [--model X]");
  return 2;
}

function indent(text: string, n: number): string {
  const pad = " ".repeat(n);
  return text
    .split("\n")
    .map((l) => `${pad}${l}`)
    .join("\n");
}

// --------------------------------------------------------------------------
// `csm bench` — the Phase C scaling-study harness.
// --------------------------------------------------------------------------

async function cmdBench(rest: string[]): Promise<number> {
  const sub = rest[0];
  switch (sub) {
    case "run":
    case "fill-cache":
      return await cmdBenchRun(rest.slice(1));
    case "replay":
      return await cmdBenchReplay(rest.slice(1));
    case "ablate":
      return await cmdBenchAblate(rest.slice(1));
    case "report":
      return await cmdBenchReport(rest.slice(1));
    default:
      console.error("csm bench {run|fill-cache|replay|ablate|report}");
      return 2;
  }
}

function buildSystems(args: ParsedArgs): BaselineRunner[] {
  const provider = createProvider();
  const wantedRaw = flagString(args, "systems") ?? "csm,longctx,rag,hybrid";
  const wanted = new Set(
    wantedRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  // The sidecar-backed baselines configure their INTERNAL extraction LLM with
  // this name. It MUST match the actual backend model: Ollama wants
  // "gemma4:31b" (colon); the baselines' own defaults are the llama-server
  // name "gemma4-31b" (dash), which 404s against Ollama and silently produces
  // an EMPTY memory store — the bug that sank the first Mem0 run (zero
  // retrieval, every query wrong). Resolve it the same way the bench config
  // resolves the answering model so all systems agree.
  const sidecarLlmModel =
    flagString(args, "model") ?? process.env.CSM_OPENAI_MODEL ?? "gemma4:31b";
  // Sidecar /index does LLM-driven extraction over the whole corpus in one
  // blocking call — ~2.5 h for a 100K sample on a 4090. The baselines' 30 s
  // default would abort it instantly. Allow override via CSM_SIDECAR_TIMEOUT_MS.
  const sidecarTimeoutMs = Number.parseInt(
    process.env.CSM_SIDECAR_TIMEOUT_MS ?? "21600000", // 6 h
    10,
  );
  const out: BaselineRunner[] = [];
  if (wanted.has("csm")) out.push(new CsmBaseline({ provider }));
  if (wanted.has("longctx")) out.push(new LongContextBaseline({ provider }));
  if (wanted.has("rag")) out.push(new VanillaRagBaseline({ provider }));
  if (wanted.has("hybrid")) out.push(new HybridRagBaseline({ provider }));
  // Phase γ sidecar-backed baselines — opt-in via --systems. Require their
  // Python sidecar to be running (default ports 8001/8002/8003) and the
  // LLM-cache proxy at 8090. See services/_common/sidecar_protocol.md.
  if (wanted.has("mem0"))
    out.push(
      new Mem0Baseline({
        provider,
        llmModel: sidecarLlmModel,
        requestTimeoutMs: sidecarTimeoutMs,
      }),
    );
  if (wanted.has("hipporag"))
    out.push(
      new HippoRagBaseline({
        provider,
        llmModel: sidecarLlmModel,
        requestTimeoutMs: sidecarTimeoutMs,
      }),
    );
  if (wanted.has("lightrag"))
    out.push(
      new LightRagBaseline({
        provider,
        llmModel: sidecarLlmModel,
        requestTimeoutMs: sidecarTimeoutMs,
      }),
    );
  if (out.length === 0) {
    throw new Error(
      `No systems matched --systems="${wantedRaw}". Valid: csm,longctx,rag,hybrid,mem0,hipporag,lightrag`,
    );
  }
  return out;
}

function parseSizesFlag(args: ParsedArgs, key: string): number[] | undefined {
  const raw = flagString(args, key);
  if (!raw) return undefined;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseHumanSize)
    .filter((n) => Number.isFinite(n) && n > 0);
  return parts.length > 0 ? parts : undefined;
}

function parseHumanSize(s: string): number {
  const m = s.match(/^([\d.]+)\s*([KkMmBbGg]?)$/);
  if (!m) return Number.NaN;
  const n = Number.parseFloat(m[1]!);
  const suffix = m[2]!.toLowerCase();
  switch (suffix) {
    case "k":
      return Math.round(n * 1_000);
    case "m":
      return Math.round(n * 1_000_000);
    case "b":
    case "g":
      return Math.round(n * 1_000_000_000);
    default:
      return Math.round(n);
  }
}

function fmtSize(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(0)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return `${n}`;
}

async function cmdBenchRun(rest: string[]): Promise<number> {
  const args = parseArgs(rest);
  const corpusDir = flagString(args, "corpus") ?? "data/eval/corpus-synthetic";
  const runIdDefault = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const runId = flagString(args, "run-id") ?? runIdDefault;
  const outputDir = flagString(args, "output-dir") ?? join("data", "eval", "runs", runId);
  const trials = Number.parseInt(flagString(args, "trials") ?? "3", 10);
  const resolvedProvider = selectProviderName();
  const model =
    flagString(args, "model") ??
    (resolvedProvider === "gemini" ? process.env.CSM_GEMINI_MODEL : undefined) ??
    process.env.CSM_OPENAI_MODEL ??
    process.env.CSM_MODEL ??
    (resolvedProvider === "gemini" ? GEMINI_DEFAULT_MODEL : "gemma4:31b");
  const corpusSizes =
    parseSizesFlag(args, "corpus-sizes") ?? Array.from(CORPUS_SIZE_SWEEP);
  const modelContexts =
    parseSizesFlag(args, "model-contexts") ?? Array.from(MODEL_CONTEXT_SWEEP);
  const queryIdsRaw = flagString(args, "queries");
  const queryIdsFilter = queryIdsRaw
    ? queryIdsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  const seed = Number.parseInt(flagString(args, "seed") ?? "42", 10);

  const systems = buildSystems(args);

  console.error(
    `bench run: corpus=${corpusDir} runId=${runId} systems=[${systems.map((s) => s.name).join(",")}] trials=${trials} model=${model}`,
  );
  console.error(
    `  corpus sizes : ${corpusSizes.map(fmtSize).join(", ")}`,
  );
  console.error(
    `  model ctxs   : ${modelContexts.map(fmtSize).join(", ")}`,
  );

  const result = await runBenchmark({
    runId,
    corpusDir,
    corpusSizes,
    modelContexts,
    trials,
    model,
    outputDir,
    systems,
    queryIdsFilter,
    seed,
    onProgress: (tick) => {
      if (tick.cellIndex % 5 === 0 || tick.cellIndex === tick.totalCells) {
        process.stderr.write(
          `\r  ${tick.cellIndex}/${tick.totalCells}  done=${tick.cellsCompleted}  skipped=${tick.cellsSkipped}  early-stops=${tick.earlyStopGroups}    `,
        );
      }
    },
  });
  process.stderr.write("\n");
  console.log(
    `\nDone: ${result.results.length} cells across ${result.summaries.length} (system × ctx × size) groups.`,
  );
  console.log(`  early-stop pairs : ${result.earlyStopMap.length}`);
  console.log(`  output dir       : ${outputDir}`);
  console.log(`  next             : csm bench report ${runId}`);
  return 0;
}

async function cmdBenchReplay(rest: string[]): Promise<number> {
  const args = parseArgs(rest);
  const runId = args.positional[0] ?? flagString(args, "run-id");
  if (!runId) {
    console.error("csm bench replay <runId>");
    return 2;
  }
  const outputDir =
    flagString(args, "output-dir") ?? join("data", "eval", "runs", runId);
  const result = await replayResults({ outputDir });
  console.log(
    `Replayed ${result.summaries.length} groups from ${result.results.length} cells.`,
  );
  console.log(`Wrote: ${join(outputDir, "summary.json")}`);
  return 0;
}

async function cmdBenchAblate(_rest: string[]): Promise<number> {
  console.error(
    "csm bench ablate: not yet implemented for v0.2.0 (Phase C planned). " +
      "Variants planned: no-router | no-probe | no-synth-skip | no-scoped-recall",
  );
  return 2;
}

async function cmdBenchReport(rest: string[]): Promise<number> {
  const args = parseArgs(rest);
  const runId = args.positional[0] ?? flagString(args, "run-id");
  if (!runId) {
    console.error("csm bench report <runId>");
    return 2;
  }
  const outputDir =
    flagString(args, "output-dir") ?? join("data", "eval", "runs", runId);
  const headlineCtx = parseHumanSize(flagString(args, "headline-ctx") ?? "8192");
  const headlineCorpus = parseHumanSize(
    flagString(args, "headline-corpus") ?? "1M",
  );

  const summaryPath = join(outputDir, "summary.json");
  if (!existsSync(summaryPath)) {
    console.error(
      `No summary.json at ${summaryPath}. Run \`csm bench replay ${runId}\` first.`,
    );
    return 1;
  }

  const summary = JSON.parse(await readFile(summaryPath, "utf8")) as {
    runId: string;
    generatedAt: string;
    cells: Array<{
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
    }>;
  };

  const dataset: ResultDataset = {
    rows: summary.cells.map<ResultRow>((c) => ({
      system: c.system,
      corpusSize: c.corpusSize,
      modelContext: c.modelContext,
      accuracy: c.accuracy,
      accuracyCiLow: c.accuracyCi95[0],
      accuracyCiHigh: c.accuracyCi95[1],
      meanCitationPrecision: c.meanCitationPrecision,
      meanCitationRecall: c.meanCitationRecall,
      meanCitationF1: c.meanCitationF1,
      meanInputTokens: c.meanInputTokens,
      meanLatencyMs: c.meanLatencyMs,
      n: c.n,
      earlyStopped: c.earlyStopped,
    })),
    accuracyThreshold: 0.8,
    earlyStopThreshold: EARLY_STOP_ACCURACY,
  };

  const graphs = generateAllGraphs(dataset, {
    headlineModelContext: headlineCtx,
    headlineCorpusSize: headlineCorpus,
  });

  const plotsDir = join(outputDir, "plots");
  await mkdir(plotsDir, { recursive: true });
  for (const [name, spec] of Object.entries(graphs)) {
    if (!spec) continue;
    await writeFile(
      join(plotsDir, `${name}.vl.json`),
      stableStringify(spec),
      "utf8",
    );
  }

  // Markdown summary table.
  const mdLines: string[] = [];
  mdLines.push(`# Benchmark report — ${summary.runId}`);
  mdLines.push("");
  mdLines.push(`Generated at: ${summary.generatedAt}`);
  mdLines.push("");
  mdLines.push("## Cells");
  mdLines.push("");
  mdLines.push(
    "| System | Corpus | ModelCtx | n | Accuracy | CI95 | Cite F1 | InTokens | LatencyMs | EarlyStop |",
  );
  mdLines.push(
    "|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const r of dataset.rows) {
    mdLines.push(
      `| ${r.system} | ${fmtSize(r.corpusSize)} | ${fmtSize(r.modelContext)} | ${r.n} | ${(r.accuracy * 100).toFixed(1)}% | [${(r.accuracyCiLow * 100).toFixed(1)}, ${(r.accuracyCiHigh * 100).toFixed(1)}]% | ${r.meanCitationF1.toFixed(2)} | ${Math.round(r.meanInputTokens)} | ${Math.round(r.meanLatencyMs)} | ${r.earlyStopped ? "✓" : ""} |`,
    );
  }
  mdLines.push("");
  mdLines.push("## Plots (Vega-Lite specs)");
  mdLines.push("");
  for (const [name, spec] of Object.entries(graphs)) {
    if (spec) mdLines.push(`- \`plots/${name}.vl.json\``);
  }
  mdLines.push("");
  mdLines.push(
    "Render via the online editor at https://vega.github.io/editor/ (paste the JSON), or use the `vega-lite` CLI to convert to SVG/PNG.",
  );

  await writeFile(join(outputDir, "report.md"), mdLines.join("\n"), "utf8");

  console.log("Generated:");
  for (const [name, spec] of Object.entries(graphs)) {
    if (spec)
      console.log(`  - ${join(outputDir, "plots", `${name}.vl.json`)}`);
  }
  console.log(`  - ${join(outputDir, "report.md")}`);
  return 0;
}

main().then((code) => {
  process.exitCode = code;
}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
