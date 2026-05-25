import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAIProvider } from "../src/providers/OpenAIProvider.js";

describe("OpenAIProvider (fetch-mocked)", () => {
  let calls: Array<{ url: string; init: RequestInit }>;

  function makeProvider(opts?: {
    handler?: (url: string, init: RequestInit) => Response | Promise<Response>;
    baseURL?: string;
    apiKey?: string;
    defaultModel?: string;
  }) {
    calls = [];
    const handler =
      opts?.handler ??
      (() =>
        new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: '{"ok":true}' } }],
            usage: { prompt_tokens: 12, completion_tokens: 5 },
            model: "gemma4:31b",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ));
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      calls.push({ url, init: init ?? {} });
      return handler(url, init ?? {});
    };
    return new OpenAIProvider({
      baseURL: opts?.baseURL ?? "http://localhost:11434/v1",
      apiKey: opts?.apiKey ?? "ollama",
      defaultModel: opts?.defaultModel ?? "gemma4:31b",
      fetchImpl,
    });
  }

  it("posts to /chat/completions with JSON-mode for completeJson", async () => {
    const p = makeProvider();
    const r = await p.completeJson<{ ok: boolean }>({
      system: "sys",
      prompt: "say hi",
      schemaName: "Ping",
      maxOutputTokens: 16,
      temperature: 0,
    });
    expect(r.rawText).toBe('{"ok":true}');
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(calls[0]!.init.method).toBe("POST");

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.model).toBe("gemma4:31b");
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "say hi" },
    ]);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.stream).toBe(false);
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(16);

    const headers = (calls[0]!.init.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ollama");
    expect(headers["Content-Type"]).toBe("application/json");

    expect(r.usage.inputTokensEstimate).toBe(12);
    expect(r.usage.outputTokensEstimate).toBe(5);
  });

  it("uses provider name 'ollama' for localhost, 'openai' otherwise", () => {
    const p1 = new OpenAIProvider({ baseURL: "http://localhost:11434/v1", apiKey: "x", fetchImpl: () => new Response("") as never });
    expect(p1.name).toBe("ollama");
    const p2 = new OpenAIProvider({ baseURL: "https://api.openai.com/v1", apiKey: "x", fetchImpl: () => new Response("") as never });
    expect(p2.name).toBe("openai");
  });

  it("auto-fills 'ollama' as apiKey for local base URL when none provided", async () => {
    const orig = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const p = new OpenAIProvider({
        baseURL: "http://localhost:11434/v1",
        defaultModel: "x",
        fetchImpl: async (_u, init) => {
          const headers = (init?.headers ?? {}) as Record<string, string>;
          expect(headers.Authorization).toBe("Bearer ollama");
          return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 });
        },
      });
      await p.completeJson({ system: "", prompt: "", schemaName: "x", maxOutputTokens: 1 });
    } finally {
      if (orig !== undefined) process.env.OPENAI_API_KEY = orig;
    }
  });

  it("throws clearly when no model is provided and no default is set", async () => {
    const orig = { CSM_OPENAI_MODEL: process.env.CSM_OPENAI_MODEL };
    delete process.env.CSM_OPENAI_MODEL;
    try {
      const p = new OpenAIProvider({
        baseURL: "http://localhost:11434/v1",
        apiKey: "ollama",
        fetchImpl: () => new Response("") as never,
      });
      await expect(
        p.completeJson({ system: "", prompt: "", schemaName: "x", maxOutputTokens: 1 }),
      ).rejects.toThrow(/no model specified/);
    } finally {
      if (orig.CSM_OPENAI_MODEL !== undefined) process.env.CSM_OPENAI_MODEL = orig.CSM_OPENAI_MODEL;
    }
  });

  it("surfaces HTTP errors with status and body snippet", async () => {
    const p = makeProvider({
      handler: () => new Response("model not found", { status: 404 }),
    });
    await expect(
      p.completeJson({ system: "", prompt: "", schemaName: "x", maxOutputTokens: 1 }),
    ).rejects.toThrow(/HTTP 404.*model not found/);
  });

  // Phase α: disableThinking suppresses Gemma 4 / DeepSeek R1 / Qwen 3
  // reasoning output via Ollama's native `think: false` body field. Silent
  // no-op on real OpenAI. These two tests pin the wire-format contract.
  it("forwards disableThinking=true as body.think=false on completeJson", async () => {
    const p = makeProvider();
    await p.completeJson({
      system: "sys",
      prompt: "hi",
      schemaName: "Ping",
      maxOutputTokens: 16,
      temperature: 0,
      disableThinking: true,
    });
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.think).toBe(false);
  });

  it("forwards disableThinking=true as body.think=false on completeText", async () => {
    const p = makeProvider({
      handler: () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "ANSWER: 1" } }],
            usage: { prompt_tokens: 5, completion_tokens: 3 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    await p.completeText({
      system: "sys",
      prompt: "answer this",
      maxOutputTokens: 16,
      temperature: 0,
      disableThinking: true,
    });
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.think).toBe(false);
  });

  it("omits body.think entirely when disableThinking is unset (back-compat)", async () => {
    const p = makeProvider();
    await p.completeJson({
      system: "sys",
      prompt: "hi",
      schemaName: "Ping",
      maxOutputTokens: 16,
      temperature: 0,
      // disableThinking intentionally not set
    });
    const body = JSON.parse(calls[0]!.init.body as string);
    expect("think" in body).toBe(false);
  });

  it("omits body.think when disableThinking is false (back-compat)", async () => {
    const p = makeProvider();
    await p.completeJson({
      system: "sys",
      prompt: "hi",
      schemaName: "Ping",
      maxOutputTokens: 16,
      temperature: 0,
      disableThinking: false,
    });
    const body = JSON.parse(calls[0]!.init.body as string);
    expect("think" in body).toBe(false);
  });
});
