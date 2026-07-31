# EXP — the hybrid router at 1M: +0.176 coverage on the losing categories

**Status: first real win of the campaign. Not yet answer-gated.**
Free (Claude sidecar), 45 paired queries per arm, real BEAM 1M slice.

## Why this could only be found at 1M

Shards per user, measured:

| tier | docs/user (median) | probe budget | fraction probed |
|---|---:|---:|---:|
| 100K | 8.5 | 8 | **94%** |
| 1M | **50** | 8 | **16%** |

At 100K the router selects 8 of 8.5 — its ranking cannot matter, so no routing
change is detectable. That is exactly why wave-1 shelved `CSM_ROUTER_HYBRID` as
"no measurable effect at 100K", and why every official ladder run has
`routerHybrid: false`. **The lever was shelved on a test that structurally could
not detect it.**

At 1M the router chooses 8 of ~50. Routing binds.

## Result — three categories where Hindsight beats CSM

| category | baseline | descriptors | **desc + hybrid** | oracle |
|---|---:|---:|---:|---:|
| instruction_following | 0.489 | 0.506 | **0.683** | 0.978 |
| knowledge_update | 0.533 | 0.467 | **0.867** | 1.000 |
| preference_following | 0.611 | 0.628 | 0.611 | 0.889 |
| **MEAN cov@24** | **0.544** | 0.533 | **0.720** | 0.956 |

**+0.176 mean coverage; headroom captured 57% → 75% of oracle.**

Two of the three are the categories Hindsight won at 1M by shutout:
`instruction_following` (7 HS / 0 CSM in the head-to-head) gains **+0.194**, and
`knowledge_update` (5/0) gains **+0.334**.

## The mechanism, and why descriptors alone failed

Descriptors alone are **flat** (−0.011). The embedding leg is doing the work.

That fits the diagnosed failure. The 1M loss is on answers stated **verbatim,
once, phrased nothing like the query** — a standing instruction or preference.
Lexical scoring cannot bridge that gap no matter how good the descriptors are;
a semantic centroid can.

It also explains why TF-IDF descriptors, which lifted coverage +0.24 in the
synthetic component bench, do nothing here: that bench used 4-event shards with
a focused topic. A real 1M shard is a ~50-turn document spanning many topics, so
its top-24 terms are diluted and stop discriminating. **Descriptor quality
depends on shard homogeneity; the embedding centroid degrades more gracefully.**


## IT CONVERTS — the answer gate agrees

Same 45 paired queries through `answer-arms` + `judge-arms` (the calibrated
judge, holdout ρ 0.864 vs the official Gemini judge):

| category | n | baseline | desc+hybrid | Δ | CI95 | MDE | W/L/T | verdict |
|---|---:|---:|---:|---:|---|---:|---|---|
| instruction_following | 15 | 0.475 | **0.886** | **+0.411** | [0.183, 0.639] | 0.334 | 8/1/6 | **WINS** |
| knowledge_update | 15 | 0.200 | **0.750** | **+0.550** | [0.183, 0.867] | 0.522 | 11/2/2 | **WINS** |
| preference_following | 15 | 0.578 | 0.711 | +0.133 | [−0.114, 0.378] | 0.364 | 7/2/6 | below MDE |
| **ALL** | **45** | **0.418** | **0.782** | **+0.365** | **[0.192, 0.530]** | 0.245 | **26/5/14** | **WINS** |

**This is the first lever in the project to convert on the answer metric.** Two
categories clear their own MDE independently, the aggregate clears by a wide
margin, and the CI excludes zero.

It is the same gate that killed the coverage reranker (−0.058, 4W/13L) and
virtual sharding (−0.123). The instrument is not biased toward saying yes.

### Against Hindsight's 1M numbers

From the head-to-head on the same judge, Hindsight scored `instruction_following`
0.819, `knowledge_update` 0.792, `preference_following` 0.750. CSM with this
config reaches **0.886 / 0.750 / 0.711** — ahead on instruction_following, at
parity on knowledge_update, still behind on preference_following.

Stated carefully: those are not a like-for-like head-to-head, because the
Hindsight comparison answered from the frozen official contexts while these arms
are freshly run through the slice harness. Re-running the head-to-head with this
config is the immediate next step and the only way to claim a win.

## What this does NOT yet establish

- **Coverage is a proxy.** This is a which-shards lever, so the proxy is the
  appropriate one (see EXP-coverage-rerank-conversion for why that distinction
  matters) — but it has NOT cleared the calibrated answer gate. Nothing is
  enabled by default until it does.
- **`hybrid` alone is untested.** Arm C is descriptors+hybrid. Since descriptors
  alone are flat, the hybrid leg is almost certainly carrying it, but the clean
  single-lever arm has not been run.
- **n=15 per category.** Aggregate n=45.
- **`preference_following` is unmoved** (0.611), so one of the three shutout
  categories is not addressed by routing at all and still needs the write-time
  answer.
- Embedding cost: one MiniLM vector per shard, local and disk-cached, no API key
  — but it is real per-query latency that must land in the token/latency
  accounting before this ships.

## Next

1. ~~Answer-gate arm C~~ DONE — converts, +0.365 aggregate.
2. Run `hybrid` alone to isolate the leg.
3. Re-run the CSM-vs-Hindsight head-to-head at 1M with the winning config.
4. `preference_following` needs write-time extraction of standing preferences —
   no existing gate covers it (`CSM_AMB_OBSERVE_MEMORY` fires only on
   summarization/event_ordering; `CSM_AMB_FACT_MEMORY` only on
   multi_session_reasoning).

## Reproduce

```bash
CSM_SHARD_DESCRIPTORS=1 CSM_ROUTER_HYBRID=1 npx tsx scripts/run-beam-slice.ts --run-id r1mC-deschybrid-v1 --split 1m --categories instruction_following,preference_following,knowledge_update --per-category-limit 15 --jobs 6 --k 24
npx tsx scripts/score-beam-slice.ts --run-id r1mC-deschybrid-v1 --split 1m
```

All four BEAM tiers are now installed under `data/eval/corpus-beam-slice/`
(500k/1m/10m added 2026-07-31; the 100k `documents.json.gz` in the source
checkout is byte-identical to the slice this repo already trusted).
