#!/usr/bin/env node
/**
 * Launcher: starts the LLM-cache proxy as a standalone process.
 *
 * Usage:
 *   tsx scripts/start-llm-cache-proxy.ts                       # port 8090
 *   PORT=9090 tsx scripts/start-llm-cache-proxy.ts
 *   CSM_OPENAI_BASE_URL=http://localhost:11434/v1 tsx ...     # upstream
 *
 * The proxy listens on `127.0.0.1:8090` by default and forwards cache misses
 * to `CSM_OPENAI_BASE_URL` (defaults to Ollama on 11434). All sidecars point
 * at this proxy so their internal LLM calls share the existing
 * `data/eval/cache/` content-hashed cache.
 *
 * Run this alongside any Phase γ sidecar (Mem0, HippoRAG, LightRAG).
 * Keeps running until Ctrl+C.
 */
import { startSidecarProxy } from "../src/eval/sidecarProxy.js";

const port = Number(process.env.PORT ?? 8090);
const upstreamBaseURL =
  process.env.CSM_OPENAI_BASE_URL ?? "http://localhost:11434/v1";

const { server, stats } = startSidecarProxy({
  port,
  upstreamBaseURL,
});

console.log(
  `[llm-cache-proxy] listening on http://127.0.0.1:${port}\n` +
    `  upstream: ${upstreamBaseURL}\n` +
    `  cache:    data/eval/cache/\n` +
    `  Ctrl+C to stop.`,
);

// Log stats every 60s so the operator can see hit-rate without parsing tail.
const reportInterval = setInterval(() => {
  console.log(
    `[llm-cache-proxy] hits=${stats.hits} misses=${stats.misses} forwarded=${stats.forwarded} errors=${stats.errors}`,
  );
}, 60_000);

// Clean shutdown.
process.on("SIGINT", () => {
  clearInterval(reportInterval);
  server.close(() => {
    console.log("[llm-cache-proxy] shutdown.");
    process.exit(0);
  });
});
process.on("SIGTERM", () => {
  clearInterval(reportInterval);
  server.close(() => {
    process.exit(0);
  });
});
