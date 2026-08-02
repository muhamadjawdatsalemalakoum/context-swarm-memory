# EXP — per-category leadership vs Hindsight (2026-08-01, in progress)

Target: CSM leading **≥2 categories at every corpus size**. This doc holds the
scoreboard, the method, and the instrument caveats that decide what the numbers
are allowed to mean.

## Baseline — official Gemini ladder (authoritative)

Recomputed per category from raw artifacts on both sides
(`scripts/category-leaderboard.mjs`; Hindsight's own committed BEAM outputs,
same answer model `gemini-3.1-pro-preview`, same judge `gemini-2.5-flash-lite`,
`oracle=false`).

| tier | categories CSM leads | which |
|---|---:|---|
| 100K | **7** | contradiction_resolution, information_extraction, instruction_following, knowledge_update, multi_session_reasoning, preference_following, temporal_reasoning |
| 500K | **1** | abstention (+0.071) |
| 1M | **1** | abstention (+0.086) |
| 10M | **4** | abstention (+0.200), information_extraction (+0.075), preference_following (+0.025), temporal_reasoning (+0.025) |

So the target reduces to **+1 category at 500K and +1 at 1M**. Nearest deficits:

- 500K: information_extraction **−0.003**, preference_following **−0.006**,
  temporal_reasoning −0.036, contradiction_resolution −0.045
- 1M: preference_following **−0.050**, information_extraction −0.091,
  multi_session_reasoning −0.109

**The decisive fact about this baseline: it is stale.** It was run 2026-06-18,
before `CSM_ROUTER_HYBRID` (+0.365 answer at 1M, the strongest lever ever
measured here), `CSM_AMB_ID_REPAIR` (~0.20), `CSM_AMB_PREFERENCE_PROFILE` —
which targets `preference_following` by name — and the 2026-08-01 defaults
fold. It measures a CSM that no longer exists.

## Free instrument — one reader, context is the only variable

`scripts/headtohead-arms.ts`: same answer model, judge, prompts and queries for
both arms; only the retrieved context differs. CSM's side comes from a fresh
slice run rendered by `scripts/emit-run-contexts.ts`; Hindsight's side is its
published context for the same query ids. Judge calibrated against the official
Gemini judge (holdout ρ 0.864, MAE 0.077) and previously reproduced the
official tie@100K and loss@1M.

### Results with today's defaults (delta positive = Hindsight ahead)

**500K** (`g500k-newdefaults-v1`, n=25/category):

| category | CSM | Hindsight | delta | MDE | leader |
|---|---:|---:|---:|---:|---|
| preference_following | **0.862** | 0.808 | −0.053 | 0.242 | CSM (below MDE) |
| abstention | 0.660 | 0.720 | +0.060 | 0.147 | HS (below MDE) |
| information_extraction | 0.605 | 0.870 | +0.265 | 0.293 | HS (below MDE) |

**1M** (`g1m-newdefaults-v1`, n=46 — 29 rows lost to a provider rate limit):

| category | CSM | Hindsight | delta | MDE | leader |
|---|---:|---:|---:|---:|---|
| abstention (16) | **0.578** | 0.531 | −0.047 | 0.340 | CSM (below MDE) |
| preference_following (15) | 0.714 | 0.781 | +0.067 | 0.199 | HS (below MDE) |
| information_extraction (15) | 0.651 | 0.813 | +0.162 | 0.346 | HS (below MDE) |

## Two instrument caveats that bound every claim above

**1. n=25/category is too small to establish a lead.** MDEs land at 0.15–0.35
while the deltas of interest are 0.05. Every cell above reads "below MDE", so
none of them is an effect — they are directional only. A category claim needs
the full 70-query category (MDE ~0.09) or the official instrument.

**2. The free instrument does not reproduce official per-category levels, and
abstention is the worst offender.** Official 500K abstention is CSM 0.971;
here it is 0.660. Abstention asks the reader to refuse when the memory lacks
the answer — that is a property of the READER's willingness to say "I don't
know", not of the memory system, so swapping `gemini-3.1-pro-preview` for
`claude-sonnet-5` moves the absolute level and can flip the sign. Its rubrics
are also 1–2 items, so each row scores 0/0.5/1 — coarse by construction, which
is exactly why its MDE is the largest in the table.

**Consequence:** the free instrument is fit for *steering* (which lever moves
which category) and unfit for *declaring* leadership. The scoreboard claim must
land on the official Gemini ladder (P7, blocked on credits). Abstention in
particular must not be counted as a free-instrument lead.

## The needle net — diagnosis, lever, and its measured trade

**Diagnosis (500K, per-query, both sides' real contexts).** Every
information_extraction loss is a hard **absence**, not a burial: the rubric's
literal string occurs **0× in CSM's context in 7/7 losses and ≥1× in 13/13
wins**, so the reader is not the variable. The cause is structural — BEAM gold
is one short user turn inside a ~100K-char session document, and the *document*
is CSM's retrieval unit. The hybrid router scores a shard by the **mean of its
50–70 turn vectors**, pooling the needle to ~1/56 of the signal, so the top-8
candidate cut is close to a coin flip: in **5 of 7 losses the gold-bearing
shard was never even a candidate**; the other 2 lost the 4-shard recall cap.

**CSM already had the right-shaped stage and suppressed it.**
`applyEmbeddingFloor` is the only retrieval stage that is both *global* and
*event-level*, but it no-ops unless the pipeline came back starved — 9% of
queries. Where it fired it was a perfect predictor (**8/8 scored 1.0**; every
zero sits in the not-fired group), and two runs with **identical router
candidates and identical recalled shards** differ only in the floor firing:
`30_information_extraction_1` scores **1.0 with, 0 without**. Over the cached
MiniLM vectors, a global turn-level cosine ranks the missing gold turn
**#1, #1, #3, #3, #8, #35, #38 of ~1000**.

**Lever:** `CSM_EMBED_ALWAYS_K` unions the top-K global turn hits regardless of
pipeline fullness, at the **head** (at the tail a RETURN_K cut discards them
first — the floor only survives today because a starved order sits far below
the cap).

**Measured, K=5 vs control, paired, n=25/category:**

| category | control | needle K=5 | delta | CI95 | W/L |
|---|---:|---:|---:|---|---|
| information_extraction | 0.650 | **0.855** | **+0.205** | [0.070, 0.365] | **7W/0L** |
| abstention | 0.700 | 0.580 | **−0.120** | [−0.240, −0.020] | 0W/4L |
| preference_following | 0.868 | 0.865 | −0.003 | [−0.083, 0.063] | 2W/1L |

A clean trade with a symmetric mechanism: when the asked-for fact exists the
global search finds it; when it genuinely does not — exactly what abstention
tests — the same search still returns the five most-similar-*looking* turns,
and plausible material talks the reader out of refusing. It moves
information_extraction from −0.195 behind Hindsight to **−0.015**.

**Gate (`CSM_EMBED_ALWAYS_BEATS_BEST`), deliberately parameter-free.** A global
hit must beat the best cosine among the events the pipeline already returned.
A cosine threshold tuned to separate these two categories would be
benchmark-fitting in numeric clothing — the F9/F10 vocabulary mistake with
numbers — so the gate reads its threshold off each query's own returned set
instead. Early telemetry shows it discriminating as intended: 5 injected when
topCos 0.674 ≫ bestReturned 0.609, **0** when the pipeline already held the
best match (0.174 = 0.174), and 1 on abstention queries. An absolute floor
(`CSM_EMBED_ALWAYS_MIN_COS`) exists but is documented as the fitted option,
requiring cross-tier validation.

### Gated vs ungated (500K, paired vs the same control)

| category | control | ungated K=5 | **gated K=5** |
|---|---:|---:|---:|
| information_extraction | 0.650 | 0.855 (+0.205) | **0.800 (+0.150)**, 5W/2L |
| abstention | 0.700 | 0.580 (−0.120) | **0.660 (−0.040)**, 1W/3L |
| preference_following | 0.868 | 0.865 (−0.003) | **0.887 (+0.018)**, 4W/1L |
| **ALL** | 0.739 | 0.767 (+0.027) | **0.782 (+0.043)**, 10W/6L |

The gate dominates the ungated form on every axis: it keeps ¾ of the
information_extraction gain, cuts the abstention damage by two thirds, and
turns preference_following slightly positive. Injection drops from a flat 5.0
to 1.0–2.0 per query, with **14/25 abstention queries receiving nothing at
all** — the discrimination is doing exactly the work it was designed for,
without a tuned constant.

Against Hindsight at 500K this moves information_extraction from **−0.220 to
−0.070** and leaves preference_following leading at **0.887 vs 0.808**.

**NOT flipped to default yet, deliberately.** ALL +0.0428 is below its MDE
(0.092), and the lean-return revert earlier the same day is the standing
lesson: a lever measured on three categories at one tier is evidence about
three categories at one tier.

### Cross-tier validation at 1M — DOES NOT REPLICATE

Same gated config, same three categories, paired against the 1M control:

| category | 500K | **1M** |
|---|---:|---:|
| information_extraction | +0.150 (5W/2L) | **+0.012 (3W/7L)** |
| abstention | −0.040 (1W/3L) | +0.040 (5W/3L) |
| preference_following | +0.018 (4W/1L) | −0.008 (6W/5L) |
| **ALL** | +0.0428 (10W/6L) | **+0.0147 (14W/15L)** |

The headline 500K result — information_extraction +0.150 — collapses to +0.012
at 1M, with **losses outnumbering wins** (3W/7L). Overall the lever is a coin
flip there (14W/15L). Every cell was below MDE at both tiers, so nothing here
was ever an effect on its own; what the second tier removes is the *pattern*
that made the first tier persuasive.

**Verdict: `CSM_EMBED_ALWAYS_K` stays default-OFF.** It is a measured,
documented, opt-in lever with a real 500K result and no evidence of
generalisation. Shipping it on the strength of one tier would have repeated the
lean-return mistake in the same session that taught it.

What survives regardless of the lever's fate is the **diagnosis**: the losses
are absences, not burials; the retrieval unit is a whole session document; and
mean-pooling 50–70 turn vectors dilutes a one-turn needle to ~1/56 of the
signal. That is a structural property of document-granular routing, and any
future fix — a smaller retrieval unit, turn-level indexing at ingest, R1's
co-occurrence edges — has to answer it. Making the *unit* smaller is a
different and more promising attack than bolting a global search onto the end
of a document-granular pipeline.

## Open thread — did the lean default cost information_extraction?

`information_extraction` was **−0.003 (a tie)** on the official ladder and is
**−0.265** here. The suspicious detail is self-inflicted: lean K=16 was
validated on instruction_following / preference_following / knowledge_update
and then flipped as a **global** default, and information_extraction is
precisely the category that needs specific facts from specific turns — the
payload lean K trims. `g500k-leanoff-v1` (`CSM_AMB_LEAN_K=0`, everything else
identical) is running to settle it. If confirmed, lean must be gated by intent
rather than shipped globally.
