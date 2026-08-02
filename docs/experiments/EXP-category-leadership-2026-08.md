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

## Open thread — did the lean default cost information_extraction?

`information_extraction` was **−0.003 (a tie)** on the official ladder and is
**−0.265** here. The suspicious detail is self-inflicted: lean K=16 was
validated on instruction_following / preference_following / knowledge_update
and then flipped as a **global** default, and information_extraction is
precisely the category that needs specific facts from specific turns — the
payload lean K trims. `g500k-leanoff-v1` (`CSM_AMB_LEAN_K=0`, everything else
identical) is running to settle it. If confirmed, lean must be gated by intent
rather than shipped globally.
