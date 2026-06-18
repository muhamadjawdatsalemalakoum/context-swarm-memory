# CSM Retrieval Latency & Token Breakdown

Date: 2026-06-10. This is the measured attribution behind the R&D-phase
latency work, plus the first round of fixes and their live A/B numbers.
Sources: the committed BEAM 100K telemetry aggregate
(`data/eval/runs/sota-combined/amb-beam-100k-csm-vs-hindsight.json`, 400
queries, May 2026 Mac run) and fresh controlled runs on the Windows box
(2026-06-09/10, live `gemini-3.5-flash`).

## Where the 29.2 s per BEAM query actually went

| Component | Avg per query | Share |
|---|---:|---:|
| AMB-measured retrieve wall (`bridge_wall_time_ms`) | 29,229 ms | 100% |
| CSM LLM pipeline (`csm_pipeline_latency_ms`, wall inside `ask()`) | 28,444 ms | **97.3%** |
| Node spawn + corpus rebuild + embeddings + JSON I/O (residual) | ~785 ms | 2.7% |

The popular hypothesis — "the bridge cold-start dominates" — is **wrong**.
The pipeline was 7.25 probe calls + 3.55 recall calls + ~1 synthesis call per
query, **executed strictly serially** at ~2.4 s per Gemini round trip. The
serialization came from `parallelProbes: false` in `CsmBaseline` — a
workaround for local Ollama's connection limits that silently carried over to
the hosted-Gemini bridge. (`ask()` itself defaults to parallel; the same flag
also serialized recalls.)

On top of that, the bridge ran `CsmBaseline.answer()` and discarded the final
answer: 7,135 input tokens and ~2.7 s per query of pure waste in AMB rag mode
(avg `csm_internal_answer_input_tokens` / `csm_internal_answer_latency_ms`).

Token side (avg per BEAM query): 21,020 internal input = 13,885 pipeline +
7,135 discarded answer; 2,531 internal output.

## Fixes landed 2026-06-09/10

1. **Parallel probes + recalls for hosted providers**
   (`resolveParallelProbes` in `src/eval/baselines/csm.ts`). Heuristic:
   parallel unless provider is `ollama`/`llama-server`; `CSM_PARALLEL_PROBES`
   overrides.
2. **Retrieve-only bridge path** (`CsmBaseline.retrieveContext()`;
   `scripts/amb-csm-retrieve.ts` now defaults to it). The discarded internal
   answer call is gone; `--with-internal-answer` restores it for A/B. Bonus:
   the legacy path's failure mode (final call starving at the default 8-token
   output budget under thinking) no longer exists.
3. **Per-call thinking floor honored** (`GeminiProvider`): probe's
   `disableThinking: true` now maps to `thinkingLevel: "minimal"` on
   gemini-3.x instead of being silently ignored at env-level `low`. Also
   fixed the `CSM_GEMINI_THINKING=none` footgun, which used to omit
   `thinkingConfig` entirely — i.e. API default, the MOST thinking.
4. **Bridge integrity hardening**: the bridge auto-loads the CSM repo `.env`
   (parity with the CLI), reports `llm_provider`/`llm_model` in its output,
   and hard-fails if it silently resolved MockProvider
   (`CSM_AMB_ALLOW_MOCK=1` to override for plumbing tests).

## Measured effects (live gemini-3.5-flash)

Thinking-level cost for a probe-shaped call (`scripts/probe-thinking-levels.ts`):

| thinkingConfig | Latency | Thought tokens |
|---|---:|---:|
| `thinkingLevel: "none"` | HTTP 400 — invalid value | — |
| `thinkingLevel: "minimal"` | 1,599 ms | 0 |
| `thinkingLevel: "low"` (old probe reality) | 2,067 ms | 125 |
| absent = API default (old `none` reality) | 3,960 ms | 436 |

Serial vs parallel, PaySwift 100K corpus, identical token counts and 3/3
correct in both runs (`perf-ab-serial-v1` / `perf-ab-parallel-v1`,
`--queries q01,q11,q28`, probes at minimal thinking in both):

| Query (shape) | Serial pipeline | Parallel pipeline | Speedup |
|---|---:|---:|---:|
| q01 (8 probes, 4 recalls, synth) | 31.5 s | 12.4 s | 2.53x |
| q11 (8 probes, 2 recalls, synth) | 22.7 s | 9.0 s | 2.51x |
| q28 (8 probes, 1 recall, no synth) | 13.7 s | 6.4 s | 2.14x |
| **Mean** | **22.6 s** | **9.3 s** | **2.43x** |

Bridge end-to-end on a 3-shard smoke store: retrieve-only 6.7 s wall;
the legacy internal-answer call added ~2.7 s + ~700 input tokens when it ran.

## Warm bridge service (landed 2026-06-10)

`scripts/amb-csm-server.ts` (`npm run amb:csm:serve`) replaces the per-query
process spawn: the AMB provider (`integrations/amb/csm_provider.py`) starts
it once via AMB's `initialize()` hook, ingests over localhost HTTP, and the
server caches the built corpus per user scope (invalidated by an ingest
version counter, ≤4 corpora warm). Retrieval reuses the identical
`executeAmbRetrieve` core, so AMB-visible output is unchanged for unchanged
inputs (`tests/ambServer.test.ts`).

Live smoke (3-shard store, gemini-3.5-flash): one-shot bridge 6.7 s wall for
a query → warm server 4.0-4.5 s wall for the same query, with wall − pipeline
≈ 0-30 ms (vs ~0.6-2 s process residual + npm wrapper before). The saving
grows with corpus size, since the rebuild and lazy embedding-model load were
per-query costs.

## Speculative top-1 recall (landed 2026-06-10)

`ask()` force-recalls the router's top candidate regardless of probe outcome
(the router-trust safety net), and that recall's input depends only on its
OWN probe's hint — so in parallel mode it now launches the moment probe #0
resolves instead of waiting for the whole probe barrier.

Verified schedule-only on a serial-vs-parallel 3-query A/B
(`rd-spec-serial-3q` / `rd-spec-parallel-3q`): pipeline input/output tokens
and recall counts identical per query, 3/3 correct both sides. Latency
(parallel, with speculation): q01 13.0 s, q11 7.9 s, q28 3.3 s — mean
**8.1 s** vs 9.3 s pre-speculation; the single-recall query collapsed
6.4 s → 3.3 s because its recall fully overlaps the probe phase.

## 30-query gates (2026-06-10, PaySwift 100K, 8K ctx, gemini-3.5-flash answers)

| Run | Config | Score | Avg pipeline | Avg pipeline in-tokens | Avg recalls |
|---|---|---:|---:|---:|---:|
| `rd-baseline-30q-v1` | parallel, minimal-thinking probes | 28/30 | 10.45 s | 10,366 | — |
| `rd-digest-30q-v1` | + recall digest dates, + top-1 speculation | **29/30** | 8.96 s | 10,538 | — |
| `rd-probelite-30q-v1` | + `CSM_PROBE_MODEL=gemini-2.5-flash-lite` | **29/30** | **7.15 s** | 9,590 | 1.97 |

Misses: baseline q04+q27; both later runs only q04 (the known multi-event
coverage failure — a retrieval-quality problem, tracked separately).
Flash-lite probes are notably more conservative (fewer shards qualify for
recall: 1.97 avg), which CUT input tokens ~9% while the score held — the
forced top-1 recall absorbs probe false-negatives. **Status: recommended
opt-in via `CSM_PROBE_MODEL=gemini-2.5-flash-lite`; not the hard default
until the BABILong slice and a BEAM-scale check confirm the conservatism is
safe off-PaySwift.**

## Eager tier-2 recalls: measured no-op here (kept opt-in)

`CSM_EAGER_RECALLS=1` generalizes the top-1 speculation: any shard whose
probe passes the recall predicate starts its recall on its own probe's
completion, then the score-ordered selection is reconciled and non-selected
eager calls are discarded (tokens counted, `discardedRecalls` reported).
Measured on q01/q11/q28: token-identical, zero discards, latency within
noise (+0.1-0.4 s). Cause: probe latencies cluster tightly, so per-probe
completion ≈ the barrier; top-1 speculation already covered the win. It may
still help under straggler/retry-heavy conditions (the May BEAM run saw
436 s max rows) — re-evaluate there; default stays OFF.

## Projected BEAM-scale stack (to be re-measured on resume)

Starting point 29.2 s avg → with everything gated above (parallel stages,
retrieve-only, warm service, top-1 speculation, digest dates, flash-lite
probes): 30-query PaySwift average is now **7.15 s**; BEAM-scale expectation
**~8-9 s** pending re-measurement. Remaining levers, in value order:

1. **Synthesis stage cost** (~3-4 s serial tail on multi-recall queries):
   cheaper synth model, more aggressive skip conditions, or merging recall
   and synthesis for 2-recall queries — all need accuracy gates.
2. **Gemini context caching** for repeated shard snapshots on the warm
   service (cuts cost and prefill latency of probe/recall calls; candidate
   R&D topic for the portfolio wave).

Target: average BEAM-style retrieval at or below **~6-7 s**, i.e. Hindsight
parity, while keeping CSM's score and bounded answer-visible context. (On the
final BEAM ladder CSM's answer context is actually *higher* than Hindsight's —
27.0K vs 17.7K at 100K — because the coverage chronicle fills its return-K
budget; CSM's all-in input is ~36-38K/query. See `AMB_BEAM_LADDER_2026_06_18.md`.)
Every change above is schedule-only or gated on internal-bench accuracy; none
touch what the answer model sees except by making it available sooner.

## Quality gates

- `npm test` (mutation safety + pipeline invariants) green at every step.
- PaySwift 30q + BABILong slice accuracy re-run before any model-routing or
  prompt change ships (`npm run bench:confirm`-class runs).
- AMB-visible behavior (returned documents) byte-stable across schedule-only
  changes — verified on the A/B above (identical token counts, identical
  retrieved IDs).
