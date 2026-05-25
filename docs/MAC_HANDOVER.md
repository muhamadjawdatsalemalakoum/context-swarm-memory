# Mac Handover: AMB / BEAM / Hindsight

## Current State

The repo now contains an Agent Memory Benchmark bridge:

- `integrations/amb/csm_provider.py` adds a CSM `MemoryProvider` to AMB.
- `scripts/patch-amb-csm-provider.ts` copies/registers that provider in an AMB checkout.
- `scripts/amb-csm-retrieve.ts` lets AMB call the TypeScript CSM retrieval path.
- `package.json` exposes `npm run amb:patch` and `npm run amb:csm:retrieve`.

Windows status: the CSM bridge type-checks and local mock retrieval works. The
full AMB dependency install was blocked on Windows by AMB's optional
`hindsight-all -> hindsight-api -> uvloop` chain, because `uvloop` does not
support Windows. Continue on macOS or Linux.

## North Star

Hindsight is the comparator to beat:

- Repo: <https://github.com/vectorize-io/hindsight>
- Benchmark harness: <https://github.com/vectorize-io/agent-memory-benchmark>
- Target dataset: BEAM 100K first, then 500K/1M/10M.

Do not claim CSM beats Hindsight until AMB produces paired rows on the same
split/model/prompt/judge/scoring path.

## Mac Setup

```bash
git clone https://github.com/muhamadjawdatsalemalakoum/context-swarm-memory.git
cd context-swarm-memory
npm install
npm test
npm run lint
```

Install `uv` if needed:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Clone AMB:

```bash
mkdir -p ~/benchmarks
git clone --filter=blob:none --sparse https://github.com/vectorize-io/agent-memory-benchmark.git ~/benchmarks/agent-memory-benchmark
cd ~/benchmarks/agent-memory-benchmark
git sparse-checkout set src pyproject.toml README.md uv.lock data/beam/100k
git rev-parse --short HEAD
```

Patch AMB with CSM:

```bash
cd ~/path/to/context-swarm-memory
npm run amb:patch -- --amb-dir ~/benchmarks/agent-memory-benchmark
```

Run the first CSM BEAM smoke:

```bash
cd ~/benchmarks/agent-memory-benchmark
export CSM_REPO_DIR=~/path/to/context-swarm-memory
export CSM_PROVIDER=gemini
export CSM_MODEL=gemini-3.5-flash
export CSM_AMB_MODEL=gemini-3.5-flash
export CSM_AMB_MODEL_CONTEXT=8192
export GEMINI_API_KEY="<set locally; never commit>"
export GOOGLE_API_KEY="$GEMINI_API_KEY"
export OMB_ANSWER_LLM=gemini
export OMB_ANSWER_MODEL=gemini-3.5-flash
export OMB_JUDGE_LLM=gemini
export OMB_JUDGE_MODEL=gemini-3.5-flash

uv sync
uv run omb run --dataset beam --split 100k --memory csm --mode rag --category information_extraction --query-limit 1 --name csm-beam-100k-smoke
```

Then run Hindsight on the same slice:

```bash
uv run omb run --dataset beam --split 100k --memory hindsight --mode rag --category information_extraction --query-limit 1 --name hindsight-beam-100k-smoke
```

If Hindsight needs Docker or service setup, follow its current README and keep
the AMB result/failure log. A setup failure is not a CSM win.

## Evidence To Save Back

Save only non-secret artifacts:

- AMB commit SHA.
- Commands and environment variable names, not values.
- AMB result JSON for CSM and Hindsight.
- Failure logs if Hindsight or AMB fails.
- Run dates, model IDs, split, category, query limit, and scoring mode.

Do not commit `.env`, API keys, local caches, downloaded venvs, Docker volumes,
or raw provider credentials.

## Handover Prompt

```text
You are continuing Context Swarm Memory from the public repo on macOS.

Goal: make CSM beat Hindsight on a real current SOTA memory benchmark, not old RAG controls.

Current repo state:
- CSM has an AMB bridge committed:
  - integrations/amb/csm_provider.py
  - scripts/patch-amb-csm-provider.ts
  - scripts/amb-csm-retrieve.ts
  - npm scripts amb:patch and amb:csm:retrieve
- docs/SOTA_BENCHMARK_PLAN.md marks Hindsight as the north-star comparator.
- Windows blocked the full AMB install because hindsight-all pulls uvloop, which does not support Windows.
- Continue on macOS/Linux.

Tasks:
1. Clone this repo and run npm install, npm test, npm run lint.
2. Clone vectorize-io/agent-memory-benchmark with BEAM 100K data.
3. Run npm run amb:patch against the AMB checkout.
4. Run a one-query BEAM 100K CSM smoke through AMB using Gemini 3.5 Flash.
5. Run the same BEAM slice against Hindsight through AMB.
6. Save result JSONs/failure logs with no secrets.
7. If both smoke runs work, scale to all information_extraction queries at 100K.
8. Only after paired CSM-vs-Hindsight rows exist, update README/docs/charts. Do not claim SOTA from smoke rows.
```
