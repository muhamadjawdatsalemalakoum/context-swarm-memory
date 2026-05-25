# Third-Party Replication Kit

Use this page if you are trying to reproduce or challenge the CSM benchmark.
The goal is to make disagreements concrete: same code, same corpus, same scoring
code, explicit model/provider differences.

## No-GPU verification

```bash
git clone https://github.com/muhamadjawdatsalemalakoum/context-swarm-memory.git
cd context-swarm-memory
npm install
npm test
npm run build
npm run verify:published
npx tsx scripts/verify-corpus.ts
npx tsx scripts/verify-no-leakage.ts
```

This verifies the code, corpus, scoring path, and committed result rows. It does
not call an LLM.

## Fresh local run

Follow `docs/REPRODUCING.md` for the local Ollama/Gemma setup. Then run:

```bash
npm run bench:confirm -- --run-id replicate-gemma-v1 --model gemma4:31b
npm run bench:trials -- replicate-gemma-v1
```

Attach the generated files:

- `data/eval/runs/replicate-gemma-v1/config.json`
- `data/eval/runs/replicate-gemma-v1/results.jsonl`
- `data/eval/runs/replicate-gemma-v1/summary.json`
- `data/eval/runs/replicate-gemma-v1/trial-summary.md`

## Hosted Gemini run

Gemini is useful for fast cross-model confirmation. It is not a drop-in
replacement for the Gemma headline because the answering model changes.

```bash
export CSM_PROVIDER=gemini
export GEMINI_API_KEY=...
export CSM_GEMINI_MODEL=gemini-3-flash-preview
npm run bench:confirm -- --run-id replicate-gemini-flash-v1 --model gemini-3-flash-preview
npm run bench:trials -- replicate-gemini-flash-v1
```

## Report template

When opening a replication issue, include:

- Repository commit or release tag
- DOI, if using an archived release
- OS, CPU, GPU, RAM
- Node, npm, Python, Docker versions
- Provider and exact model IDs
- Whether the run used local Gemma, Gemini, OpenAI-compatible, or mock provider
- Commands run
- Run IDs produced
- Whether `npm run verify:published` passed
- Differences from the published tables

Do not paste API keys, `.env` files, or raw provider credentials into issues.
