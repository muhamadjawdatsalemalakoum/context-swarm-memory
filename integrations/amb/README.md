# Agent Memory Benchmark Bridge

> **Read [`../../docs/STATUS.md`](../../docs/STATUS.md) first.** The status
> banner below is from 2026-06-09. Since then: PR #19 was author-closed
> unmerged; the upstream runner changed (post-PR-#20); the May comparison
> quoted further down is historical and not comparable to a current run; and
> `amb:patch` makes two upstream edits (provider registration in
> `memory/__init__.py`, an HTTP timeout in `llm/gemini.py`) in addition to
> copying the provider file.
>
> **Status 2026-06-09:** the officialization effort is paused while CSM core
> R&D (warm service, token cost, summarization/ordering) lands. Everything
> verified against AMB HEAD and the exact resume runbook live in
> [`../../docs/AMB_OFFICIALIZATION_STATUS.md`](../../docs/AMB_OFFICIALIZATION_STATUS.md).
> Note: at AMB HEAD `45fa38052` the real CLI is still `omb` with `--split`;
> the upstream README's `amb`/`--domain` syntax is ahead of the code.

This bridge lets the public Agent Memory Benchmark (AMB) runner evaluate CSM as
a memory provider without forking AMB.

## What It Does

- Adds an AMB `MemoryProvider` named `csm`.
- Stores AMB `Document` rows as JSONL during `ingest`.
- Calls this repo's TypeScript CSM retrieval path during `retrieve`.
- Returns the retrieved CSM documents to AMB's normal `rag` mode, so AMB still
  owns the BEAM prompt and judge path.

Since 2026-06-10 the bridge is **retrieve-only by default**: it stops after
CSM's probe → recall → synthesis pipeline and never runs CSM's internal final
answer call (which AMB discards in rag mode anyway; it cost ~7.1K input tokens
and ~2.7 s per query on the May BEAM run). `--with-internal-answer` (or
`CSM_AMB_WITH_INTERNAL_ANSWER=1`) restores the legacy path for A/B. Probes and
recalls also now run in parallel against hosted providers
(`CSM_PARALLEL_PROBES` overrides), and the bridge auto-loads the CSM repo's
`.env`, reports `llm_provider`/`llm_model` in `raw_response`, and refuses to
run on MockProvider unless `CSM_AMB_ALLOW_MOCK=1`. Measured effects:
[`../../docs/PERF_BREAKDOWN.md`](../../docs/PERF_BREAKDOWN.md).

Since 2026-06-10 the provider uses a **warm Node service**
(`npm run amb:csm:serve`, `scripts/amb-csm-server.ts`): it is started once in
AMB's `initialize()` hook, ingests documents over localhost HTTP, caches the
built corpus per user scope, and serves every retrieval from the same process
(`cleanup()` shuts it down). The original per-query subprocess script
(`npm run amb:csm:retrieve`) is kept for one-shot debugging and for
reproducing the May 2026 BEAM run. The May full BEAM 100K run used the
per-query path; future runs use the warm service.

## North Star: Hindsight

Hindsight is the named comparator to beat. It presents itself as agent memory
that learns over time, with retain/recall/reflect APIs and a public SOTA memory
benchmark story. CSM should not claim victory by beating weak RAG controls.

The first full local comparison (May 2026, pre-#20 runner, **historical**) on
BEAM 100K: CSM scored 0.757573 with 342/400 correct rows versus the accepted
Hindsight artifact at 0.733658 with 326/400 correct rows. Superseded by the June
official-runner rerun and then by the August campaign; see STATUS.md. Record:
[`../../docs/BEAM_100K_CSM_VS_HINDSIGHT.md`](../../docs/BEAM_100K_CSM_VS_HINDSIGHT.md).

Future publishable tables should include at least:

- CSM via this AMB bridge
- Hindsight via AMB's Hindsight provider
- AMB's strongest published Hindsight row, if the exact same split is available
- BM25 or hybrid-search as a control, clearly labeled as a control

## Patch An AMB Checkout

```powershell
git clone --filter=blob:none --sparse https://github.com/vectorize-io/agent-memory-benchmark.git E:\benchmarks\agent-memory-benchmark
cd E:\benchmarks\agent-memory-benchmark
git sparse-checkout set src pyproject.toml README.md data/beam/100k

cd "C:\path\to\context-swarm-memory"
npm run amb:patch -- --amb-dir E:\benchmarks\agent-memory-benchmark
```

## Run A BEAM 100K Smoke

From the AMB checkout:

```powershell
$env:CSM_REPO_DIR="C:\path\to\context-swarm-memory"
$env:CSM_PROVIDER="gemini"
$env:CSM_MODEL="gemini-3.5-flash"
$env:CSM_AMB_MODEL="gemini-3.5-flash"
$env:CSM_AMB_MODEL_CONTEXT="8192"
$env:GEMINI_API_KEY="<your key>"

uv run omb run --dataset beam --split 100k --memory csm --mode rag --query-limit 1 --name csm-beam-100k-smoke
```

## macOS Path

macOS is the preferred next environment because the full AMB dependency stack is
not blocked by Windows-only `uvloop` support issues.

```bash
git clone https://github.com/muhamadjawdatsalemalakoum/context-swarm-memory.git
cd context-swarm-memory
npm install
npm test

mkdir -p ~/benchmarks
git clone --filter=blob:none --sparse https://github.com/vectorize-io/agent-memory-benchmark.git ~/benchmarks/agent-memory-benchmark
cd ~/benchmarks/agent-memory-benchmark
git sparse-checkout set src pyproject.toml README.md uv.lock data/beam/100k

cd ~/path/to/context-swarm-memory
npm run amb:patch -- --amb-dir ~/benchmarks/agent-memory-benchmark

cd ~/benchmarks/agent-memory-benchmark
export CSM_REPO_DIR=~/path/to/context-swarm-memory
export CSM_PROVIDER=gemini
export CSM_MODEL=gemini-3.5-flash
export CSM_AMB_MODEL=gemini-3.5-flash
export CSM_AMB_MODEL_CONTEXT=8192
export GEMINI_API_KEY="$GEMINI_API_KEY"
uv sync
uv run omb run --dataset beam --split 100k --memory csm --mode rag --query-limit 1 --name csm-beam-100k-smoke
```

Use `--category information_extraction` or another BEAM category to target a
specific memory ability. Increase `--query-limit` only after the one-query smoke
has saved a clean AMB result JSON.

## Token Accounting Audit

AMB's result JSON reports `context_tokens`, which is the retrieved context passed
to the AMB answer model. That is the right apples-to-apples context-window
number, but it is not the whole CSM cost because CSM also spends tokens inside
its own probe/recall/synthesis pipeline before AMB answers.

Set `CSM_AMB_TELEMETRY_JSONL` during BEAM runs to save a per-query CSM token
ledger:

```bash
export CSM_AMB_TELEMETRY_JSONL="$CSM_REPO_DIR/data/eval/runs/amb-beam-100k-full-v3/csm-token-telemetry.jsonl"
```

Each row includes:

- CSM internal input/output/total tokens across all LLM calls the bridge made,
- probe/recall counts, returned event counts, evidence-capsule flags, and bridge
  wall-clock latency,
- a query hash and query text for joining back to AMB's saved per-query rows.

In the default retrieve-only mode the `csm_internal_answer_*` fields are null
because no internal answer call is made; internal totals equal pipeline
totals. Legacy rows (May 2026 run, or `--with-internal-answer`) split out the
discarded answer call explicitly.

Final BEAM reports should show both numbers: AMB `context_tokens` for the answer
model's visible context, and CSM internal token totals from this JSONL sidecar.
Otherwise CSM would look cheaper than it really is.

## Evidence Rules

Do not use the smoke result as a README SOTA claim. A publishable BEAM claim
needs:

- a clean AMB result file with per-query rows,
- a saved AMB commit SHA and dataset split,
- model IDs and run date,
- judge prompts/responses or AMB's saved scoring fields,
- at least the 100K split before scale claims,
- 100K, 500K, 1M, and 10M before saying CSM improves or holds under BEAM scale.
