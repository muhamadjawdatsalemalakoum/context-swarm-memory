# Official AMB BEAM 100K rerun — run manifest

Date: 2026-06-10. Purpose: reproduce the CSM BEAM 100K result through the
unmodified public AMB runner per the maintainers' guidance (follow the repo
instructions, demonstrate results with the benchmark runners), certifying the
June 2026 CSM architecture.

## Pinned versions

- AMB repo: https://github.com/vectorize-io/agent-memory-benchmark
- AMB base SHA: `45fa380523afab9b1acd667a03de51c5ea63f4d2` (HEAD of main)
- Provider branch: `csm-provider` — commits `632b6c4` (provider
  `src/memory_bench/memory/csm.py` + registry line in
  `src/memory_bench/memory/__init__.py`) and `cf0d47a` (README requirements
  blurb). **No changes to AMB scoring, answer prompt, judge prompt, gold
  data, or any harness source.** (Unlike the May 2026 local run, AMB's
  `llm/gemini.py` is NOT patched.) The run executed from this branch content;
  the branch commits were re-authored for attribution before publication with
  identical trees.
- CSM repo SHA: `599dfc0` (context-swarm-memory, main).
- Checkout: `E:\benchmarks\amb-t3-data` (sparse: `data/beam` + `src`).

## Environment recipe (Windows)

- Python 3.12.10, uv 0.11.19, Node 24.15.0 (CSM bridge), npm 11.12.1.
- `uv sync --no-install-package uvloop` — uvloop arrives transitively
  (`hindsight-all → hindsight-api → uvloop`) and does not build on Windows;
  it is only needed to run Hindsight's own server, never the csm path.
- All commands use `uv run --no-sync` (plain `uv run` re-attempts the uvloop
  build) and `PYTHONUTF8=1` (AMB's rich console output otherwise crashes on
  cp1252 when piped).

## Models

- CSM internal retrieval: `gemini-3.5-flash` (recall/synthesis, thinking=low),
  `gemini-2.5-flash-lite` (probe stage, gated 2026-06-10).
- AMB answer model: `gemini:gemini-3.1-pro-preview` (`OMB_ANSWER_LLM`/
  `OMB_ANSWER_MODEL`; HEAD default is groq — override required).
- AMB judge model: `gemini:gemini-2.5-flash-lite` (`OMB_JUDGE_LLM`/
  `OMB_JUDGE_MODEL`).
- Same answer/judge path as the accepted Hindsight BEAM 100K artifact.

## CSM configuration (env)

CSM_PROVIDER=gemini, CSM_GEMINI_MODEL=gemini-3.5-flash,
CSM_GEMINI_THINKING=low, CSM_GEMINI_TIMEOUT_MS=600000,
CSM_GEMINI_MAX_RETRIES=2, CSM_AMB_MODEL=gemini-3.5-flash,
CSM_AMB_MODEL_CONTEXT=8192, CSM_AMB_MAX_OUTPUT_TOKENS=512,
CSM_AMB_RETURN_K=24, CSM_AMB_SUMMARY_RETURN_K=24,
CSM_AMB_REASONING_RETURN_K=32, CSM_AMB_NEIGHBOR_WINDOW=1,
CSM_PROBE_MODEL=gemini-2.5-flash-lite, CSM_PARALLEL_PROBES=1,
CSM_REPO_DIR=<context-swarm-memory checkout>,
CSM_AMB_TELEMETRY_JSONL=<this dir>/csm-token-telemetry.jsonl.
Defaults in effect at CSM `599dfc0`: coverage/chronicle mode ON,
hybrid router OFF, eager tier-2 recalls OFF, retrieve-only bridge.
GEMINI_API_KEY supplied via process env; never written to any artifact.

## Commands

Sanity (captured in this dir):
`uv run --no-sync omb providers` → csm listed; `uv run --no-sync omb splits
--dataset beam` → 100k/500k/1m/10m.

Smoke (passed, 1/1 correct; artifacts: `amb-outputs-smoke/`,
`smoke-telemetry.jsonl`, `smoke-stdout.log`; retrieval wall 3.35 s):
`uv run --no-sync omb run --dataset beam --split 100k --memory csm --mode rag
--query-limit 1 --output-dir <this dir>/amb-outputs-smoke --name
csm-official-smoke`

Full run:
`uv run --no-sync omb run --dataset beam --split 100k --memory csm --mode rag
--output-dir <this dir>/amb-outputs --name csm-official-rerun-100k`
(resume after interruption: append `--skip-ingested`)

## Integrity

- CSM retrieval receives only AMB documents, the scoped query, user id, and
  timestamp. No gold answers, rubrics, query IDs, or benchmark-specific
  hardcoding in retrieval (the June wave additionally deleted the legacy
  BEAM-domain term tables from the active coverage path).
- The telemetry sidecar reports CSM-internal tokens separately from AMB's
  answer-visible `context_tokens`, so CSM's full cost is not under-reported.
- Result not to be described as official/leaderboard-accepted until the AMB
  maintainers accept the runner/provider/result.
