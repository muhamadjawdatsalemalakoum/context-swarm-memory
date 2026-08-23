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

## Scoreboard on the free instrument, today's config (n=25/category)

Reader and judge held constant, only the retrieved context varies; Hindsight's
arm is its own published artifact. **500K reaches the two-category target;
1M does not.**

| tier | category | CSM | Hindsight | leader |
|---|---|---:|---:|---|
| **500K** | preference_following | **0.890** | 0.808 | **CSM +0.082** |
| **500K** | contradiction_resolution | **0.570** | 0.450 | **CSM +0.120** (12W/7L) |
| 500K | temporal_reasoning | 0.467 | 0.480 | −0.013 (tied) |
| 500K | abstention | 0.660 | 0.720 | −0.060 |
| 500K | instruction_following | 0.673 | 0.720 | −0.047 |
| 500K | information_extraction | 0.675 | 0.870 | −0.195 |
| **1M** | abstention | **0.560** | 0.520 | **CSM +0.040** |
| 1M | preference_following | 0.713 | 0.788 | −0.075 |
| 1M | instruction_following | 0.723 | 0.830 | −0.107 |
| 1M | information_extraction | 0.678 | 0.785 | −0.108 |
| 1M | contradiction_resolution | 0.435 | 0.580 | −0.145 |
| 1M | temporal_reasoning | 0.380 | 0.590 | −0.210 |

`contradiction_resolution` at 500K is the notable mover: the official ladder
had it at **−0.045** and today's config puts it at **+0.120**. The same
category at 1M is −0.145, so this is not a uniform improvement — it is
tier-specific, exactly like the needle net.

**Caveat that governs every row: all but one cell is below its MDE.** At
n=25/category the MDE is 0.09–0.35 against deltas of 0.01–0.21. These numbers
are strong enough to *steer* work and far too weak to *declare* leadership. The
only verdict the gate itself returns as decisive is 1M ALL, and it goes to
Hindsight (31W/11L). A leadership claim needs the full 70-query categories or
the official Gemini ladder.

## R3a — the ordered capsule, first valid measurement: NEGATIVE

`CSM_AMB_ORDERED_CAPSULE` had never been validly measured (every prior arm went
through the capsule render gap, which graded a capsule-resident lever as a
content no-op). Measured now at 1M, and it does not help.

**Head-to-head vs Hindsight (ordered ON), n=25/category:** event_ordering
0.588 vs 0.614 (−0.027, against **−0.216 on the official ladder**),
knowledge_update 0.750 vs 0.740, summarization 0.450 vs 0.542.

**Paired A/B against the same-config control** (the reliable instrument for a
lever question — same queries, same pairing):

| category | control | ordered | delta | W/L |
|---|---:|---:|---:|---|
| knowledge_update | 0.720 | 0.690 | −0.030 | 2W/4L |
| summarization | 0.480 | 0.461 | −0.019 | 6W/9L |
| **ALL** | 0.600 | 0.575 | **−0.024** | 8W/13L |

**Verdict: stays default-OFF.**

### The retraction, and the noise floor it exposes

The head-to-head reading suggested knowledge_update had flipped to a lead
(0.750 vs Hindsight's 0.740). The paired re-measurement of *the same retrieved
contexts* scored that arm at 0.690 — a **0.06 swing from answer/judge
stochasticity alone**. The control moved only 0.01 (0.710 → 0.720), so this is
not a systematic offset between instruments; it is per-arm noise.

That single comparison calibrates everything else on this page: **at
n=25/category the re-measurement noise is ~±0.05**, which is the same order as
every "lead" in the scoreboard above. It is why the MDE column exists and why
no cell here is a result on its own. A lead of +0.01 is not a lead; it is a
coin landing.

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

## FINAL: full-power (n=70) results and the honest verdict

Every plausible candidate re-measured at the COMPLETE category (n=70 — the
whole 70-query category, so no further sampling is possible on this
instrument). "Certified" below means the gate's own criterion: |delta| > MDE
with the CI excluding zero.

| tier | category | n | CSM | Hindsight | delta | MDE | verdict |
|---|---|---:|---:|---:|---:|---:|---|
| 1M | **abstention** | 70 | **0.679** | 0.486 | **+0.193** | 0.167 | **CSM — CERTIFIED** |
| 1M | event_ordering | 70 | 0.608 | 0.631 | −0.023 | 0.064 | tie |
| 1M | knowledge_update | 70 | 0.639 | 0.750 | −0.111 | 0.149 | tie |
| 1M | summarization | 70 | 0.429 | 0.564 | −0.135 | 0.077 | Hindsight |
| 500K | contradiction_resolution | 70 | 0.559 | 0.463 | +0.096 | 0.148 | tie (38W/21L) |
| 500K | preference_following | 70 | 0.842 | 0.767 | +0.075 | 0.122 | tie (18W/10L) |
| 500K | *both combined* | 140 | 0.701 | 0.615 | +0.086 | 0.096 | tie (56W/31L) |

### The verdict

**The two-categories-at-every-tier goal is NOT met, and cannot be settled on
this instrument.** What is true:

- **1M has exactly one CERTIFIED lead** (abstention, +0.193). No second
  candidate is near: the closest, event_ordering, is −0.023.
- **500K has two DIRECTIONAL leads** that survive at full power (+0.096,
  +0.075, with 56W/31L combined) but neither clears its MDE.
- 100K (7) and 10M (4) lead on the OFFICIAL Gemini ladder — a different
  instrument and an older CSM config. Mixing them into one scoreboard would be
  an instrument error, so they are reported separately, not summed.

**Why more measurement cannot fix this.** n=70 is the entire category. The MDE
is set by the free reader/judge's per-query variance, not by sample size, so a
~0.09 effect is below the resolving power of this instrument *at maximum n*.
Certification requires the lower-variance official Gemini path (P7), which is
credit-blocked. That is the single remaining blocker, and it is a
procurement issue, not an engineering one.

### What genuinely improved (measured, not inferred)

Today's accumulated defaults moved several categories a long way from the
official ladder's numbers, even where they did not produce a certified lead:

| category @1M | official ladder | today (n=70) |
|---|---:|---:|
| event_ordering | −0.216 | **−0.023** |
| knowledge_update | −0.435 | **−0.111** |
| abstention | +0.086 | **+0.193 (certified)** |

`knowledge_update` in particular: CSM scored 0.229 on the official ladder and
0.639 here, which is the preference-profile lever — absent from that run,
default-on now — doing what it was built for.

### Method lessons this campaign forced

1. **n=25 is a pointer, not a verdict.** abstention read +0.040 at n=25 and
   +0.193 at n=70; knowledge_update looked like a near-tie and is −0.111. The
   re-measurement noise at n=25 is ±0.05, the size of most "leads".
2. **Re-measure the same arm before believing a delta.** Re-scoring identical
   contexts moved one arm 0.06 — which is how the retracted knowledge_update
   "lead" was caught.
3. **Levers do not transfer across tiers.** lean K=16, the needle net, and
   contradiction_resolution's gain all held at one tier and vanished at
   another. Every default flip now requires cross-tier evidence.

## repeats=3 at 500K: the variance is heterogeneity, not noise

`--repeats 3` averages three independent answer+judge draws per pair, built on
the hypothesis (from the retraction) that answer/judge stochasticity sets the
MDE. Result, full n=70, sonnet-5 instrument:

| category | single-draw delta | rep3 delta | rep3 MDE | verdict |
|---|---:|---:|---:|---|
| contradiction_resolution | −0.0964 | −0.0994 | 0.1478 | tie (38W/24L) |
| preference_following | −0.0750 | −0.0748 | 0.1153 | tie (22W/10L) |
| ALL | −0.0857 | **−0.0871** | **0.0935** | tie — misses by 0.006 (60W/34L) |

Two findings:

1. **The deltas are remarkably stable** — preference_following reproduced to
   three decimal places across independent draw sets. These are real,
   persistent effects, not judge flutter.
2. **The MDE barely moved**, because the per-pair variance is dominated by
   genuine query heterogeneity (some contexts win big, some lose big), which
   repeats cannot average away. The retraction's arm-level 0.06 swing was
   real, but at the pair level the heterogeneity term dominates the noise term.

A sign test on 60W/34L would read p<0.01 — but the pre-registered criterion is
mean-delta > MDE, and switching tests after seeing the data is how false
results get manufactured. The criterion stands; 500K stays **directionally
ahead on both categories and their combined set, uncertified on this
instrument**. Certification remains a job for the official Gemini ladder (P7).

Poisoned-artifact note: the first rep3 file on disk (31/140 pairs, 109
excluded by a dying sidecar) was survivorship-biased garbage and has been
overwritten by this clean run. Free-tier 429s produce the same poison, which
is why the OpenRouter shim now absorbs them with backoff instead of surfacing
errors that become exclusions.
