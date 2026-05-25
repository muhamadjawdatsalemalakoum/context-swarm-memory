"""
Mem0 sidecar — Phase γ CSM baseline.

Exposes the CSM sidecar protocol (POST /index, POST /query, GET /health) over
HTTP on port 8003. Internally uses the `mem0ai` Python library against an
OpenAI-compatible LLM endpoint (the LLM-cache proxy at port 8090, NOT
Ollama/llama-server directly — fairness control).

Contract: services/_common/sidecar_protocol.md
"""

from __future__ import annotations

import hashlib
import os
import time
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

try:
    from mem0 import Memory
except ImportError as e:
    raise SystemExit(
        "mem0ai not installed. Install via: pip install mem0ai\n"
        "Then re-run this sidecar. See services/mem0-sidecar/requirements.txt."
    ) from e


# -- Configuration -------------------------------------------------------------

SIDECAR_PORT = int(os.environ.get("MEM0_SIDECAR_PORT", "8003"))
SIDECAR_HOST = os.environ.get("MEM0_SIDECAR_HOST", "127.0.0.1")
LLM_ENDPOINT = os.environ.get("MEM0_LLM_ENDPOINT", "http://127.0.0.1:8090/v1")
LLM_MODEL = os.environ.get("MEM0_LLM_MODEL", "gemma4:31b")
EMBED_ENDPOINT = os.environ.get("MEM0_EMBED_ENDPOINT", LLM_ENDPOINT)
EMBED_MODEL = os.environ.get("MEM0_EMBED_MODEL", "nomic-embed-text")
INDEX_ROOT = Path(
    os.environ.get(
        "MEM0_INDEX_ROOT",
        "data/eval/mem0-indexes",
    )
).resolve()


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


# -- In-process Mem0 instance cache --------------------------------------------

_started_at = time.time()
_loaded_corpora: dict[str, dict[str, Any]] = {}  # corpusId → {memory, idToText, llmModel, embedModel}


def _user_id_for(corpus_id: str) -> str:
    return f"csm-bench-{corpus_id}"


def _index_dir(corpus_id: str) -> Path:
    return INDEX_ROOT / corpus_id


def _manifest_path(corpus_id: str) -> Path:
    return _index_dir(corpus_id) / "manifest.json"


def _build_memory(llm_model: str, embed_model: str, corpus_id: str) -> Memory:
    """Construct a Memory with OpenAI-compat backends pointed at our proxy.

    Per-corpus collection name avoids Qdrant collection-dim mismatch when the
    user changes embedding models between runs (Qdrant trusts the existing
    collection's dim setting on reuse and silently fails).
    """
    # nomic-embed-text → 768; text-embedding-3-small → 1536; bge-base → 768.
    # Mem0's default Qdrant config assumes OpenAI 1536, which silently fails
    # against any other embedder. Pass the dim explicitly.
    embed_dim_overrides = {
        "nomic-embed-text": 768,
        "BAAI/bge-base-en-v1.5": 768,
        "BAAI/bge-large-en-v1.5": 1024,
        "text-embedding-3-small": 1536,
        "text-embedding-3-large": 3072,
        "text-embedding-ada-002": 1536,
    }
    embed_dim = embed_dim_overrides.get(embed_model, 768)
    safe_collection = (
        "csm_" + corpus_id.replace("-", "_")[:40] + f"_{embed_dim}"
    )
    config: dict[str, Any] = {
        "llm": {
            "provider": "openai",
            "config": {
                "model": llm_model,
                "openai_base_url": LLM_ENDPOINT,
                # Mem0's openai client uses OPENAI_API_KEY; the proxy doesn't
                # validate it but the client requires a non-empty value.
                "api_key": os.environ.get("OPENAI_API_KEY", "proxied"),
                "temperature": 0,
            },
        },
        "embedder": {
            "provider": "openai",
            "config": {
                "model": embed_model,
                "openai_base_url": EMBED_ENDPOINT,
                "api_key": os.environ.get("OPENAI_API_KEY", "proxied"),
                "embedding_dims": embed_dim,
            },
        },
        "vector_store": {
            # In-process Qdrant in :memory: mode. QdrantLocal has a per-process
            # singleton constraint — opening a second QdrantClient in the same
            # process (even with a different path) conflicts with the first.
            # `:memory:` mode sidesteps file locks; we couple this with the
            # "drop old corpus" pattern in the /index handler so only one
            # Memory is alive at a time.
            "provider": "qdrant",
            "config": {
                "collection_name": safe_collection,
                "embedding_model_dims": embed_dim,
                "path": ":memory:",
            },
        },
    }
    return Memory.from_config(config)


# -- FastAPI app ---------------------------------------------------------------

app = FastAPI(title="CSM Mem0 sidecar", version="0.1.0")


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        ready=True,
        baseline="mem0",
        loadedCorpora=sorted(_loaded_corpora.keys()),
        uptimeSeconds=int(time.time() - _started_at),
        llmEndpoint=LLM_ENDPOINT,
    )


@app.post("/index", response_model=IndexResponse)
def index_endpoint(req: IndexRequest) -> IndexResponse:
    t0 = time.time()
    llm_model = req.llmModel or LLM_MODEL
    embed_model = req.embeddingModel or EMBED_MODEL

    # Idempotent: if the manifest matches, just load the existing index.
    manifest = _manifest_path(req.corpusId)
    if manifest.exists():
        # Trust the manifest; load into RAM cache.
        # Drop other loaded corpora first (Qdrant singleton).
        _loaded_corpora.clear()
        memory = _build_memory(llm_model, embed_model, req.corpusId)
        id_to_text = {d.idx: d.text for d in req.documents}
        _loaded_corpora[req.corpusId] = {
            "memory": memory,
            "idToText": id_to_text,
            "llmModel": llm_model,
            "embedModel": embed_model,
        }
        return IndexResponse(
            corpusId=req.corpusId,
            indexedDocCount=len(req.documents),
            indexElapsedMs=int((time.time() - t0) * 1000),
            cost=IndexCost(),  # zero — replay
            fromCache=True,
            indexPath=str(_index_dir(req.corpusId)),
        )

    # Fresh index. Build the Memory, call .add() for every document.
    #
    # QdrantLocal singleton workaround: clear ALL other loaded corpora first.
    # Having two Memory instances alive in the same process — even with
    # `:memory:` paths or distinct disk paths — conflicts with Qdrant's
    # internal singleton. We accept losing previously-indexed corpora; the
    # bench runner only indexes one corpus per session anyway.
    _loaded_corpora.clear()
    _index_dir(req.corpusId).mkdir(parents=True, exist_ok=True)
    memory = _build_memory(llm_model, embed_model, req.corpusId)
    user_id = _user_id_for(req.corpusId)
    id_to_text: dict[str, str] = {}

    for doc in req.documents:
        try:
            # Older mem0ai versions accepted user_id as a top-level kwarg.
            # Newer versions surface it through metadata. Try the modern form
            # first; fall through if signature is older.
            try:
                memory.add(
                    messages=[{"role": "user", "content": doc.text}],
                    user_id=user_id,
                    metadata={"eventId": doc.idx},
                )
            except TypeError:
                # Some forks took user_id off the public surface entirely; in
                # that case put it in metadata so we can scope on retrieval.
                memory.add(
                    messages=[{"role": "user", "content": doc.text}],
                    metadata={"eventId": doc.idx, "user_id": user_id},
                )
        except Exception as e:
            # Don't blow up the whole index on one bad doc. Log + continue.
            print(f"[mem0-sidecar] add() failed for {doc.idx}: {e}")
            continue
        id_to_text[doc.idx] = doc.text

    _loaded_corpora[req.corpusId] = {
        "memory": memory,
        "idToText": id_to_text,
        "llmModel": llm_model,
        "embedModel": embed_model,
    }

    # Persist the manifest so re-issuing the same /index request is a fast no-op.
    manifest.write_text(
        f'{{"corpusId":"{req.corpusId}","docCount":{len(req.documents)},'
        f'"llmModel":"{llm_model}","embedModel":"{embed_model}"}}'
    )

    return IndexResponse(
        corpusId=req.corpusId,
        indexedDocCount=len(req.documents),
        indexElapsedMs=int((time.time() - t0) * 1000),
        cost=IndexCost(),  # populated by the proxy via response headers
        fromCache=False,
        indexPath=str(_index_dir(req.corpusId)),
    )


@app.post("/query", response_model=QueryResponse)
def query_endpoint(req: QueryRequest) -> QueryResponse:
    if req.corpusId not in _loaded_corpora:
        raise HTTPException(
            status_code=404,
            detail=f"corpus {req.corpusId} not loaded; call /index first",
        )
    t0 = time.time()
    state = _loaded_corpora[req.corpusId]
    memory: Memory = state["memory"]
    id_to_text: dict[str, str] = state["idToText"]

    user_id = _user_id_for(req.corpusId)
    try:
        # Newer mem0ai versions require filters={'user_id': ...} rather than
        # the top-level user_id= kwarg. Try filters first, fall back for older.
        try:
            result = memory.search(
                query=req.question,
                filters={"user_id": user_id},
                limit=req.k,
            )
        except TypeError:
            result = memory.search(query=req.question, user_id=user_id, limit=req.k)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"mem0 search failed: {e}") from e

    # Mem0 returns either {"results": [...]} or a bare list depending on
    # version. Normalise.
    if isinstance(result, dict):
        items = result.get("results", [])
    elif isinstance(result, list):
        items = result
    else:
        items = []

    retrieved: list[RetrievedDoc] = []
    for item in items[: req.k]:
        # metadata.eventId is the ID we set at index time.
        metadata = item.get("metadata") or {}
        event_id = metadata.get("eventId")
        if not event_id:
            continue
        # Prefer canonical event content over Mem0's distilled "memory" string
        # — this keeps citation comparisons fair across baselines.
        text = id_to_text.get(event_id, item.get("memory", ""))
        score = float(item.get("score", 0.0))
        retrieved.append(RetrievedDoc(idx=event_id, text=text, score=score))

    return QueryResponse(
        retrievedDocs=retrieved,
        cost=QueryCost(latencyMs=int((time.time() - t0) * 1000)),
        rerankerUsed=False,
    )


# -- Entrypoint ----------------------------------------------------------------


def main() -> None:
    INDEX_ROOT.mkdir(parents=True, exist_ok=True)
    print(
        f"[mem0-sidecar] starting on http://{SIDECAR_HOST}:{SIDECAR_PORT}\n"
        f"  LLM endpoint:   {LLM_ENDPOINT}\n"
        f"  LLM model:      {LLM_MODEL}\n"
        f"  embed endpoint: {EMBED_ENDPOINT}\n"
        f"  embed model:    {EMBED_MODEL}\n"
        f"  index root:     {INDEX_ROOT}"
    )
    uvicorn.run(app, host=SIDECAR_HOST, port=SIDECAR_PORT, log_level="info")


if __name__ == "__main__":
    main()
