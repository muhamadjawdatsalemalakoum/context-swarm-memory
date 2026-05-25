# Sidecar Protocol Contract — Phase γ baselines

**Status**: locked design contract.
**Audience**: implementation agents wiring HippoRAG 2 / LightRAG / Mem0 as CSM benchmark baselines.
**Goal**: every external baseline runs as a Python FastAPI sidecar with an identical three-endpoint surface so the Node client (`src/eval/baselines/<name>.ts`) is interchangeable and the cost-accounting / cache-fairness contract holds across all of them.

## Why this exists

All three target baselines (HippoRAG 2, LightRAG, Mem0) are Python-first. Two are Python-only; the third (Mem0) has a thinner Node SDK than Python lib. Rather than mix three different integration patterns, this contract pins one shape: **one Python FastAPI sidecar per baseline**, talking HTTP to a thin Node client at `src/eval/baselines/<name>.ts`. Every sidecar's internal LLM and embedding traffic flows through the **LLM-cache proxy** at port 8090 so all baselines share the existing content-hashed disk cache (`src/eval/cache.ts`) — replays are byte-identical and the per-call cost telemetry stays honest.

This is a contract. Implementation agents must conform or update this doc with reasons.

## Process model

```
┌──────────────────┐    HTTP    ┌──────────────────────┐
│  Node bench      │ ─────────► │  Python sidecar      │
│  baselines/X.ts  │            │  services/X-sidecar  │
│  (in vitest /    │ ◄───────── │  (FastAPI on 8001-3) │
│   csm bench)     │  JSON      │                      │
└──────────────────┘            └─────────┬────────────┘
                                          │ LLM / embed
                                          │ via OpenAI-compat
                                          ▼
                                ┌──────────────────────┐
                                │  LLM-cache proxy     │
                                │  src/eval/           │
                                │   sidecarProxy.ts    │
                                │  (Node, port 8090)   │
                                └─────────┬────────────┘
                                          │ on miss
                                          ▼
                                ┌──────────────────────┐
                                │  Ollama 11434  OR    │
                                │  llama-server 8080   │
                                └──────────────────────┘
```

**Port allocation** (locked):

| Service             | Port | Notes                                         |
|---------------------|------|-----------------------------------------------|
| Ollama              | 11434| Existing — left running for rollback safety   |
| llama-server        | 8080 | Phase β.1 daemon                              |
| LLM-cache proxy     | 8090 | New (this phase)                              |
| HippoRAG sidecar    | 8001 |                                               |
| LightRAG sidecar    | 8002 |                                               |
| Mem0 sidecar        | 8003 |                                               |

## Endpoints (every sidecar exposes exactly these three)

### `POST /index`

Build / load the per-corpus index. Idempotent — if the on-disk manifest at `data/eval/<baseline>-indexes/<corpusId>/manifest.json` matches the request, returns immediately.

**Request body:**
```json
{
  "corpusId": "<deterministic hash>",
  "documents": [
    { "idx": "e0001", "text": "Event content..." },
    { "idx": "e0002", "text": "..." }
  ],
  "embeddingModel": "BAAI/bge-base-en-v1.5",
  "llmModel": "gemma4-31b",
  "config": { /* baseline-specific knobs */ }
}
```

**Response body:**
```json
{
  "corpusId": "<echoed>",
  "indexedDocCount": 12345,
  "indexElapsedMs": 11240000,
  "cost": {
    "inputTokens": 200000,
    "outputTokens": 80000,
    "estimatedUsd": 0
  },
  "fromCache": false,
  "indexPath": "data/eval/<baseline>-indexes/<corpusId>/"
}
```

The `corpusId` is computed Node-side as:
```typescript
hash({ sampleSeed, targetTokens, eventCount: events.length, embeddingModel, llmModel })
```
Changing any of these forces a rebuild. Same input → same `corpusId` → sidecar reuses on-disk index.

### `POST /query`

Retrieve top-K relevant events for a question.

**Request body:**
```json
{
  "corpusId": "<must exist via prior /index>",
  "question": "Which integration partner from the dental-SaaS vertical signed the first LOI?",
  "k": 10,
  "extras": { /* baseline-specific (e.g., LightRAG `mode: "hybrid"`) */ }
}
```

**Response body:**
```json
{
  "retrievedDocs": [
    { "idx": "e0031", "text": "ChairSync signed LOI on 2024-09-14...", "score": 0.93 },
    { "idx": "e0032", "text": "...", "score": 0.87 }
  ],
  "cost": {
    "inputTokens": 1200,
    "outputTokens": 450,
    "latencyMs": 850
  },
  "rerankerUsed": false
}
```

**Citation roundtrip rule**: every `retrievedDocs[i].idx` MUST be a verbatim `BenchEvent.id` from the source corpus. The Node baseline relies on this to compute citation precision / recall — if a sidecar returns chunked or rewritten text, it must also return the IDs of the events that chunk overlapped.

### `GET /health`

Liveness + readiness probe. The Node bench launcher (`scripts/sidecars.ts`) polls this with a 30s timeout on startup.

**Response body:**
```json
{
  "ready": true,
  "baseline": "hipporag",
  "loadedCorpora": ["<corpusId-1>", "<corpusId-2>"],
  "uptimeSeconds": 1234,
  "llmEndpoint": "http://127.0.0.1:8090/v1"
}
```

`ready: false` is acceptable during model warm-up; the launcher waits up to 60s.

## LLM-cache proxy interposition

Every sidecar configures its internal LLM and embedding endpoints to point at `http://127.0.0.1:8090` (the LLM-cache proxy), NOT directly at Ollama / llama-server. The proxy:

1. Accepts OpenAI-compat (`POST /v1/chat/completions`, `POST /v1/embeddings`) and Ollama-compat (`POST /api/generate`, `POST /api/embeddings`) routes.
2. Normalises each request into a `CacheKeyInput` shape (`src/eval/cache.ts`).
3. On cache hit: returns the recorded response with response header `x-cache-hit: true`.
4. On cache miss: forwards to the real backend (`CSM_OPENAI_BASE_URL`), writes the response into the cache, returns it.
5. Tracks per-request input/output token counts; reports them via response headers `x-cache-bytes-in`, `x-cache-bytes-out` so the sidecar can roll them into its `cost` block.

This is the single most important fairness control: HippoRAG's OpenIE indexing, LightRAG's entity-extraction, and Mem0's fact-distillation all run through the same content-hashed cache as the rest of the bench. **Replay determinism is preserved end-to-end.**

## Baseline-specific configuration knobs

Each sidecar may extend `config` with baseline-specific knobs. The Node client should treat unknown knobs as opaque and pass them through.

### HippoRAG 2 (port 8001)

```json
{ "embeddingModel": "BAAI/bge-base-en-v1.5", "graphBackend": "igraph" }
```

### LightRAG (port 8002)

```json
{ "embeddingModel": "BAAI/bge-base-en-v1.5", "modeDefault": "hybrid", "chunkSize": 1200 }
```

Per-query `extras.mode` accepts `"naive" | "local" | "global" | "hybrid" | "mix"`.

### Mem0 (port 8003)

```json
{ "embeddingModel": "BAAI/bge-base-en-v1.5", "vectorStore": "qdrant-in-memory", "userIdPrefix": "csm-bench" }
```

## Process lifecycle (Node-side launcher)

`scripts/sidecars.ts` — npm scripts:

| Script                       | Action                                              |
|------------------------------|-----------------------------------------------------|
| `npm run sidecars:start all` | Starts all three sidecars + the LLM-cache proxy.    |
| `npm run sidecars:start mem0`| Starts only Mem0 sidecar.                           |
| `npm run sidecars:stop`      | Kills all sidecars (pid files in `data/eval/sidecars/`). |
| `npm run sidecars:status`    | Health-check on every port; prints loaded corpora.  |

Each sidecar has a sibling `services/<baseline>-sidecar/run.sh` (Linux/macOS) and `services/<baseline>-sidecar/run.ps1` (Windows) that creates / activates its venv and runs `uvicorn`.

## Error handling

- **Sidecar unreachable**: Node baseline retries 3 times with 500ms backoff, then fails the cell with a clear error. The runner records the failure in `meta.error` and moves on (cell counted as wrong answer).
- **Index endpoint timeout**: configurable; default 24 h cap (long-tail HippoRAG/LightRAG indexing). Surface as `cost.indexElapsedMs` for honest reporting.
- **Query endpoint timeout**: 300s default; runner records the failure.
- **`retrievedDocs.idx` not in `corpus.byId`**: sidecar bug; Node baseline logs warning and drops that item from citations. Tests must catch this in CI.

## Implementation order

1. **LLM-cache proxy** (no Python deps). Single Node file, ~300 LOC. Tested in isolation against `MockProvider`.
2. **Mem0 sidecar** (smallest indexing cost, cleanest IDs round-trip). Validates the protocol end-to-end.
3. **HippoRAG sidecar** (medium effort, multi-hop QA SOTA).
4. **LightRAG sidecar** (largest effort, requires marker-block trick for ID roundtrip).

## Test strategy

- **Smoke test (no Python, vitest)**: each Node baseline test stubs the sidecar with a tiny express handler returning canned `retrievedDocs`. Asserts (a) the runner produces a well-formed `BaselineResult`, (b) cost accounting is consistent (`inputTokens === sidecarCost + finalLlmCost`), (c) citation extraction works.
- **Integration test (manual, requires Python + Ollama)**: `npm run test:integration:hipporag` boots a real sidecar against a 50-event mini-corpus and runs three queries. Not in CI.
- **Cost-accounting contract** extension in `tests/cost-accounting.test.ts`: every multi-call baseline must satisfy `inputTokens === pipelineInputTokens + finalCallInputTokens` (same shape as CSM today).
