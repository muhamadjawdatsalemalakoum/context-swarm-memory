# PRE-FLIGHT — the official BEAM ladder re-run (the one-shot final exam)

Purpose, in the operator's own framing: after this re-run on the official
runner with Gemini, the verdict stands — if CSM fails, the idea is judged not
competitive and the experiment ends. This document exists so that a failure
would be a verdict on the IDEA, not on an unwired flag, a poisoned cache, or a
broken upstream loader. Every item below was found by the 2026-08-25 five-
stream audit or the fixes that followed; each is either FIXED (commit noted)
or a decision the operator makes at launch.

## The frozen configuration — and why it is the best measurable CSM

**The run uses code defaults. No behavioural CSM_* flag is set in the
environment except the operational ones the tier script exports.** The
defaults ARE the certified configuration:

| lever | default | evidence |
|---|---|---|
| hybrid router + descriptors | ON | +0.365 answer @1M, 26W/5L |
| ID repair | ON | ~0.20 |
| batched probe (hosted) | ON | −21% internal input, score-neutral |
| **fact fold** | **ON** | ku 500K **certified ×2 readers** (+0.382/+0.326); 1M paired +0.114 CI>0; abstention guard wash; PF/CR guard positive; token-neutral |
| preference profile | OFF | every certified full-n arm ran profile-OFF; fold+profile COMPOSED measured −0.036 (4W/9L) vs fold alone — g1m-ku70-foldpref-v1 |
| lean return, needle net, session digests, ordered capsule, local probe gate, probe shrink, coverage rerank, virtual shards, legacy vocab/intent | OFF | each measured negative, non-replicating, or a wash — see the EVIDENCE lever ledger |

The residual-loss audit confirmed nothing measured-positive is switched off
under the one-config-for-all-tiers constraint. The `tests/env.test.ts` FLAGS
table now pins the two decisive defaults (profile OFF, fold ON) so a silent
flip is a test failure, and manifests record RESOLVED lever values including
factFold and idRepair.

## Blockers found and FIXED (any one would have voided or corrupted the run)

1. **Fold inert on the official path** — the server passed the registry only
   under the legacy aggregation gate; the certified lever existed only on the
   slice harness. Fixed + server-test pinned (7c79b78).
2. **Cross-tier cache poisoning** — user_ids are `1..N` in every tier and the
   write-time disk caches key by split|user|model; a sequential ladder would
   serve tier 1's registries/profiles to tier 2+. `run-beam-tier.ps1` now sets
   `CSM_AMB_SPLIT = $Split` (47410af).
3. **Profile "DEFAULT ON" was a comment-only flip** the docs repeated for three
   weeks. Docs/ledger corrected; certified config is profile-OFF; composition
   measured rather than assumed (47410af, 9093d6c).
4. **Prewarm concurrency storm** — 1M ingest fired ~280 concurrent ~100K-token
   build calls; now bounded workers (`CSM_AMB_PREWARM_SCOPES`, default 2)
   (9093d6c).
5. **Ladder not re-runnable** — tier names were hardcoded to the completed June
   dirs (every tier would read "already complete"). Now `-Tag`-parameterized;
   **10M held by default** (9093d6c).
6. **Query-time build vs retrieve timeout** — `CSM_AMB_RETRIEVE_TIMEOUT_SEC`
   now 3600 for 10m / 1200 otherwise, belt-and-braces behind the prewarm
   (9093d6c).
7. **AMB repo `.env` override trap** — AMB's cli.py loads it with
   override=True; the tier script now refuses to run if it contains CSM_*
   entries (9093d6c).
8. Manifest ambiguity across default flips; ECHOED_ENV_VARS gaps — fixed
   (47410af).

## External facts that reshape the exam (decide at launch)

- **The runner changed after upstream PR #20**: mem0-parity prompt, nugget
  judge, temp-0; event_ordering is no longer Kendall τ-b. Pre-change numbers —
  including Hindsight's committed April artifacts and our own June ladder —
  are NOT comparable to a post-change run. **Pin the runner commit, and
  re-run/re-score Hindsight under the same pinned commit** (its raw contexts
  are committed upstream; re-scoring is answer+judge cost only). Our
  free-instrument comparisons are unaffected (they re-scored both sides'
  CONTEXTS under one reader), but every OFFICIAL score comparison must be
  same-commit.
- **10M has an upstream loader defect** (maintainer PR #38, 2026-08-25). The
  report implies the published 10M results — CSM's and Hindsight's — measured a
  ~0.27%-loaded corpus. **An empirical check of the committed artifacts does not
  support that reading for the published run** — but the figure this document
  first gave for it (98-99.9%) was itself wrong, and is corrected here.
  Recomputed by `scripts/measure-hindsight-10m-span.mjs`: Hindsight's 10M
  contexts reach turn indices spanning **64.3%-89.7%** of each unit's full turn
  range, surfacing **11.6%-15.9%** of its turns. Reaching across 64-90% of a
  unit's timeline is still not what a 0.27%-loaded corpus would produce.
  (This document also once asserted the 0.27% figure itself as established
  fact; that was wrong too.) Both facts are recorded because they conflict and the conflict is
  upstream's to resolve. Either way the ladder holds 10M until the fix merges,
  then re-stages it on the fixed loader as its own run.
- **PR #19 is closed** (author-closed 2026-06-22, unmerged). Any submission is
  a NEW PR against the post-#20 runner. Note for the PR body: Hindsight's
  current site "rag" numbers are self-labeled leak-prompt runs under a
  since-removed prompt; cite blob SHAs and flag the juxtaposition to the
  maintainer rather than letting clean-prompt numbers sit beside them
  unannotated.

## Launch recipe (100K → 500K → 1M)

```
pwsh scripts/run-beam-ladder.ps1 -Tag official-v3-<date>
```

- Models: internals gemini-3.5-flash, answer gemini-3.1-pro-preview, judge
  gemini-2.5-flash-lite (exported by the tier script; AMB records
  "gemini:<model>").
- Write-time builds run at ingest via the throttled prewarm; registries/
  profiles disk-cache under `data/eval/{fact-registries,preference-profiles}`
  keyed split|user|model|promptVersion — Gemini-built, so sonnet-era caches do
  not apply and the first tier pass pays the one-time build cost.
- Budget (audit estimate): three tiers ≈ $200–300 at assumed list prices;
  verify current Gemini pricing and set an AI-Studio budget alert first
  (docs/GEMINI.md "Cost safety"). The deferred 10M tier is most of the old
  $750–960 figure (~117 map calls per artifact per unit).
- Before launch: `npm test` (549), `npm run lint`, confirm HEAD ≥ 9093d6c,
  clean AMB checkout at the pinned commit, AMB `.env` free of CSM_* entries
  (the script enforces this).

## What "best it could be" means — and does not

Under the free instrument (full-n, cross-reader): every certified cell and
guard is on; every negative or non-replicating lever is off; the composition
question is measured, not assumed. What this CANNOT promise: reader transfer
(the fold's magnitude is reader-sensitive: +0.114 sonnet / +0.022 ox paired),
judge transfer to the new nugget judge, and the write-time artifacts being
built by Gemini instead of the sonnet extractor that produced the certified
texts. Those are the honest residual unknowns of the exam — they are the
exam. If CSM loses on this configuration, on a pinned runner, with Hindsight
re-scored on the same commit, the loss is real.
