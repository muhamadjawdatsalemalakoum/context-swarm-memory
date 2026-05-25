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
      defaultModel: "gemini-test",
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

    expect(url).toBe(`${GEMINI_DEFAULT_BASE_URL}/models/gemini-test:generateContent`);
    expect(apiKeyHeader).toBe("secret-key");
    expect(body).toMatchObject({
      systemInstruction: { parts: [{ text: "Return JSON only." }] },
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 64,
        responseMimeType: "application/json",
      },
    });
    expect(result.rawText).toBe('{"ok":true}');
    expect(result.usage.inputTokensEstimate).toBe(10);
    expect(result.usage.outputTokensEstimate).toBe(3);
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
