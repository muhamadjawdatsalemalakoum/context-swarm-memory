# EXP — virtual sharding, assembled: the component won and the system lost

**Status: DO NOT SHIP. `CSM_VIRTUAL_SHARDS` and `CSM_SHARD_DESCRIPTORS` stay
default-off.** Free (Claude sidecar), 60 paired queries, 100K.

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

## The concrete next experiment

Hold **events**, not shards, constant. If shard size drops ~10×, then
`maxRecallShards` must rise ~10× to harvest the same evidence, and the
shard-local floors/caps must be expressed in events rather than per-shard
counts. Small shards make each recall digest cheap, so recalling 20 tiny shards
may cost no more than 2 large ones — that is the version worth testing.

Falsification: if event-normalised budgets do not bring arm B's `retrieved` back
to ~0.86 while keeping the router's selection advantage, virtual sharding is
dead at this tier and the router fix should be pursued on document-sized shards
only (where, at 100K, it cannot help — so it would move to the upper tiers).

## Reproduce

```bash
CSM_VIRTUAL_SHARDS=4 CSM_SHARD_DESCRIPTORS=1 npx tsx scripts/run-beam-slice.ts --run-id sysB-shard4desc-v1 --split 100k --categories multi_session_reasoning,knowledge_update,summarization --per-category-limit 20 --jobs 6 --k 24
npx tsx scripts/score-beam-slice.ts --run-id sysB-shard4desc-v1 --split 100k
```
