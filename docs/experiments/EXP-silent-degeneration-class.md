# The silent-degeneration bug class in CSM

**Two confirmed instances, measured. Both compound.** Zero-LLM verification.

## The class

> A selection / ranking / truncation step that, when its discriminating signal is
> uniform or absent, silently returns an arbitrary-but-deterministic result that
> is **indistinguishable in the output from a confident decision**.

Every instance so far shares three properties: the degenerate path is *stable*
(so it looks intentional), it resolves to *id or insertion order* (so it looks
sorted), and nothing anywhere reports that discrimination failed.

## Instance 1 — candidate selection (`selectCandidates`)

`src/core/router.ts:154-168`. All BEAM entries score ~0 → filter passes
everything → stable sort is a no-op → slice takes the alphabetically-first N.

**Measured (BEAM 1M, 45 queries):** 14 of 15 users received the identical 8
shards for every query. CSM read a fixed **16%** of memory regardless of the
question. Full write-up: `EXP-router-query-independence-bug.md`.

## Instance 2 — probe visibility (`compactEventIndex`)

`src/core/probe.ts:93-160`. `relevanceScore` weights tags ×2 and scans only the
**first 200 chars** of content. On BEAM every event's tags are byte-identical
(`amb, beam, beam-turn, conversation:N`), and every turn opens with a
`[Month-DD-YYYY | Turn N] User:` header, so ~30 of those 200 chars are
boilerplate. Most events therefore score 0 and the tiebreak is `eventId`
ascending — lexicographic.

**Measured, real BEAM 1M shard `13_s0_0` (47 events, charBudget 1200):**

| query | events shown to the probe model |
|---|---|
| "kubernetes autoscaler … payments cluster" | turn-0, 1, 10, 11, 12, 13, 14, 15 |
| *(no query at all)* | turn-0, 1, 10, 11, 12, 13, 14, 15 |

**The query-aware ranking produced a byte-identical result to passing no query.**
Only **8 of 47 events (17%)** are visible, and lexicographic ordering means
turns 2–9 and 20+ are structurally invisible while turns 10–15 are always shown.

### 2b — the index format spends its budget on noise

One index line, real shape, is 145 chars: 19 for the event id, **42 for a tags
field that is byte-identical on every BEAM event**, 83 for the content head.

**29% of the probe's entire visibility budget carries zero information.**
Dropping uniform tags alone raises visible events from ~8 to ~11 (**+38%**) at
no cost.


## Instance 3 — recall digest truncation (`scopedEventDigest` blind mode)

`src/core/recall.ts:123-145` → `selectEventDigest` with both salience levers
off (the default). Events are taken in hint-priority-then-original order and
each is **head-truncated** to a per-event char share of the digest budget.

**Measured, real BEAM 1M document `13_s0_0` (47 turns; median turn 352 chars,
p90 4,923 chars) at the default `maxRecallTokensPerShard = 1200`:**

| digest spans | chars/event | turns surviving intact | median turn survives |
|---|---:|---:|---:|
| 47 events | 102 | **0 of 47** | 29% |
| 24 events | 200 | 15 of 47 | 57% |
| 12 events | 400 | 24 of 47 | 100% |

At full breadth the recall model sees roughly **the first sentence of each
turn**, and ~30 of those 102 chars are the `[Month-DD-YYYY | Turn N] User:`
header. Head-truncation is position-blind: a fact stated mid-turn is discarded
even when the correct shard and correct event were both selected.

There is a built, tested mitigation — `salientTruncation` /
`reorderBySalience` behind `CSM_SIGNALS_RANKER` — and it is **default-off**.

## The full compounding

| stage | what survives | selection rule |
|---|---|---|
| router | 16% of documents | alphabetical |
| probe | 17% of turns | alphabetical |
| recall | 29% of each turn's text | first-N chars |

Each stage independently discards ~80% of what reaches it, and each does so by
a rule unrelated to the query. This is the mechanism behind every
"the retrieved context lacks this information" failure in the artifacts.

Note the shape: **all three have a query-aware path that is switched off or
inert, and a degenerate path that is the default.**

## They compound

| stage | reaches |
|---|---|
| router: 8 of ~50 documents | 16.0% |
| probe: 8 of ~47 turns | 17.0% |
| **product (selection only)** | **≈2.7% of a user's memory ever reaches an LLM** |

and of what does reach it, recall forwards ~29% of each turn's text.

Chosen alphabetically. This is the mechanism behind "the answer was not
retrieved": for most queries it was never *shown* to the probe in the first
place, so no downstream stage could recover it.

## Why the benchmark hid it

Both instances are dose-response in corpus size. At BEAM 100K a user holds ~8.5
documents against a probe budget of 8, so the router's degenerate path returns
~94% of the corpus and costs nothing. The ladder is that dose curve: tie at
100K, −0.052 at 500K, −0.169 at 1M (the tier with the most documents per user).

## The principle being violated

**A component that cannot discriminate must say so, not guess quietly.**

CSM's selectors return a plain array. An array cannot express "these are ranked"
versus "I had no signal and this is arbitrary". Every instance above is that
missing distinction, and every downstream stage is entitled to assume the former.

The proper fix is therefore a contract change at the selector boundary, not a
guard at each site — see the refactor design.
