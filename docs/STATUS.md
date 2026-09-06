# STATUS — where Context Swarm Memory actually stands

**Last updated: 2026-09-05.** This is the single page that says what is true
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
| 500K | `knowledge_update` (with fact fold) | 70 | 0.758 | 0.376 | **+0.382** | 0.173 | 37/6/27 | **+0.326** (n=67) |
| 1M | `abstention` | 70 | 0.679 | 0.486 | **+0.193** | 0.167 | 23/8/39 | **+0.185** (n=69) |

The second reader ran at a *smaller* n than the primary — 67 and 69 rather than
70 — because free-tier throttling exhausted retries. At 500K the run covered the
`knowledge_update` + `information_extraction` pair (140 rows) and lost 7 in total,
**3 of them `knowledge_update`** (70 − 3 = 67); at 1M it lost 1 `abstention` pair.
(An earlier version of this paragraph said "7" against the 500K
`knowledge_update` row, which does not reconcile with n=67.) Excluded pairs are
reported as-is, never backfilled.

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
   *Read that comparison for its direction, not its magnitude:* the "ladder"
   column is the official Gemini judge and the "today" column is the free
   instrument, so it crosses instruments — exactly what this page otherwise
   forbids. It is kept because the movement is far larger than the instruments'
   known offset (~0.04), and it is labelled so nobody quotes it as a delta.
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
implying the published 10M results measured a barely-loaded corpus.

**Correction (2026-08-30).** An earlier version of this page put that figure at
"98–99.9% of each unit's full turn range". That number was never computed by any
committed script and is **wrong**. Recomputed from primary artifacts by
`scripts/measure-hindsight-10m-span.mjs`:

| measure | across the 10 units |
|---|---|
| span coverage — highest turn index reached / unit's last turn | **63.5% – 88.8%** |
| ref density — distinct turns retrieved / unit's total turns | **11.5% – 15.8%** |

*Second correction (2026-09-05):* the first version of the script matched only
the ~100 **dated** turn markers per unit (`[July-01-2024 | Turn 0]`) as the
denominator, not all ~19,900 turns (`[Turn N]`), so its 64.3–89.7% / 11.6–15.9%
were about one point high. The regex is fixed and the script now prints the
dated-marker count so the discrepancy is visible in its own output.

Retrieval reaching across 63–89% of each unit's timeline is still hard to
reconcile with a ~0.27%-loaded corpus, so the tension with the upstream report
stands — but the honest number is 63–89%, not 98–99.9%, and it is now a
computation anyone can re-run rather than a recollection. The tier is held until
the upstream fix merges, then re-staged under the fixed loader.

## The cost claim, precisely

| what | flat? | figure |
|---|---|---|
| **Per-query retrieval** (answer packet + internal pipeline) | **yes** | ~36–38K input tokens across a 76× haystack range (avg per-unit 154,431 → 11,707,222; census-sourced) |
| **Per-query, with the fact fold on** | **yes** | fold measured token-neutral at answer time: 7,106 → 7,080 (abstention), 7,010 → 7,074 (knowledge_update) |
| **Ingest (write-time fact extraction)** | **no — O(corpus)** | the registry chunks each unit at 100K tokens and reads every chunk |

First-ingest cost, amortized over each tier's query budget:

| tier | per-unit haystack (avg) | units | first-ingest input | queries | amortized/query |
|---|---:|---:|---:|---:|---:|
| 100K | 154,431 | 20 | 3,088,625 | 400 | ~7.7K |
| 500K | 560,086 | 35 | 19,602,995 | 700 | ~28K |
| 1M | 1,155,117 | 35 | 40,429,107 | 700 | **~58K** |
| 10M | 11,707,222 | 10 | 117,072,219 | 200 | **~585K** |

Source: `data/eval/corpus-beam-slice/census.json` — the benchmark's own corpus
census, not an estimate. At **1M the one-time build (~58K/query) exceeds the
per-query retrieval cost (~38K)**; at **10M (~585K/query) it is ~16× larger**.
The pre-flight budgets the 10M tier as most of a $750–960 estimate.

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
in the environment. `tests/env.test.ts` pins **twelve** flag rows — including
coverage mode (ON), the profile (OFF) and the fact fold (ON) — so a silent flip
is a test failure.

| lever | default | evidence |
|---|---|---|
| hybrid router + descriptors | **ON** | +0.365 answer at 1M, 26W/5L — the strongest single effect measured on this project. **Caveat:** measured on sidecar arm r1mC (2026-07-31) *before* the render-gap fix, on a harness that dropped the evidence capsule from *both* arms; the delta is within-harness valid but the absolutes are not, and it has not been re-measured with the capsule rendered. Every post-fix certified result runs with it ON — indirect support, not a re-measurement |
| ID repair | **ON** | ~0.20 |
| batched probe (hosted only) | **ON** | −21% internal input (arithmetic: one shared scaffold replaces 8); score delta +0.032, below its 0.079 MDE. Local (ollama, llama-server) stays OFF — the evidence is from one hosted model family |
| fact fold | **ON** | 500K `knowledge_update` certified ×2 readers; 1M paired +0.114 (CI > 0); abstention guard a symmetric wash; token-neutral at answer time |
| preference profile | **OFF** | every certified full-n arm ran profile-OFF; composed with the fold it measured **−0.036** (4W/9L) versus fold alone |
| coverage mode + chronicle (`CSM_COVERAGE`) | **ON** | deterministic cited timeline for summary/ordering/temporal queries; default since 2026-06-10 |
| embedding recall floor (`CSM_EMBED_FLOOR_K=10`) | **ON** | bridge path: a local-embedding top-K of raw turns is unioned into the return set when CSM's packet is starved. On every certified query |
| shard expansion (`CSM_SHARD_EXPAND_K=3` / `_MAX=16`) | **ON** | bridge path: neighbouring turns of a hit are pulled in. On every certified query |
| entity bridge (`CSM_ENTITY_BRIDGE_K=6` / `_MAX=24`) | **ON** | bridge path: same-shard turns sharing the query's entity terms are pulled in. On every certified query; its hand-rolled cut now goes through `select()` |
| lean return, needle net, session digests, ordered capsule, local probe gate, probe shrink, coverage reranker (`CSM_AMB_COVERAGE_RERANK` — the one that gained +11.6 proxy and lost answers), cross-encoder reranker (`CSM_HYBRID_RERANK` — a different, unrelated lever), virtual shards, legacy vocab/intent | **OFF** | each measured negative, non-replicating, or a wash |

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
| Router component bench (+0.24 **coverage** predicted) | **did not survive assembly** | wired into the real pipeline it delivered **−0.12 coverage**; retrieved evidence fell 55% because downstream stages are calibrated in shards, not events. Both figures are coverage, not answer score. Artifact: `EXP-virtual-shards-system.md` (the assembly), `EXP-router-component-bench.md` (the isolated bench). |
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
| **Official AMB runner** (Gemini) | upstream CLI, scoring, judge. CSM enters via `npm run amb:patch`: one provider file copied in, plus two upstream edits — registering the provider in `memory/__init__.py`, and a configurable HTTP timeout in `llm/gemini.py`. Neither touches scoring/judging/retrieval; "a 3-file provider and nothing else" was not accurate | the only publishable instrument; currently blocked |
| **Free head-to-head** (`scripts/headtohead-arms.ts`) | one reader + one judge serve both arms; only the retrieved context differs; Hindsight replayed from its own published contexts | calibrated ρ 0.864 / MAE 0.077 vs the **pre-#20** official judge (`gemini-2.5-flash-lite`, rubric-fraction + Kendall τ-b), on the 100K artifact; reproduced the official tie@100K and loss@1M. **Upstream has since replaced that judge with a nugget judge (post-PR-#20); the calibration has not been redone against it**, so "calibrated against the official judge" means the June judge, not today's. Certifies *within-instrument* paired deltas only. **Known defect (found 2026-09-05):** the reader's context is silently cut at 200,000 chars. Hindsight's contexts never reach it; CSM's did on **1 of 140** rows in the certified 500K pair (`28_information_extraction_1`, 371K→200K, 46% dropped) and **1 of 70** in the 1M paired fold arm (`34_knowledge_update_1`, 215K→200K). The cut is asymmetric *against* CSM, so the certified leads are if anything conservative — but it was silent, and is now counted and written into the output. |
| **Agent-SDK sidecar** | local iteration harness | iteration only — it carries ~8.5K tokens/call of harness overhead that is not CSM's, so its token totals are never publishable |

Numbers from different instruments are **never pooled**. Absolute levels differ
by reader (~0.04 between the two readers used here); only within-instrument
deltas are compared.

## Honest summary for anyone quoting this project

- CSM is an **R&D prototype**, not a product.
- It has **no leaderboard placement** and does not claim SOTA.
- Its **flat per-query retrieval cost** is measured and durable; its ingest cost is O(corpus) and disclosed.
- Its **certified accuracy claims** are two categories, on a free instrument,
  cross-reader replicated, with MDEs and exclusions attached.
- Its **failure record is public** and longer than its win record.
- The goal of "leading two categories at every corpus size" is **not met**.

## Audit 2026-09-05 — every layer, by hand

A 14-layer audit (core read path, write path and contracts, providers,
storage/utils/CLI, the CSM baseline runner, the eval harness, the AMB bridge,
the gate scripts, the verifier and charts, ops scripts and integrations, tests,
top-level docs, experiment docs, config and CI) produced **383 candidate
findings**. Agent-side verification was killed twice by usage limits, so every
finding acted on below was **verified by hand against the code or the artifact**
before it was touched. The full candidate list with per-item status is
[`experiments/AUDIT-2026-09-05.md`](experiments/AUDIT-2026-09-05.md) (report) and [`experiments/AUDIT-2026-09-05-CANDIDATES.md`](experiments/AUDIT-2026-09-05-CANDIDATES.md) (raw list); the twelve
fix units are the commits `e952618..HEAD` and are itemised in `CHANGELOG.md`.

### Invariant scorecard (CLAUDE.md's ten, after the fixes)

| # | invariant | before the audit | now | decided by |
|---|---|---|---|---|
| 1 | Query path never mutates durable memory | upheld, tested | **upheld, tested** | `tests/mutationSafety.test.ts` (SHA-256) |
| 2 | Durable writes only via `appendEventAndSnapshot` / `applyCommitDecision` | upheld; one undocumented exception (`csm init` writes the `init` chronicle record) | **upheld, exception documented** in ARCHITECTURE.md | `src/core/commit.ts`, `src/cli/index.ts` |
| 3 | Snapshots immutable, storage refuses overwrites | upheld, but a crash-orphan made every later append fail with a bare refusal | **upheld; orphan diagnosed with a recovery path** | `commit.ts` orphan check, `tests/commit.test.ts` |
| 4 | Ranking through `select()`; degeneracy reported | **violated** — 6 bare `.sort().slice()` cuts; report computed then discarded by `ask()`; no consumer of `hybridRouterStats()` | **upheld and surfaced**: all cuts through `select()`; `AskRunResult.selection`, `QueryRunRecord.routerDiscriminated/recallDiscriminated/degenerate[]`, bridge `raw_response.meta` | `tests/askPipeline.test.ts`, `tests/selection.test.ts` |
| 5 | Every `CSM_*` read through `env.ts`; unknown value throws | **violated** — 12 hand-parsed integer readers, 2 silent-default enums (`CSM_PROVIDER` → mock!), 5 tests pinning the silence | **upheld, tabled**: all through `envInt`/`envPositiveInt`/`envEnum` | `tests/envIntegerResolvers.test.ts`, `tests/env.test.ts` |
| 6 | No corpus vocabulary in the retrieval path | **violated** — the live recall prompt named a PaySwift entity; `HIGH_SIGNAL` is a hand-written vocabulary | **prompt fixed; `HIGH_SIGNAL` retained as a disclosed exception** (default-OFF measured lever) | `src/core/prompts.ts`, `digestSelection.ts` header |
| 7 | Recall cites shard, snapshot, event IDs correctly | **violated** — shard/snapshot copied from the model's echo; support ids taken on trust | **upheld**: ids from the call, fabricated support dropped, both recorded as conflicts | `tests/recallScope.test.ts` |
| 8 | Every LLM JSON output through a Zod schema + `providerJson` | upheld | **upheld** (no finding survived) | `src/core/schemas.ts`, `providerJson.ts` |
| 9 | Gold never reaches retrieval (leakage firewall) | upheld in code; the filler leakage scan was vacuous on a fresh checkout ("Clean" after reading 0 events) | **upheld; scan says SKIP when it scanned nothing** | `tests/beamLeakageFirewall.test.ts`, `verify-no-leakage.ts` |
| 10 | Write-time artifacts fold, never append | **overstated** — the bridge emits a standalone document when no capsule exists | **restated as the conditional it is**, and every row now says how the registry rode (`factFoldMode`) | `amb-csm-retrieve.ts`, README/site/llms |

### Published numbers the audit changed

- 10M span coverage: **63.5–88.8%** (was 64.3–89.7%; regex matched only dated turn markers).
- Head-to-head reader cap (200,000 chars) fired on 1/140 certified 500K rows and 1/70 in the 1M paired fold arm, never on Hindsight — asymmetric against CSM, now counted in the output.
- The hybrid-router evidence (+0.365) predates the render-gap fix and was never re-measured with the capsule rendered.
- Second-reader exclusions at 500K: 3 `knowledge_update` pairs (7 across the pair), not 7.
- Judge calibration (ρ 0.864) is against the **pre-#20** official judge, since replaced upstream.
- "3-file provider and nothing else": `amb:patch` also edits two upstream files.
- Internal token component is **not** pinned by `verify:published` (only `context_tokens` is).

### Run-integrity defects fixed

A dead warm server respawned empty and served the rest of the unit as wrong
rows; the 10M resume could never have fit its single-POST replay under the 256
MiB cap; an empty fact-registry build was cached forever as a silent OFF (four
such files existed); a failed fold build was indistinguishable from fold-OFF; the
watchdog relaunched a ladder that then blocked on a parameter prompt; a resumed
slice run overwrote its own manifest; the report certified at n=1.

### Still open

The candidate list holds items the audit did not act on — mostly low-severity
drift in experiment docs, dead exports, and test-coverage gaps — each marked
`unaddressed` in the record. Nothing in that set touches a published number.

