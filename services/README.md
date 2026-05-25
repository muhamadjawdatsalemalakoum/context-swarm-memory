# Sidecar Reproducibility

The SOTA comparison baselines are Python FastAPI sidecars. The Node benchmark
talks to them over the locked protocol in `_common/sidecar_protocol.md`.

## Local venv path

Each sidecar has a `requirements.txt` for a dedicated virtual environment:

```bash
python -m venv .venv-lightrag
. .venv-lightrag/bin/activate
pip install -r services/lightrag-sidecar/requirements.txt
python services/lightrag-sidecar/main.py
```

Windows uses `.venv-lightrag\Scripts\activate` instead of `bin/activate`.

Exact dependency freezes from the local Windows/Python 3.12 environment used for
the published integration work are in `services/locks/`:

- `lightrag-windows-py312.lock.txt`
- `mem0-windows-py312.lock.txt`
- `hipporag-windows-py312.lock.txt`

These locks are evidence of the observed environment, not portable Linux Docker
inputs. To create a fresh lock in your own environment:

```bash
python -m pip freeze --all > services/locks/<sidecar>-<platform>-py<version>.lock.txt
```

## Docker path

The Dockerfile gives reviewers a clean containerized starting point:

```bash
docker compose -f services/docker-compose.sidecars.yml build lightrag-sidecar
docker compose -f services/docker-compose.sidecars.yml up lightrag-sidecar
```

The compose file expects the LLM-cache proxy on the host at port `8090` and
Ollama embeddings on the host at port `11434`. On Linux, `host.docker.internal`
may need an explicit Docker host gateway entry depending on your Docker version.

## Gemini LLM path

To use Gemini 3.5 Flash for sidecar LLM calls, keep the sidecars pointed at the
local proxy and point the proxy upstream at Gemini's OpenAI-compatible endpoint:

```bash
export CSM_OPENAI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
export OPENAI_API_KEY=$GEMINI_API_KEY
export CSM_GEMINI_REASONING_EFFORT=low
npm run proxy:start
```

Then set the sidecar LLM model to `gemini-3.5-flash` (for example,
`LIGHTRAG_LLM_MODEL=gemini-3.5-flash`). Embeddings are configured separately:
LightRAG and Mem0 still need an OpenAI-compatible embeddings endpoint and model
such as local Ollama `nomic-embed-text`; HippoRAG defaults to a local
sentence-transformers embedding model.

## Known limits

Mem0 and HippoRAG are kept as blocked-local findings in the public report until
they produce clean 30-query rows. Do not convert a sidecar install failure into a
benchmark win claim.
