/**
 * CSM ⇄ Claude Agent SDK sidecar.
 *
 * WHY A SIDECAR AND NOT A DIRECT DEPENDENCY:
 * `@anthropic-ai/claude-agent-sdk` peer-requires zod 4; CSM is pinned to zod 3
 * (src/core/schemas.ts and every provider schema). Installing it into the root
 * package.json forces `--legacy-peer-deps` and risks destabilising the frozen,
 * already-benchmarked pipeline. Instead this directory owns its own
 * node_modules, and CSM talks to it over localhost with plain `fetch` — zero new
 * dependencies in the main repo.
 *
 * AUTH: the Agent SDK authenticates through Claude Code's own credential chain,
 * so this runs on a Claude subscription rather than a metered API key. A spawned
 * subprocess cannot refresh an interactive OAuth session, so create a long-lived
 * token first:
 *
 *     claude setup-token
 *
 * Then export whatever it gives you (typically ANTHROPIC_AUTH_TOKEN) before
 * starting this server. Never commit the token; never pass it as an argv flag.
 *
 * REPRODUCIBILITY: results produced through this path are NOT independently
 * reproducible — a third party cannot replay them with their own API key. Use it
 * for iteration only. Any published number must come from a documented,
 * key-based provider (CSM_PROVIDER=gemini).
 *
 * Endpoints:
 *   GET  /health    -> { ok, model, sdk }
 *   POST /complete  -> { text, usage: { inputTokens, outputTokens }, latencyMs }
 *        body: { system, prompt, maxTokens?, model?, jsonMode? }
 */
import { createServer } from "node:http";
import { query } from "@anthropic-ai/claude-agent-sdk";

const PORT = Number.parseInt(process.env.CSM_AGENT_PORT ?? "8787", 10);
const DEFAULT_MODEL = process.env.CSM_AGENT_MODEL ?? "claude-opus-5";
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Instruction appended for JSON stages. CSM's `completeAndValidate` still runs
 *  extractJson + Zod + retry downstream, so this only has to get us close. */
const JSON_NUDGE =
  "\n\nOutput ONLY the raw JSON object. No prose, no explanation, no markdown code fences.";

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Collect a single-turn completion. Tools are disabled: CSM needs a pure
 *  text/JSON completion, not an agent loop with filesystem access. */
async function complete({ system, prompt, model, jsonMode }) {
  const started = Date.now();
  let text = "";
  let usage = null;

  const q = query({
    prompt,
    options: {
      systemPrompt: jsonMode ? `${system}${JSON_NUDGE}` : system,
      maxTurns: 1,
      tools: [],
      model: model || DEFAULT_MODEL,
    },
  });

  for await (const message of q) {
    // Message shapes vary across SDK versions; accept both the flat and the
    // nested (`message.message.content`) forms rather than pinning to one.
    const content = message?.content ?? message?.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string") text += block.text;
      }
    }
    if (message?.type === "result_message" || message?.type === "result") {
      usage = message.usage ?? message?.message?.usage ?? null;
      // Some versions return the final answer only on the result message.
      if (!text && typeof message.result === "string") text = message.result;
    }
  }

  return {
    text,
    usage: {
      inputTokens: usage?.input_tokens ?? usage?.inputTokens ?? null,
      outputTokens: usage?.output_tokens ?? usage?.outputTokens ?? null,
    },
    latencyMs: Date.now() - started,
  };
}

const server = createServer(async (req, res) => {
  const send = (code, payload) => {
    const body = JSON.stringify(payload);
    res.writeHead(code, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  };

  try {
    if (req.method === "GET" && req.url === "/health") {
      return send(200, { ok: true, model: DEFAULT_MODEL, sdk: "claude-agent-sdk" });
    }

    if (req.method === "POST" && req.url === "/complete") {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(400, { error: "invalid JSON body" });
      }
      if (typeof body?.prompt !== "string" || !body.prompt) {
        return send(400, { error: "`prompt` (non-empty string) is required" });
      }
      const result = await complete({
        system: typeof body.system === "string" ? body.system : "",
        prompt: body.prompt,
        model: typeof body.model === "string" ? body.model : undefined,
        jsonMode: body.jsonMode === true,
      });
      if (!result.text) {
        return send(502, { error: "empty completion from Agent SDK", latencyMs: result.latencyMs });
      }
      return send(200, result);
    }

    return send(404, { error: "not found" });
  } catch (err) {
    // Auth failures are the common case; surface them verbatim so the operator
    // knows to re-run `claude setup-token` rather than debugging CSM.
    return send(500, { error: String(err?.message ?? err).slice(0, 600) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[csm-claude-agent] listening on http://127.0.0.1:${PORT}  model=${DEFAULT_MODEL}`);
  console.log(`[csm-claude-agent] health: curl -s http://127.0.0.1:${PORT}/health`);
});
