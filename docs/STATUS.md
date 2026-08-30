# STATUS — where Context Swarm Memory actually stands

**Last updated: 2026-08-30.** This is the single page that says what is true
*today*. Every other document in `docs/` is a record of a moment; when one of
them disagrees with this page, this page wins and the other one is history.

---

## The one-paragraph version

CSM keeps its **per-query retrieval cost flat** — ~36–38K input tokens all-in
— as the per-unit haystack grows **76×**, and that property is measured on the
public benchmark's own runner. Its *ingest* cost is not flat: the default
write-time fact extraction reads the whole corpus once, which is O(corpus) and
at the top tier dominates query spend (see **The cost claim, precisely**).

On **accuracy**, CSM has two **certified** category
leads over Hindsight on a calibrated free instrument (500K `knowledge_update`,
1M `abstention`, both replicated on a second independent reader), a handful of
directional-but-unresolvable leads, and no official standing of any kind. The
run that would settle the accuracy question end-to-end is fully staged and
blocked on API credit plus an upstream benchmark fix.

## What is certified

"Certified" means the gate's own pre-registered criterion: the delta exceeds
its **minimum detectable effect (MDE)** *and* the confidence interval excludes
zero, at the full category size (n=70 — the entire category, no further
sampling possible). Both entries below additionally **replicate on a second,
independent reader**, which is a deliberate falsification attempt that they
survived.

| tier | category | n | CSM | Hindsight | delta | MDE | W/L/T | second reader |
|---|---|---:|---:|---:|---:|---:|---|---:|
| 500K | `knowledge_update` (with fact fold) | 70 | 0.758 | 0.376 | **+0.382** | 0.173 | 37/6/27 | **+0.326** |
| 1M | `abstention` | 70 | 0.679 | 0.486 | **+0.193** | 0.167 | 23/8/39 | **+0.185** |

Also certified as a pair at 500K: `knowledge_update` + `information_extraction`
combined, +0.129 (45W/22L/73T, MDE 0.123).

**Directional, full-n, replicated on two readers — but under MDE, so NOT
claimed as leads:** 500K `contradiction_resolution` (+0.096, 38W/21L) and
`preference_following` (+0.075, 18W/10L).

## What is stale

### The June 2026 BEAM ladder

`docs/AMB_BEAM_LADDER_2026_06_18.md` is the only run this project has on the
**official AMB runner**, and it is stale twice over:

1. **It measured a CSM that no longer exists.** It predates the hybrid router,
   ID repair, the batched probe, and the fact fold — see the defaults table
   below. On the same 1M queries, `knowledge_update` went from −0.435 on that
   ladder to −0.111 today, and `abstention` from +0.086 to +0.193 certified.
2. **Its scores are no longer comparable to anything current.** After upstream
   PR #20 the benchmark changed its answer prompt (mem0-parity), its judge
   (nugget-based), and its temperature (0); `event_ordering` is no longer
   Kendall τ-b. Pre-change numbers — Hindsight's committed April artifacts
   *and* our June ladder — cannot be placed beside a post-change run.

**The ladder's cost measurement mostly survives**, because a token count does
not depend on the prompt or the judge. Two caveats, since the config-change
objection applies to tokens as well as to scores: the batched probe (now
default) cuts internal input ~21%, so today's per-query figure is probably
nearer ~34–36K and is **projected, not measured**, on the official path; and
the config that produced the ladder had **no write-time stage at all**, so its
accounting excludes an ingest cost that today's default config incurs.

### The upstream submission

[PR #19](https://github.com/vectorize-io/agent-memory-benchmark/pull/19) was
**author-closed on 2026-06-22, unmerged**. Any document still describing it as
"pending acceptance" is out of date. A future submission is a **new PR against
the post-#20 runner**, with Hindsight re-scored on the same pinned commit.

### The 10M tier

The maintainer reported a 10M loader defect (upstream PR #38, 2026-08-25)
implying the published 10M results measured a barely-loaded corpus. **An
empirical check of the committed artifacts does not support that reading for
the published run**: Hindsight's 10M contexts reference turns spanning
98–99.9% of each unit's full turn range. Both facts are recorded because they
conflict, and the conflict is not ours to resolve — the tier is held until the
upstream fix merges, then re-staged as its own run under the fixed loader.

## The cost claim, precisely

| what | flat? | figure |
|---|---|---|
| **Per-query retrieval** (answer packet + internal pipeline) | **yes** | ~36–38K input tokens across a 76× haystack range (154K → 11.7M per unit) |
| **Per-query, with the fact fold on** | **yes** | fold measured token-neutral at answer time: 7,106 → 7,080 (abstention), 7,010 → 7,074 (knowledge_update) |
| **Ingest (write-time fact extraction)** | **no — O(corpus)** | the registry chunks each unit at 100K tokens and reads every chunk |

First-ingest cost, amortized over each tier's query budget:

| tier | per-unit haystack | units | first-ingest input | queries | amortized/query |
|---|---:|---:|---:|---:|---:|
| 100K | ~154K | 20 | ~3.1M | 400 | ~7.7K |
| 1M | ~800K | 35 | ~28M (≈280 × 100K calls) | 700 | **~40K** |
| 10M | ~11.7M | — | ~117 chunk calls **per unit** | 200 | dominates all query spend |

At 1M the one-time build is roughly the same order as the entire per-query
retrieval spend for the run; at 10M it is larger by an order of magnitude (the
pre-flight budgets it as most of a $750–960 tier estimate).

What keeps this honest rather than fatal: it is **one-time and disk-cached**
(keyed `split|user|model|promptVersion`), it runs on the **cheap model tier**,
and in a real deployment memory arrives incrementally so facts are extracted per
turn — the whole-corpus read is a **backfill**, not a recurring cost.

**That last point is also Hindsight's defense**, which is why this repo no
longer claims its own accounting is "the complete one." Both systems distill at
ingest. CSM's ingest cost is disclosed above; Hindsight's is not. That, and only
that, is the difference worth stating.

## Current defaults — the certified configuration

The official re-run uses **code defaults**; no behavioural `CSM_*` flag is set
in the environment. `tests/env.test.ts` pins the two decisive ones so a silent
flip is a test failure.

| lever | default | evidence |
|---|---|---|
| hybrid router + descriptors | **ON** | +0.365 answer at 1M, 26W/5L — the strongest single effect measured on this project |
| ID repair | **ON** | ~0.20 |
| batched probe (hosted) | **ON** | −21% internal input, score-neutral |
| fact fold | **ON** | 500K `knowledge_update` certified ×2 readers; 1M paired +0.114 (CI > 0); abstention guard a symmetric wash; token-neutral at answer time |
| preference profile | **OFF** | every certified full-n arm ran profile-OFF; composed with the fold it measured **−0.036** (4W/9L) versus fold alone |
| lean return, needle net, session digests, ordered capsule, local probe gate, probe shrink, coverage rerank, virtual shards, legacy vocab/intent | **OFF** | each measured negative, non-replicating, or a wash |

A residual-loss audit confirmed nothing measured-positive is switched off under
the one-config-for-all-tiers constraint.

## What is blocked

| blocker | kind | what unblocks it |
|---|---|---|
| Official Gemini ladder (100K/500K/1M) | procurement | API credit; est. $200–300 for three tiers at list prices |
| 10M tier | upstream | maintainer PR #38 merging, then a re-staged run on the fixed loader |
| Certifying the sub-MDE directional leads | instrument | only the lower-variance official path can resolve a ~0.09 effect; n=70 is already the whole category |

The pre-flight is complete: eight blockers that would have voided or corrupted
the run were found and fixed, the config is frozen, and the launch recipe is
one command. See [`PREFLIGHT_OFFICIAL_LADDER.md`](PREFLIGHT_OFFICIAL_LADDER.md).

## What was measured and failed

Published with the same weight as the wins, because the failures are what make
the wins credible.

| result | verdict | why it matters |
|---|---|---|
| Displacement / fold-vs-append **+0.068** | **RETRACTED** | a harness artifact — the capsule rendered as a placeholder string. Rule: never grade an arm on a context you cannot byte-reproduce. Synthesized text is now persisted per run. |
| Coverage-proxy reranker (+11.6 proxy) | **rejected** | *lost* answers on `event_ordering` (4W/13L, p=0.049). The proxy is anti-correlated; order-changing levers are gated on the answer metric only. |
| Router component bench (+0.24 predicted) | **did not survive assembly** | the assembled system delivered −0.12. Benchmark the unit production conserves. |
| Needle net | **non-replicating** | worked at 500K, vanished at 1M. Cross-tier evidence is now required for any default flip. |
| Lean return K=16 | **reverted same day** | 500K `information_extraction` regression. |
| L3 local pre-gate | **killed** | a 3-point dose-response showed it drops witnesses and loses `knowledge_update`. Cheapen the question, not the witness. |
| Gemini context caching (40–60% projected) | **falsified** | a measured 4,096-token implicit-cache floor means every CSM call is sub-floor — zero caching, by construction. |
| Virtual shards | **regression** | coverage 0.743 → 0.620. |
| Mem0, HippoRAG | **blocked, not beaten** | could not be run on available hardware. Recorded as a gap. |

Method lessons these forced, now standing rules:

1. **n=25 is a pointer, not a verdict.** `abstention` read +0.040 at n=25 and
   +0.193 at n=70. Re-measurement noise at n=25 is ±0.05 — the size of most
   "leads".
2. **Re-measure the same arm before believing a delta.** Re-scoring identical
   contexts moved one arm 0.06; that is how a retracted "lead" was caught.
3. **A delta below its MDE is not an effect.** Stated at birth, never softened
   afterwards.
4. **Levers do not transfer across tiers**, and component gains do not transfer
   into assembled systems.

## Retired instruments

The August campaign used a second, independent reader (`stealth/ox-alpha` via
OpenRouter) purely to falsify the primary reader's verdicts. That model was a
time-boxed free preview and is **no longer available**; the shim that served it
was removed on 2026-08-30. Its numbers stay in the record as **frozen
evidence** — each was a within-instrument paired delta over contexts still on
disk byte-for-byte — but they are not re-runnable. A future falsification pass
needs a different second reader.

## The instruments themselves

| instrument | what it is | when it is authoritative |
|---|---|---|
| **Official AMB runner** (Gemini) | upstream CLI, scoring, judge; a 3-file CSM provider and nothing else | the only publishable instrument; currently blocked |
| **Free head-to-head** (`scripts/headtohead-arms.ts`) | one reader + one judge serve both arms; only the retrieved context differs; Hindsight replayed from its own published contexts | calibrated ρ 0.864 / MAE 0.077 vs the official judge; reproduced the official tie@100K and loss@1M. Certifies *within-instrument* paired deltas only. |
| **Agent-SDK sidecar** | local iteration harness | iteration only — it carries ~8.5K tokens/call of harness overhead that is not CSM's, so its token totals are never publishable |

Numbers from different instruments are **never pooled**. Absolute levels differ
by reader (~0.04 between the two readers used here); only within-instrument
deltas are compared.

## Honest summary for anyone quoting this project

- CSM is an **R&D prototype**, not a product.
- It has **no leaderboard placement** and does not claim SOTA.
- Its **flat-cost property** is measured and durable.
- Its **certified accuracy claims** are two categories, on a free instrument,
  cross-reader replicated, with MDEs and exclusions attached.
- Its **failure record is public** and longer than its win record.
- The goal of "leading two categories at every corpus size" is **not met**.
