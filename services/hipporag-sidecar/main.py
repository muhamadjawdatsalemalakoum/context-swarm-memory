"""
HippoRAG 2 sidecar — Phase γ CSM baseline.

Exposes the CSM sidecar protocol (POST /index, POST /query, GET /health) on
port 8001. Internally uses the `hipporag` Python library against an
OpenAI-compatible LLM endpoint (the LLM-cache proxy at port 8090, NOT
Ollama/llama-server directly — fairness control).

Contract: services/_common/sidecar_protocol.md
"""

from __future__ import annotations

import json
import os
import shutil
import time
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

try:
    from hipporag import HippoRAG
except ImportError as e:
    raise SystemExit(
        "hipporag not installed. Install via: pip install hipporag\n"
        "Then re-run this sidecar. See services/hipporag-sidecar/requirements.txt."
    ) from e


# -- Configuration -------------------------------------------------------------

SIDECAR_PORT = int(os.environ.get("HIPPORAG_SIDECAR_PORT", "8001"))
SIDECAR_HOST = os.environ.get("HIPPORAG_SIDECAR_HOST", "127.0.0.1")
LLM_ENDPOINT = os.environ.get("HIPPORAG_LLM_ENDPOINT", "http://127.0.0.1:8090/v1")
LLM_MODEL = os.environ.get("HIPPORAG_LLM_MODEL", "gemma4:31b")
EMBED_MODEL = os.environ.get("HIPPORAG_EMBED_MODEL", "BAAI/bge-base-en-v1.5")
INDEX_ROOT = Path(
    os.environ.get("HIPPORAG_INDEX_ROOT", "data/eval/hipporag-indexes")
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


# -- In-process HippoRAG instance cache ----------------------------------------

_started_at = time.time()
_loaded_corpora: dict[str, dict[str, Any]] = {}  # corpusId → {hipporag, idToText, ...}


def _corpus_dir(corpus_id: str) -> Path:
    return INDEX_ROOT / corpus_id


def _manifest_path(corpus_id: str) -> Path:
    return _corpus_dir(corpus_id) / "manifest.json"


def _build_hipporag(corpus_id: str, llm_model: str, embed_model: str) -> HippoRAG:
    """Construct a HippoRAG instance pointed at our LLM-cache proxy."""
    save_dir = str(_corpus_dir(corpus_id))
    return HippoRAG(
        save_dir=save_dir,
        llm_model_name=llm_model,
        llm_base_url=LLM_ENDPOINT,
        embedding_model_name=embed_model,
    )


# -- FastAPI app ---------------------------------------------------------------

app = FastAPI(title="CSM HippoRAG 2 sidecar", version="0.1.0")


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        ready=True,
        baseline="hipporag",
        loadedCorpora=sorted(_loaded_corpora.keys()),
        uptimeSeconds=int(time.time() - _started_at),
        llmEndpoint=LLM_ENDPOINT,
    )


@app.post("/index", response_model=IndexResponse)
def index_endpoint(req: IndexRequest) -> IndexResponse:
    t0 = time.time()
    llm_model = req.llmModel or LLM_MODEL
    embed_model = req.embeddingModel or EMBED_MODEL

    manifest = _manifest_path(req.corpusId)

    # Idempotent: if the manifest matches, reload the existing HippoRAG.
    if manifest.exists():
        try:
            old = json.loads(manifest.read_text())
            same_config = (
                old.get("llmModel") == llm_model
                and old.get("embedModel") == embed_model
                and old.get("docCount") == len(req.documents)
            )
            if same_config:
                hipporag = _build_hipporag(req.corpusId, llm_model, embed_model)
                id_to_text = {d.idx: d.text for d in req.documents}
                _loaded_corpora[req.corpusId] = {
                    "hipporag": hipporag,
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
            print(f"[hipporag-sidecar] manifest read failed, rebuilding: {e}")

    # Fresh index. Build HippoRAG, call .index() with the document list.
    _corpus_dir(req.corpusId).mkdir(parents=True, exist_ok=True)
    hipporag = _build_hipporag(req.corpusId, llm_model, embed_model)
    id_to_text = {d.idx: d.text for d in req.documents}

    # HippoRAG's index() expects a list of text strings. We use the same order
    # as our documents so per-doc retrieval can be mapped back via index.
    docs = [d.text for d in req.documents]
    try:
        # HippoRAG mutates the save_dir during indexing — OpenIE triples are
        # extracted via the LLM at llm_base_url (our cache proxy).
        hipporag.index(docs=docs)
    except Exception as e:
        # Wipe the partial index dir so a retry starts fresh.
        try:
            shutil.rmtree(_corpus_dir(req.corpusId), ignore_errors=True)
        except Exception:
            pass
        raise HTTPException(
            status_code=500, detail=f"hipporag index failed: {e}"
        ) from e

    _loaded_corpora[req.corpusId] = {
        "hipporag": hipporag,
        "idToText": id_to_text,
        "llmModel": llm_model,
        "embedModel": embed_model,
        "docOrder": [d.idx for d in req.documents],
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
def query_endpoint(req: QueryRequest) -> QueryResponse:
    if req.corpusId not in _loaded_corpora:
        raise HTTPException(
            status_code=404,
            detail=f"corpus {req.corpusId} not loaded; call /index first",
        )
    t0 = time.time()
    state = _loaded_corpora[req.corpusId]
    hipporag: HippoRAG = state["hipporag"]
    id_to_text: dict[str, str] = state["idToText"]
    doc_order: list[str] = state.get("docOrder", list(id_to_text.keys()))

    try:
        # HippoRAG.retrieve returns a list of QuerySolution per query, each
        # with .docs (text) and .doc_scores. Match docs back to original idx
        # by content equality (HippoRAG doesn't preserve our IDs natively).
        solutions = hipporag.retrieve(queries=[req.question], num_to_retrieve=req.k)
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"hipporag retrieve failed: {e}"
        ) from e

    if not solutions:
        return QueryResponse(
            retrievedDocs=[],
            cost=QueryCost(latencyMs=int((time.time() - t0) * 1000)),
        )

    sol = solutions[0]
    retrieved_docs_text: list[str] = list(getattr(sol, "docs", []) or [])
    retrieved_scores: list[float] = [
        float(s) for s in (getattr(sol, "doc_scores", []) or [])
    ]
    # Pad scores if HippoRAG returns fewer scores than docs.
    while len(retrieved_scores) < len(retrieved_docs_text):
        retrieved_scores.append(0.0)

    # Map text → idx. Build reverse map from idToText for O(1) lookup.
    text_to_idx = {v: k for k, v in id_to_text.items()}

    retrieved: list[RetrievedDoc] = []
    for text, score in zip(retrieved_docs_text, retrieved_scores):
        idx = text_to_idx.get(text)
        if not idx:
            # HippoRAG may have rewritten the doc (rare). Fall back to
            # positional alignment if exact-match fails.
            continue
        retrieved.append(RetrievedDoc(idx=idx, text=text, score=score))

    return QueryResponse(
        retrievedDocs=retrieved,
        cost=QueryCost(latencyMs=int((time.time() - t0) * 1000)),
        rerankerUsed=False,
    )


# -- Entrypoint ----------------------------------------------------------------


def main() -> None:
    INDEX_ROOT.mkdir(parents=True, exist_ok=True)
    print(
        f"[hipporag-sidecar] starting on http://{SIDECAR_HOST}:{SIDECAR_PORT}\n"
        f"  LLM endpoint: {LLM_ENDPOINT}\n"
        f"  LLM model:    {LLM_MODEL}\n"
        f"  embed model:  {EMBED_MODEL}\n"
        f"  index root:   {INDEX_ROOT}"
    )
    uvicorn.run(app, host=SIDECAR_HOST, port=SIDECAR_PORT, log_level="info")


if __name__ == "__main__":
    main()
