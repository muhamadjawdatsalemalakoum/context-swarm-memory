"""
LightRAG sidecar — Phase γ CSM baseline.

Exposes the CSM sidecar protocol (POST /index, POST /query, GET /health) on
port 8002. Internally uses the `lightrag-hku` Python library against an
OpenAI-compatible LLM endpoint (the LLM-cache proxy at port 8090).

Citation roundtrip trick: each event is wrapped in `<<<EVT id=X>>> ...
<<<END>>>` markers at insert time. The chunker preserves the markers (default
1200-token chunks easily fit a ~30-token event); at retrieval time we regex
the returned chunk text for the markers to recover event IDs.

Contract: services/_common/sidecar_protocol.md
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import time
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

try:
    from lightrag import LightRAG, QueryParam  # type: ignore[import-not-found]
    from lightrag.llm.openai import openai_complete_if_cache  # type: ignore[import-not-found]
    from lightrag.utils import EmbeddingFunc  # type: ignore[import-not-found]
except ImportError as e:
    raise SystemExit(
        "lightrag-hku not installed. Install via:\n"
        "  pip install lightrag-hku\n"
        "Then re-run this sidecar. See services/lightrag-sidecar/requirements.txt."
    ) from e


# -- Configuration -------------------------------------------------------------

SIDECAR_PORT = int(os.environ.get("LIGHTRAG_SIDECAR_PORT", "8002"))
SIDECAR_HOST = os.environ.get("LIGHTRAG_SIDECAR_HOST", "127.0.0.1")
LLM_ENDPOINT = os.environ.get("LIGHTRAG_LLM_ENDPOINT", "http://127.0.0.1:8090/v1")
LLM_MODEL = os.environ.get("LIGHTRAG_LLM_MODEL", "gemma4:31b")
EMBED_ENDPOINT = os.environ.get("LIGHTRAG_EMBED_ENDPOINT", LLM_ENDPOINT)
EMBED_MODEL = os.environ.get("LIGHTRAG_EMBED_MODEL", "nomic-embed-text")
EMBED_DIM = int(os.environ.get("LIGHTRAG_EMBED_DIM", "768"))
INDEX_ROOT = Path(
    os.environ.get("LIGHTRAG_INDEX_ROOT", "data/eval/lightrag-indexes")
).resolve()
DEFAULT_MODE = os.environ.get("LIGHTRAG_DEFAULT_MODE", "hybrid")


# -- Protocol schemas ----------------------------------------------------------


class Document(BaseModel):
    idx: str
    text: str


class IndexRequest(BaseModel):
    corpusId: str
    documents: list[Document]
    embeddingModel: str | None = None
    llmModel: str | None = None
    config: dict[str, Any] | None = None


class IndexCost(BaseModel):
    inputTokens: int = 0
    outputTokens: int = 0
    estimatedUsd: float = 0.0


class IndexResponse(BaseModel):
    corpusId: str
    indexedDocCount: int
    indexElapsedMs: int
    cost: IndexCost
    fromCache: bool
    indexPath: str


class QueryRequest(BaseModel):
    corpusId: str
    question: str
    k: int = 10
    extras: dict[str, Any] | None = None


class RetrievedDoc(BaseModel):
    idx: str
    text: str
    score: float


class QueryCost(BaseModel):
    inputTokens: int = 0
    outputTokens: int = 0
    latencyMs: int = 0


class QueryResponse(BaseModel):
    retrievedDocs: list[RetrievedDoc]
    cost: QueryCost
    rerankerUsed: bool = False


class HealthResponse(BaseModel):
    ready: bool
    baseline: str
    loadedCorpora: list[str]
    uptimeSeconds: int
    llmEndpoint: str


# -- In-process LightRAG instance cache ---------------------------------------

_started_at = time.time()
_loaded_corpora: dict[str, dict[str, Any]] = {}

# Marker convention. Must round-trip through LightRAG's chunker unmodified.
EVT_MARKER = re.compile(r"<<<EVT id=([^>]+)>>>")


def _corpus_dir(corpus_id: str) -> Path:
    return INDEX_ROOT / corpus_id


def _manifest_path(corpus_id: str) -> Path:
    return _corpus_dir(corpus_id) / "manifest.json"


def _wrap_event(idx: str, text: str) -> str:
    return f"<<<EVT id={idx}>>>\n{text}\n<<<END>>>"


def _extract_event_ids(chunk_text: str) -> list[str]:
    """Pull every `<<<EVT id=X>>>` marker out of a chunk's body."""
    return EVT_MARKER.findall(chunk_text)


async def _llm_func(prompt: str, *, system_prompt: str | None = None, **kwargs: Any) -> str:
    """OpenAI-compat LLM call routed through the LLM-cache proxy."""
    history = kwargs.pop("history_messages", [])
    return await openai_complete_if_cache(
        LLM_MODEL,
        prompt,
        system_prompt=system_prompt,
        history_messages=history,
        api_key=os.environ.get("OPENAI_API_KEY", "proxied"),
        base_url=LLM_ENDPOINT,
        **kwargs,
    )


def _embed_func() -> EmbeddingFunc:
    """Embedding callable routed through the LLM-cache proxy / Ollama."""
    from openai import AsyncOpenAI

    async def _embed_call(texts: list[str]) -> Any:
        client = AsyncOpenAI(
            api_key=os.environ.get("OPENAI_API_KEY", "proxied"),
            base_url=EMBED_ENDPOINT,
        )
        resp = await client.embeddings.create(model=EMBED_MODEL, input=texts)
        import numpy as np
        return np.array([d.embedding for d in resp.data])

    return EmbeddingFunc(
        embedding_dim=EMBED_DIM,
        max_token_size=8192,
        func=_embed_call,
    )


async def _build_lightrag(corpus_id: str) -> LightRAG:
    working_dir = str(_corpus_dir(corpus_id))
    Path(working_dir).mkdir(parents=True, exist_ok=True)
    rag = LightRAG(
        working_dir=working_dir,
        llm_model_func=_llm_func,
        llm_model_name=LLM_MODEL,
        embedding_func=_embed_func(),
        chunk_token_size=1200,
    )
    # Required by LightRAG >=0.1: storages + pipeline status must be explicitly
    # initialized before any ainsert/aquery, else "JsonDocStatusStorage not
    # initialized". Older sidecar code predated this API requirement.
    await rag.initialize_storages()
    from lightrag.kg.shared_storage import initialize_pipeline_status

    await initialize_pipeline_status()
    return rag


# -- FastAPI app ---------------------------------------------------------------

app = FastAPI(title="CSM LightRAG sidecar", version="0.1.0")


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        ready=True,
        baseline="lightrag",
        loadedCorpora=sorted(_loaded_corpora.keys()),
        uptimeSeconds=int(time.time() - _started_at),
        llmEndpoint=LLM_ENDPOINT,
    )


@app.post("/index", response_model=IndexResponse)
async def index_endpoint(req: IndexRequest) -> IndexResponse:
    t0 = time.time()
    llm_model = req.llmModel or LLM_MODEL
    embed_model = req.embeddingModel or EMBED_MODEL

    manifest = _manifest_path(req.corpusId)
    if manifest.exists():
        try:
            old = json.loads(manifest.read_text())
            if (
                old.get("llmModel") == llm_model
                and old.get("embedModel") == embed_model
                and old.get("docCount") == len(req.documents)
            ):
                rag = await _build_lightrag(req.corpusId)
                id_to_text = {d.idx: d.text for d in req.documents}
                _loaded_corpora[req.corpusId] = {
                    "rag": rag,
                    "idToText": id_to_text,
                    "llmModel": llm_model,
                    "embedModel": embed_model,
                }
                return IndexResponse(
                    corpusId=req.corpusId,
                    indexedDocCount=len(req.documents),
                    indexElapsedMs=int((time.time() - t0) * 1000),
                    cost=IndexCost(),
                    fromCache=True,
                    indexPath=str(_corpus_dir(req.corpusId)),
                )
        except Exception as e:
            print(f"[lightrag-sidecar] manifest read failed, rebuilding: {e}")

    # Fresh index — insert each event wrapped in markers.
    _corpus_dir(req.corpusId).mkdir(parents=True, exist_ok=True)
    rag = await _build_lightrag(req.corpusId)
    id_to_text = {d.idx: d.text for d in req.documents}

    # Insert as one big string with marker-delimited events. LightRAG's chunker
    # will split it into chunks; each chunk carries its enclosed markers.
    payload = "\n\n".join(_wrap_event(d.idx, d.text) for d in req.documents)
    try:
        await rag.ainsert(payload)
    except Exception as e:
        try:
            shutil.rmtree(_corpus_dir(req.corpusId), ignore_errors=True)
        except Exception:
            pass
        raise HTTPException(
            status_code=500, detail=f"lightrag index failed: {e}"
        ) from e

    _loaded_corpora[req.corpusId] = {
        "rag": rag,
        "idToText": id_to_text,
        "llmModel": llm_model,
        "embedModel": embed_model,
    }
    manifest.write_text(
        json.dumps(
            {
                "corpusId": req.corpusId,
                "docCount": len(req.documents),
                "llmModel": llm_model,
                "embedModel": embed_model,
            }
        )
    )

    return IndexResponse(
        corpusId=req.corpusId,
        indexedDocCount=len(req.documents),
        indexElapsedMs=int((time.time() - t0) * 1000),
        cost=IndexCost(),
        fromCache=False,
        indexPath=str(_corpus_dir(req.corpusId)),
    )


@app.post("/query", response_model=QueryResponse)
async def query_endpoint(req: QueryRequest) -> QueryResponse:
    if req.corpusId not in _loaded_corpora:
        raise HTTPException(
            status_code=404,
            detail=f"corpus {req.corpusId} not loaded; call /index first",
        )
    t0 = time.time()
    state = _loaded_corpora[req.corpusId]
    rag: LightRAG = state["rag"]
    id_to_text: dict[str, str] = state["idToText"]
    mode = (req.extras or {}).get("mode", DEFAULT_MODE)

    try:
        # LightRAG's aquery returns generated answer text; we discard the
        # answer and use only the retrieved contexts via param.only_need_context.
        result = await rag.aquery(
            req.question,
            param=QueryParam(mode=mode, only_need_context=True, top_k=req.k),
        )
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"lightrag query failed: {e}"
        ) from e

    # `result` is the retrieved-contexts text block. Extract event IDs from
    # marker patterns. Order preserved (LightRAG lists source chunks in relevance
    # order, so marker order ≈ chunk-relevance order).
    #
    # Event-extraction cap. `req.k` controls LightRAG's internal entity/relation
    # `top_k` retrieval; a single top_k=10 retrieval pulls in MANY source chunks
    # whose union contains dozens of events. The DEFAULT cap is `req.k` — i.e.
    # event-count parity with the other systems (CSM/RAG pack ~10), which is the
    # fair, reported headline config (lightrag-30q).
    #
    # NOTE (verified, 2026-05-21): capping at `req.k`=10 takes only the first
    # ~4-5 event-dense chunks, so gold events LightRAG ranked at chunk #6-10 get
    # truncated (e.g. q13's gold e0043/44/45/77 sit at marker positions 19-20).
    # We tested removing the cap (`extras.maxEvents=60` → LightRAG's full ~50-event
    # retrieval, run lightrag-30q-fullctx): it did NOT help LightRAG — accuracy
    # DROPPED (context dilution flipped q11/q12 from right to wrong) and citation
    # F1 fell (precision collapse, 0.265 → ~0.13). So the default cap is both fair
    # (parity) AND charitable to LightRAG; `extras.maxEvents` exposes the knob for
    # anyone who wants to re-verify. See SOTA_COMPARISON.md.
    max_events = int((req.extras or {}).get("maxEvents", req.k))
    if not isinstance(result, str):
        result = str(result)
    ids_seen: list[str] = []
    seen_set: set[str] = set()
    for match in _extract_event_ids(result):
        if match in seen_set or match not in id_to_text:
            continue
        seen_set.add(match)
        ids_seen.append(match)
        if len(ids_seen) >= max_events:
            break

    retrieved: list[RetrievedDoc] = []
    for i, idx in enumerate(ids_seen):
        # Higher rank → higher score. No real distance from LightRAG here.
        score = 1.0 / (i + 1)
        retrieved.append(RetrievedDoc(idx=idx, text=id_to_text[idx], score=score))

    return QueryResponse(
        retrievedDocs=retrieved,
        cost=QueryCost(latencyMs=int((time.time() - t0) * 1000)),
        rerankerUsed=False,
    )


# -- Entrypoint ----------------------------------------------------------------


def main() -> None:
    INDEX_ROOT.mkdir(parents=True, exist_ok=True)
    print(
        f"[lightrag-sidecar] starting on http://{SIDECAR_HOST}:{SIDECAR_PORT}\n"
        f"  LLM endpoint:   {LLM_ENDPOINT}\n"
        f"  LLM model:      {LLM_MODEL}\n"
        f"  embed endpoint: {EMBED_ENDPOINT}\n"
        f"  embed model:    {EMBED_MODEL}\n"
        f"  embed dim:      {EMBED_DIM}\n"
        f"  index root:     {INDEX_ROOT}\n"
        f"  default mode:   {DEFAULT_MODE}"
    )
    uvicorn.run(app, host=SIDECAR_HOST, port=SIDECAR_PORT, log_level="info")


if __name__ == "__main__":
    main()
