import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { estimateTokens } from "../src/core/tokenBudget.js";
import { CsmBaseline } from "../src/eval/baselines/csm.js";
import type { BenchEvent, Corpus } from "../src/eval/corpus.js";
import type { FreeFormQuery } from "../src/eval/mcq.js";
import { createProvider } from "../src/providers/index.js";

interface AmbDocument {
  id: string;
  content: string;
  user_id?: string | null;
  timestamp?: string | null;
  context?: string | null;
}

interface AmbRetrieveRequest {
  query: string;
  k?: number;
  user_id?: string | null;
  query_timestamp?: string | null;
}

interface Args {
  storeDir: string;
  requestPath: string;
  model: string;
  modelContext: number;
  maxOutputTokens: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.CSM_MODEL) process.env.CSM_MODEL = args.model;

  const [documents, request] = await Promise.all([
    readDocumentsJsonl(join(args.storeDir, "documents.jsonl")),
    readRequest(args.requestPath),
  ]);
  const scopedDocs = request.user_id
    ? documents.filter((doc) => doc.user_id === request.user_id)
    : documents;

  if (scopedDocs.length === 0) {
    writeJson({ documents: [], raw_response: { reason: "no_documents_in_scope" } });
    return;
  }

  const corpus = buildCorpus(scopedDocs);
  const baseline = new CsmBaseline({ provider: createProvider() });
  const query: FreeFormQuery = {
    kind: "free-form",
    id: "amb-request",
    question: request.query,
    correctAnswer: "unused",
    relevantEventIds: [],
  };

  const result = await baseline.answer(query, corpus, {
    maxInputTokens: args.modelContext,
    model: args.model,
    maxOutputTokens: args.maxOutputTokens,
    temperature: 0,
    seed: 42,
  });

  const packedEventIds = asStringArray(result.meta?.packedEventIds);
  const retrievedEventIds = asStringArray(result.meta?.csmRetrievedEventIds);
  const ids = (packedEventIds.length > 0 ? packedEventIds : retrievedEventIds).slice(
    0,
    request.k ?? 10,
  );

  const outDocs = ids
    .map((id) => corpus.byId.get(id))
    .filter((event): event is BenchEvent => Boolean(event))
    .map((event) => ({
      id: event.id,
      content: event.content,
      user_id: request.user_id ?? null,
      timestamp: event.timestamp ?? null,
      context: `CSM retrieved from shard ${event.shardId}`,
    }));

  writeJson({
    documents: outDocs,
    raw_response: {
      provider: "context-swarm-memory",
      mode: "retrieve-via-csm-baseline",
      note:
        "Smoke bridge: CSM retrieval is exposed to AMB; the internal final answer call is discarded.",
      meta: result.meta ?? {},
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: result.latencyMs,
    },
  });
}

async function readDocumentsJsonl(path: string): Promise<AmbDocument[]> {
  const text = stripBom(await readFile(path, "utf8"));
  const docs: AmbDocument[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    docs.push(JSON.parse(stripBom(trimmed)) as AmbDocument);
  }
  return docs;
}

async function readRequest(path: string): Promise<AmbRetrieveRequest> {
  const raw = JSON.parse(stripBom(await readFile(path, "utf8"))) as AmbRetrieveRequest;
  if (!raw.query || typeof raw.query !== "string") {
    throw new Error(`AMB request at ${path} is missing string field "query"`);
  }
  return raw;
}

function buildCorpus(documents: AmbDocument[]): Corpus {
  const events: BenchEvent[] = documents.map((doc, index) => {
    const context = doc.context ? `Context: ${doc.context}\n\n` : "";
    const content = `${context}${doc.content}`;
    return {
      id: doc.id || `amb-doc-${index}`,
      shardId: doc.id || `amb-doc-${index}`,
      content,
      tokenCount: estimateTokens(content),
      isCore: true,
      tier: 0,
      timestamp: doc.timestamp ?? undefined,
      tags: [
        "amb",
        "beam",
        ...(doc.user_id ? [`conversation:${doc.user_id}`] : []),
      ],
    };
  });

  const byShard = new Map<string, BenchEvent[]>();
  const byId = new Map<string, BenchEvent>();
  for (const event of events) {
    byId.set(event.id, event);
    const shardEvents = byShard.get(event.shardId);
    if (shardEvents) shardEvents.push(event);
    else byShard.set(event.shardId, [event]);
  }

  const totalTokens = events.reduce((sum, event) => sum + event.tokenCount, 0);
  return {
    events,
    coreEvents: events,
    fillerEvents: [],
    totalTokens,
    byShard,
    byId,
    targetTokens: totalTokens,
    sampleSeed: 42,
  };
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function parseArgs(argv: string[]): Args {
  const raw = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key?.startsWith("--")) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${key}`);
    }
    raw.set(key.slice(2), value);
    i++;
  }

  const storeDir = raw.get("store");
  const requestPath = raw.get("request");
  if (!storeDir) throw new Error("Usage: amb-csm-retrieve --store <dir> --request <json>");
  if (!requestPath) throw new Error("Usage: amb-csm-retrieve --store <dir> --request <json>");

  return {
    storeDir,
    requestPath,
    model:
      raw.get("model") ??
      process.env.CSM_AMB_MODEL ??
      process.env.CSM_MODEL ??
      "gemini-3.5-flash",
    modelContext: parsePositiveInt(
      raw.get("model-context") ?? process.env.CSM_AMB_MODEL_CONTEXT,
      8192,
    ),
    maxOutputTokens: parsePositiveInt(
      raw.get("max-output-tokens") ?? process.env.CSM_AMB_MAX_OUTPUT_TOKENS,
      8,
    ),
  };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

main().catch((err) => {
  process.stderr.write(
    `amb-csm-retrieve failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exitCode = 1;
});
