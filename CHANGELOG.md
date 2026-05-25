# Changelog

All notable changes to Context Swarm Memory.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Phase α / β.1 / γ — token-efficiency + SOTA-baseline pass (2026-05)

Driven by a multi-agent research sweep: four parallel agents surveyed the 2024-2026 long-context-memory SOTA, audited CSM's token sinks, and produced implementation plans for token efficiency, serving-stack migration, and SOTA baseline integration. The findings reframed CSM's pitch from "beats hybrid RAG" (2023-vintage) to "competitive with the published 2025 frontier (HippoRAG 2 / LightRAG / Mem0) AND uniquely scalable to 10M+ token corpora where the frontier cannot be indexed at all on consumer hardware." Implementation in three rolling phases:

#### Phase α — disable thinking + drop unused fields + codify prefix cache (low-risk, ~3 hr eng time)

- **`disableThinking` flag** (`src/providers/LlmProvider.ts`, `OpenAIProvider.ts`, `cachedLlm.ts`, `cache.ts`). New optional field on `CompleteJsonInput` / `CompleteTextInput` / `CacheKeyInput` / `CachedLlmCallInput`. When true, `OpenAIProvider` sets `body.think = false` (Ollama-native, silently ignored by real OpenAI), suppressing Gemma 4 / DeepSeek R1 / Qwen 3 reasoning output. Plumbed through the cache key conditionally (only included in the hash when truthy) so existing entries — written without the field — remain addressable for `bench:replay headline-10q`.
- **Applied to probe + answer stages.** Probe (`src/core/probe.ts`) is binary classification on Gemma 4 e4b; reasoning consumed 600–1500 output tokens per call with no decision benefit. Answer stage (`src/eval/baselines/csm.ts`) was burning 2000–3500 tokens of CoT before emitting `ANSWER: N`. **Kept ON for recall and synth** because mid-pipeline reasoning earns its keep on multi-claim citation tasks. Expected savings: ~10,500 output tokens/query, ~80–120 s wall-clock per query.
- **Dropped two unused fields from `ProbeResult`.** `likelyConflicts` (zero downstream readers anywhere) and `reason` (CLI-debug-print only). Verified by grep before removal. `memoryType` and `estimatedAnswerValue` are LOAD-BEARING in `ask.ts`'s inferred-recall gate (audit was over-eager about these — kept). Schema, prompt, type, mock, CLI, and four test fixtures updated. Saves ~120 input + 450 output tokens/query.
- **Prefix-cache contract codified.** `SHARD_SYSTEM_PROMPT` was already byte-identically prepended to every probe and recall call's `system` field, letting Ollama's slot-based KV cache reuse the ~140-token prefill under `OLLAMA_NUM_PARALLEL=1`. Phase α adds explicit IMPORTANT-comments in `probe.ts` and `recall.ts` documenting the contract, plus `tests/prefixCacheContract.test.ts` pinning it so a future refactor that interpolates a per-call variable into the prefix breaks loudly.
- **8 new tests, 0 regressions.** `tests/openaiProvider.test.ts` (4 new: forward `body.think=false` on `disableThinking:true`, omit on undef/false), `tests/prefixCacheContract.test.ts` (3 new), `tests/schemaRobustness.test.ts` (1 new: legacy `likely_conflicts`/`reason` keys silently stripped for back-compat replay).

#### Phase β.1 — Ollama → llama-server migration (skeleton landed, daemon validation pending)

- **`LlamaServerProvider`** (`src/providers/LlamaServerProvider.ts`). Sibling to `OllamaProvider`; extends `OpenAIProvider` with llama.cpp `llama-server` defaults: port 8080, model name `gemma4-31b` (normalised — distinct cache key from legacy `gemma4:31b`), provider name `llama-server`, 600s timeout. Coexists with `OllamaProvider` on different ports for safe rollback.
- **Discriminator extended** (`src/providers/LlmProvider.ts`, `src/providers/index.ts`). `ProviderName` adds `"llama-server"`. `selectProviderName()` honours explicit `CSM_PROVIDER=llama-server` and auto-detects local port 8080. Other local ports (11434 et al.) default to ollama for back-compat. 13 new tests pin the discriminator behavior (`tests/providerSelect.test.ts`).
- **Cache key strategy.** `gemma4:31b` (legacy ollama) and `gemma4-31b` (new llama-server) hash distinctly. Existing `headline-10q` entries replay byte-identical under the old key; new runs build a new cache shard. No destructive rewrite.
- **Runbook documented** in the JSDoc of `LlamaServerProvider`. Exact CLI command (`-m`, `-md`, `--cache-reuse 256`, `-fa --swa-full`, `-np 4`, `--keep -1`), VRAM math (22.9 / 24 GB with 1.1 GB headroom), failure-mode ladder (`-np` 4→3 → `-c` 16384→12288 → KV quant q8→q4 → drop `--swa-full`), and verification protocol (`curl /metrics | grep n_accepted_total` for spec-decode firing). User-side: download Gemma 4 31B Q4_K_M + Gemma 3 1B Q4_K_M GGUFs, start the server, flip `CSM_PROVIDER=llama-server`. Expected: ~2× wall-clock improvement per bench cell.
- **Speculative decoding pair.** Primary: Gemma 3 1B → Gemma 4 31B (1.7× lossless wall-clock cited in Google's spec-decode blog). Fallback A: Gemma 4 270M. Fallback B: target-only (still benefits from prefix caching + parallel slots).

#### Hybrid RAG upgrade — cross-encoder reranker (`src/eval/rerank.ts`)

- **Optional cross-encoder rerank** for the `hybridRag` baseline, gated on `CSM_HYBRID_RERANK=1` env var (default off → existing replays unchanged). Drop-in cross-encoder reranks the RRF top-K via `@huggingface/transformers`'s `text-classification` pipeline. Default model: `Xenova/ms-marco-MiniLM-L-6-v2` (22M params, CPU-friendly); upgrade target is `Xenova/bge-reranker-base` or `bge-reranker-v2-m3` via `CSM_RERANKER_MODEL` env var.
- **Graceful fallback.** If the model fails to load (or inference errors mid-call), the path falls back to RRF order with logged warning. Hybrid RAG never breaks because of reranker issues — it just loses the upgrade.
- **Rationale.** Our prior `hybridRag` was 2023-vintage hybrid (BM25 + dense + RRF). Every 2025 production-RAG paper makes a cross-encoder reranker non-negotiable. Without one, "CSM beats hybrid RAG" is steel-manning a weak baseline. With the reranker, we measure against the actual 2025 hybrid pattern.

### Research findings (multi-agent sweep, archived for spec/methodology)

- **ShardMemo (arXiv:2601.21545)** is the closest published architectural cousin to CSM — sharded memory, per-shard local indexes, masked-MoE budgeted probing, ran on 4×RTX 4090D. CSM differentiates on (1) shards-as-LLM-witnesses vs ANN/vector index per shard, (2) hash-checked branch-and-discard read path with Committer-gated mutation vs in-place shard writes, (3) mandatory `shard@snapshot:event_id` citations vs implicit ANN retrieval. No GitHub release found → cannot benchmark directly; explicit differentiation paragraph added to spec instead.
- **HippoRAG 2 (arXiv:2502.14802, ICML 2025)** is the cited multi-hop QA SOTA: MuSiQue F1 = 48.6, 2Wiki F1 = 71.0, HotpotQA F1 = 75.5. Target for the Phase γ head-to-head. Indexes via LLM-driven OpenIE triple extraction (~2× corpus tokens). At 1M corpus on a 4090 with Gemma 4 31B: ~31 h indexing wall-clock.
- **LightRAG (arXiv:2410.05779, EMNLP 2025)** is the cheap-graph baseline — dual-level entity + relation graph; Ollama-first; ~6,000× retrieval-cost reduction over full Microsoft GraphRAG once indexed. Indexes via entity + relation + community extraction (~4× corpus tokens). At 1M on 4090 with Gemma: ~62 h.
- **Mem0 (arXiv:2504.19413)** is the production agentic-memory layer baseline — pip-installable, OpenAI-compat, ~90% lower tokens than full-context per their LoCoMo claims (disputed by Letta / Zep). Indexing cost is the cheapest of the three (~0.5× corpus). At 1M on 4090 with Gemma: ~8 h.
- **Scaling-ceiling reframe.** The Phase γ findings revealed that HippoRAG 2 and LightRAG cannot be indexed past ~1M tokens in any reasonable wall-clock on a single 4090 — at 10M they're 13-26 DAYS of indexing. CSM's indexing is a keyword/tag scorer (~zero LLM tokens). The crossover math: HippoRAG amortises its index cost at ~200 queries for a 1M corpus, ~20,000 for 100M, ~200,000 for 1B. Translation: CSM wins on (a) any system where the corpus mutates faster than amortisation, (b) any system where the corpus exceeds ~10M tokens. The 2025 pitch is "CSM matches/beats SOTA at scales where SOTA can be indexed, and uniquely scales above that ceiling."

### Added

- **Dual-corpus benchmark.** BABILong support added alongside PaySwift:
  - `src/eval/corpus/babilong.ts` — loader for Tasks 1–3 at multiple context lengths (0K–1M); converts BABILong instances to internal `BenchEvent` + `FreeFormQuery` format.
  - `scripts/fetch-babilong.ts` — one-shot download from Hugging Face's public `resolve` URLs; falls back to manual placement instructions if intermediate-length repos 404.
  - `scripts/run-babilong-bench.ts` — wrapper that loops over (task × context-length), materialises each to disk, calls `runBenchmark` per combo. Each combo becomes its own `runId` for cache reuse + replay.
- **`Query` discriminated union** in `src/eval/mcq.ts` covering both `McqQuery` (PaySwift) and `FreeFormQuery` (BABILong). Same runner, same scorer, same baselines.
- **Free-form scoring path** in `src/eval/scorer.ts` — normalised exact-match (lowercase, strip punctuation, strip leading "the", collapse whitespace); accepts `alternativeAnswers` as additional correct surface forms.
- **`buildPrompt` + `parseAnswer` dispatchers** (`src/eval/answer.ts`) so each baseline handles both query kinds uniformly via the same call sites.
- `docs/BENCHMARK_METHODOLOGY.md` — authoritative methodology reference (10 sections, dual-corpus, explicit threats-to-validity).
- `docs/ARCHITECTURE.md` — distilled architecture overview.
- `docs/REPRODUCING.md` — step-by-step reproduction guide.
- `CONTRIBUTING.md` — contributor onboarding.
- `LICENSE` — MIT License text for public open-source release.
- `NOTICE` — third-party attribution.
- `.github/workflows/ci.yml` — Node 20 + 22 lint + test matrix.
- `scripts/render-plots.ts` + `vega` / `vega-lite` devDeps — server-side render of the Phase C plot specs to `.svg` files (no canvas, no browser, no PNG step). Lets the README embed the headline graphs directly from the bench report output.
- Reproducible MCQ benchmark harness under `src/eval/`:
  - Four baseline systems: `longContext`, `vanillaRag`, `hybridRag`, `csm` — all implementing a common `BaselineRunner` interface.
  - Content-hashed Ollama response cache (`src/eval/cache.ts`) for API-free replay.
  - Programmatic scorer (`src/eval/scorer.ts`) — exact-match accuracy + citation precision/recall + bootstrap 95% CI + paired McNemar's test + Benjamini-Hochberg correction.
  - Sweep-aware matrix runner with adaptive 50%-accuracy early-stop (`src/eval/runner.ts`).
  - Vega-Lite plot generator (`src/eval/plotter.ts`) for Graphs A–F of the context-scaling study.
  - `OllamaProvider` (`src/providers/OllamaProvider.ts`) with 4090-tuned defaults.
- Synthetic benchmark corpus (`data/eval/corpus-synthetic/`):
  - 163 hand-authored core events (~66K tokens, 8 shards) covering a fictional B2B payments-infrastructure startup.
  - 200 hand-authored tier-1 filler events across 5 other fictional companies.
  - Programmatic expansion to tier-3 (~22K filler events / ~9M tokens total).
  - 30 MCQ queries × 40 options each (18 single-shard, 9 multi-shard, 3 adversarial).
  - 50-decision ledger + decision-events-map for traceability.
- New CLI subcommands: `csm bench {run, fill-cache, replay, ablate, report}`.
- npm script aliases: `bench:smoke`, `bench:full`, `bench:fill-cache`, `bench:replay`, `bench:report`.
- Vitest tests for the eval harness — **108 tests total, all passing** (up from the pre-BABILong baseline of 83; +25 covering free-form parser, free-form scoring, type guards, `validateQuery` dispatcher, and end-to-end free-form runner paths).

### Changed

- `CORPUS_SIZE_SWEEP` now starts at 100K (was 10K) — the synthetic core exceeds 10K, so the smallest sample point is infeasible until the "essential core" subset is identified per query.
- `OpenAIProvider` continues to back `OllamaProvider` via the OpenAI-compatible HTTP path; no behavioural change to existing callers.

### Notes

- Real benchmark numbers are gathered on local Gemma 4 via Ollama — no external paid APIs.
- MIT license metadata and public-release documentation are now staged for v0.2.0.

### Pilot results (run `headline-10q`)

First pilot completed on Gemma 4 31B Q4_K_M, 4090, N=10 queries, 1 trial, 100K-token sampled corpus, 8K model context. Three baselines completed; CSM live-on-31b integration deferred to v0.2.1.

| System | Accuracy | Avg latency | Avg input tokens |
|---|---|---|---|
| hybrid RAG | 9 / 10 (90%) | 136 s | 5,842 |
| vanilla RAG | 8 / 10 (80%) | 149 s | 5,801 |
| long-context | 5 / 10 (50%) | 229 s | 8,896 |

Headline finding: retrieval-based systems beat brute-force long-context at 100K-corpus / 8K-context on accuracy, latency, and tokens. All three systems fail the adversarial q28 ("no decision was made"). Full sweep and CSM integration deferred to v0.2.1.

### Cost-accounting safeguards (post-bug)

- **Critical bug caught + retracted.** CSM's `BaselineResult.inputTokens / outputTokens / latencyMs` were previously reporting only the final MCQ-answering call's cost, not the entire pipeline (probes + recalls + synth + answer). A claim of "CSM uses 2,141 tokens vs RAG's 5,800 on q01" was nearly published; the corrected number is **10,936** (5.1×). See `docs/COST_ACCOUNTING.md` for full story.
- **Fix in `src/eval/baselines/csm.ts`:** top-level `inputTokens` / `outputTokens` / `latencyMs` now sum `pipelineCost + finalCall`. Per-stage breakdown lives in `meta.pipelineInputTokens` / `meta.finalCallInputTokens` (and analogous output / latency fields) so the reporter can show both totals and the split.
- **`docs/COST_ACCOUNTING.md`** — explicit contract document. Every baseline must report total cost at the top level; multi-call baselines must sum explicitly.
- **`BaselineResult` JSDoc** (`src/eval/baselines/types.ts`) now states the contract on the interface itself so anyone touching it sees the rule.
- **`tests/cost-accounting.test.ts`** — pins the contract for CSM with a stub `LlmProvider` that records every call. Asserts `inputTokens === meta.pipelineInputTokens + meta.finalCallInputTokens` and analogous for output/latency. Any refactor that drops pipeline cost from the top level fails the test loudly.
- **`scripts/fix-csm-accounting.ts`** — retroactive post-processor for any results.jsonl produced BEFORE the fix. Reads `meta.packetCost`, rewrites top-level fields, backs up the original. Idempotent.

### Deep-audit retraction (v1 → v3): one fix did more harm than good

The first post-audit bench (`csm-audit-fix-10q` v1) regressed CSM from 9/10 to **7/10** accuracy. Citation precision dropped 0.80 → 0.62. Per-query diagnosis pinpointed two specific harms:

- **q23**: with the comprehensive-citation prompt (Bug 3) producing more claims AND the soft recall scope (Bug 1) sending more events into recall, the 31B recall LLM exhausted its 2048 output budget mid-reasoning and returned empty content. Pipeline → null answer.
- **q17**: Bug 2 (probe-events tier in `csm.ts`) added 3 filler probe-events from a filler shard the probe wrongly accepted, polluting the answering context. Pre-audit had 0 packed events and got lucky; post-audit had wrong context and committed to the wrong option.

**v3 fixes:**

- **REVERT Bug 2** (`src/eval/baselines/csm.ts`): probe-identified events no longer added as a third retrieval tier. The probe is too unreliable at filler-rich corpora — when it falsely accepts a filler shard, its `relevant_event_ids` propagate misleading content. Retrieval order is back to `[cited, recalled]`. Comment in code explains the retraction.
- **Recall output budget 2048 → 4096** (`src/core/recall.ts`): the post-audit recall stage sees more events (Bug 1) and is prompted to comprehensively cite (Bug 3). 2048 was sufficient for the tight pre-audit pipeline but choked the wider post-audit one. 4096 mirrors the final-answer budget.
- **Synth output budget 2048 → 4096** (`src/core/synthesize.ts`): same reasoning — synth merges multiple recalls each with more claims, so its output is also bigger.

**v3 result vs pre-audit:**

| metric | pre-audit | v3 | Δ |
|---|---|---|---|
| accuracy | 9/10 | 9/10 | flat (recovered) |
| citation precision | 0.80 | 0.73 | -0.07 |
| citation recall | 0.33 | 0.36 | +0.03 |
| citation F1 | 0.42 | **0.44** | +0.02 (highest of any run) |
| latency | 328s | 297s | -31s (faster) |

The audit fixes that survive (Bug 1 soft recall scope + Bug 3 comprehensive citation + Bug 4 schema tolerance + larger recall/synth budgets) leave CSM with same accuracy but better citation quality and lower latency. The single dropped fix (Bug 2 probe events) was net-negative because the corpus is filler-heavy and the probe is unreliable. **Lesson: at this corpus scale, "include more" must be paired with a quality signal — pure quantity adds noise.**

### Deep-audit pipeline fixes — addendum: schema rigidity bug (Bug 4)

A regression caught after launching the post-audit bench: when the comprehensive-citation prompt update started producing 4+ claims per recall, the 31B model occasionally emitted `"confidence": "0.8"` (string) instead of `0.8` (number) on the Nth claim. Strict Zod validation then threw — dropping ALL claims in that recall response — and the entire pipeline returned empty for that query. q01 went from correct → null on the first re-run.

- **Fix in `src/core/schemas.ts`:**
  - `confidence` fields use `z.coerce.number().min(0).max(1)`. String `"0.8"` becomes `0.8`. Out-of-range values still rejected (we don't silently clamp).
  - `claims` and `key_claims` arrays use a tolerant transform: each item is `safeParse`'d individually; malformed items are dropped but well-formed siblings survive. A single bad claim no longer takes down the entire array.
- 7 new tests in `tests/schemaRobustness.test.ts` pin: string-confidence coercion at probe / recall / per-claim level, out-of-range rejection, non-numeric string rejection, partial-array recovery (3 good + 1 bad → 3 survive), and full-array failure recovery (all-bad → empty claims but recall still parses).

The recall path now degrades gracefully: a partially-malformed LLM response produces a partially-correct parse, not a thrown error.

### Deep-audit pipeline fixes (post-bench)

After the first full 10q × 4-system bench landed CSM at **9/10** vs RAG/Hybrid's **10/10**, a deep audit traced where information was being dropped in the CSM pipeline. Three independent bugs were found, all in the probe → recall → context-pack handoffs:

- **Bug 1 (`src/core/recall.ts`): hard-filter on probe hint dropped events recall could have seen.** When the probe returned `relevant_event_ids` (typically 3–6 IDs from the 1,200-char compact index a 8B model just scanned), recall was hard-filtered to ONLY those events. Any event the probe missed — even if obviously relevant — was permanently blocked from recall. With a fragile 8B probe sampling a small window of a 45-event shard, that miss rate was real. The fix treats the hint as a PRIORITY ORDER, not a filter: hint events go first in the digest, then the remaining token budget is filled with the rest of the shard's events. Same input-token cost; strictly more information reaches the recall LLM. Pinned by 4 tests in `tests/recallScope.test.ts`.

- **Bug 2 (`src/eval/baselines/csm.ts`): probe-identified events were ignored when packing the answering context.** The previous retrievalOrder was `[...citedEventIds, ...recalledEventIds]` — only events that appeared in `recall.claims[].support` made it through. The probe's `relevant_event_ids` (a second, independent retrieval signal) were silently discarded. The fix adds them as a third tier: `[cited, recalled, probed]`, dedupe-in-order. Probed events only count if their shard was actually accepted into recall (so spurious probe hints don't leak in). The answering LLM now sees the broader evidence the probe flagged, not just whatever recall happened to explicitly cite.

- **Bug 3 (`src/core/prompts.ts` — recall prompt): no encouragement to cite comprehensively.** The pre-fix prompt asked for "claims with support" but didn't say to list every contributing event. LLMs default to minimal: 1–2 IDs per claim even when 5+ events contribute. Added explicit citation guidance: "For EACH claim, list EVERY event ID that contributes to it… It is better to over-cite than under-cite." Downstream `support[]` arrays should now carry more event IDs, raising citation recall in `BaselineResult`.

The three fixes compound — each closes one funnel point in the chain `shard → probe-list → recall-scope → claim.support → packet.sources → packed context`. The cumulative effect should narrow the CSM-vs-RAG accuracy gap and (more importantly) raise CSM's citation recall from 0.33 toward parity with its already-best-in-class precision (0.80).

### Iter1d probe event-index ranking

- **Bug** (q05 failure after iter1c): the CSM router correctly identified `s-architecture` as a candidate for "authentication" (thanks to the iter1c prefix-tolerant tag match), but the probe stage's compact event index is capped at 1,200 chars. `s-architecture` has 45 events; with id-sorted ordering the index showed only e0001–e0008 (monolith / postgres / payments) — the auth events (e0017+) never appeared. The e4b probe correctly concluded "this shard isn't about auth" because nothing it saw was about auth. The pipeline then recalled only filler shards, the model saw a Devise-mentioning filler event, and chose Option 40 instead of Option 27 (Lucia).
- **Fix in `src/core/probe.ts`:** `compactEventIndex` now accepts an optional `userQuery` and ranks events by query relevance before truncating. Scoring: each event-tag that matches a query token = +2 (with prefix tolerance, "authentication" ↔ "auth"); each query token appearing in the event's first 200 chars = +1. Within each tier we keep stable event-id order so cache keys remain deterministic. Backwards-compatible: with no `userQuery` argument the function behaves exactly as before.
- **`compactEventIndex` exported** for direct unit testing. Four new tests in `tests/probeIndex.test.ts` cover: auth-tagged events bubbling to the top, prefix-tolerant matching ("authentication" → "auth"), backwards-compatible no-query behaviour, and stable id-tiebreak within the same score.

### Iter1c retrieval + answering fixes

Three independent fixes after iter1b returned 0/3 accuracy with the model arriving at the right answer in its reasoning but never reaching the `ANSWER:` tail:

- **`src/eval/runner.ts`: maxOutputTokens default 2048 → 4096.** Gemma 4 31B's chain-of-thought on a 40-option MCQ commonly consumes 2,000–3,500 reasoning tokens before reaching the answer line. At 2048 the model hit length-stop mid-reasoning. 4096 gives consistent headroom; per-call wall-clock ≈ 3.8 min at 18 tok/s.

- **`src/core/router.ts`: prefix-tolerant tag matching.** Exact-token matching missed `"authentication"` (query) ↔ `"auth"` (shard tag), so q05's router scored every active shard at 0 and slice(0, 8) picked alphabetically — `f1-*` filler beat `s-architecture` (the actual core shard with the Lucia events). New `prefixMatch(a, b)` returns true when either string is a prefix of the other AND the shared prefix is ≥ 4 chars (prevents pathological "ag" → "agent" / "again" matches). `tagOverlap` / `descMatch` / `nameMatch` / `summaryMatch` all use it via `termMatchesAnyTag`. Two new regression tests pin the behaviour.

- **`src/eval/mcq.ts`: `Option N` secondary fallback in `parseMcqOutput`.** When `ANSWER: N` is missing (model ran out of budget mid-reasoning), the tertiary fallback was "first integer in 1..N" — which catches incidental numbers like `"21 CFR Part 11"` → wrong option 21, or `"Bun 1.1"` → wrong option 1. The new secondary fallback prefers the LAST `Option N` / `choice N` / `answer N` mention as a stronger committal signal. Three new tests cover the patterns and the "prefer last over first" rule.

### Streaming parser: reasoning fallback for text-mode calls

- **Bug:** Gemma 4 31B on 40-option MCQs reasoned for ~2000 tokens (the entire `maxOutputTokens` budget) before reaching the `ANSWER: N\nCITATIONS:` tail. Those reasoning tokens stream in `delta.reasoning`, not `delta.content`. The streaming SSE parser deliberately accumulated content only (correct for JSON-mode probe/recall/synth), but for text-mode final answers it left `content` empty even though the model's CoT contained the answer. The bench saw `finalCallOutputTokens: 0` and `chosenOption: null` on q02/q05.
- **Fix in `src/providers/OpenAIProvider.ts`:** the streaming branch now tracks `reasoning` separately. After the stream closes, if `args.jsonMode === false` AND `content` is empty AND `reasoning` is non-empty, we surface `reasoning` as `content`. JSON-mode calls keep content-only (reasoning isn't valid JSON; the `extractJson` fallback can dig if needed). Mirrors the existing non-streaming fallback at line ~219.
- **Probe budget bumped** (`src/core/probe.ts`): 1024 → 2048. e4b spent ~600–800 reasoning tokens per probe before emitting JSON; 1024 caused length-stop with empty content. 2048 fits both 31B and e4b comfortably.

### Cache-poisoning safeguard (post-CPU-offload incident)

- **Bug:** During an earlier CSM pilot, gemma4:31b was loaded with 32K context and partial CPU offload (3.5GB on CPU, ~10–50× slowdown). The final answering call took 4.3 minutes and returned an empty string. The cache wrote that empty response under the prompt's hash. On the next run, the bench got a cache HIT with `response: ""` — silently propagating `chosenOption: null` into the scorer and counting it as a wrong answer rather than re-trying the LLM.
- **Fix in `src/eval/cache.ts`:** new `CacheRefusedEmptyError`. `cacheSet` now throws on any response with `.trim().length < 5` (legitimate MCQ output is at least `"ANSWER: 1"` = 9 chars; legitimate free-form is a word). The runner catches the throw and treats the response as uncached so the next invocation actually calls the LLM.
- **`tests/cache.test.ts`:** two new tests pin the refusal — empty string and whitespace-only — and verify nothing was written.
- **Retroactive cleanup:** `scripts/purge-empty-cache.ts` (or a one-liner via `python`) walks `data/eval/cache/` and deletes any entry with `response` shorter than 5 chars trimmed. Run before any replay if you ever ran a bench against a CPU-offloaded model.

### Pilot-driven infrastructure fixes

- **Undici long-timeout dispatcher** (`src/providers/OllamaProvider.ts`) — Node's bundled fetch has its own `headersTimeout` (~300s) that fires before any per-fetch AbortController. Gemma 31B routinely exceeds that on long-context prompts. Set globally to 600s when OllamaProvider is constructed.
- **`maxOutputTokens` default 256 → 2048** — Gemma 31B does verbose chain-of-thought before reaching the final `ANSWER:` line. 256 was exhausting mid-CoT; 2048 leaves headroom.
- **CoT-tolerant MCQ parser** (`src/eval/mcq.ts`) — picks the LAST `ANSWER: N` match, not the first, so intermediate "ANSWER:" candidates inside reasoning don't trip the parser.
- **Serialised CSM probes** (`src/eval/baselines/csm.ts`) — disable `parallelProbes` against local Ollama; the server queues anyway and concurrent fetches were tripping Undici's connection-pool limits.
- **`undici` as a direct dep** — for type access; runtime bundled with Node.
