# Mem0 sidecar

Python FastAPI service exposing the [CSM sidecar protocol](../_common/sidecar_protocol.md) for the Mem0 agentic-memory baseline.

## Setup

```powershell
# from repo root
python -m venv .venv-mem0
.venv-mem0\Scripts\activate
pip install -r services/mem0-sidecar/requirements.txt
```

Linux/macOS:

```sh
python -m venv .venv-mem0
source .venv-mem0/bin/activate
pip install -r services/mem0-sidecar/requirements.txt
```

## Run

```powershell
# Default: listen on 127.0.0.1:8003, point LLM at the LLM-cache proxy on 8090.
python services/mem0-sidecar/main.py
```

Override via env:

| Env var | Default | Purpose |
|---|---|---|
| `MEM0_SIDECAR_PORT` | `8003` | Bind port |
| `MEM0_SIDECAR_HOST` | `127.0.0.1` | Bind host (loopback only by default) |
| `MEM0_LLM_ENDPOINT` | `http://127.0.0.1:8090/v1` | Where Mem0's internal LLM calls go. **MUST point at the LLM-cache proxy in normal bench mode** to preserve cache-fairness. |
| `MEM0_LLM_MODEL` | `gemma4-31b` | Model name (must match the proxy's upstream model). |
| `MEM0_EMBED_ENDPOINT` | same as LLM_ENDPOINT | Embedding API endpoint |
| `MEM0_EMBED_MODEL` | `nomic-embed-text` | Embedding model name. Ollama must have it pulled. |
| `MEM0_INDEX_ROOT` | `data/eval/mem0-indexes` | Where the per-corpus Qdrant + manifest files live |

## Healthcheck

```sh
curl http://127.0.0.1:8003/health
```

Returns `{"ready": true, "baseline": "mem0", "loadedCorpora": [...]}`.

## Index a corpus

```sh
curl -X POST http://127.0.0.1:8003/index \
  -H "Content-Type: application/json" \
  -d '{
    "corpusId": "smoke-corpus-1",
    "documents": [
      {"idx": "e0001", "text": "ChairSync signed LOI on 2024-09-14"},
      {"idx": "e0002", "text": "Acme Corp declined our enterprise pitch"}
    ],
    "llmModel": "gemma4-31b",
    "embeddingModel": "nomic-embed-text"
  }'
```

## Query

```sh
curl -X POST http://127.0.0.1:8003/query \
  -H "Content-Type: application/json" \
  -d '{
    "corpusId": "smoke-corpus-1",
    "question": "Which dental-SaaS company signed an LOI?",
    "k": 5
  }'
```

Returns `{"retrievedDocs": [{"idx": "e0001", "text": "...", "score": 0.91}, ...]}`.

## Notes

- The sidecar uses canonical event content for `retrievedDocs[i].text` rather than Mem0's distilled-fact form. This keeps citation comparisons fair across baselines (every baseline sees the same evidence text, just retrieved differently).
- Indexing cost on a single 4090 with Gemma 4 31B: ~46 min for 100K tokens, ~8 h for 1M, ~77 h for 10M.
- Reranker: Mem0 doesn't ship one. To upgrade, wrap the response in a cross-encoder rerank pass on the Node side (similar to `src/eval/rerank.ts`).
