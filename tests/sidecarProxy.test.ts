import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  startSidecarProxy,
  type SidecarProxyOptions,
} from "../src/eval/sidecarProxy.js";
import { closeServer, serverPort, waitForServer } from "./helpers.js";

/**
 * LLM-cache proxy contract — Phase γ sidecar fairness.
 *
 * The proxy interposes on Python-sidecar LLM traffic so HippoRAG / LightRAG /
 * Mem0 indexing AND query-time LLM calls share the same content-hashed cache
 * as the rest of the bench. Without this, replay determinism breaks the
 * moment a Python sidecar calls Gemma 4 31B inside its own process.
 *
 * These tests pin the cache-hit/miss contract end-to-end:
 *   - Same prompt twice → first call forwards, second returns cached.
 *   - Different prompt → both forward.
 *   - `think: false` distinct cache key from default.
 *   - Stream requests bypass cache transparently.
 *   - Non-cached endpoints (embeddings, /v1/models) passthrough.
 */

interface UpstreamCall {
  url: string;
  body: string | undefined;
  method: string;
}

function makeMockUpstream(): {
  fetchImpl: typeof fetch;
  calls: UpstreamCall[];
  setResponse: (content: string) => void;
} {
  const calls: UpstreamCall[] = [];
  let nextContent = "default response";
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    calls.push({
      url,
      body: typeof init?.body === "string" ? init.body : undefined,
      method: init?.method ?? "GET",
    });
    // Simulate an OpenAI-compat chat completion response.
    return new Response(
      JSON.stringify({
        id: "mock-1",
        object: "chat.completion",
        created: 1234,
        model: "stub-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: nextContent },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return {
    fetchImpl,
    calls,
    setResponse: (content: string) => {
      nextContent = content;
    },
  };
}

async function postChat(
  port: number,
  body: unknown,
): Promise<{ status: number; headers: Headers; json: unknown }> {
  // Use the global fetch (Undici); local proxy is a real HTTP server.
  const resp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test",
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: resp.status, headers: resp.headers, json };
}

async function startTestProxy(
  opts: Omit<SidecarProxyOptions, "port">,
): Promise<ReturnType<typeof startSidecarProxy>> {
  const proxy = startSidecarProxy({ ...opts, port: 0 });
  await waitForServer(proxy.server);
  return { ...proxy, port: serverPort(proxy.server) };
}

describe("sidecarProxy — Phase γ cache fairness", () => {
  let cacheRoot: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "csm-proxy-test-"));
  });

  afterEach(async () => {
    try {
      await rm(cacheRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("cache miss forwards to upstream; second identical call is a hit", async () => {
    const upstream = makeMockUpstream();
    upstream.setResponse("hello world response");
    const { server, stats, port } = await startTestProxy({
      upstreamBaseURL: "http://localhost:99999/v1", // dummy; fetchImpl bypasses
      fetchImpl: upstream.fetchImpl,
      cacheRoot,
    });
    try {
      const body = {
        model: "stub-model",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "say hi" },
        ],
        temperature: 0,
        max_tokens: 16,
      };

      const r1 = await postChat(port, body);
      expect(r1.status).toBe(200);
      expect(r1.headers.get("x-cache-hit")).toBe("false");
      expect(stats.misses).toBe(1);
      expect(stats.hits).toBe(0);
      expect(upstream.calls.length).toBe(1);
      const c1 = r1.json as {
        choices: Array<{ message: { content: string } }>;
      };
      expect(c1.choices[0]!.message.content).toBe("hello world response");

      // Same body → hit. Even if upstream would return something different now.
      upstream.setResponse("THIS SHOULD NOT BE RETURNED");
      const r2 = await postChat(port, body);
      expect(r2.status).toBe(200);
      expect(r2.headers.get("x-cache-hit")).toBe("true");
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1); // unchanged
      expect(upstream.calls.length).toBe(1); // unchanged — no upstream fetch
      const c2 = r2.json as {
        choices: Array<{ message: { content: string } }>;
      };
      expect(c2.choices[0]!.message.content).toBe("hello world response");
    } finally {
      await closeServer(server);
    }
  });

  it("different prompts produce different cache keys (both miss)", async () => {
    const upstream = makeMockUpstream();
    const { server, stats, port } = await startTestProxy({
      fetchImpl: upstream.fetchImpl,
      cacheRoot,
    });
    try {
      const body1 = {
        model: "stub",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "prompt one" },
        ],
        temperature: 0,
        max_tokens: 16,
      };
      const body2 = { ...body1, messages: [body1.messages[0]!, { role: "user", content: "prompt two" }] };

      const r1 = await postChat(port, body1);
      const r2 = await postChat(port, body2);
      expect(r1.headers.get("x-cache-hit")).toBe("false");
      expect(r2.headers.get("x-cache-hit")).toBe("false");
      expect(stats.misses).toBe(2);
      expect(upstream.calls.length).toBe(2);
    } finally {
      await closeServer(server);
    }
  });

  it("`think: false` produces a distinct cache key from default (no false hit)", async () => {
    const upstream = makeMockUpstream();
    const { server, stats, port } = await startTestProxy({
      fetchImpl: upstream.fetchImpl,
      cacheRoot,
    });
    try {
      const base = {
        model: "stub",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hi" },
        ],
        temperature: 0,
        max_tokens: 16,
      };
      // First call: default (thinking on)
      const r1 = await postChat(port, base);
      expect(r1.headers.get("x-cache-hit")).toBe("false");
      // Second call: same prompt but think:false → distinct key, miss again
      const r2 = await postChat(port, { ...base, think: false });
      expect(r2.headers.get("x-cache-hit")).toBe("false");
      expect(stats.misses).toBe(2);
    } finally {
      await closeServer(server);
    }
  });

  it("does NOT cache when upstream returns empty content (preserves retry semantics)", async () => {
    const upstream = makeMockUpstream();
    // Empty response — should bypass cache writes.
    upstream.setResponse("");
    const { server, stats, port } = await startTestProxy({
      fetchImpl: upstream.fetchImpl,
      cacheRoot,
    });
    try {
      const body = {
        model: "stub",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hi" },
        ],
        temperature: 0,
        max_tokens: 16,
      };
      // First call: miss + forward.
      await postChat(port, body);
      // Second identical call: should still be a miss (empty response wasn't
      // cached) and re-forwards.
      await postChat(port, body);
      expect(stats.misses).toBe(2);
      expect(stats.hits).toBe(0);
      expect(upstream.calls.length).toBe(2);
    } finally {
      await closeServer(server);
    }
  });

  it("streaming requests pass through without caching", async () => {
    const upstream = makeMockUpstream();
    const { server, stats, port } = await startTestProxy({
      fetchImpl: upstream.fetchImpl,
      cacheRoot,
    });
    try {
      const body = {
        model: "stub",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hi" },
        ],
        temperature: 0,
        max_tokens: 16,
        stream: true,
      };
      await postChat(port, body);
      await postChat(port, body);
      // Both should hit upstream — no caching for stream:true.
      expect(stats.hits).toBe(0);
      expect(upstream.calls.length).toBe(2);
    } finally {
      await closeServer(server);
    }
  });

  it("passes through non-cached endpoints (e.g. /v1/embeddings)", async () => {
    const upstream = makeMockUpstream();
    const { server, stats, port } = await startTestProxy({
      fetchImpl: upstream.fetchImpl,
      cacheRoot,
    });
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: "hello", model: "embed-stub" }),
      });
      // Drain.
      await resp.text();
      expect(stats.forwarded).toBe(1);
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(upstream.calls.length).toBe(1);
    } finally {
      await closeServer(server);
    }
  });

  it("emits x-cache-bytes-in and x-cache-bytes-out headers", async () => {
    const upstream = makeMockUpstream();
    upstream.setResponse("a meaningful response longer than 5 chars");
    const { server, port } = await startTestProxy({
      fetchImpl: upstream.fetchImpl,
      cacheRoot,
    });
    try {
      const body = {
        model: "stub",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "the user prompt" },
        ],
        temperature: 0,
        max_tokens: 16,
      };
      const r1 = await postChat(port, body);
      expect(Number(r1.headers.get("x-cache-bytes-in"))).toBeGreaterThan(0);
      expect(Number(r1.headers.get("x-cache-bytes-out"))).toBeGreaterThan(0);
    } finally {
      await closeServer(server);
    }
  });
});
