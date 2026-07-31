# BUG — the router selects query-independently at scale

**Severity: high. Present in every official ladder run. Explains the ladder
collapse.** Found 2026-07-31 from committed run artifacts; zero LLM calls to
confirm.

## What happens

`selectCandidates` (`src/core/router.ts:154-168`) ends:

```ts
.filter((c) => c.score > 0 || c.entry.status === "active")
.sort((a, b) => b.score - a.score)
.slice(0, maxCandidates)
```

On BEAM every shard carries the same four tags (`amb`, `beam`, `beam-turn`,
`conversation:N`) and a boilerplate `name` / `description` / `summaryShort`
(`buildShardsFromCorpus`). `scoreEntryLexical` reads exactly those fields, so
**every entry scores ~0**.

Consequently: the filter passes all active entries, the sort is a no-op between
equal scores (stable, so directory order survives), and the slice takes the
first N **in directory order** — which `buildShardsFromCorpus` produces from
`shardIds.sort()`.

**The router returns the alphabetically-first N shards, for every query.**

## Measured, on committed artifacts

BEAM 1M, 45 queries (`data/eval/runs/r1mA-base-v1`):

- **14 of 15 users received the IDENTICAL 8 shards for every one of their
  queries.**
- Example, user 13 — three unrelated questions, same selection:
  `13_s0_0, 13_s0_1, 13_s0_2, 13_s0_3, 13_s0_4, 13_s0_5, 13_s1_10, 13_s1_11`
  (note `s1_10` sorting before `s1_2` — pure lexicographic).
- With ~50 documents per user, CSM read a **fixed 16% of memory regardless of
  the question**. Any answer outside those 8 documents was unreachable.

That is exactly the shutout pattern seen against Hindsight at 1M: **0 CSM wins
of 10** on `knowledge_update`, 0 of 7 on `instruction_following`.

## Why it survived to production

At BEAM 100K a user holds ~8.5 documents against a probe budget of 8. "First 8
alphabetically" is ~94% of the corpus, so the defect is **invisible** — 20 of 20
users also got identical selections there, and it cost nothing.

The bug's severity is a dose-response in documents-per-user, and the ladder is
that curve:

| tier | docs/user | router reaches | published result |
|---|---:|---:|---|
| 100K | 8.5 | 94% | tie (+0.003) |
| 500K | 27 | 30% | −0.052 |
| 1M | **50** | **16%** | **−0.169 (worst)** |
| 10M | 1 | 100% | −0.079 (a *different* defect: no sub-document structure) |

**1M is the worst tier because it has the most documents per user.** That is not
a coincidence; it is the bug's dose curve.

It also explains why the wave-1 hybrid router measured "no effect at 100K" and
was shelved: at 100K there is nothing for a router to do. It was shelved on a
test that structurally could not detect the problem it fixed.

## The fix, measured

Giving the router real signal restores query-dependence: **15 of 15 users** get
query-dependent selection with `CSM_SHARD_DESCRIPTORS=1 CSM_ROUTER_HYBRID=1`.

End-to-end at 1M on the three affected categories (calibrated answer judge):

| | baseline | fixed | Δ |
|---|---:|---:|---:|
| answer score, 45 paired | 0.4176 | **0.7824** | **+0.365** (26W/5L, CI [0.19, 0.53]) |
| vs Hindsight | +0.372 behind (25/4) | **+0.007, tie (10/9)** | gap closed 98% |

Descriptors alone are flat (−0.011); the embedding leg does the work, which fits
a failure mode where the answer is phrased nothing like the query.

## Guard

`tests/routerQueryIndependence.test.ts` (4 cases) pins both halves: that a
boilerplate directory ignores the query and returns the alphabetically-first N,
that this is invisible when the directory fits the probe budget, that real
descriptors restore query-dependence, and the scale dose-response
(94% → <20% reachable as the directory grows).

## Open

- The proper fix is arguably in `selectCandidates` itself: a router with no
  discriminating signal should not silently emit a confident-looking ranking.
  `routeConfidence` in `routerEmbed.ts` already computes a
  `recommendedProbeCount` and is documented as telemetry-only — wiring it is the
  obvious safety valve.
- `preference_following` is unmoved by the fix and needs write-time extraction.
- `temporal_reasoning` fell −0.135 in the n=8 regression check; that is the
  specific reason the flags remain default-off.
