# EXP — virtual sharding, assembled: the component won and the system lost

**Status: DO NOT SHIP. `CSM_VIRTUAL_SHARDS` and `CSM_SHARD_DESCRIPTORS` stay
default-off.** Free (Claude sidecar), 60 paired queries, 100K.

*(Forward pointer, 2026-09-05: `CSM_VIRTUAL_SHARDS` is still OFF. `CSM_SHARD_DESCRIPTORS`
was flipped ON on 2026-08-01 — not on its own merit (it is flat alone) but because
the hybrid router's lexical leg consumes it; see `tests/env.test.ts` FLAGS and
STATUS.md. The −0.12 coverage result here is what the failure record cites.)*

## What was predicted

The router component bench ([EXP-router-component-bench](EXP-router-component-bench.md))
measured, in isolation, at a fixed 32-event budget:

| | baseline | descriptors+hybrid |
|---|---:|---:|
| mean gold-facet coverage | 0.457 | **0.696** |
| % of oracle | 54.0% | **82.4%** |

with the largest lifts on `multi_session_reasoning` (+0.388) and
`knowledge_update` (+0.387).

## What the assembled system actually did

Both levers wired into the real pipeline (`CSM_VIRTUAL_SHARDS=4`,
`CSM_SHARD_DESCRIPTORS=1`), same 60 queries, same provider, everything else
identical:

| category | A cov@24 | B cov@24 | Δ | A retrieved | B retrieved | oracle |
|---|---:|---:|---:|---:|---:|---:|
| knowledge_update | 0.900 | 0.725 | **−0.175** | 0.900 | 0.725 | 0.950 |
| multi_session_reasoning | 0.743 | 0.700 | −0.043 | 0.868 | 0.700 | 0.938 |
| summarization | 0.587 | 0.435 | **−0.152** | 0.824 | 0.448 | 0.882 |
| **MEAN** | **0.743** | **0.620** | **−0.123** | **0.864** | **0.624** | |

**The component improved by +0.24 in isolation and the system regressed by
−0.12 when assembled.**

## Why — the interfaces were tuned for the old component

Pipeline telemetry, same runs:

| | probes | accepted | recalls | **retrieved events** |
|---|---:|---:|---:|---:|
| A baseline | 6.95 | 5.07 | 2.85 | **58.3** |
| B virtual shards | 8.00 | 4.52 | 2.17 | **26.4** |

Retrieved evidence fell by **55%**. The router got better at *choosing*, but
every stage that *harvests* from the chosen shards is calibrated in units of
shards, not events:

- `maxRecallShards = 4` (`src/core/tokenBudget.ts`) — recalling 2.17 shards of
  ~40 turns is ~87 events; recalling 2.17 shards of 4 turns is ~9.
- `MIN_FROM_TOP_SHARD = 8` (`src/eval/baselines/csm.ts:931`) — a 4-event shard
  cannot satisfy a floor of 8.
- `applyShardLocalExpansion`, `CSM_SHARD_EXPAND_K/_MAX`, `CSM_LEXICAL_BRIDGE_K`,
  `CSM_ENTITY_BRIDGE_K` all expand *within a shard*, which is now 1/10th the
  size.

So finer routing starved the harvest. The two changes are not independent: shard
size and every downstream budget are one coupled system.

## The lesson

**A component gain does not survive assembly unless the interfaces are re-tuned
with it.** The bench was right about the router and still predicted the wrong
system outcome, because it held the router's *output budget* fixed (32 events)
while the real pipeline holds the *number of shards* fixed and lets the event
count fall out. Component benches must be re-read against the units the
assembled system actually conserves.

## Why the answer gate was not run

Coverage is the appropriate proxy for a *which-shards* lever (the distinction
established in [EXP-coverage-rerank-conversion](EXP-coverage-rerank-conversion.md):
coverage is anti-correlated only for levers that change ORDER). Here the proxy
fell −0.123 **and** retrieved evidence fell 55% — two independent measurements
agreeing that the arm is worse. Spending the gate to confirm a rejection is not
a good use of it; the gate is reserved for candidates that look like wins.

## Arm C — event-normalised budgets (the fix, tested)

`CSM_MAX_PROBE_SHARDS=24`, `CSM_MAX_RECALL_SHARDS=20` alongside the same
sharding, to harvest events rather than shards:

| category | A baseline | B shard-fixed | **C event-normalised** |
|---|---:|---:|---:|
| knowledge_update | **0.900** | 0.725 | 0.750 |
| multi_session_reasoning | 0.743 | 0.700 | **0.797** |
| summarization | **0.587** | 0.435 | 0.571 |
| **MEAN cov@24** | **0.743** | 0.620 | 0.706 |
| **MEAN retrieved** | **0.864** | 0.624 | 0.745 |

| | probes | recalls | retrieved events | pipeline input tok |
|---|---:|---:|---:|---:|
| A | 6.95 | 2.85 | 58.3 | 20.5K |
| B | 8.00 | 2.17 | 26.4 | 20.9K |
| C | **24.00** | 5.52 | 39.0 | **59.8K** |

**The fix works directionally and still loses.** Event-normalising recovers
0.620 → 0.706 of the 0.743 baseline, but does not reach it — and pays **3.5× the
probe calls and ~3× the input tokens** to get there. Recall still harvests only
39 events against the baseline's 58, because 5.52 shards × 4 turns is ~22 events
where 2.85 × ~40 is ~114; closing that fully would need ~28 recall shards and
~60 probes, and the cost curve is already unacceptable.

**One result survives:** `multi_session_reasoning` **0.743 → 0.797 (+0.054)** —
arm C beats the baseline on precisely the category that collapses hardest up the
ladder (0.480 at 100K → 0.120 at 10M). That is the one signal worth carrying
forward.

## Verdict

**Both flags stay default-off.** At 100K virtual sharding is a cost regression
with no aggregate benefit: −0.037 coverage for 3.5× the probe calls.

The mechanism is now understood well enough to state the condition under which
it *could* pay: the router only earns its keep when shards-per-user greatly
exceeds the probe budget. At 100K that ratio is 8.5 : 8 — there is nothing to
choose. The component bench needed a synthetic 75 : 8 to show the effect at all.
So this belongs at 500K/1M/10M, which are **not on disk**; fetching them is the
prerequisite for any further work on this lever, and the `multi_session_reasoning`
gain is the reason to bother.

## Reproduce

```bash
CSM_VIRTUAL_SHARDS=4 CSM_SHARD_DESCRIPTORS=1 npx tsx scripts/run-beam-slice.ts --run-id sysB-shard4desc-v1 --split 100k --categories multi_session_reasoning,knowledge_update,summarization --per-category-limit 20 --jobs 6 --k 24
npx tsx scripts/score-beam-slice.ts --run-id sysB-shard4desc-v1 --split 100k
```
