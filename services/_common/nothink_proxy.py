"""
Thinking-disable translation shim for SOTA sidecars (Mem0 / LightRAG / HippoRAG).

Problem: gemma4:31b on Ollama is a thinking model. On the OpenAI-compat
`/v1/chat/completions` path (which the sidecars' `openai` clients use), the
model's answer goes to a `reasoning` channel and `content` comes back EMPTY —
worse, with `response_format: {"type":"json_object"}` it's reliably empty.
Mem0/LightRAG then fail to parse the (empty) extraction response. Ollama's
`/v1` endpoint ignores `think:false`; only the native `/api/chat` honors it.

Fix: this shim speaks `/v1/chat/completions` to the sidecar but forwards to
Ollama's native `/api/chat` with `think: false`, so the model emits clean
(unfenced) JSON in `message.content`. It strips `response_format` (the
json_object constraint is what empties content) and maps the response back to
the OpenAI shape the sidecars expect. Embeddings are NOT routed here — point
the sidecars' embed endpoint straight at Ollama (`/v1/embeddings`), since
embeddings have no thinking channel.

Run (in any venv with fastapi+uvicorn+httpx, e.g. .venv-mem0):
    NOTHINK_UPSTREAM=http://127.0.0.1:11434 NOTHINK_PORT=8091 \
        python services/_common/nothink_proxy.py

Then set the sidecar LLM endpoint to http://127.0.0.1:8091/v1 and keep the
embed endpoint at http://127.0.0.1:11434/v1.
"""
from __future__ import annotations

import os
import time

import httpx
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

UPSTREAM = os.environ.get("NOTHINK_UPSTREAM", "http://127.0.0.1:11434").rstrip("/")
PORT = int(os.environ.get("NOTHINK_PORT", "8091"))
HOST = os.environ.get("NOTHINK_HOST", "127.0.0.1")
TIMEOUT = float(os.environ.get("NOTHINK_TIMEOUT_S", "1800"))

app = FastAPI(title="nothink-proxy", version="0.1.0")


def _unfence(text: str) -> str:
    """Strip a leading/trailing markdown code fence (```json ... ``` or ``` ... ```).

    Returns the inner body if fenced; otherwise the original text unchanged.
    """
    s = text.strip()
    if not s.startswith("```"):
        return text
    # Drop the opening fence line (``` or ```json) and the closing ```.
    lines = s.splitlines()
    if lines and lines[0].startswith("```"):
        lines = lines[1:]
    if lines and lines[-1].strip().startswith("```"):
        lines = lines[:-1]
    return "\n".join(lines).strip()


@app.get("/health")
def health() -> dict:
    return {"ready": True, "upstream": UPSTREAM, "mode": "api/chat think=false"}


@app.post("/v1/chat/completions")
async def chat_completions(req: Request) -> JSONResponse:
    body = await req.json()
    model = body.get("model", "gemma4:31b")
    messages = body.get("messages", [])
    # Carry through the generation knobs the sidecars set.
    options: dict = {}
    if "temperature" in body and body["temperature"] is not None:
        options["temperature"] = body["temperature"]
    if "top_p" in body and body["top_p"] is not None:
        options["top_p"] = body["top_p"]
    max_toks = body.get("max_tokens") or body.get("max_completion_tokens")
    if max_toks:
        options["num_predict"] = int(max_toks)

    ollama_body = {
        "model": model,
        "messages": messages,
        "stream": False,
        "think": False,  # the whole point — clean content, no reasoning channel
        "options": options,
    }

    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        r = await client.post(f"{UPSTREAM}/api/chat", json=ollama_body)
        r.raise_for_status()
        data = r.json()

    msg = data.get("message", {}) or {}
    content = msg.get("content", "") or ""
    # Belt-and-suspenders: if a build still routed the answer to thinking, fall
    # back to it so downstream parsers at least see something.
    if not content.strip():
        content = msg.get("thinking", "") or ""
    # Strip markdown code fences. The sidecars send response_format=json_object
    # (which we drop, since it empties content on this model), so they then
    # call json.loads() on the raw content expecting bare JSON. gemma4 wraps
    # its answer in ```json ... ``` — unwrap it so the parse succeeds.
    content = _unfence(content)

    prompt_tokens = int(data.get("prompt_eval_count", 0) or 0)
    completion_tokens = int(data.get("eval_count", 0) or 0)
    now = int(time.time())
    openai_shape = {
        "id": f"chatcmpl-nothink-{now}",
        "object": "chat.completion",
        "created": now,
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": data.get("done_reason", "stop") or "stop",
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
    }
    return JSONResponse(openai_shape)


if __name__ == "__main__":
    print(
        f"[nothink-proxy] /v1/chat/completions -> {UPSTREAM}/api/chat (think=false) "
        f"on http://{HOST}:{PORT}"
    )
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
