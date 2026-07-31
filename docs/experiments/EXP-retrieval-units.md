# EXP — retrieval units (best-passage pooling): correct, and it does not help

**Status: DO NOT ENABLE. `CSM_RETRIEVAL_UNITS` stays default-off.**
BEAM 1M, 45 paired queries, calibrated judge.

## The hypothesis

Chain-of-custody said `preference_following` loses **13.5 points at routing**
(0.950 in corpus → 0.815 after routing). Mechanism: a stated preference is a
small span inside a document about something else, and `centroidOf` mean-pools
it into noise.

Fix: score a shard by its **best passage** rather than its average.

    before:  score(shard) = cos(query, mean(all event vectors))
    after:   score(shard) = max over units u of cos(query, centroid(u))

Shards stay document-sized — ranking-time only — so no budget is starved. That
is the specific difference from `CSM_VIRTUAL_SHARDS`, which shrank shards and
cost 55% of retrieved evidence.

## Result — the hypothesis is not supported

| arm | answer vs baseline | vs Hindsight | preference_following |
|---|---:|---:|---:|
| A baseline | — | +0.372 behind (25/4) | 0.578 |
| **C router fix** | **+0.365** (26W/5L) | **+0.007 tie** | **0.711** |
| D + signals ranker | +0.334 | +0.038 tie | 0.689 |
| E + probe full-scan | +0.327 | +0.045 tie | 0.706 |
| **F + retrieval units** | +0.311 (22W/7L) | +0.061 tie | **0.650** |

Best-passage pooling made `preference_following` **worse** (0.711 → 0.650),
which is the category it was built for.

**Plausible mechanism for the regression:** max-pooling is *more* susceptible to
a single spurious high-similarity span than mean-pooling is. A preference query
("how do I like X done") shares vocabulary with many passages that merely
mention X, so one accidental match can promote an irrelevant document — where
the mean would have correctly rated the whole document as off-topic. Max-pooling
trades false negatives for false positives, and on this query distribution that
is a bad trade.

## The pattern that matters more than this result

Four levers have now been layered on top of the router fix. **Every one repaired
a real, independently measured defect. Every one made the end-to-end result
slightly worse:**

| lever | the defect it genuinely fixed | end-to-end |
|---|---|---|
| signals ranker | recall head-truncates to the first sentence | −0.031 |
| probe full-scan | probe ranking was byte-identical to *no query* | −0.038 |
| retrieval units | document centroids mean-pool a passage away | −0.054 |

That is not four coincidences. Retrieval is **slot-limited**: `RETURN_K = 24`
and the coverage capsule already fills ~20 of those 24 from full content. Any
change that alters *which* candidates arrive displaces something that was
already working. Improving a stage in isolation is not the same as improving the
system, and this repo now has four measurements saying so.

**Corollary: stop layering.** Arm C is the optimum of everything tried. Further
selection-side work needs a reason to believe it clears the displacement cost,
not just that it fixes a defect.

## Where this leaves the goal

Still a **tie** with Hindsight at 1M (0.7824 vs 0.7898), not a win.
`preference_following` (CSM 0.711 vs 0.803) is untouched by four different
selection-side interventions.

That is now strong evidence the remaining gap is **not a selection problem**.
Hindsight's contexts are typed distilled memories (`[world]`, `[experience]`,
`[observation]`) built at ingest, so a preference becomes its own retrievable
atom rather than a span to be found. CSM has that machinery — the Observation
lever, measured at **+0.2224 on summarization** on the official config — but its
gate fires only on summarization and event_ordering, and the fact registry's
only on multi_session_reasoning. **Neither covers preference_following.**

Extending write-time extraction to standing preferences and instructions is the
next thing with a real mechanism behind it, and it is the one intervention this
campaign has not tried.

## What the refactor leaves behind regardless

`src/core/retrievalUnit.ts` is correct, tested (15 cases including the tiling
invariant) and default-off. It is the single source of truth for retrieval
granularity, so the next attempt at sub-document retrieval starts from a
partitioner with a session-aware fallback chain and zero-padded ids rather than
re-inventing one for the fifth time.
