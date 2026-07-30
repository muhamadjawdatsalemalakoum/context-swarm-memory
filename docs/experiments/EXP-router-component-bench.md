# EXP — router component bench: the descriptors are boilerplate, and it costs ~50%

**Status: large win in the stress condition. Not yet answer-gated.**
Free, offline, zero LLM calls, ~2s per variant over 400 queries.

## Method — bench one component, not the pipeline

`scripts/bench-router.ts` drives **only** candidate selection: no probe, no
recall, no synthesis. Per query it emits the union of event ids in the top-`k`
routed shards as a `payloads.jsonl` row, so the existing gold-side scorer
(`scripts/score-beam-slice.ts`) grades it with no new gold-touching code — the
bench itself never sees a rubric.

Everything is deterministic: the lexical leg is pure and the embedding leg is a
local MiniLM with a disk cache. No API keys anywhere.

## The defect

`buildShardsFromCorpus` (`src/eval/baselines/csm.ts:1378`) gives every BEAM shard:

- `name` = the shard id
- `description` = `"Benchmark shard <id>"`
- `summaryShort` = `"Synthetic shard <id> (n events)."`
- `tags` = the same four-tag union (`amb`, `beam`, `beam-turn`, `conversation:N`)
  for every shard of a user

`scoreEntryLexical` scores exactly those four fields. **So on BEAM the lexical
router has no query signal at all**, and `selectCandidates` falls through to its
`status === "active"` passthrough. The official ladder ran this way —
`routerHybrid: false` on every run, confirmed from the payload census.

## The stress condition (and why 100K cannot show this)

At 100K a user holds **8.5 documents** and `maxProbeShards` is 8. The router
selects 8 of 8.5 — 94% of the user's memory — so its *ranking* cannot matter.
The session spine does not change that: measured, it moves shards/user from
**8.5 → 8.6**, because 170 documents map to ~90 sessions, so it merges about as
often as it splits.

This is why the wave-1 hybrid router measured "no effect at 100K" and was
shelved. **It was shelved on a test that structurally could not detect it.**

`--partition chunk4` groups each document's turns into shards of 4, giving
**75.2 shards/user with k=8 = 10.6% probed** — the regime the upper ladder runs
in (500K/1M pin probe at exactly 8.0 out of a much larger set; at 10M one
document holds 15,083 turns). It is also the rung-4 **null model** for virtual
sharding: if session-aware partitioning cannot beat blind chunking, the
session-spine story is decoration.

## Result — cov@32, 400 queries

| category | baseline | descriptors | hybrid | desc+hybrid | oracle | best lift |
|---|---:|---:|---:|---:|---:|---:|
| contradiction_resolution | 0.194 | 0.431 | 0.394 | 0.431 | 0.506 | **+0.238** |
| event_ordering | 0.569 | 0.682 | 0.702 | 0.729 | 0.961 | +0.160 |
| information_extraction | 0.834 | 0.821 | 0.813 | 0.829 | 0.971 | −0.005 |
| instruction_following | 0.300 | 0.500 | 0.525 | 0.600 | 0.825 | **+0.300** |
| knowledge_update | 0.438 | 0.800 | 0.775 | 0.825 | 0.925 | **+0.387** |
| multi_session_reasoning | 0.470 | 0.858 | 0.805 | 0.796 | 0.918 | **+0.388** |
| preference_following | 0.354 | 0.600 | 0.600 | 0.600 | 0.713 | +0.246 |
| summarization | 0.431 | 0.624 | 0.641 | 0.701 | 0.926 | **+0.269** |
| temporal_reasoning | 0.519 | 0.767 | 0.746 | 0.756 | 0.863 | +0.238 |
| **MEAN** | **0.457** | **0.676** | **0.667** | **0.696** | 0.845 | **+0.240** |

**Headroom captured: baseline 54.0% → descriptors 80.0% → hybrid 78.9% →
descriptors+hybrid 82.4%.**

Three things worth noting:

1. **+0.240 mean coverage at an identical 32-event budget** — a +52% relative
   improvement from fixing metadata, not from retrieving more.
2. **Descriptors alone get most of it** (0.676 of 0.696). That leg is pure
   string work: no embeddings, no model, no latency. The embedding leg adds
   ~0.02 on top and costs one vector per shard.
3. **The biggest gains land on the categories that collapse up the ladder** —
   multi_session_reasoning +0.388 (0.470 → 0.858) and knowledge_update +0.387
   (0.438 → 0.825). Those are the two worst categories at 1M/10M.

`information_extraction` is flat (−0.005, inside the CI): no regression
anywhere.

## Why the two baselines are identical

`routerbench-doc-baseline` and `routerbench-chunk4-baseline` score **exactly the
same** per category. That is not a bug — it is the finding. With 8 of 8.5 shards
selected, "routed" ≈ "everything", so under either partition the metric reduces
to *the first 32 events in id order*. The router is contributing nothing, and
the bench measures that directly.

## What this does NOT establish

- **Coverage is a proxy.** This session proved coverage can be *anti-correlated*
  with the score for levers that change event ORDER
  ([EXP-coverage-rerank-conversion](EXP-coverage-rerank-conversion.md)). This is
  a *which-shards* lever, not an ordering lever, so the proxy is the appropriate
  one here — but it still has to clear the calibrated answer gate before
  shipping. Not yet run.
- **`chunk4` is synthetic.** It reproduces the many-shards regime on the 100K
  slice; it is not a real 500K/1M/10M tier. The claim is conditional: *if* a
  user's memory is split into ~75 shards, informed routing recovers +0.24
  coverage. Whether the real upper tiers have that shard structure is untested
  here.
- **This is the router's ISOLATED contribution.** The baseline arm is not
  production end-to-end coverage (production `retrieved` at 100K is ~0.74);
  downstream probe/recall/coverage selection is deliberately removed so the
  component can be measured alone. Re-assembly is a separate step.
- **Descriptors are computed from the corpus at bench time.** In production they
  would be written at commit time by the Committer, which is a real (small)
  write-path change, and the tf-idf is over one user's sibling shards.

## Next

1. Answer-gate `descriptors` (the cheap leg) end-to-end.
2. Compare `session` vs `chunk4` partitioning at equal shard count — if the
   spine does not beat blind chunking, ship chunking and drop the spine framing.
3. Sweep `k` and shard size: the bench runs in ~2s, so the whole surface is free.

## Reproduce

```bash
npx tsx scripts/bench-router.ts --variant descriptors+hybrid --partition chunk4 --k 8
npx tsx scripts/score-beam-slice.ts --run-id routerbench-chunk4-descriptors+hybrid --split 100k
```
