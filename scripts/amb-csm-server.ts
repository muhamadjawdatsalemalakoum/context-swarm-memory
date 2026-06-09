/** Warm CSM bridge server for the Agent Memory Benchmark.
 *
 * The one-shot bridge (`amb-csm-retrieve.ts`) pays a Node spawn + corpus
 * rebuild + embedding-model load on EVERY query (~0.8 s/query process
 * residual on the May BEAM run, plus npm wrapper overhead). This server is
 * the ingest-once / query-many replacement: the AMB provider starts it once
 * in `initialize()`, POSTs documents during `ingest()`, and calls
 * `/retrieve` per query. Retrieval goes through the exact same
 * `executeAmbRetrieve` core as the one-shot script, so AMB-visible behavior
 * is identical for identical inputs.
 *
 * Memory-safety invariant: this process holds AMB documents in RAM and
 * NEVER touches CSM's durable storage. The read-only `ask()` path inside
 * `CsmBaseline` is unchanged.
 *
 * Routes (localhost only):
 *   GET  /healthz   → { ok, llm_provider, llm_model, documents, corpora }
 *   POST /ingest    { documents: AmbDocument[] }
 *   POST /reset     {}                            — clears documents + cache
 *   POST /retrieve  { query, k?, user_id?, query_timestamp? }
 *   POST /shutdown  {}
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CsmBaseline } from "../src/eval/baselines/csm.js";
import type { Corpus } from "../src/eval/corpus.js";
import type { LlmProvider } from "../src/providers/LlmProvider.js";
import { loadLocalEnv } from "../src/utils/loadEnv.js";
import {
  type AmbBridgeOptions,
  type AmbDocument,
  type AmbRetrievePayload,
  type AmbRetrieveRequest,
  buildCorpus,
  createBridgeProvider,
  emptyAmbPayload,
  executeAmbRetrieve,
  scopeDocuments,
} from "./amb-csm-retrieve.js";

/** Max user-scoped corpora kept warm. BEAM walks units sequentially, so one
 *  would mostly hit; a little slack covers interleaved access without letting
 *  a big split pin every unit's corpus in memory at once. */
const CORPUS_CACHE_MAX = 4;

/** Request bodies are JSON; ingest batches are the largest (a BEAM 100K unit
 *  is ~400 KB of text). 256 MB leaves room for 10M-split batches while still
 *  bounding a runaway client. */
const MAX_BODY_BYTES = 256 * 1024 * 1024;

export interface AmbServerState {
  documents: AmbDocument[];
  /** Bumped on every ingest/reset; corpus cache entries from older versions
   *  are stale and rebuilt on next use. */
  version: number;
  corpusCache: Map<string, { version: number; corpus: Corpus }>;
  baseline: CsmBaseline;
  providerName: string;
  defaults: AmbBridgeOptions;
}

export function createAmbServerState(provider?: LlmProvider): AmbServerState {
  const resolved = provider ?? createBridgeProvider();
  return {
    documents: [],
    version: 0,
    corpusCache: new Map(),
    baseline: new CsmBaseline({ provider: resolved }),
    providerName: resolved.name,
    defaults: defaultBridgeOptions(),
  };
}

export function defaultBridgeOptions(): AmbBridgeOptions {
  return {
    model:
      process.env.CSM_AMB_MODEL ?? process.env.CSM_MODEL ?? "gemini-3.5-flash",
    modelContext: parsePositiveInt(process.env.CSM_AMB_MODEL_CONTEXT, 8192),
    maxOutputTokens: parsePositiveInt(process.env.CSM_AMB_MAX_OUTPUT_TOKENS, 512),
    withInternalAnswer: isTruthy(process.env.CSM_AMB_WITH_INTERNAL_ANSWER),
  };
}

/** Build (or reuse) the corpus for a user scope at the current doc version. */
export function getScopedCorpus(
  state: AmbServerState,
  userId: string | null | undefined,
): Corpus | null {
  const key = userId ?? "__all__";
  const hit = state.corpusCache.get(key);
  if (hit && hit.version === state.version) return hit.corpus;

  const scoped = scopeDocuments(state.documents, userId);
  if (scoped.length === 0) return null;
  const corpus = buildCorpus(scoped);

  state.corpusCache.set(key, { version: state.version, corpus });
  // Evict stale versions first, then oldest insertion until under the cap.
  for (const [k, v] of state.corpusCache) {
    if (state.corpusCache.size <= CORPUS_CACHE_MAX) break;
    if (k !== key && v.version !== state.version) state.corpusCache.delete(k);
  }
  for (const k of state.corpusCache.keys()) {
    if (state.corpusCache.size <= CORPUS_CACHE_MAX) break;
    if (k !== key) state.corpusCache.delete(k);
  }
  return corpus;
}

export async function handleRetrieve(
  state: AmbServerState,
  request: AmbRetrieveRequest,
): Promise<AmbRetrievePayload> {
  const corpus = getScopedCorpus(state, request.user_id);
  if (!corpus) return emptyAmbPayload("no_documents_in_scope");
  return executeAmbRetrieve({
    baseline: state.baseline,
    providerName: state.providerName,
    corpus,
    request,
    opts: state.defaults,
  });
}

export function createAmbServer(state: AmbServerState): Server {
  return createServer((req, res) => {
    routeRequest(state, req, res).catch((err) => {
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
}

async function routeRequest(
  state: AmbServerState,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = req.url ?? "/";

  if (req.method === "GET" && (url === "/healthz" || url === "/")) {
    sendJson(res, 200, {
      ok: true,
      service: "csm-amb-bridge",
      llm_provider: state.providerName,
      llm_model: state.defaults.model,
      documents: state.documents.length,
      corpora: state.corpusCache.size,
      version: state.version,
    });
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: `method ${req.method} not allowed` });
    return;
  }

  if (url === "/shutdown") {
    sendJson(res, 200, { ok: true, shutting_down: true });
    res.once("close", () => {
      // Give the response a beat to flush, then exit. The AMB provider also
      // terminates the child process in cleanup(), so this is belt-and-braces.
      setTimeout(() => process.exit(0), 50).unref();
    });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  switch (url) {
    case "/ingest": {
      const docs = (body as { documents?: unknown }).documents;
      if (!Array.isArray(docs)) {
        sendJson(res, 400, { error: 'body must be {"documents": [...]}' });
        return;
      }
      for (const doc of docs) state.documents.push(doc as AmbDocument);
      state.version++;
      sendJson(res, 200, { ok: true, ingested: docs.length, total: state.documents.length });
      return;
    }
    case "/reset": {
      state.documents = [];
      state.corpusCache.clear();
      state.version++;
      sendJson(res, 200, { ok: true });
      return;
    }
    case "/retrieve": {
      const request = body as AmbRetrieveRequest;
      if (!request || typeof request.query !== "string" || request.query.length === 0) {
        sendJson(res, 400, { error: 'body must include string field "query"' });
        return;
      }
      const payload = await handleRetrieve(state, request);
      sendJson(res, 200, payload);
      return;
    }
    default:
      sendJson(res, 404, { error: `unknown route ${url}` });
  }
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(text));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const text = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

async function main(): Promise<void> {
  // Same env contract as the CLI and the one-shot bridge: pick up the CSM
  // repo's .env; vars exported by the parent (AMB) process win.
  loadLocalEnv();

  const portArgIx = process.argv.indexOf("--port");
  const requestedPort =
    portArgIx !== -1 ? Number.parseInt(process.argv[portArgIx + 1] ?? "0", 10) : 0;

  const state = createAmbServerState();
  if (!process.env.CSM_MODEL) process.env.CSM_MODEL = state.defaults.model;
  const server = createAmbServer(state);

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(
      { host: "127.0.0.1", port: Number.isFinite(requestedPort) ? requestedPort : 0 },
      () => resolveListen(),
    );
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : requestedPort;
  // The AMB provider parses this exact line to learn the ephemeral port.
  process.stdout.write(`AMB_CSM_SERVER_READY port=${port}\n`);
  process.stderr.write(
    `csm-amb-bridge listening on 127.0.0.1:${port} (provider=${state.providerName}, model=${state.defaults.model})\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(
      `amb-csm-server failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exitCode = 1;
  });
}
