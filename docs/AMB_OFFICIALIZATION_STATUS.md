# AMB Officialization: Status and Resume Runbook

Status: **paused by decision on 2026-06-09**, in favor of a CSM core R&D phase
(latency first: warm-service architecture, then token cost, then the
summarization/event-ordering score gaps). The full official BEAM 100K run is
deliberately deferred so that the one run we submit certifies the *improved*
CSM, not the current 29 s/query bridge.

This page is the complete handover for resuming the mission. It records what
was verified against AMB HEAD on 2026-06-09 so none of that research has to be
repeated.

## Mission

Move CSM from "local accepted-artifact BEAM 100K comparison" to "officially
reproducible AMB runner/provider" so vectorize-io can publish the CSM result as
official rather than unsubstantiated. Chris Latimer (Hindsight/vectorize)
confirmed our local Hindsight comparison numbers agree with their published
AMB BEAM 100K result, and said official publication requires following the AMB
repo instructions and demonstrating results with the benchmark runners.

Local result being officialized (NOT yet official; see
[BEAM_100K_CSM_VS_HINDSIGHT.md](BEAM_100K_CSM_VS_HINDSIGHT.md)):

| System | Score | Correct | Avg answer-visible context | Avg retrieval latency |
|---|---:|---:|---:|---:|
| CSM | 0.757573 | 342/400 | 10,914 tokens | 29.230 s |
| Hindsight | 0.733658 | 326/400 | 17,654.6 tokens | 6.379 s |

## What was verified against AMB HEAD (2026-06-09)

AMB = <https://github.com/vectorize-io/agent-memory-benchmark>, default branch
`main`, HEAD `45fa38052` (2026-05-08, "Update memory provider to use Gemini
2.5 Flash (#10)"). Repo size ~697 MB (data + published outputs are committed).

- **The CLI entry point is still `omb`, not `amb`.** HEAD `pyproject.toml`
  has `[project.scripts] omb = "memory_bench.cli:app"` and nothing else. HEAD
  `cli.py` implements `run --split <s>` (required), plus commands `splits`,
  `providers`, `dataset-stats`, `publish-results`. The README at the same HEAD
  says `uv run amb run ... --domain 32k` and `uv run amb domains` — **the
  README is ahead of the code**. Resume step: re-verify, then run with
  `uv run omb ...` and `--split`, and flag the README/CLI mismatch to
  maintainers in the issue/PR.
- **`run` flags at HEAD**: `--split/-s` (required), `--dataset`, `--memory/-m`,
  `--mode` (default `rag`), `--llm` (answer LLM family, default `gemini`),
  `--category/-c`, `--query-limit/-q`, `--query-id`, `--doc-limit`, `--oracle`,
  `--skip-ingestion`, `--skip-ingested`, `--skip-retrieval`, `--skip-answer`,
  `--only-failed`, `--show-raw`, `--output-dir/-o` (default `outputs`),
  `--name/-n`, `--description/-d`.
- **Provider interface** (`src/memory_bench/memory/base.py`) is compatible with
  our existing bridge: class attrs `name/description/kind/provider/variant/
  link/logo/concurrency`; `prepare(store_dir, unit_ids, reset)`;
  `ingest(documents)`; `retrieve(query, k, user_id, query_timestamp) ->
  (list[Document], dict|None)`. New optional hooks since our bridge was
  written: `initialize()`/`cleanup()` (external-process setup — *exactly what a
  warm CSM sidecar should use*), `async_*` variants (default to threads),
  `retrieve_by_steps`, `direct_answer` (agent mode). Keep `concurrency = 1`
  unless the warm service is made safely concurrent.
- **`Document`** (`src/memory_bench/models.py`) gained
  `messages: list[dict] | None` (structured turns, used by Mem0). Our bridge's
  fields (`id/content/user_id/timestamp/context`) are still valid.
- **Registry** (`src/memory_bench/memory/__init__.py`): plain `REGISTRY:
  dict[str, type[MemoryProvider]]` literal. Upstream providers: bm25, cognee,
  hindsight, hindsight-cloud, hindsight-http, mastra, mastra-om, mem0,
  mem0-cloud, ogham, qdrant (hybrid_search), supermemory. **No `csm`
  upstream.** Our `scripts/patch-amb-csm-provider.ts` regexes still match the
  HEAD registry shape.
- **Datasets at HEAD**: beam, lifebench, locomo, longmemeval, membench, memsim,
  personamem; `data/beam/` is committed in the repo. Modes: rag, agentic_rag,
  agent.
- **Results path**: `outputs/{dataset}/{run-name|memory}/{mode}/{split}.json`.
  `omb publish-results <file>` strips `raw_response`, gzips, computes
  `avg_retrieve_time_ms`/`avg_context_tokens`, optionally uploads to Vercel
  Blob (`BLOB_READ_WRITE_TOKEN` — maintainers only), and regenerates
  `results-manifest.json`. So the official-publication lever is on their side;
  our deliverable is the provider + a reproducible result JSON.
- **Dependencies**: `uvloop` is **gone** from HEAD `pyproject.toml` — the old
  Windows blocker that pushed the May run to macOS appears resolved. Heavy
  deps remain (cognee, sentence-transformers/torch, hindsight-all, mem0ai), so
  `uv sync` is a multi-GB install. `cli.py` loads `.env` from the AMB repo
  root via python-dotenv with `override=True` and requires `GEMINI_API_KEY`
  (or `GOOGLE_API_KEY`).
- **Unverified at HEAD** (check at resume): whether the
  `OMB_ANSWER_LLM`/`OMB_ANSWER_MODEL`/`OMB_JUDGE_LLM`/`OMB_JUDGE_MODEL` env
  overrides used by the May 2026 Mac run still exist in `llm/__init__.py` and
  `judge.py`; the current default answer/judge models (commit #10 moved some
  provider-internal LLM to Gemini 2.5 Flash); whether `omb view` exists.
  Maintainers may prefer AMB-default answer/judge models over the May run's
  pinned ones — ask in the issue/PR.

## Machine state (Windows box, verified 2026-06-09)

- git 2.50.1, Node 24.15.0, npm 11.12.1, Python 3.12.10, **uv 0.11.19**
  (installed via pip this session), gh 2.91.0 authenticated as
  `muhamadjawdatsalemalakoum` with repo+workflow scopes (fork/PR/issue all
  possible).
- WSL has only docker-desktop (no general distro); plan is native Windows.
- Benchmark checkouts live at `E:\benchmarks\` (212 GB free). A blobless clone
  was started and intentionally killed at pivot time; nothing remains on E:.
- CSM repo `.env` is present with `CSM_PROVIDER`, `GEMINI_API_KEY`,
  `CSM_GEMINI_MODEL`, `CSM_GEMINI_THINKING` (names verified, values never
  logged). The csm CLI auto-loads it since commit `0aba021`.

## Resume runbook

1. Clone fresh and pin the SHA (PowerShell):

   ```powershell
   git clone --filter=blob:none https://github.com/vectorize-io/agent-memory-benchmark.git E:\benchmarks\agent-memory-benchmark
   git -C E:\benchmarks\agent-memory-benchmark rev-parse HEAD   # record AMB SHA
   ```

   The 2026-06-09 attempt stalled at 0 bytes for ~10 minutes before being
   killed at pivot; if that recurs, retry without `--filter` or check network.

2. `uv sync` in the AMB checkout (expect a large torch download). Confirm the
   old uvloop/Windows issue is really gone.

3. Re-verify the CLI before anything else: `uv run omb --help`. If `omb` and
   `--split` are still the reality, use them and note the README mismatch.

4. Create a branch in the AMB checkout (this is the upstream PR vehicle, not
   the patch script): add `src/memory_bench/memory/csm.py` (copy of
   [`integrations/amb/csm_provider.py`](../integrations/amb/csm_provider.py))
   and register `"csm"` in the registry. **The provider is already
   warm-service based** (2026-06-10): it starts `npm run amb:csm:serve` in
   AMB's `initialize()` hook, talks localhost HTTP, and shuts down in
   `cleanup()`. Provider env contract to document upstream: Node 22+,
   `CSM_REPO_DIR`, `npm install` in CSM, `GEMINI_API_KEY`, optional
   `CSM_AMB_MODEL`/`CSM_AMB_MODEL_CONTEXT`/`CSM_AMB_RETURN_K`/
   `CSM_AMB_TELEMETRY_JSONL` (full list in the provider docstring).
   Latency/token work since the May run: `PERF_BREAKDOWN.md`.

5. Sanity commands (capture stdout for artifacts):
   `uv run omb providers` and `uv run omb splits --dataset beam`.

6. One-query smoke:
   `uv run omb run --dataset beam --split 100k --memory csm --mode rag --query-limit 1 --name csm-beam-100k-smoke`.
   The full env recipe (model pins, retries, timeouts, telemetry sidecar) is in
   [BEAM_100K_CSM_VS_HINDSIGHT.md](BEAM_100K_CSM_VS_HINDSIGHT.md) — re-verify
   the `OMB_*` answer/judge overrides still exist before trusting it.

7. Full run only with the improved CSM, then preserve under
   `data/eval/runs/<run-id>/`: AMB SHA, CSM SHA, exact command, result JSON,
   stdout/stderr, telemetry sidecar. No secrets.

8. Fork + PR (or issue first) to vectorize-io/agent-memory-benchmark asking
   whether an external-provider PR is their preferred official submission
   path; reference the Chris Latimer exchange; include the local result with
   the explicit caveat that it is not official; flag the README `amb`/
   `--domain` vs code `omb`/`--split` mismatch; offer the telemetry sidecar as
   evidence of honest token accounting.

## Hard constraints (unchanged)

- No gold answers, rubrics, query IDs, or benchmark-answer hardcoding in CSM
  retrieval.
- Do not modify AMB scoring, answer prompt, judge prompt, or gold data.
- Use the same answer/judge model path as Hindsight or AMB defaults requested
  by maintainers.
- Report CSM internal tokens separately from AMB visible context tokens.
- Be explicit that CSM is slower than Hindsight (that is the thing the R&D
  phase is fixing first).
- No official-SOTA claims in README/docs until AMB maintainers accept the
  runner/result.
