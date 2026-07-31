# EXP — write-time preference extraction: why retrieval cannot solve this

**Status: architectural finding established; gate NOT yet safe; extractor not
built.** Free, offline, deterministic.

## The decisive observation

Read the actual `preference_following` queries at BEAM 1M:

> "I'm planning to build a text generation pipeline. **Which transformer model
> would you suggest I start with?**"
>
> "How would you suggest structuring my workflow to handle both testing and
> actual deployment of my trading strategies?"
>
> "I'm applying for a job in the UK. **How should I format it?**"

And `instruction_following`:

> "**Which libraries are we currently using** in the project?"

**The query never mentions the preference.** It is a forward-looking request for
help; the gold is a standing preference the user stated much earlier, in
different words, about a different immediate topic.

Compare a winner category, `information_extraction`:

> "What versions of the frontend framework, backend runtime, and database **did
> I say** I was starting the project with?"

That query *describes its own answer*. Similarity search works.

## Why this retroactively explains four failures

Every intervention this campaign tried ranks candidates **by similarity to the
query**. If the query does not describe the target, none of them can find it:

| lever | what it genuinely fixed | preference_following |
|---|---|---:|
| router descriptors + hybrid | document centroid had no query signal | 0.578 → 0.711 |
| + signals ranker | recall truncates to the first sentence | 0.689 |
| + probe full-scan | probe ranking ignored 97% of each turn | 0.706 |
| + retrieval units | centroid mean-pooled the passage away | **0.650** |

Four principled fixes to four real defects, and the category barely moves. That
is not four unlucky results — **it is the signature of a problem that lives
outside the retrieval stage entirely.**

Hindsight scores 0.803 here because its contexts are typed distilled memories
(`[world]`, `[experience]`, `[observation]`) built at ingest. A preference
becomes **its own retrievable atom, keyed to the user**, not a span to be found
by query similarity.

**Conclusion: solve this at write time, and retrieve by user rather than by
query match. No further selection-side work should be spent on this category.**

## The gate — three iterations, still not safe

Repo discipline: a write-time lever's gate is validated on all four tier query
sets (2,000 queries) and must not fire on categories CSM already wins. The
Observation gate achieved 200/200 recall with **0 of 1,600** leaks.

| version | rule | recall (of 400) | leak (of 1600) |
|---|---|---:|---:|
| v1 | narrow advice phrasings | 35.8% | 2 (information_extraction) |
| v2 | + "can you walk/explain/show", − past tense | 65.3% | **82** (event_ordering 50, multi_session 29) |
| v3 | advice-seeking only, − past tense, − ordering/aggregation | 50.5% | **27** (multi_session_reasoning) |

**v3 is not shippable.** Its 27 fires land on `multi_session_reasoning`, which
CSM wins (0.532 vs Hindsight 0.474 at 100K). Retrieval is slot-limited —
`RETURN_K = 24`, with ~20 already filled by the coverage capsule — so injecting
a profile document displaces working evidence. A leak onto a winner is a real
regression risk, not a cosmetic one.

The failure modes are instructive:

- v1's 2 leaks were both **past tense** ("How *did* I decide on the best way…",
  "What strategies *did* you recommend…"). A past-tense guard fixes those.
- v2's 82 leaks came from `can you walk me through` / `explain` — which is
  exactly how `event_ordering` and `multi_session_reasoning` are phrased.
- v3's residual 27 are `multi_session_reasoning` queries phrased as
  forward-looking advice asks, lexically indistinguishable from the target by
  any pattern tried.

This is the same wall the repo already documented for `knowledge_update`:
*"lexically indistinguishable from information_extraction, so no safe lexical
gate exists."*

## Where that leaves it

Two honest options, neither of which is "tune the regex harder":

1. **Always-on profile.** Skip the gate: build a small standing-preference
   profile per user and include it on every query. Removes the leak question
   entirely and turns the decision into a pure cost/displacement measurement,
   which the calibrated answer gate can settle. The profile must be small
   enough that spending one of 24 slots is worth it.
2. **Semantic gate.** Classify intent with the model rather than a regex. More
   expensive per query, and it needs its own 2,000-query validation.

**Option 1 first.** It is cheaper, has no leak surface, and this campaign has
repeatedly found that adding a retrieval lever costs a slot — so the right
experiment is to measure that cost directly rather than keep trying to dodge it.

## What is NOT done

The extractor itself. `organizeFactsScaled` (fact registry, metric histories)
and `organizeMemoryScaled` (Observation, narrative) already exist and are the
right shape to copy; an `organizePreferencesScaled` producing a compact
"standing preferences and instructions" profile is the missing piece. It was not
built in this session because the gate work established that the gating question
has to be settled first — and the answer may be that there should be no gate.
