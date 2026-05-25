# Gemini Provider

CSM supports Gemini through the same `LlmProvider` seam used by MockProvider,
Ollama, llama.cpp `llama-server`, and OpenAI-compatible hosted providers.

## Model choice

Google's official Gemini API model list currently exposes Gemini 3 Flash as
`gemini-3-flash-preview`. Some news coverage uses names like "Gemini 3.5 Flash",
but the repo defaults to the official API model code. If your AI Studio account
shows a newer Flash model, set `CSM_GEMINI_MODEL` to that exact model ID.

Recommended starting point:

```bash
export CSM_PROVIDER=gemini
export GEMINI_API_KEY=...
export CSM_GEMINI_MODEL=gemini-3-flash-preview
```

PowerShell:

```powershell
$env:CSM_PROVIDER = "gemini"
$env:GEMINI_API_KEY = "..."
$env:CSM_GEMINI_MODEL = "gemini-3-flash-preview"
```

`GOOGLE_API_KEY` is also accepted for compatibility, but `GEMINI_API_KEY` is the
preferred project-local name.

## Smoke test

```bash
npm run csm -- provider info
npm run csm -- provider ping --model gemini-3-flash-preview
```

The ping prints the raw model response and token estimates, but never prints the
API key.

For low-latency JSON stages, the provider requests minimal/zero thinking where
the model family supports it. This matters for Gemini Flash because otherwise a
tiny JSON budget can be consumed by hidden reasoning before the model emits text.

## 3-trial confirmation run

Gemini is useful for fast replication because it removes local 4090 throughput
as the bottleneck. Keep the run separate from the Gemma/GPU headline, because a
hosted model changes the answering model and therefore the scientific claim.

```bash
npm run bench:confirm -- --run-id gemini-flash-3trial-v1 --model gemini-3-flash-preview
npm run bench:trials -- gemini-flash-3trial-v1
npm run bench:report -- gemini-flash-3trial-v1 --headline-ctx 8K --headline-corpus 1M
```

Suggested interpretation:

- Gemma/GPU rows are the local, no-cloud baseline.
- Gemini rows are cross-model confirmation and throughput evidence.
- Do not merge Gemini numbers into the existing README headline unless the
  README explicitly labels the model change.

## Cost safety

Before running the full confirmation, set a Google Cloud or AI Studio budget
alert and run a tiny smoke first:

```bash
npm run csm -- bench run --systems csm,rag --trials 1 --corpus-sizes 100K --model-contexts 8K --queries q01 --model gemini-3-flash-preview --run-id gemini-cost-smoke
```

If the smoke behaves, run the full confirmation. The benchmark cache is
content-hashed, so interrupted runs can resume without paying again for
completed cells.
