# EXP-T2 — Router v1: content-derived descriptors + local-embedding hybrid scoring

Status: **offline phase complete; live phase WRITTEN, NOT RUN** (per the T2
brief). Branch `rd/t2-router`. Owner: T2.

This doc is the durable record for: the design-question answers, the offline
calibration evidence, the probe-interplay memo, the merge-window integration
plan, and the live experiment protocol the orchestrator runs in the merge
window.

Hard rules inherited by every step below:

- **Embeddings are LOCAL ONLY** (`Xenova/all-MiniLM-L6-v2` via
  `@huggingface/transformers`, disk-cached under `data/eval/embeddings/`).
  **No Gemini/LLM calls at index time, ever.** The README "zero LLM-indexing
  cost" claim explicitly includes local MiniLM.
- The read path never mutates durable memory. The hybrid router's only side
  effect is the embedding disk cache (established precedent;
  `tests/mutationSafety.test.ts` hashes directory/shards/chronicle only and
  stays green).
- Benchmark gold (`queries.json` `relevantEventIds`, BEAM evidence) is
  eval-side only — it never reaches routing logic.

---

## 1. What shipped (offline, this branch)

| Piece | Path |
|---|---|
| Descriptor derivation (TF-IDF auto-terms, centroid helpers, directory field design) | `src/core/descriptors.ts` |
| Hybrid scorer (`RouterIndex`, `selectCandidatesHybrid`, weights, confidence) | `src/core/routerEmbed.ts` |
| Additive router exports (`scoreEntryLexical`, `termMatchesAnyTag`) — `selectCandidates` behavior untouched | `src/core/router.ts` |
| Additive embedder export (`makeCachedEmbedder`) | `src/eval/embed.ts` |
| Offline recall@K eval (compare/calibrate/calibrate-joint/fusion/beam-fixture/interplay) | `scripts/router-recall-eval.ts` |
| Unit tests (descriptors, hybrid ordering, BEAM fixture, fallbacks) | `tests/descriptors.test.ts`, `tests/routerEmbed.test.ts` |
| PaySwift recall@K gate test (real corpus + real MiniLM) | `tests/routerRecallPayswift.test.ts` |
| Worktree-only wiring demo (merge-window material, separate commit) | `src/eval/baselines/csm.ts`, `src/core/ask.ts` |

## 2. Design-question answers (T2 brief)

### Q1 — Descriptor derivation

**Decision: TF-IDF auto-terms (lexical leg) + per-shard MiniLM centroid
(embedding leg). Both. Tag-union stays as-is; medoid rejected for v1.**

- *Tag-union* is what exists today and is exactly what fails on AMB/BEAM
  (every shard gets the same 3–4 bridge tags) — necessary, not sufficient.
- *Top TF-IDF/log-odds terms* (`deriveShardDescriptors`): pure arithmetic,
  deterministic, interpretable (they land in `reasons` and the directory),
  zero runtime cost at query time, and corpus-relative — BEAM boilerplate
  ("user", "assistant", "turn") appears in every shard so idf ≈ 0 and it
  drops out with **no hardcoded domain tables** (the thing the evidence
  capsule got wrong). Smoothed form `(1 + ln tf) · ln((N+1)/(df+0.5))`, tags
  count ×3 tf, top-16, ties broken by term asc.
- *MiniLM centroid* (`centroidOf`: L2-normalized mean of per-event vectors):
  catches paraphrase/generic-vocabulary queries that share no surface tokens
  with any shard ("What database backs the core service?" — the q04-class
  embedding-floor origin story). Event vectors reuse the exact disk-cache
  keys `vanillaRag`/embed-floor already populate.
- *Medoid events* (embed the most-central event instead of the mean):
  rejected for v1 — a medoid represents ONE topic of a multi-topic shard and
  measured nothing better on PaySwift-shaped shards; multi-centroid (k-means,
  k≤3) is the wave-2 upgrade if BEAM units prove too multi-topic for a single
  mean. The mean is also the only form with an O(1)-ish incremental story.

**Where computed.** (a) Bridge/baseline adapters: at corpus build, one
O(events) pass (worktree wiring does exactly this). (b) Durable stores: at
**commit time** via the Committer's directory update — the spec §16
"directory drift" mitigation — never on the read path. A
`csm shard descriptors refresh` admin command (design-only here) recomputes
terms + centroid from the latest snapshot and bumps `descriptorVersion`.

**Storage shape.** Additive OPTIONAL fields on `MemoryDirectoryEntry`
(design in `DirectoryDescriptorFields`, `src/core/descriptors.ts`):
`derivedTerms?: string[]`, `embedCentroidB64?: string` (384-d Float32 LE,
~2 KB/shard), `embedModel?: string`, `descriptorVersion?: number`. The
directory remains the only memory object the router reads;
`routerIndexFromDirectory` hydrates the index by pure decode with zero
embedding calls. Directory JSON is `JSON.parse`-cast (no Zod), so the fields
are backward/forward compatible; the types.ts graft is a merge-window edit
(types.ts is T1-owned territory this wave).

### Q2 — Fusion

**Decision: weighted sum with a saturating lexical leg.**

```
lexTotal = phase0LexicalScore + derivedTermOverlap * termWeight
hybrid   = wLex * lexTotal/(|lexTotal| + lexSat) + wEmb * max(0, cos(q, centroid))
```

Measured against the alternatives on PaySwift (28 gold-bearing queries,
primary-gold metrics, full ranking over all shards; see §3 for the
calibration):

| strategy | P@3 @100K | P@3 @1M |
|---|---|---|
| old lexical | 0.714 | 0.643 |
| **weighted-sum (calibrated)** | **0.857** | **0.857** |
| RRF k=60 (lex>0 guard) | 0.821 | 0.643 |
| lexical + embed tiebreak | 0.786 | 0.714 |
| embedding only | 0.679 | 0.786 |

- **RRF** needed a guard to exclude all-zero lexical rankings (otherwise it
  re-imports the Discovery-A alphabetical noise as "rank information"), and
  still collapses at 1M: rank-based fusion is scale-free but
  *magnitude-blind* — at high filler density many filler shards get small
  positive lexical scores and their lexical RANKS pollute the fusion even
  though their lexical MAGNITUDE is negligible.
- **Lexical-with-embedding-tiebreak** can't fix the starved class by
  construction (a wrong shard with lex 4.0 still beats the gold shard with
  lex 2.0 regardless of embeddings — exactly q17).
- Each single signal is strictly dominated; the fusion is genuinely
  complementary (lex-only 0.714/0.643, emb-only 0.679/0.786, fused
  0.857/0.857).

The saturation makes the weighted sum robust without per-query
normalization (per-query min-max would make a shard's score depend on which
other shards exist — non-deterministic across corpus composition).
Health/recency penalties stay inside the Phase-0 leg unchanged.

### Q3 — The `score > 0 || active` passthrough

**Keep the passthrough; fix the ORDER; ship probe-shrink as telemetry only.**

The filter is a recall safety net and is preserved verbatim in
`selectCandidatesHybrid` (pinned by test). What Discovery A showed is that
the passthrough's *ordering* was the failure (alphabetical under all-zero
scores), not the passthrough itself. With the embedding leg, scores are
near-continuous (cos > 0 essentially always), so the all-zero degenerate
case disappears and the top-8 cut is informed.

**Probe-shrink (cost win).** `routeConfidence()` emits
`recommendedProbeCount` = number of candidates within `keepWithin=0.35` of
top-1 (floor 4). v1 keeps `ask()` probing up to `maxProbeShards` — the
shrink lever flips only after the live gate (§6 step 4) because probe
false-negatives interact with the recall-selection net (T7 territory).
Expected savings from telemetry if the gate passes:

- BEAM 100K: 7.25 probes/query avg (sum 2,900 over 400 queries; max 8 = the
  cap). PaySwift runs: 8.00 avg (cap always hit).
- Offline, the calibrated router puts the primary gold shard in the top-4 on
  93% of PaySwift queries (P@8 0.964, and rank>4 is rare). Probing top-4 on
  high-confidence routes (margin-gated, conservatively ~60% of queries) cuts
  probe calls by ~7.25→~5.3/query ≈ **27% of probe calls ≈ 13–18% of
  pipeline input tokens** (probes ≈ 5K of 13.9K input/query on BEAM). At
  100% gating the ceiling is 7.25→4 ≈ 45% of probe calls.

### Q4 — Async boundary

**Decision: pre-computed `RouterIndex` passed by callers + async
`selectCandidatesHybrid`; `selectCandidates` stays sync and untouched.**

- Index construction (the expensive, embed-everything part) happens once per
  corpus/directory version at adapter-build/commit time — NOT per query.
- `selectCandidatesHybrid` is async only for the single query-embed call
  (~5 ms local, disk-cached). It takes `index?: RouterIndex | null` and
  falls back to `selectCandidates` byte-identically when absent — so the
  swap is risk-free for callers without descriptors.
- `EmbedFn` is declared in core and implemented in `src/eval/embed.ts`
  (`makeCachedEmbedder`) — dependency inversion keeps core free of eval
  imports; callers inject.

The exact merge-window `ask.ts` edit (≤5 lines + 1 optional field) is in §5.

### Q5 — Probe interplay

See the memo in §4. Headline: with gemini-3.5-flash probing, the probe gate
is nearly loss-free ONCE THE ROUTER SURFACES THE SHARD (gold-candidate-but-
not-recalled: 0–1/28 per run); the false-negative bottleneck is the router
itself (gold missing from all 8 candidates on 7–8/28 queries). **Extending
the router-trust net to top-2 is NOT recommended** — measured rescue
population ≤1/28 at +1 recall/query cost (~+12% recalls); the same query is
already rescued at answer level by the augmentation stack.

### Q6 — Scale

- **Index memory:** 384 × 4 B ≈ 1.5 KB/shard + ≤16 terms. 1,000 shards ≈
  1.6 MB; 10,000 shards ≈ 16 MB. Flat in-memory maps fine through T8's
  500K/1M targets; no vector store needed (standing rule).
- **First-pass embed cost** (the real cliff): centroid-from-events embeds
  every event once. Measured on this machine (CPU): PaySwift 100K sample =
  247 events ≈ 5.1 s cold; 1M sample = 2,467 events ≈ 42 s cold; **0.1–0.7 s
  warm (disk cache)**. Extrapolated 10M ≈ ~25K events ≈ ~7 min cold, once
  ever per corpus. Two mitigations, both implemented: (a) cache keys are
  shared with `vanillaRag`/embed-floor so any prior baseline run already
  paid most of it; (b) `descriptorText` + `buildRouterIndex.embedText` is
  the O(shards) path — one embed per shard (name + derived terms + first
  heads), turning 10M-token first-pass into ~thousands of embeds (~1–2 min)
  at a small recall cost (un-benchmarked; wave-2 measurement).
- **Query-time:** one query embed (~5 ms) + O(shards × 384) dot products
  (≈0.4 ms per 1,000 shards). Negligible against a 7-probe LLM pipeline.
- **Incremental update on commit:** embed ONLY the new event (1 local call),
  re-mean n cached vectors (µs), re-run TF-IDF on the shard's term counts
  (df table kept directory-wide or recomputed lazily), bump
  `descriptorVersion`. No O(1) running-sum state needed at MVP scale.
- **BEAM 500K/1M:** units × ~5–8 session-shards stay small per-unit; the
  census T3 delivers feeds the exact numbers.

## 3. Calibration (how the default weights were derived)

Script: `scripts/router-recall-eval.ts --mode calibrate-joint
--corpus-tokens 100K,1M`. Grid: wLex ∈ {0.5,1,1.5,2} × wEmb ∈
{0.5,1,1.5,2,3} × lexSat ∈ {2,4,8} × termWeight ∈ {0.5,1,1.5} = 180 configs,
evaluated on pre-computed per-(query, shard) signals (identical formula to
`selectCandidatesHybrid`), 28 gold-bearing PaySwift queries, seed-42 samples.

Objective (in order): **worst-case primary-recall@3 across the two corpus
sizes** (guards against overfitting one filler density), then avg P@3, avg
P@1, avg MRR.

| rank | wLex | wEmb | lexSat | termW | minP@3 | avgP@1 | avgP@3 | avgP@8 | avgMRR |
|---|---|---|---|---|---|---|---|---|---|
| **1** | **0.5** | **2** | **2** | **1.5** | **0.857** | 0.554 | 0.857 | 0.964 | 0.721 |
| 2 | 0.5 | 2 | 2 | 0.5 | 0.821 | 0.554 | 0.857 | 0.964 | 0.717 |
| 3 | 1 | 3 | 2 | 1.5 | 0.821 | 0.554 | 0.839 | 0.964 | 0.719 |

The winner is the unique config holding P@3 = 0.857 at BOTH scales; the
(wLex=0.5, wEmb=2, lexSat=2) cell is a flat region (neighbours differ in MRR
digits only), so the default is a region centre, not a knife-edge. Single-
scale sweeps agree on the wEmb:wLex ≈ 4:1 effective ratio. Baked into
`DEFAULT_HYBRID_WEIGHTS` (`src/core/routerEmbed.ts`).

Headline A/B with those defaults (calibration-set caveat: same 28 queries —
the live protocol provides the held-out confirmation):

| metric | 100K old | 100K hybrid | 1M old | 1M hybrid |
|---|---|---|---|---|
| primary recall@1 | 0.429 | 0.536 | 0.429 | 0.571 |
| primary recall@3 | 0.714 | **0.857** | 0.643 | **0.857** |
| primary recall@8 | 0.750 | **0.964** | 0.714 | **0.964** |
| any-gold recall@8 | 0.893 | 1.000 | 0.893 | 0.964 |
| MRR (primary) | 0.587 | 0.711 | 0.556 | 0.731 |
| gold coverage@8 | 0.596 | 0.823 | 0.554 | 0.780 |

Spec §22 bar ("correct shard in top 3 ≥ 85%"): **met at both scales**
(pinned by `tests/routerRecallPayswift.test.ts`). Starved-class fixes:
q17 11→1, q16 37→2, q24 19→1, q03 32→6, q12 9→2, q09 9→2. Regressions: all
stay within the probe set (q04 1→2, q05 2→3, q10 1→2, q26 2→4). Inspected
at 100K: on q26 the displacers are co-gold shards (s-product/s-incidents/
s-customers); on q04/q05/q10 the displacer is a same-DOMAIN filler shard
with high embedding similarity (e.g. f1-klipboard-compliance above
s-architecture on q04, f1-mealhaul-compliance above s-compliance on q10).
Consequence: the router-trust net's FORCED top-1 recall moves from the gold
shard to a filler shard on those queries, and the gold shard at rank 2–3
must now pass its own probe. Measured probe-accept on gold candidates is
~98% (§4), so expected loss is ≤1 query — but this is exactly the
flip-detection population for live Step 1/Step 2, called out there.

BEAM-shaped fixture (12 thin-metadata shards, real MiniLM, real bridge-style
metadata): old router ranks gold 9/10/11/12 (all dropped by the alphabetical
top-8 cut — Discovery A reproduced); hybrid ranks gold **#1 on 4/4** queries
(gold-in-top-3: 0/4 → 4/4).

## 4. Probe-interplay memo (Q5, analysis only)

Source: `scripts/router-recall-eval.ts --mode interplay` over committed run
artifacts (gemini-3.5-flash pipeline; 28 gold-bearing queries each):

| run | gold in cands | gold top-1 | gold top-3 | gold recalled | cand-but-not-recalled | rank-2-not-recalled | acc \| recalled | acc \| not |
|---|---|---|---|---|---|---|---|---|
| 160k-30q @100K | 21/28 | 12 | 20 | 21/28 | 0 | 0 | 19/21 | 7/7 |
| 160k-30q @1M | 20/28 | 12 | 18 | 20/28 | 0 | 0 | 19/20 | 8/8 |
| 160k-30q @2M | 20/28 | 13 | 19 | 20/28 | 0 | 0 | 18/20 | 8/8 |
| v020 @100K | 21/28 | 12 | 20 | 20/28 | 1 | 1 | 20/20 | 8/8 |
| scaling-1m @1M | 20/28 | 12 | 18 | 19/28 | 1 | 1 | 18/19 | 8/9 |

Findings:

1. **Router-rank vs probe-verdict agreement is near-total.** Whenever the
   primary gold shard made the candidate list, the probe+trust-net recalled
   it in 101/103 cases (98%). The Gemini-3.5-flash probe is NOT the
   false-negative bottleneck the Gemma-era q11 story described — the
   bottleneck moved to the ROUTER (gold absent from all 8 candidates on
   7–8/28 queries; exactly the population the hybrid fixes: offline
   gold-in-candidates rises 0.71–0.75 → 0.96).
2. **Top-2 trust extension: rejected for v1.** Rescue population (gold at
   rank 2 AND not recalled) is 0–1/28 per run; cost is +1 recall on every
   query whose rank-2 probe was rejected (~+0.3–1.0 recalls/query ≈ +10–30%
   recall-stage tokens). The 0–1 affected queries were ALL answered
   correctly anyway via the augmentation stack ("acc | not recalled" column
   is 7/7–8/9). One hybrid-specific nuance cuts the other way: on
   q04/q05/q10 the hybrid top-1 is a same-domain filler shard with the gold
   at rank 2–3 (§3), so the forced-recall slot no longer covers gold there —
   but the measured ~98% probe-accept rate on gold candidates bounds the
   expected loss at ≤1 query. Verdict stands: NOT recommended now;
   re-evaluate from the live A/B's per-probe verdict logs if a rank-2
   false-negative actually materializes.
3. **Caveat:** run telemetry exposes the post-trust-net recall set, not raw
   per-shard probe verdicts, so "probe rejected" at rank 1 is not separable
   from "trust-net rescued" in these artifacts. The live protocol logs
   per-probe verdicts (`probes[].knows`) to close this.
4. PaySwift probe fan-out is pinned at the cap (8.00/query) — the shrink
   lever's headroom quantified in §2-Q3.

## 5. Merge-window integration plan (exact diffs, orchestrator-owned)

Two serially-gated changes, each gated on `npm test` + `npm run eval` +
PaySwift 30q live A/B + T3 recall@k:

**Change 1 — adapter descriptors (`src/eval/baselines/csm.ts`).** Lift the
worktree demo commit: `InMemoryStorageReader` derives descriptors + builds a
`RouterIndex` at adapter construction (O(events), cached per corpus) and
passes it to `ask()`. The RAG-floor confidence gate converts via
`hybridEquivalentOfLexScore(4)` ≈ 0.333 so its firing semantics are
preserved on the new scale. AMB bridge (`scripts/amb-csm-retrieve.ts`,
orchestrator-owned): same pattern at `buildCorpus` time; with
`descriptorText` mode if ingest-latency matters (one embed per shard).

**Change 2 — `src/core/ask.ts` (the ≤5-line edit + 1 optional field):**

```ts
// AskOptions (1 line):
  routerIndex?: RouterIndex | null;

// imports (1 line):
import { selectCandidatesHybrid } from "./routerEmbed.js";

// replace the selectCandidates call site (3 lines changed):
  const candidates: CandidateScore[] = opts.routerIndex
    ? await selectCandidatesHybrid({ query, directory, index: opts.routerIndex,
        maxCandidates: budget.maxCandidateShards })
    : selectCandidates({ query, directory, maxCandidates: budget.maxCandidateShards });
```

No `routerIndex` ⇒ byte-identical behavior (pinned by the fallback test).
Durable-store CLI path: `JsonlStorage` callers hydrate via
`routerIndexFromDirectory(directory, makeCachedEmbedder(), EMBED_MODEL_NAME)`
— returns null (⇒ old path) until a Committer-side refresh writes descriptor
fields. Committer refresh + `csm shard descriptors refresh` is wave-2.

**Deletable after both gates pass:** none of the augmentation stack is
deleted immediately — but the live A/B (§6 step 3) measures how often
`embedFloorFired`/`ragFallbackFired` drop, which is the data for shrinking
`CSM_EMBED_FLOOR_K`/floor thresholds in a follow-up gate (T1 owns the
capsule-deletion track).

## 6. LIVE EXPERIMENT PROTOCOL (write-only — DO NOT RUN in this branch)

**Budget.** gemini-3.5-flash, thinking=low. Measured PaySwift csm cost:
~14.3K input tok/query @100K, ~19.0K @1M (incl. final answer call). Full
protocol ≈ 30q × (100K + 1M) × 2 arms × 1 trial ≈ **~2.0M input + ~0.12M
output tokens** (≈ $0.75 at current flash pricing), plus 3-trial repeats on
flipped queries (≤ 3 × 6q × 2 ≈ 0.5M). Embedding index build is local-only
(≈ 45 s cold, ~0 warm) — **zero Gemini calls at index time** (verify:
provider telemetry must show no calls before the first probe).

**Step 0 — environment.**

```
CSM_PROVIDER=gemini  CSM_GEMINI_MODEL=gemini-3.5-flash  CSM_GEMINI_THINKING=low
CSM_EMBED_FLOOR_K=10 (default)   CSM_EAGER_RECALLS unset   seed 42
arms: old = HEAD~1 of the wiring commit (or CSM_ROUTER_HYBRID=0 if the flag
variant is merged); hybrid = wiring commit with DEFAULT_HYBRID_WEIGHTS
```

**Step 1 — PaySwift 30q A/B at 100K and 1M (1 trial).**

```
npm run csm -- bench run --systems csm --trials 1 --corpus-sizes 100K,1M \
  --model-contexts 8K            # once per arm
npm run bench:compare <old-run> <hybrid-run>
npx tsx scripts/router-recall-eval.ts --mode interplay   # post-run telemetry
```

Success criteria (ALL must hold):
- Accuracy: hybrid ≥ old on each (corpus, ctx) cell (old baseline: 28/30
  @100K [v020], 29/30 @1M [160k run]); any per-query flip old-correct →
  hybrid-wrong triggers Step 2.
- Retrieval: `candidateShardIds` contains the primary gold shard on ≥ 26/28
  (vs 20–21/28 today); q03/q04/q17 packedEventIds contain ≥ 1 gold event
  WITHOUT `embedFloorFired` (the starved class must be fixed by ROUTING, not
  the safety net); citation F1 non-degrading in aggregate.
- Cost: pipeline input tokens within +5% of old (the index is free at query
  time; only candidate ORDER changes — probe count identical at the cap).
- `embedFloorFired` rate strictly decreases (today it fires on the starved
  class by construction).

**Step 2 — 3-trial confirmation on flips.** Any query that flips in either
direction: re-run that cell 3× (`--trials 3`, seeds 42/43/44); the flip
counts only if 2/3 trials agree (matches `bench:confirm` convention; paired
McNemar from `scorer.ts` on the full set).

**Step 3 — BEAM-slice retrieval recall@k on ALL categories (T3 harness).**

```
npx tsx scripts/<t3-harness> --categories all --k 10,24,32 \
  --systems csm-old,csm-hybrid --split 100k    # retrieval-only, no judge
```

- Primary: recall@k on summarization + event_ordering (the losing
  categories) must not decrease; target +0.05 absolute on gold-evidence
  coverage at k=24 (the avg retrieved-event count is 24.9).
- **No-regression bar on the 7 winning categories** (abstention 1.000,
  contradiction_resolution 0.650, information_extraction 0.757,
  knowledge_update 0.669, multi_session_reasoning 0.548,
  preference_following 0.975, temporal_reasoning 0.638): retrieval
  recall@24 within −0.02 of old per category; any larger drop blocks the
  merge regardless of the average.
- Retrieval-only cost ≈ 80 queries × ~14K ≈ 1.1M input tokens for the two
  losing categories; ~5.5M for all 400 (reuse T3's payload JSONL replay so
  the old arm is free if T3's baseline run exists).
- BEAM index build: ingest-once per unit via the warm server; embed cost is
  per-unit local CPU (~seconds); confirm `csm_probe_count` avg drops below
  7.25 only if the shrink lever is enabled (it is NOT in this gate).

**Step 4 (separate, optional after 1–3 pass) — probe-shrink gate.** Enable
`recommendedProbeCount` (env `CSM_ROUTER_SHRINK=1` to be added then):
PaySwift 30q + BEAM-slice, success = accuracy/recall@k flat while probe
calls/query and pipeline input tokens drop ≥ 20%. This gate is OWNED by the
merge window, not v1.

**Abort conditions.** Any Gemini call before the first probe (= index-time
LLM usage, forbidden); mutationSafety failure; >5% pipeline-input-token
regression; any 7-winning-category drop > 0.02.

## 7. Corrections to the portfolio doc

- `RD_PORTFOLIO_2026_06.md` Discovery A says the BEAM 100K telemetry shows
  "probe count avg 7.25, max 8 = the cap". Confirmed in the artifact
  (min 5, max 8, sum 2,900/400) — but note the PaySwift runs sit at a hard
  8.00 avg, so the "max 8 = cap" framing understates how saturated routing
  is on PaySwift.
- The brief's q04 example ("q04-class — the documented embedding-floor
  origin story"): at 100K/1M seed-42 samples the OLD router actually ranks
  q04's primary gold (s-architecture) #1 lexically; q04's failure was
  recall/packing-stage starvation, not candidate-list exclusion. The
  candidate-list exclusion failures in that class are q03 (rank 32), q16
  (37), q17 (11), q24 (19), q30 (35) — the hybrid fixes those; q04's packing
  failure is T1 coverage territory.
- Discovery A's "alphabetical top-8" mechanism is reproduced exactly by the
  BEAM-shaped fixture (old gold ranks 9–12 dropped; see §3).

---

## 7b. Live gate results (orchestrator, 2026-06-10)

*(Renumbered from a duplicate "## 7" so in-doc §7 references are unambiguous.)*

**PaySwift 30q A/B** (rd-t2hybrid-30q-v1 vs rd-probelite-30q-v1, flash-lite
probes both arms): 29/30 both (same q04 miss), latency -5%, pipeline input
tokens +6.4% (outside the +5% bar). The augmentation stack masks router
differences here: embedding floor fired on 28/30 queries in BOTH arms.

**BEAM-slice 100k A/B** (beam-slice-100k-live-hybridoff-v1 vs
beam-slice-100k-live-hybridon-v1; 80 summarization+event_ordering queries,
live gemini-3.5-flash): no movement outside overlapping CIs
(event_ordering cov@32 0.615->0.570, packed 0.565->0.554; summarization
cov@24 0.561->0.600, packed 0.415->0.431; retrieved ~unchanged; tokens and
latency ~identical). Structural cause: 100k units average ~9 sessions, so
the alphabetical top-8 already probes nearly the whole unit — Discovery A's
cliff is a 500k/1m phenomenon (27/52 sessions per unit, per the T3 census).

**Verdict (2026-06-10): CSM_ROUTER_HYBRID stays default-off.** *(Superseded 2026-08-01: the 500K/1M re-gate this verdict asked for happened at 1M and the router is default ON — `EXP-router-1m-hybrid.md`, STATUS.md. Note the +0.365 there carries a render-gap caveat.)* The mechanism is proven
(offline recall@3 0.714->0.857/0.857, BEAM fixture gold top-3 0/4->4/4) and
shelved for the scale phase: re-gate on a 500k BEAM-slice before the 500k/1m
official runs, where informed top-8 vs alphabetical-8 is load-bearing.
