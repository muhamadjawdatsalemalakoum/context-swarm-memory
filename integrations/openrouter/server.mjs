/**
 * OpenRouter shim — sidecar-compatible, DEV/TESTING ONLY.
 *
 * Speaks the exact contract of integrations/claude-agent/server.mjs so every
 * gate script (answer-arms, judge-arms, headtohead-arms) works unchanged:
 * point CSM_AGENT_BASE_URL at this port and pass --model <openrouter-model>.
 * Cache keys include the model string, so runs through this shim can never
 * collide with sonnet-5-instrument cache entries.
 *
 * WHY IT EXISTS (2026-08-23): OpenRouter's stealth/ox-alpha is free for a few
 * days, which makes it useful for plumbing tests and lever iteration without
 * spending Claude usage. THE BOUNDARY: it is an UNCALIBRATED third instrument.
 * The judge calibration (rho 0.864 vs the official Gemini judge) was
 * established for claude-sonnet-5 only. Numbers produced through this shim
 * must never be mixed into the sonnet-5 scoreboard or any published claim;
 * an A/B is valid only if BOTH arms and the judge run on the same model.
 * Stealth models are free because prompts are logged upstream — benchmark
 * corpora only, never anything sensitive.
 *
 * Endpoints:
 *   GET  /health    -> { ok, model, sdk: "openrouter-shim" }
 *   POST /complete  -> { text, usage: { inputTokens, outputTokens }, latencyMs }
 *        body: { system, prompt, model?, maxTokens?, jsonMode? }
 *
 * Auth: OPENROUTER_API_KEY from the environment or the repo-root .env
 * (gitignored). The key is never logged and is redacted from error bodies.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Load repo-root .env WITHOUT overriding anything already exported. */
function loadDotEnv() {
  try {
    const text = readFileSync(join(HERE, "..", "..", ".env"), "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch {
    /* no .env — rely on the shell environment */
  }
}
loadDotEnv();

const KEY = process.env.OPENROUTER_API_KEY ?? "";
const DEFAULT_MODEL = process.env.CSM_OPENROUTER_MODEL ?? "stealth/ox-alpha";
const PORT = Number.parseInt(process.env.OPENROUTER_SHIM_PORT ?? "8788", 10);
const BASE = "https://openrouter.ai/api/v1";

const JSON_NUDGE =
  "\n\nRespond with a single valid JSON object and nothing else — no prose, no code fences.";

function redact(s) {
  return String(s).replaceAll(KEY, "sk-or-***");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function complete({ system, prompt, model, maxTokens, jsonMode }) {
  const started = Date.now();
  // Free-tier providers rate-limit aggressively. A 429 surfaced to the gate
  // scripts becomes an EXCLUDED pair, and selective exclusion is survivorship
  // bias — the poison that invalidated the first rep3 artifact. So the shim
  // absorbs 429/5xx with capped exponential backoff (Retry-After honoured)
  // and only fails after the retries are spent.
  const MAX_TRIES = 6;
  let lastErr = "";
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const out = await completeOnce({ system, prompt, model, maxTokens, jsonMode, started });
    if (!out.retryable) {
      if (out.error) throw new Error(out.error);
      return out.value;
    }
    lastErr = out.error;
    const retryAfter = Number(out.retryAfter);
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, 60_000)
      : Math.min(2000 * 2 ** attempt, 60_000);
    await sleep(waitMs);
  }
  throw new Error(`retries exhausted: ${lastErr}`);
}

async function completeOnce({ system, prompt, model, maxTokens, jsonMode, started }) {
  let res;
  try {
    res = await fetch(`${BASE}/chat/completions`, {
    // A request that never completes would freeze a jobs=1 pipeline forever —
    // observed 2026-08-23: 24 minutes of silence on one hung upstream call.
    // Timeouts are retryable, same as 429s.
    signal: AbortSignal.timeout(120_000),
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${KEY}`,
      // OpenRouter attribution headers (optional, plain identifiers only).
      "HTTP-Referer": "https://localhost/csm-dev",
      "X-Title": "csm-dev-shim",
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      temperature: 0,
      max_tokens: maxTokens ?? 2048,
      messages: [
        { role: "system", content: jsonMode ? `${system}${JSON_NUDGE}` : system },
        { role: "user", content: prompt },
      ],
    }),
  });
  } catch (err) {
    return { retryable: true, error: `upstream ${err?.name ?? "error"}: ${redact(err?.message ?? err).slice(0, 200)}` };
  }
  let bodyText;
  try {
    bodyText = await res.text();
  } catch (err) {
    return { retryable: true, error: `body read failed: ${redact(err?.message ?? err).slice(0, 200)}` };
  }
  if (!res.ok) {
    const error = `openrouter HTTP ${res.status}: ${redact(bodyText).slice(0, 400)}`;
    return {
      retryable: res.status === 429 || res.status >= 500,
      error,
      retryAfter: res.headers.get("retry-after"),
    };
  }
  const j = JSON.parse(bodyText);
  const text = j.choices?.[0]?.message?.content ?? "";
  return {
    retryable: false,
    value: {
      text,
      usage: {
        inputTokens: j.usage?.prompt_tokens ?? null,
        outputTokens: j.usage?.completion_tokens ?? null,
      },
      latencyMs: Date.now() - started,
    },
  };
}

const server = createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  try {
    if (req.method === "GET" && req.url === "/health") {
      return send(200, { ok: Boolean(KEY), model: DEFAULT_MODEL, sdk: "openrouter-shim" });
    }
    if (req.method === "POST" && req.url === "/complete") {
      if (!KEY) return send(500, { error: "OPENROUTER_API_KEY is not set (.env or shell)" });
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return send(200, await complete(body));
    }
    return send(404, { error: "not found" });
  } catch (err) {
    return send(500, { error: redact(err?.message ?? err).slice(0, 600) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`openrouter shim on http://127.0.0.1:${PORT} (model ${DEFAULT_MODEL})\n`);
});
