# EXP — recall breadth census: hypothesis refuted, a harness discrepancy found

**Status: hypothesis REFUTED. A more serious open question replaces it.**
Free, offline, zero LLM calls — a census over committed run artifacts.

## The hypothesis

Official BEAM telemetry shows `csm_recall_count` p50 = p90 = **1** at every
tier, with `maxRecallShards = 4` and ~7–8 probes per query:

| tier | probe p50 | recall p50 | recall > 1 |
|---|---:|---:|---:|
| 100K | 8 | 1 | 17/400 |
| 500K | 8 | 1 | 37/755 |
| 1M | 8 | 1 | 46/729 |
| 10M | 1 | 1 | 0/208 |

The natural reading — and the one written into the plan — was that
`probeQualifiesForRecall` (`src/core/ask.ts:474-486`) rejects ~7 of 8 probes at
every scale, so CSM probes broadly but only ever *reads* one shard, and the only
recall that happens is the router-trust safety net.

## The refutation

`payloads.jsonl` records `probeAcceptCount`, which the official telemetry does
not. Censusing every slice run that has it:

| run | provider | n | probe | accept | recall | hybrid |
|---|---|---:|---:|---:|---:|---|
| beam-slice-100k-live-coverage-v1 | gemini | 80 | 7.25 | 5.96 | **3.96** | 0/80 |
| beam-slice-100k-rerank-v1 | gemini | 80 | 7.25 | 5.96 | **3.96** | 0/80 |
| beam-slice-100k-live-hybridon-v1 | gemini | 80 | 7.25 | 6.11 | **3.95** | 80/80 |
| gateA-off-v1 | agent-sdk | 40 | 6.95 | 5.97 | **3.67** | 0/40 |
| gateB-on-v1 | agent-sdk | 40 | 6.95 | 5.95 | **3.67** | 0/40 |
| idrepair-on-v2 | agent-sdk | 4 | 7.50 | 7.50 | **4.00** | 0/4 |

The gate accepts **82% of probes** (5.96 of 7.25), and recall runs at ~3.96 —
i.e. it is pinned at the `maxRecallShards = 4` budget cap, not starved by the
gate. **The gate is not the bottleneck.** Hypothesis dead.

Incidentally confirmed: `routerHybrid: false` on every official-config run, so
the hybrid router was indeed dormant for the published ladder (P2's premise).

## What replaces it — and why it is worse

The same corpus, tier, categories, provider, probe model and probe count give
two different recall counts depending on which harness ran them:

| | probe | recall (summarization) | recall (event_ordering) |
|---|---:|---:|---:|
| official AMB run (`amb-beam-100k-official-v1`) | 7.25 | **1.18** | **1.40** |
| beam-slice harness, same 2 categories | 7.25 | **3.96** | **3.96** |

Probe count is identical to two decimal places, so routing and probing are doing
the same thing. Only the probe→recall outcome differs, by ~4×.

Checked and ruled out:

- **Probe model.** Both set `CSM_PROBE_MODEL=gemini-2.5-flash-lite`
  (official `RUN_MANIFEST.md`; slice `config.json` `envEcho`).
- **Model / context / return-k / neighbour window / parallel probes / thinking.**
  Identical in both configs.
- **Category composition.** The official numbers above are already restricted to
  the same two categories the slice runs cover. Official recall is ~1 on *all
  ten* categories.
- **Code drift.** The official run is commit `599dfc0`, which already contains
  speculative top-1 recall (`347d730`) and the probe-routing gate (`2e086fd`).
  Only one commit since then touches the core recall path (`bbb6daa`, gated off
  by default). The 500K/1M official runs are a week later and still show recall
  ≈ 1.

Remaining candidates, untested: the warm-server path
(`scripts/amb-csm-server.ts`, ingest-once/query-many) constructing a different
corpus or budget than the direct path (`scripts/run-beam-slice.ts`); output-token
truncation at the probe stage changing probe verdicts; or a per-stage thinking
setting that differs between the two entry points.

## Why this matters more than the original hypothesis

Two readings, and they point in opposite directions:

1. **The official config really does read one shard where current code reads
   four.** Then the published ladder was produced with ~4× less evidence than
   the pipeline now gathers, and there is unmeasured headroom.
2. **The slice harness is not faithfully reproducing the official config.** Then
   *every* slice-based A/B — including the answer-gate arms `gateA-off-v1` /
   `gateB-on-v1` — is measuring a different system from the one on the
   leaderboard, and its results do not transfer.

Reading 2 is a direct threat to the validity of the entire free-iteration
approach, so it must be resolved before any slice-based result is used to
justify a config change. It is also cheap to resolve: run the two harnesses on
the same handful of queries with the same provider and diff the resulting
`meta`.

## Falsification criteria for the follow-up

- **F1** — run `run-beam-slice.ts` and the warm server on an identical 4-query
  set, same provider and env. If `recallCount` matches, the discrepancy is in
  the env/config plumbing, not the harness.
- **F2** — if they differ, bisect the bridge options
  (`modelContext`, `maxOutputTokens`, `withInternalAnswer`) until the slice path
  reproduces recall ≈ 1.
- **F3** — whichever config reads more shards, gate it on the **calibrated
  answer judge** (`docs/experiments/EXP-judge-calibration.md`), not on recall
  count. More recalls cost more tokens; the trade has to be shown, not assumed.

## Corrections to the record

The plan's Finding 3 claimed the probe→recall gate "rejects ~7 of 8 probes at
every tier". That is **wrong** — measured acceptance is 82%. The observation
that official runs recall ~1 shard stands; the explanation does not.
