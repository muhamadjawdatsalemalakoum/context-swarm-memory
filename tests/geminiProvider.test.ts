import { describe, expect, it } from "vitest";

import {
  GEMINI_DEFAULT_BASE_URL,
  GEMINI_DEFAULT_MODEL,
  GeminiProvider,
} from "../src/providers/GeminiProvider.js";
import {
  selectProviderName,
  type ProviderEnv,
} from "../src/providers/LlmProvider.js";

describe("GeminiProvider", () => {
  it("is selectable with CSM_PROVIDER=gemini", () => {
    const env: ProviderEnv = { CSM_PROVIDER: "gemini" };
    expect(selectProviderName(env)).toBe("gemini");
  });

  it("sends Gemini JSON mode requests without leaking the key into headers", async () => {
    let url = "";
    let body: Record<string, unknown> = {};
    let apiKeyHeader = "";
    const provider = new GeminiProvider({
      apiKey: "secret-key",
      defaultModel: GEMINI_DEFAULT_MODEL,
      fetchImpl: async (input, init) => {
        url = String(input);
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        apiKeyHeader = new Headers(init?.headers).get("x-goog-api-key") ?? "";
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const result = await provider.completeJson<{ ok: boolean }>({
      system: "Return JSON only.",
      prompt: "ping",
      schemaName: "Ping",
      maxOutputTokens: 64,
      temperature: 0,
    });

    expect(url).toBe(`${GEMINI_DEFAULT_BASE_URL}/models/${GEMINI_DEFAULT_MODEL}:generateContent`);
    expect(apiKeyHeader).toBe("secret-key");
    expect(body).toMatchObject({
      systemInstruction: { parts: [{ text: "Return JSON only." }] },
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 64,
        thinkingConfig: { thinkingLevel: "low" },
        responseMimeType: "application/json",
      },
    });
    expect(result.rawText).toBe('{"ok":true}');
    expect(result.usage.inputTokensEstimate).toBe(10);
    expect(result.usage.outputTokensEstimate).toBe(3);
  });

  it("adds native Gemini responseJsonSchema for CSM structured stages", async () => {
    let body: Record<string, unknown> = {};
    const provider = new GeminiProvider({
      apiKey: "secret-key",
      defaultModel: GEMINI_DEFAULT_MODEL,
      fetchImpl: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        query: "q",
                        summary: "s",
                        key_claims: [],
                        caveats: [],
                        conflicts: [],
                        recommended_main_context: "ctx",
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    await provider.completeJson({
      system: "Return JSON only.",
      prompt: "ping",
      schemaName: "MemoryPacket",
      maxOutputTokens: 1024,
      temperature: 0,
    });

    const generationConfig = body.generationConfig as {
      responseJsonSchema?: {
        type?: string;
        required?: string[];
        properties?: Record<string, unknown>;
      };
    };
    expect(generationConfig.responseJsonSchema).toMatchObject({
      type: "object",
      properties: {
        key_claims: { type: "array" },
        recommended_main_context: { type: "string" },
      },
    });
    expect(generationConfig.responseJsonSchema?.required).toContain("key_claims");
    expect(generationConfig.responseJsonSchema?.required).toContain("recommended_main_context");
  });

  it("retries transient Gemini transport failures without changing the prompt", async () => {
    let attempts = 0;
    const provider = new GeminiProvider({
      apiKey: "secret-key",
      defaultModel: GEMINI_DEFAULT_MODEL,
      maxRetries: 2,
      retryBaseDelayMs: 0,
      fetchImpl: async () => {
        attempts += 1;
        if (attempts === 1) {
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          throw err;
        }
        if (attempts === 2) {
          throw new TypeError("fetch failed");
        }
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "ok" }] } }],
            usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const result = await provider.completeText({
      system: "Be brief.",
      prompt: "ping",
      maxOutputTokens: 16,
    });

    expect(attempts).toBe(3);
    expect(result.rawText).toBe("ok");
    expect(result.usage.inputTokensEstimate).toBe(4);
  });

  it("redacts the API key in error messages", async () => {
    const provider = new GeminiProvider({
      apiKey: "secret-key",
      defaultModel: GEMINI_DEFAULT_MODEL,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ error: { message: "bad key", status: "UNAUTHENTICATED" } }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    });

    await expect(
      provider.completeText({
        system: "Be brief.",
        prompt: "ping",
        maxOutputTokens: 16,
      }),
    ).rejects.toThrow(/generateContent/);
    await expect(
      provider.completeText({
        system: "Be brief.",
        prompt: "ping",
        maxOutputTokens: 16,
      }),
    ).rejects.not.toThrow(/secret-key/);
  });
});
