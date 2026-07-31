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


## Instance 3 — recall digest (`selectEventDigest` blind mode)

> **CORRECTION (2026-07-31).** An earlier version of this section described the
> per-event cap as "a per-event char *share* of the digest budget" and tabulated
> 102 chars/event across 47 events. **That was wrong.** An adversarial verifier
> caught it against the shipped code. `perEventChars` is a **fixed 480**
> (`DEFAULT_PER_EVENT_CHARS`, `src/core/digestSelection.ts:50`); the budget does
> not shrink per-event, it **drops trailing events**. The corrected measurements
> are below and are worse in a different way.

`src/core/digestSelection.ts:66-99`, reached from `scopedEventDigest`
(`src/core/recall.ts:123-145`) with both salience levers off — the default.
Two distinct defects, both of this class:

**3a — fixed 480-char head truncation.** Each event body is
`truncate(e.content, 480)`. Position-blind: it keeps the opening of a turn
regardless of where the answer-bearing clause sits.

**3b — budget overflow drops trailing events silently.** The loop packs lines
greedily until `maxTokens` is exceeded, then emits
`(… N more events truncated to fit budget)` and stops. Which events survive is
decided by `orderCandidates` — on BEAM, with no hint and no salience, that is
insertion order, i.e. lexicographic event id.

**Measured, real BEAM 1M shard `13_s0_0` (47 events, `maxRecallTokensPerShard`
= 1200), running the production function:**

| | |
|---|---|
| events exceeding the 480-char cap | **23 of 47 (49%)** |
| events that get a digest line at all | **11 of 47 (23%)** — 36 dropped entirely |
| **share of the shard's text reaching the recall model** | **3.8%** |
| the 11 survivors | turn-0, 1, 10, 11, 12, 13, 14, 15, 16, 17, 18 |

Note the survivor list: **lexicographic again.** Turns 2–9 and 19–46 are
dropped before the recall model sees them. This is the same degenerate ordering
as instances 1 and 2, at a third stage.

### Severity bound — an important correction

An adversarial verifier established that this does **not** dominate the 1M
answer gap, and the reasoning holds up: `CSM_COVERAGE` is default-**ON**, and on
the official 1M run 696/700 answer contexts begin with the CSM chronological
evidence capsule. The capsule is built by `renderTimelineCapsule` from the
coverage chronicle, which scores **untruncated** event content and renders
query-anchored `termCenteredExcerpt` spans — not head truncation. With
`return_k = 24` and `recall_count = 1` on 683/729 official rows, the
recall-citation tier accounts for only roughly **3–4 of the 24 returned
documents**; the rest arrive via the full-content chronicle, the embedding
floor, shard-local expansion and the entity bridge.

So instance 3 is **real and worth fixing, but low severity on the shipped BEAM
path** — bounded to ~12–17% of answer-visible documents, where a bad pick also
evicts a full-content timeline entry from the 24-slot return. It is not the
cause of the verbatim-fact gap. I originally implied it was; that was wrong.

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

and of what does reach it, the recall digest forwards 3.8% of a shard's text —
though see the severity bound in instance 3: the coverage capsule supplies most
answer-visible documents from full content, so that last stage is not the
dominant term.

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


## Fixing one stage vs all three (BEAM 1M, 45 paired queries)

| config | coverage cov@24 | answer score | vs Hindsight |
|---|---:|---:|---:|
| A — baseline | 0.544 | 0.4176 | +0.372 behind (25/4) |
| C — router fix (descriptors + hybrid) | 0.720 | **0.7824** | +0.007, tie (10/9) |
| D — all three (+ `CSM_SIGNALS_RANKER`) | **0.780** | 0.7519 | +0.038, tie (13/10) |
| oracle | 0.956 | — | — |

Both fixes clear the baseline decisively on the answer metric (+0.365 and
+0.334, 26W/5L and 24W/9L). **C and D are indistinguishable from each other**
(the difference is far inside the n=45 MDE of ~0.23).

### The coverage/answer divergence is predicted

D captures more coverage (82% of oracle vs 75%) and scores slightly *lower* on
answers. That is the pattern this repo already established: `CSM_SIGNALS_RANKER`
bundles two different levers —

- `salientTruncation` — keeps the query-relevant span of an event instead of the
  first N chars. A **content-preservation** fix; directly addresses instance 3.
- `reorderBySalience` — changes the ORDER events appear in the digest. An
  **order-changing** lever, and `EXP-coverage-rerank-conversion.md` established
  that gold-facet coverage is anti-correlated with the score for exactly that
  class.

They are behind a single flag, so the good half cannot be shipped without the
risky half. **Separating them is a required part of the refactor**, and until
they are separated neither can be evaluated honestly.

### Decision

Ship the router fix. `CSM_SIGNALS_RANKER` stays off pending flag separation and
a re-test of `salientTruncation` alone.
