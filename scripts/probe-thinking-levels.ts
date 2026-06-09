/** One-off diagnostic: which `thinkingConfig.thinkingLevel` values does the
 *  active Gemini model accept, and what do they cost in latency/thought
 *  tokens for a probe-shaped call? Reads GEMINI_API_KEY from env/.env via the
 *  same loader as the CLI. Never prints the key. */
import { loadLocalEnv } from "../src/utils/loadEnv.js";

loadLocalEnv();

const KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";
const MODEL = process.argv[2] ?? process.env.CSM_GEMINI_MODEL ?? "gemini-3.5-flash";
const BASE = "https://generativelanguage.googleapis.com/v1beta";

const PROBE_SYSTEM = `You are a read-only memory shard witness. Decide if this shard can help answer the user query.

[Shard s-test@S001]
Summary:
Synthetic shard s-test (12 events) about PaySwift authentication, password hashing, and session lockout policy.

Available events (id + tags + first chars):
- [e0001] tags=[auth] "Team chose PBKDF2 with SHA256 for password hashing"
- [e0002] tags=[auth,session] "Lockout after 5 failed attempts for 15 minutes"
- [e0003] tags=[db] "SQLite chosen for MVP, Postgres later"`;

const PROBE_PROMPT = `User query: "What hashing algorithm protects stored passwords?"

Return JSON: {"knows": bool, "confidence": 0-1, "memory_type": "direct|adjacent|conflicting|vague|none", "estimated_answer_value": "none|low|medium|high", "needs_full_recall": bool, "relevant_event_ids": [..]}`;

interface Trial {
  label: string;
  thinkingConfig: Record<string, unknown> | undefined;
}

const trials: Trial[] = [
  { label: "none", thinkingConfig: { thinkingLevel: "none" } },
  { label: "minimal", thinkingConfig: { thinkingLevel: "minimal" } },
  { label: "low", thinkingConfig: { thinkingLevel: "low" } },
  { label: "thinkingBudget:0", thinkingConfig: { thinkingBudget: 0 } },
  { label: "(absent)", thinkingConfig: undefined },
];

async function run(): Promise<void> {
  if (!KEY) throw new Error("No GEMINI_API_KEY in env/.env");
  console.log(`model=${MODEL}`);
  for (const t of trials) {
    const body = {
      systemInstruction: { parts: [{ text: PROBE_SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: PROBE_PROMPT }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 1024,
        responseMimeType: "application/json",
        ...(t.thinkingConfig ? { thinkingConfig: t.thinkingConfig } : {}),
      },
    };
    const start = Date.now();
    try {
      const res = await fetch(`${BASE}/models/${MODEL}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
        body: JSON.stringify(body),
      });
      const ms = Date.now() - start;
      const json = (await res.json()) as {
        error?: { message?: string };
        candidates?: Array<{ finishReason?: string }>;
        usageMetadata?: {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
          thoughtsTokenCount?: number;
          totalTokenCount?: number;
        };
      };
      if (!res.ok || json.error) {
        console.log(
          `${t.label.padEnd(18)} HTTP ${res.status} ${String(json.error?.message ?? "").slice(0, 140)}`,
        );
        continue;
      }
      const u = json.usageMetadata ?? {};
      console.log(
        `${t.label.padEnd(18)} ok ${String(ms).padStart(5)}ms  prompt=${u.promptTokenCount} out=${u.candidatesTokenCount} thoughts=${u.thoughtsTokenCount ?? 0} finish=${json.candidates?.[0]?.finishReason}`,
      );
    } catch (err) {
      console.log(`${t.label.padEnd(18)} FAIL ${(err as Error).message.slice(0, 140)}`);
    }
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
