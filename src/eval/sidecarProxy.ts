import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  cacheGet,
  cacheSet,
  CacheRefusedEmptyError,
  type CacheKeyInput,
} from "./cache.js";

/**
 * LLM-cache proxy — fairness layer for Phase γ Python sidecars.
 *
 * Python sidecars (HippoRAG / LightRAG / Mem0) do their internal LLM calls
 * (OpenIE triple extraction, entity-relation extraction, fact distillation,
 * etc.) inside the sidecar process. Without an interposed cache, every bench
 * replay would re-fire those LLM calls — breaking the replay-determinism
 * story that makes our bench reproducible.
 *
 * This proxy listens on a configurable port (default 8090). Each sidecar's
 * OpenAI-compat client is pointed at it instead of at Ollama / llama-server
 * directly. The proxy:
 *
 *   1. Accepts `POST /v1/chat/completions` (the expensive call shape).
 *   2. Normalises into a `CacheKeyInput` and hits `src/eval/cache.ts`.
 *   3. On cache hit: returns the cached `content` re-wrapped in the
 *      OpenAI-compat response shape, with `x-cache-hit: true`.
 *   4. On cache miss: forwards the request to `CSM_OPENAI_BASE_URL`, captures
 *      the response, writes it to the cache, returns it with
 *      `x-cache-hit: false`.
 *   5. For any other path (embeddings, models, etc.): transparent passthrough
 *      to the real backend with no caching. Embeddings have their own
 *      disk-cache layer in `src/eval/embed.ts`; they don't need this one.
 *
 * **Replay determinism**: identical to the existing cache contract — same
 * `CacheKeyInput` hashes to the same key, same response is returned.
 *
 * **Cost telemetry**: response headers include `x-cache-bytes-in` /
 * `x-cache-bytes-out` so the sidecar can roll the proxy's view of cost into
 * its own `cost` block in the protocol response.
 *
 * **Streaming**: not supported in v1. Sidecars must use `stream: false`
 * (most Python OpenAI clients default to non-streaming). The Node CSM path
 * keeps streaming for direct Ollama / llama-server calls; only sidecars are
 * affected by this constraint.
 */

export interface SidecarProxyOptions {
  /** Port to listen on. Default 8090. */
  port?: number;
  /** Upstream OpenAI-compat base URL (without trailing slash). Defaults to
   *  `CSM_OPENAI_BASE_URL` env or `http://localhost:11434/v1`. */
  upstreamBaseURL?: string;
  /** Bearer token forwarded to the upstream. Defaults to `OPENAI_API_KEY` or
   *  `"ollama"` for local endpoints. */
  apiKey?: string;
  /** Optional fetch implementation override (useful for tests). */
  fetchImpl?: typeof fetch;
  /** Per-call timeout in ms on upstream forwards. Default 600s (matches
   *  OllamaProvider's timeout for long Gemma 4 31B calls). */
  upstreamTimeoutMs?: number;
  /** Cache root directory override (matches `cache.ts` parameter). */
  cacheRoot?: string;
}

export interface SidecarProxyStats {
  hits: number;
  misses: number;
  forwarded: number;
  errors: number;
}

const DEFAULT_PORT = 8090;
const DEFAULT_UPSTREAM = "http://localhost:11434/v1";
const DEFAULT_UPSTREAM_TIMEOUT_MS = 600_000;

interface ChatCompletionsRequest {
  model: string;
  messages: Array<{ role: string; content: string | null }>;
  temperature?: number;
  max_tokens?: number;
  seed?: number;
  think?: boolean;
  // Many other OpenAI-compat fields ignored for cache-key purposes.
  [k: string]: unknown;
}

/**
 * Start the proxy. Returns the running `http.Server` handle (call `.close()`
 * to stop) and a `stats` accumulator for test assertions.
 */
export function startSidecarProxy(opts: SidecarProxyOptions = {}): {
  server: Server;
  stats: SidecarProxyStats;
  port: number;
} {
  const port = opts.port ?? DEFAULT_PORT;
  const upstreamBaseURL = stripSlash(
    opts.upstreamBaseURL ??
      process.env.CSM_OPENAI_BASE_URL ??
      DEFAULT_UPSTREAM,
  );
  const apiKey =
    opts.apiKey ??
    process.env.OPENAI_API_KEY ??
    (isLocalBase(upstreamBaseURL) ? "ollama" : "");
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const upstreamTimeoutMs =
    opts.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  const cacheRoot = opts.cacheRoot;

  const stats: SidecarProxyStats = {
    hits: 0,
    misses: 0,
    forwarded: 0,
    errors: 0,
  };

  const server = createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const url = req.url ?? "/";

      // Only POST /v1/chat/completions is cached. Everything else passes
      // through transparently (embeddings, /v1/models, /api/generate, etc.).
      if (method === "POST" && /^\/v1\/chat\/completions(\?|$)/.test(url)) {
        await handleChatCompletions(req, res, {
          upstreamBaseURL,
          apiKey,
          fetchImpl,
          upstreamTimeoutMs,
          cacheRoot,
          stats,
        });
        return;
      }
      // Passthrough.
      await handlePassthrough(req, res, {
        upstreamBaseURL,
        apiKey,
        fetchImpl,
        upstreamTimeoutMs,
        stats,
      });
    } catch (err) {
      stats.errors++;
      // eslint-disable-next-line no-console
      console.error(`[sidecarProxy] handler error: ${(err as Error).message}`);
      sendJson(res, 500, {
        error: { message: (err as Error).message, type: "proxy_error" },
      });
    }
  });

  server.listen(port, "127.0.0.1");
  const address = server.address();
  const actualPort =
    address && typeof address !== "string" ? address.port : port;
  return { server, stats, port: actualPort };
}

async function handleChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: {
    upstreamBaseURL: string;
    apiKey: string;
    fetchImpl: typeof fetch;
    upstreamTimeoutMs: number;
    cacheRoot?: string;
    stats: SidecarProxyStats;
  },
): Promise<void> {
  const bodyText = await readBody(req);
  let body: ChatCompletionsRequest;
  try {
    body = JSON.parse(bodyText) as ChatCompletionsRequest;
  } catch {
    sendJson(res, 400, {
      error: { message: "invalid JSON body", type: "proxy_error" },
    });
    return;
  }

  // Streaming not supported in v1 (re-wrapping SSE adds complexity, sidecars
  // can use non-streaming). Forward streaming requests untouched without
  // caching.
  if (body.stream === true) {
    await handlePassthrough(req, res, ctx, bodyText);
    return;
  }

  // Build the CacheKeyInput. Map OpenAI-compat fields to our internal shape.
  const systemMsg = body.messages?.find((m) => m.role === "system")?.content;
  const userMsg = body.messages?.find((m) => m.role === "user")?.content;
  const promptText = typeof userMsg === "string" ? userMsg : "";
  const systemText = typeof systemMsg === "string" ? systemMsg : undefined;

  const cacheInput: CacheKeyInput = {
    model: body.model,
    prompt: promptText,
    system: systemText,
    temperature: typeof body.temperature === "number" ? body.temperature : 0,
    seed: typeof body.seed === "number" ? body.seed : undefined,
    maxOutputTokens: typeof body.max_tokens === "number" ? body.max_tokens : 0,
    // Honor `think: false` so sidecar runs with thinking-off don't collide
    // with thinking-on cache entries. See `cache.ts` for the conditional-key
    // strategy.
    disableThinking: body.think === false ? true : undefined,
  };

  // Cache hit path.
  const hit = await cacheGet(cacheInput, ctx.cacheRoot);
  if (hit) {
    ctx.stats.hits++;
    res.setHeader("x-cache-hit", "true");
    res.setHeader("x-cache-bytes-in", String(bodyText.length));
    res.setHeader("x-cache-bytes-out", String(hit.response.length));
    sendJson(res, 200, openAIWrap(body.model, hit.response));
    return;
  }

  ctx.stats.misses++;

  // Cache miss — forward to upstream.
  const upstreamUrl = `${ctx.upstreamBaseURL}/chat/completions`;
  const upstreamResponse = await forward(upstreamUrl, bodyText, ctx);

  // Parse response to extract the content for caching.
  let upstreamJson: unknown;
  try {
    upstreamJson = JSON.parse(upstreamResponse.body) as unknown;
  } catch {
    // Don't cache unparseable responses. Stream the bytes through unchanged.
    res.setHeader("x-cache-hit", "false");
    res.setHeader("x-cache-bytes-in", String(bodyText.length));
    res.setHeader("x-cache-bytes-out", String(upstreamResponse.body.length));
    res.statusCode = upstreamResponse.status;
    for (const [k, v] of Object.entries(upstreamResponse.headers)) {
      // Don't echo content-length — Node sets it. Don't echo our cache headers.
      if (k.toLowerCase() === "content-length") continue;
      if (k.toLowerCase().startsWith("x-cache-")) continue;
      res.setHeader(k, v);
    }
    res.end(upstreamResponse.body);
    return;
  }

  const content = extractContent(upstreamJson);
  // Honor cacheSet's empty-response guard. If the upstream returned empty
  // text, don't cache — let the next call retry.
  if (typeof content === "string" && content.trim().length >= 5) {
    try {
      await cacheSet(
        cacheInput,
        {
          response: content,
          latencyMs: upstreamResponse.latencyMs,
        },
        ctx.cacheRoot,
      );
    } catch (err) {
      if (!(err instanceof CacheRefusedEmptyError)) throw err;
    }
  }

  res.setHeader("x-cache-hit", "false");
  res.setHeader("x-cache-bytes-in", String(bodyText.length));
  res.setHeader("x-cache-bytes-out", String(upstreamResponse.body.length));
  sendJson(res, upstreamResponse.status, upstreamJson);
}

async function handlePassthrough(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: {
    upstreamBaseURL: string;
    apiKey: string;
    fetchImpl: typeof fetch;
    upstreamTimeoutMs: number;
    stats: SidecarProxyStats;
  },
  alreadyReadBody?: string,
): Promise<void> {
  ctx.stats.forwarded++;
  const method = req.method ?? "GET";
  const url = req.url ?? "/";
  // The proxy's URL prefix is `/v1` per OpenAI compat; the upstream base URL
  // also ends with `/v1`. So we route by stripping `/v1` from the incoming
  // path and re-appending after the base. Map other prefixes (`/api/...`)
  // by appending them after the upstream HOST (without `/v1`).
  const upstreamPath = remapPath(url, ctx.upstreamBaseURL);
  const body = alreadyReadBody ?? (await readBody(req));
  const headers: Record<string, string> = {
    Authorization: `Bearer ${ctx.apiKey}`,
  };
  // Copy a small set of safe inbound headers.
  const contentType = req.headers["content-type"];
  if (typeof contentType === "string") headers["Content-Type"] = contentType;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.upstreamTimeoutMs);
  if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }
  let upstream: Response;
  try {
    upstream = await ctx.fetchImpl(upstreamPath, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  res.statusCode = upstream.status;
  upstream.headers.forEach((value, key) => {
    if (key.toLowerCase() === "content-length") return;
    res.setHeader(key, value);
  });
  const text = await upstream.text();
  res.end(text);
}

interface UpstreamResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  latencyMs: number;
}

async function forward(
  upstreamUrl: string,
  body: string,
  ctx: {
    apiKey: string;
    fetchImpl: typeof fetch;
    upstreamTimeoutMs: number;
  },
): Promise<UpstreamResult> {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.upstreamTimeoutMs);
  if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }
  let resp: Response;
  try {
    resp = await ctx.fetchImpl(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.apiKey}`,
      },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const headers: Record<string, string> = {};
  resp.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const text = await resp.text();
  return {
    status: resp.status,
    headers,
    body: text,
    latencyMs: Date.now() - t0,
  };
}

function remapPath(incomingUrl: string, upstreamBaseURL: string): string {
  // upstreamBaseURL is typically `http://host:port/v1`.
  // For `/v1/...` paths: replace `/v1` prefix with upstreamBaseURL (already
  // contains `/v1`).
  // For `/api/...` paths (Ollama-native): forward to upstreamHost + path.
  if (incomingUrl.startsWith("/v1/")) {
    return `${upstreamBaseURL}${incomingUrl.slice(3)}`;
  }
  // Strip the `/v1` from the base for non-`/v1` paths.
  const base = upstreamBaseURL.replace(/\/v1$/, "");
  return `${base}${incomingUrl}`;
}

function openAIWrap(model: string, content: string): unknown {
  return {
    id: `proxy-cached-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

function extractContent(json: unknown): string | null {
  if (typeof json !== "object" || json === null) return null;
  const j = json as {
    choices?: Array<{
      message?: { content?: string | null; reasoning?: string | null };
    }>;
  };
  const message = j.choices?.[0]?.message;
  if (!message) return null;
  const content = message.content;
  if (typeof content === "string" && content.length > 0) return content;
  // Reasoning-fallback (thinking-mode models) — same shape as OpenAIProvider.
  const reasoning = message.reasoning;
  if (typeof reasoning === "string" && reasoning.length > 0) return reasoning;
  return null;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function stripSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function isLocalBase(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal)/i.test(url);
}
