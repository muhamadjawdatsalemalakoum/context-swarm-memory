# CSM End-to-End Plan: Public-Ready State with Reproducible MCQ Benchmark

**Goal.** Build CSM to a public-ready state under the MIT License with documentation, a credible head-to-head benchmark on a programmatically-scored multiple-choice eval, and one-command reproducibility. Tag `v0.2.0` locally after maintainer approval. **Target: 5–7 weeks.**

**Out of scope.** Patent work. README "Future work" items beyond what the benchmark needs (HTTP/MCP server, autonomous Committer, encryption, multi-user). Add later as separate releases.

---

## Non-negotiable success criteria

A "ready-to-flip-public" decision requires ALL of:

1. **Benchmark.** ≥200 events, ≥30 ground-truth-labeled MCQ queries (40 options each, exactly one correct), CSM + 3 baselines (long-context, vanilla RAG, hybrid RAG), ≥3 trials, 95% CIs reported via 10K-resample bootstrap.
2. **Programmatic scoring only.** Accuracy = exact-match on the chosen option (1–40). Citation quality = precision/recall against ground-truth `relevant_event_ids`. **No LLM judge anywhere.**
3. **Reproducibility.** `npm run bench:replay` runs the full benchmark from cached Ollama responses in <5 minutes with zero LLM calls and produces byte-identical summary numbers.
4. **One-command UX.** A new user can `git clone … && npm install && npm test && npm run bench:replay` and see the published numbers, no API key, no Ollama, no GPU required.
5. **Documentation.** README walks `git clone` → results in <10 min reading. Architecture overview + benchmark methodology + reproducibility guide + CONTRIBUTING all present and accurate.
6. **CI workflow file present and validated.** `.github/workflows/ci.yml` lints clean.
7. **License clean.** `LICENSE` (MIT) + `NOTICE` (third-party attribution).
8. **Honest results.** Published numbers come from a single tagged run. Failure cases written up alongside wins. Limitations section explicit.

If any of those slips, the public-ready tag waits.

---

## Workstreams

| Track | What | Blocks |
|---|---|---|
| A | Eval harness, baselines, programmatic scorer, Ollama cache | nothing |
| B | Synthetic corpus + MCQ queries (40 options each, ground-truth labels) | nothing |
| C | Pre-pilot + pilot + primary run + ablations + write-up | A and B |
| D | Documentation, packaging, public-ready prep (no public push) | partial overlap with A/C |

A and B start day 1. D starts week 1 (drafting in parallel). C starts when A and B are both done AND user has Ollama running on the 4090.

---

## Phase A — Eval harness & baselines

Lives in `src/eval/`. Extends current smoke-eval scaffold; do not break `npm run eval` for the existing fixture suite.

### A.0 Spec alignment
- This file (`specs/benchmark-and-release-plan.md`) updated to match locked decisions before any code lands. (Done as the first task in Phase A.)

### A.1 Baseline runners
- `src/eval/baselines/longContext.ts` — concatenate all events into one prompt, with truncation at the model context limit (recorded per query). Output: chosen option number + cited event IDs.
- `src/eval/baselines/vanillaRag.ts` — chunk-by-event, embed via **`all-MiniLM-L6-v2` (`@huggingface/transformers`, fully local)**, top-K cosine (K∈{5,10}), generate.
- `src/eval/baselines/hybridRag.ts` — BM25 + vector RRF fusion, top-K, generate.
- `src/eval/baselines/csm.ts` — thin wrapper over `ask()` with `skipQueryLog: true` to convert `MemoryPacket` → `BaselineResult`.

Common interface: `answer(query: McqQuery, corpus: Corpus) → Promise<{ chosenOption: number, citedEventIds: string[], inputTokens: number, outputTokens: number, latencyMs: number, model: string }>`.

All four baselines call **the same Gemma 4 model via Ollama** for fair head-to-head.

### A.2 Programmatic scorer (replaces LLM judge)
- `src/eval/scorer.ts` — pure function. Inputs: system output (`{ chosenOption, citedEventIds }`) + ground truth (`{ correctOption, relevantEventIds }`). Outputs: `{ correct: boolean, citationPrecision: number, citationRecall: number, f1: number }`.
- Exact-match scoring on `chosenOption`. No interpretation. No LLM call.
- Citation P/R computed against `relevantEventIds`.

### A.3 MCQ helpers
- `src/eval/mcq.ts` — types + helpers for the multiple-choice format:
  - `McqQuery = { id, question, options: string[40], correctOption: number, relevantEventIds: string[] }`
  - Prompt templates that frame the 40 options to the model with explicit "respond with a single integer 1–40 and a JSON list of cited event IDs" instructions.
  - Robust output parser (regex-first for `^\d+`, JSON-fallback, malformed → `chosenOption=0` recorded as wrong).

### A.4 Ollama provider (verify/extend)
- `src/providers/OllamaProvider.ts` — verify it works (the README mentions Gemma-on-4090 setup). Add 4090-tuned defaults documented in the "4090 Hardware Engineering" section below.
- Generation params per call: `temperature=0`, `seed=42`, `num_predict=8` (output is just a number + maybe a tiny JSON list — short).

### A.5 Response cache (cache-first architecture)
- `data/eval/cache/<sha256-of-(model + prompt + temperature + seed + num_predict)>.json` — atomic writes (tmp + rename). Cache every Ollama call (recall, synth, answer, probe).
- Cache key includes ALL generation parameters → no silent drift. Replay is API-free forever.
- Pin Ollama model tags explicitly (`gemma4:31b@<digest>`) so cache stays valid across pulls.

### A.6 Runner
- `src/eval/runner.ts` — given `BenchmarkSuite = { corpus, queries, systems, trials }`, run the matrix. Write `data/eval/runs/<runId>/{config.json, results.jsonl, summary.json}`. Resumable on crash via cache. Progress bar + tok/s ticker.

### A.7 CLI surface
Add to `src/cli/index.ts`:
- `csm bench run --corpus <path> --systems csm,longctx,rag,hybrid --trials 3` — runs fresh against local Ollama, writes a new `runId`.
- `csm bench replay <runId>` — recompute summary from cached Ollama responses, no LLM calls.
- `csm bench ablate <runId> --variant no-router|no-probe|no-synth-skip|no-scoped-recall`
- `csm bench report <runId>` — render Markdown table + CSV from `summary.json`.
- `csm bench fill-cache --corpus <path>` — **new**: dedicated "warm the cache" command, intended for the user's one-shot 4090 run during Phase C.

And npm script aliases:
- `npm run bench:smoke` — 3 queries × 4 systems × 1 trial against MockProvider. <30s. $0.
- `npm run bench:replay` — replays the published `runId` from cache. No LLM. <5 min. $0.
- `npm run bench:full` — full primary run, fresh Ollama. ~30–50 min wall on a 4090. $0 cash.
- `npm run bench:fill-cache` — warm the cache from scratch via local Ollama. $0 cash.
- `npm run bench:report` — regenerate tables/plots from a published run.

### A.8 Acceptance for Phase A
- Smoke matrix against MockProvider runs end-to-end in <30s.
- Smoke matrix against local Ollama on a sample query completes in <10s.
- `replay` regenerates byte-identical summary from cache.

**Estimate: 7–9 working days.**

---

## Phase B — Synthetic corpus & MCQ queries

The corpus IS the proof. A toy corpus invalidates the benchmark.

### B.1 Corpus authoring (Day 1)
- **Synthetic project log**: ~200 events of a fictional fintech-adjacent SaaS startup, 5-person team, 3 months. Events span commits, design docs, decisions, incident postmortems, customer-feedback notes, retros.
- Authored together with the queries that target each event — every query's correct answer ties to specific event IDs.
- Stored under `data/eval/corpus-synthetic/`.
- License: CC0 / public-domain dedication (we author it; no upstream license issues).

### B.2 Importer
- `src/eval/corpus/importSynthetic.ts` — reads the authored event spec, emits via `csm remember` calls into `data/eval/corpus-synthetic/`.
- Output: ~200 events across 8–12 shards.
- Deterministic; re-imports are free.

### B.3 MCQ query design
- ~30 queries. Distribution:
  - 60% single-shard answerable (router test)
  - 30% multi-shard synthesis
  - 10% adversarial / no-answer (correct option = "no decision was made" or similar)
- Each query has the structure: `{ id, question, options: string[40], correctOption: number, relevantEventIds: string[] }`.

### B.4 Distractor strategy (40 options per query)
For each question, generate 39 distractors + 1 correct answer, presented in **randomized order** (seeded for reproducibility):

| Tier | Count | What |
|---|---|---|
| Hard | 10 | Near-truths — mined from the corpus; close-but-wrong (right person/feature, wrong outcome; right decision, wrong week) |
| Medium | 15 | Plausible alternatives — believable answers that aren't in the corpus at all |
| Easy | 14 | Irrelevant-but-true claims — true statements about the corpus that don't answer the question |
| Correct | 1 | Ground truth |
| **Total** | **40** | |

Distractors are reviewed for fairness: no trick questions, no distractors that are genuinely plausible without corpus context that can be defended as also-correct.

### B.5 Ground-truth labels
- For each query, `relevantEventIds` lists the events that should appear in citations.
- Stored at `data/eval/corpus-synthetic/queries.json`.
- Since the corpus is authored alongside the queries, ground truth is unambiguous (no Cohen's κ needed — we wrote the events to match the answers).

### B.6 Acceptance for Phase B
- `data/eval/corpus-synthetic/` populated, ≥200 events, ≥8 shards.
- `queries.json` has ≥30 queries, each with exactly 40 options, exactly one `correctOption`, ≥1 `relevantEventIds`.
- Spot-check: long-context baseline answers ≥80% on a 5-query sanity sample (validates corpus internal consistency).
- A `corpus/README.md` documents authoring process, distractor strategy, license.

**Estimate: 4–5 working days.**

---

## Phase C — Run the matrix and write up

Blocks on A and B AND user's Ollama setup on the 4090.

### C.0 Pre-pilot (user's machine — REQUIRED before pilot)
- User installs Ollama, runs `ollama pull gemma4:31b` and `ollama pull gemma4:e4b`, sets the env vars in the "4090 Hardware Engineering" section, and starts `ollama serve`.
- Run `npm run bench:smoke` against the live Ollama: 5 queries, 1 system (CSM), 1 trial. ~5 min wall.
- **Verify:** Ollama responds, throughput within expected band (~25–40 tok/s on 31B), GPU temp <80°C, no OOM.
- **Cost: $0 cash, ~5 min electricity.**

### C.1 Pilot run
- 5 queries × 4 systems × 1 trial, ~10 min wall on the 4090.
- Verify cache works, scorer produces sensible numbers, no system silently broken.
- **Cost: $0 cash.** Investigate any anomaly before proceeding.

### C.2 Full primary run
- All 30+ queries × 4 systems × 3 trials, ~30–50 min wall on the 4090.
- Generator (recall/synth/answer): `gemma4:31b` Q4_K_M.
- Probe: `gemma4:e4b`.
- Same model for all 4 systems (CSM, long-context, vanilla RAG, hybrid RAG).
- **Cost: $0 cash, ~50 min electricity.** Cache means subsequent reruns/replays are free.

### C.3 Statistical analysis
- Per-metric: mean accuracy, mean citation P/R, 95% CI (bootstrap, 10K resamples, paired by query).
- Paired tests: **McNemar's test** on per-query correctness (binary outcomes), CSM vs each baseline.
- Multiple-comparison correction: **Benjamini-Hochberg**.
- Output: `data/eval/runs/<runId>/analysis.json` + Markdown table.

(Note: Wilcoxon signed-rank is not appropriate here — accuracy is binary per query, so McNemar's test on the 2×2 paired-discordance table is the correct paired test.)

### C.4 Ablations
1. **No router** — every query goes to probe on every shard.
2. **No probe** — router output goes directly to recall.
3. **No synth-skip** — always call synth LLM even when N≤1 recalls.
4. **No scoped recall** — recall sees full snapshot, not just `relevant_event_ids`.

For each: report Δaccuracy, Δcitation F1, Δcost (tokens), Δlatency vs full CSM with significance. ~30 min wall each on the 4090.

### C.5 Robustness sweep
- Subsample corpus to N=10, 100, 200 events.
- Run all 4 systems on a fixed 10-query subset at each N, ~30 min total wall.
- Plot accuracy and citation F1 vs N. **Headline figure** if curves diverge favorably.

### C.6 Results document
- `specs/benchmark-results.md`. Sections:
  - Setup (corpus, systems, exact Gemma 4 tags + digests, query design, distractor strategy)
  - Headline accuracy table (CSM, long-context, vanilla RAG, hybrid RAG) with CIs and McNemar p-values (BH-adjusted)
  - Citation P/R table
  - Ablation table
  - Robustness plot (description + raw data)
  - Failure analysis: 5 cases where CSM lost, 5 where it won decisively (full traces — query, retrieved context, chosen option, correct option, why)
  - **Limitations section, explicit:**
    - Single LLM family (Gemma 4) — results may not generalize to GPT-class or Claude-class models
    - Single corpus (synthetic) — domain effects untested
    - MCQ format constrains evaluation to selectable answers; free-form generation quality is untested
    - Single hardware target (RTX 4090); throughput numbers don't generalize
  - Reproduce: link to `npm run bench:replay`

### C.7 Acceptance for Phase C
- Headline table populated with statistical significance.
- All 4 ablations run; results honestly reported (including null results).
- Robustness plot drawn.
- Results document complete with limitations section.
- `npm run bench:replay` regenerates the headline numbers byte-for-byte from cache.

**Estimate: 5–8 working days, including the user's cache-fill window.**

---

## Phase D — Documentation, packaging, public-ready prep

Runs in parallel with A/B/C from Week 1. Final polish in the last week. **No public push.**

### D.1 README rewrite (target: 10-min read)

Structure:
1. **What is CSM** — one paragraph + the architecture diagram.
2. **Headline results** — small accuracy + citation F1 table, link to full benchmark.
3. **Quickstart** — three commands: install, test, see-the-bench (replay path; no Ollama needed).
4. **Architecture** — distilled to ~1 page; link to spec for deep dive.
5. **Use it yourself** — `csm init`, `csm remember`, `csm ask` walkthrough.
6. **Reproduce the benchmark from scratch** — Ollama-on-a-GPU walkthrough, link to `docs/REPRODUCING.md`.
7. **License** — MIT License with a plain-English summary.
8. **Status & roadmap** — current phase, what's missing, where to contribute (post-public).

### D.2 Architecture overview
- New: `docs/ARCHITECTURE.md` — distilled from `specs/context_swarm_memory_spec.md`. ~1 page, diagrams + invariants.

### D.3 Reproducibility guide
- New: `docs/REPRODUCING.md`. Step-by-step:
  1. `git clone … && npm install`
  2. `npm test` — confirms code works
  3. `npm run bench:replay` — confirms benchmark replays exactly from cache (no Ollama needed)
  4. (Optional, GPU recommended) Install Ollama, pull Gemma 4, set 4090 env vars
  5. (Optional) `npm run bench:smoke` — confirms fresh-Ollama path works
  6. (Optional) `npm run bench:fill-cache` — full re-run from scratch
- Document: hardware/OS assumptions (RTX 4090 baseline; smaller GPUs noted), Node version, expected wall-clock, expected throughput, how to swap Ollama models.

### D.4 Benchmark methodology
- New: `docs/BENCHMARK_METHODOLOGY.md`. Documents:
  - Corpus authoring process + license (CC0)
  - MCQ format rationale (programmatic, no judge bias, reproducible)
  - Distractor strategy (10 hard + 15 medium + 14 easy + 1 correct)
  - Query selection criteria
  - System configurations (RAG K, chunk size, embedding model, BM25 params, etc.)
  - Generator + probe models (exact Gemma 4 tags + digests)
  - Trials + temperature + seed + num_predict handling
  - Statistical methodology (McNemar's, bootstrap CIs, Benjamini-Hochberg)
  - **Threats to validity** — explicit (Gemma family, synthetic corpus, MCQ ceiling effects)

### D.5 CONTRIBUTING.md
- How to run tests
- Coding conventions (small files, Zod schemas, no JSON.parse, mock-fence rule)
- Commit message style
- PR process
- How to run benchmark locally before submitting changes that touch router/probe/recall/synth

### D.6 LICENSE + NOTICE
- `LICENSE` — MIT License with copyright holder filled in.
- `NOTICE` — attributions for third-party code/data (Gemma weights license, `@huggingface/transformers`, `all-MiniLM-L6-v2`, etc.).
- README license section uses plain English; LICENSE file is authoritative.

### D.7 CI workflow file (validated, not yet active)
- New: `.github/workflows/ci.yml`. On push + PR (once public):
  - Node 20 + 22 matrix
  - `npm ci`
  - `npm run lint`
  - `npm test`
- Optional second job (manual trigger only): `npm run bench:replay` — confirms cache integrity.
- File is present and lint-validated locally (`actionlint` or equivalent).

### D.8 Cache artifact strategy
- **Small caches (<10 MB)** — check into the repo at `data/eval/cache/`.
- **Large caches** — publish as a GitHub Release attachment (`bench-cache-<runId>.tar.gz`); add a `npm run bench:fetch-cache` script.
- **Decision required** based on actual cache size after C.2.

### D.9 Local tag (NOT pushed)
- `CHANGELOG.md` — "0.2.0 – Public-ready state with reproducible MCQ benchmark."
- Version bump to `0.2.0` in `package.json`.
- `git tag v0.2.0` **locally only**. No `git push --tags`.
- Public-release checklist completed:
  - GitHub repository metadata confirmed
  - MIT license metadata confirmed
  - Cache fits in-repo or release-attachment plan ready
  - Final review of LICENSE + NOTICE + README
  - Maintainer approval recorded before tag or release.

### D.10 Acceptance for Phase D
- A fresh clone lands on README and can run `git clone && npm install && npm test && npm run bench:replay` with success in <10 min.
- All linked docs exist and are accurate.
- CI workflow file lints clean (verified locally).
- License is unambiguous.
- `git tag v0.2.0` exists locally; **no remote push**.
- Release-readiness checklist complete, awaiting maintainer sign-off.

**Estimate: 5–7 working days, spread over the project.**

---

## 4090 Hardware Engineering

The benchmark runs on a local RTX 4090-class GPU via Ollama. These settings are critical for stable, reproducible throughput.

### Ollama environment variables (set before `ollama serve`)

| Var | Value | Why |
|---|---|---|
| `OLLAMA_FLASH_ATTENTION` | `1` | Enables flash attention; required for sane throughput on Ada-class GPUs |
| `OLLAMA_KV_CACHE_TYPE` | `q8_0` | Quantized KV cache; ~2× context fit, negligible quality hit |
| `OLLAMA_NUM_CTX` | `8192` | Sufficient for our prompts; larger wastes VRAM |
| `OLLAMA_KEEP_ALIVE` | `10m` | Keeps the model resident across sequential bench calls |
| `OLLAMA_NUM_PARALLEL` | `1` | Avoid GPU thrashing under sequential bench load (we want single-stream throughput, not concurrency) |

### Models
- Primary (recall / synth / answer): `ollama pull gemma4:31b` (Q4_K_M, ~17 GB).
- Probe: `ollama pull gemma4:e4b` (~3 GB).

### Optional thermal safety
- `nvidia-smi -pl 350` caps power at 350W (of 450W max). Result: ~10°C cooler, ~3% perf hit. Recommended if case airflow is questionable or sustained runs are expected.

### Expected throughput & thermals
- `gemma4:31b` Q4_K_M: ~25–40 tok/s generate.
- `gemma4:e4b`: ~80–150 tok/s generate.
- GPU temp: 70–78°C under sustained load with stock cooling.
- Full benchmark wall-clock: ~30–50 min.

---

## Calendar (5–7 weeks, public-ready)

| Week | A: Harness | B: Corpus | C: Experiments | D: Docs/release |
|------|-----------|-----------|----------------|-----------------|
| 1 | Spec alignment (A.0); baselines + scorer + cache | Synthetic event spec | — | README rewrite v1 + CONTRIBUTING |
| 2 | Runner + CLI + smoke (MockProvider) | 200 events authored, MCQ design | — | LICENSE + NOTICE + CI workflow file |
| 3 | Polish, ablation hooks, OllamaProvider verify | Distractor authoring + curation | — | ARCHITECTURE + REPRODUCING drafts |
| 4 | — | — | Maintainer pre-pilot on 4090 + pilot | BENCHMARK_METHODOLOGY draft |
| 5 | — | — | Full primary run + ablations | Cache strategy decision + scripts |
| 6 | — | — | Robustness sweep + analysis | Polish all docs, version bump, CHANGELOG |
| 7 | — | — | Sanity reruns, bug fixes, results doc | **Local tag v0.2.0 + release-readiness checklist** |

Slip allowance: +1 week if pilot reveals systemic issues or distractor curation drags.

---

## Budget

| Item | Estimate |
|------|----------|
| External APIs (OpenAI, Anthropic, etc.) | **$0** |
| Claude Code subagent usage (engineering) | covered by maintainer tooling |
| Ollama / Gemma 4 (local 4090-class GPU) | **$0** + electricity |
| Embedding model (`all-MiniLM-L6-v2` via `@huggingface/transformers`) | **$0** (local) |
| Labeling / contractors | **$0** (corpus is authored alongside queries) |
| GitHub | **$0** |
| Electricity (one full bench fill: ~30–50 min at ~350W) | <$0.10 |
| **Total cash** | **$0 (electricity-only)** |

No legal fees, no filing fees, no API fees.

---

## Decision gates

1. **End of pre-pilot — Hardware gate.** If Ollama throughput is wildly off-spec (e.g., <10 tok/s on 31B, OOM, GPU thermal throttle), debug before pilot. Likely fixes: env vars not set, wrong quant, background GPU contention.
2. **End of pilot — Pilot quality gate.** If pilot shows CSM is not measurably ahead of vanilla RAG, debug before the primary run. Likely fixes: prompt revision, RAG hyperparameter tuning, distractor difficulty audit. Do NOT proceed to the full run blind.
3. **End of primary run — Headline gate.** If the primary run shows CSM doesn't win on accuracy OR citation F1, write it up honestly. Decision: still build to public-ready state (the framework + reproducible bench is valuable on its own), but reframe the README from "CSM beats RAG" to whatever the data says.
4. **End of Phase D — Release gate.** Maintainer reviews the release-readiness checklist and decides go / no-go on tag and public release.

---

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Gemma 4 underperforms GPT-class on MCQ (results unimpressive across all systems) | Pilot first; if even long-context can't crack 50% on a sanity sample, audit corpus difficulty / prompt clarity before going further |
| GPU thermal throttling skews per-trial latency | Optional `nvidia-smi -pl 350` cap; record GPU temps per trial; redo any trial with throttle events |
| Cache key drift (silent stale-cache reads) | Cache key includes ALL generation params (`model`, `prompt`, `temperature`, `seed`, `num_predict`); replay diff-checks summary against tagged baseline byte-for-byte |
| Distractors too easy (ceiling) or too hard (floor) | Spot-check long-context baseline accuracy ≥80% on sanity sample, ≤95% on full set; tune if outside band |
| Distractor curator unconsciously favors CSM | Distractor authoring blind to which system retrieves what; reviewer checks for "answer leaks" via lexical overlap with corpus chunks |
| RAG baseline under-tuned (unfair fight) | Sweep K and chunk size on a held-out 5 queries; document the sweep |
| Synthetic corpus favors CSM artificially | Limitations section explicitly notes single-corpus constraint; second corpus is post-v0.2.0 follow-up |
| Cache too large for in-repo storage | Pre-decided fallback to release attachment + `bench:fetch-cache` (D.8) |
| License metadata drift | Keep `LICENSE`, README, `package.json`, `NOTICE`, and contribution docs aligned on MIT |
| Reproducibility broken by Ollama model pull drift | Pin exact `gemma4:31b@<digest>` in config; document in REPRODUCING.md |
| Repo accidentally published before approval | Local tag only; no `git push --tags`; no visibility changes until explicit maintainer approval |

---

## What gets delivered at the end

- GitHub repo with MIT LICENSE present.
- `npm run bench:replay` works in <5 min, no API, no Ollama needed.
- README, ARCHITECTURE, REPRODUCING, BENCHMARK_METHODOLOGY, CONTRIBUTING, LICENSE, NOTICE, CHANGELOG.
- `data/eval/corpus-synthetic/` — corpus + MCQ queries + ground-truth labels.
- `data/eval/runs/<runId>/` — primary run results + ablations + robustness sweep, fully reproducible from cache.
- `specs/benchmark-results.md` — written results document with headline table, ablations, robustness plot, failure analysis, limitations.
- `git tag v0.2.0` **local**.
- `.github/workflows/ci.yml` — present and lint-clean; activates on flip.
- A release-readiness checklist awaiting maintainer sign-off.

---

## Open decisions before / during the project

1. **GitHub repository target** — needed before any `git remote add`.
2. **Ollama setup confirmation timing** — maintainer installs Ollama + pulls Gemma 4 + sets env vars + runs pre-pilot smoke at start of Phase C. (Blocking for Phase C.)
3. **Decision to publish** — maintainer reviews the release-readiness checklist and explicitly approves tag/release.
