# Gemini Provider

CSM supports Gemini through the same `LlmProvider` seam used by MockProvider,
Ollama, llama.cpp `llama-server`, and OpenAI-compatible hosted providers.

## Model choice

As of 2026-05-25, Google's official Gemini API model page lists stable Gemini
3.5 Flash as `gemini-3.5-flash`. The repo defaults to this stable API model
code.

Official references:

- Gemini 3.5 Flash model card: <https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash>
- OpenAI compatibility endpoint: <https://ai.google.dev/gemini-api/docs/openai>
- API key environment variables: <https://ai.google.dev/gemini-api/docs/api-key>

Recommended starting point:

```bash
export CSM_PROVIDER=gemini
export GEMINI_API_KEY=...
export CSM_GEMINI_MODEL=gemini-3.5-flash
export CSM_GEMINI_THINKING=low
```

PowerShell:

```powershell
$env:CSM_PROVIDER = "gemini"
$env:GEMINI_API_KEY = "..."
$env:CSM_GEMINI_MODEL = "gemini-3.5-flash"
$env:CSM_GEMINI_THINKING = "low"
```

`GOOGLE_API_KEY` is also accepted for compatibility, but `GEMINI_API_KEY` is the
preferred project-local name.

## Smoke test

```bash
npm run csm -- provider info
npm run csm -- provider ping --model gemini-3.5-flash
```

The ping prints the raw model response and token estimates, but never prints the
API key.

For evidence runs, the provider requests low thinking where the model family
supports it. `minimal` is useful for cost-smoke checks, but the 2M/160K smoke
showed that `low` is the safer quality setting for CSM's multi-stage pipeline.
Set `CSM_GEMINI_THINKING=default` to omit this override.

## 3-trial confirmation run

Gemini is useful for fast replication because it removes local 4090 throughput
as the bottleneck. Keep the run separate from the Gemma/GPU headline, because a
hosted model changes the answering model and therefore the scientific claim.

The recommended CSM scaling run uses only about 15% of Gemini 3.5 Flash's
1,048,576-token input limit as the model context budget (`160K`) while scaling
the memory corpus beyond 2M tokens. That keeps the experiment about CSM's memory
layer rather than brute-force long-context packing.

```bash
npm run bench:confirm -- --run-id gemini35-flash-160k-3trial-v1 --model gemini-3.5-flash --model-contexts 160K --corpus-sizes 100K,1M,2M,5M,9M
npm run bench:trials -- gemini35-flash-160k-3trial-v1
npm run bench:report -- gemini35-flash-160k-3trial-v1 --headline-ctx 160K --headline-corpus 2M
```

For the smaller default confirmation matrix:

```bash
npm run bench:confirm -- --run-id gemini35-flash-3trial-v1 --model gemini-3.5-flash
npm run bench:trials -- gemini35-flash-3trial-v1
npm run bench:report -- gemini35-flash-3trial-v1 --headline-ctx 8K --headline-corpus 1M
```

Suggested interpretation:

- Gemma/GPU rows are the local, no-cloud baseline.
- Gemini rows are cross-model confirmation and throughput evidence.
- Do not merge Gemini numbers into the existing README headline unless the
  README explicitly labels the model change.

## Completed single-trial evidence run

The repository includes one committed Gemini 3.5 Flash evidence run:

- Run id: `gemini35-160k-30q-v1`
- Artifacts: `data/eval/runs/gemini35-160k-30q-v1/`
- Matrix: CSM, long-context, vanilla RAG, and hybrid RAG over 30 queries at
  100K, 1M, and 2M corpus sizes
- Context cap: 160K model-context budget
- Result at 2M: CSM 28/30, hybrid 27/30, vanilla RAG 26/30, long-context 15/30
- Reliability: 360/360 cells completed with zero provider errors

This is useful cross-model evidence, not the final 3-trial confirmation. The
raw rows are verified by `npm run verify:published`; aggregate report artifacts
can be regenerated with:

```bash
npm run bench:trials -- gemini35-160k-30q-v1
npm run bench:report -- gemini35-160k-30q-v1 --headline-ctx 160K --headline-corpus 2M
```

## Cost safety

Before running the full confirmation, set a Google Cloud or AI Studio budget
alert and run a tiny smoke first:

```bash
npm run csm -- bench run --systems csm,rag --trials 1 --corpus-sizes 100K --model-contexts 8K --queries q01 --model gemini-3.5-flash --run-id gemini-cost-smoke
```

If the smoke behaves, run the full confirmation. The benchmark cache is
content-hashed, so interrupted runs can resume without paying again for
completed cells.

## SOTA sidecar mode

The Python sidecars can route their internal LLM calls through Gemini's
OpenAI-compatible endpoint via the Node LLM-cache proxy:

```bash
export CSM_OPENAI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
export OPENAI_API_KEY=$GEMINI_API_KEY
export CSM_GEMINI_REASONING_EFFORT=low
npm run proxy:start
```

Then point each sidecar's LLM endpoint at the proxy (`http://127.0.0.1:8090/v1`)
and use `gemini-3.5-flash` as the sidecar LLM model. Embeddings are a separate
dependency: the current LightRAG/Mem0 sidecars default to local
`nomic-embed-text` through an OpenAI-compatible embeddings endpoint, while
HippoRAG defaults to `BAAI/bge-base-en-v1.5`.

## Data enrichment guardrail

Gemini can help generate additional synthetic corpora or adversarial query
drafts, but those artifacts must be versioned as a separate corpus with their
own generation prompt, seed, review notes, and leakage checks. Do not mix
Gemini-generated enrichment into the canonical PaySwift evidence rows without
renaming the corpus and rerunning the full methodology.
