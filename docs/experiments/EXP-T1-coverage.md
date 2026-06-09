# EXP-T1 — First-class coverage & chronicle recall in CSM core

Status: prototype complete on branch `rd/t1-coverage` (offline-validated);
live experiment WRITTEN, NOT RUN. Brief: `docs/RD_PORTFOLIO_2026_06.md`
("Brief T1"). Grounding HEAD at dispatch: `67fb858` (branch cut from
`0b11754`).

Mission recap: CSM loses to Hindsight on exactly two BEAM categories —
summarization (0.7086 vs 0.7929) and event_ordering (0.7375 vs 0.8047) — and
the current mitigation is a 1,224-line external regex heuristic ("evidence
capsule") in `scripts/amb-csm-retrieve.ts`, overfit to BEAM content domains.
Locally the same failure is multi-event coverage collapse: PaySwift q04
packed 0/6 gold events, q27 packed 2/13. This experiment makes broad
chronological/coverage evidence with event-ID citations a first-class core
capability so the external capsule can eventually be deleted.

---

## 1. Design analysis (the five questions)

### Q1 — Query-intent classification: deterministic lexical, in core

**Decision: deterministic lexical classifier in `src/core/coverage.ts`
(`classifyQueryIntent`), a generalized port of `detectAmbQueryIntent` with no
domain tables. The probe-stage side-output is rejected for wave 1; the seam
for it is documented below.**

Why lexical-in-core and not a probe side-output:

- **Granularity.** Intent is a per-QUERY property; probes are per-shard.
  A probe side-output yields 8 independent opinions per query that need an
  aggregation rule, and the answer ("is this a summary question?") does not
  depend on shard content at all.
- **Gate surface.** Adding a field to the probe JSON changes every probe
  prompt and schema → full accuracy gates on all categories before anything
  else can ship. The lexical classifier changes no LLM input by itself; only
  its downstream consumers do, and only behind `CSM_COVERAGE`.
- **Cost and determinism.** Zero tokens, zero latency, deterministic and
  unit-testable with exact assertions (29 fixtures in
  `tests/coverageIntent.test.ts`).
- **Single source of truth.** It lives in core so `ask()` and the AMB bridge
  import the SAME classifier post-merge and can never disagree about what
  "coverage-shaped" means. The bridge keeps only a thin protocol layer for
  its two benchmark-strategy facets (`abstentionRisk`, `userCentric`), which
  are BEAM-scoring decisions, not memory-system decisions.

Output shape (additive in `types.ts`): `QueryIntent { kind: "point" |
"coverage", facets: { summary, ordering, temporalArithmetic, aggregation },
cues: string[] }` — `cues` mirrors `CandidateScore.reasons` for CLI/debug
explanations.

Conservative-classifier principle (load-bearing): a false negative degrades
to today's behaviour; a false positive changes LLM inputs. Hence precision
wins, with two documented divergences from the bridge:

- Bare **"why did …"** stays point (it overlaps the bridge's abstention-risk
  class; PaySwift q19 deliberately classifies point and is covered by the
  starvation net instead).
- Bare **"different"** is not an aggregation cue (the bridge's `countLike`
  matches it; "why did we choose a different database" is a point lookup).

Probe-side seam (wave 2, gated): if the lexical classifier's recall proves
limiting on BEAM phrasing variety, add an optional `query_shape` enum to the
probe schema, majority-vote it across probes, and OR it with the lexical
result. This is an LLM-input change → full gate chain; not prototyped.

### Q2 — Coverage recall mechanism: (b) deterministic chronicle assembler

**Decision: option (b) — a deterministic chronicle assembler in core
(`assembleChronicle`), with the LLM coverage-recall prompt variant (option
(a)) written as a design-only artifact (prompt + schema shipped, unwired)
and option (c) available later by feeding the assembler's output through the
existing synth stage.**

Justification:

- **The deterministic approach is the one with evidence.** The BEAM 100K
  score survived the router's alphabetical-8 failure precisely because the
  external capsule's deterministic heuristics scan all shards
  (`selectChronologicalCoverageIds` with `includeAllShards=true`). The LLM
  recall was present in both winning and losing categories; the capsule is
  what moved summarization/ordering.
- **Latency/cost.** CSM is already 4.58× slower than Hindsight on retrieval.
  Option (a) adds a per-shard LLM call (or replaces one) on coverage
  queries; option (b) is pure CPU (sub-millisecond on 8 shards × ~200
  events) and zero tokens.
- **Testability.** The brief's offline bar (≥5/6 and ≥10/13 gold surfaced)
  can only be GUARANTEED by a deterministic mechanism; an LLM variant can at
  best be sampled.
- **Blast radius.** The standard recall prompt stays byte-identical, so the
  seven winning BEAM categories cannot regress through prompt drift. The
  assembler's output is additive evidence (a new optional packet field).

Mechanism (as built, `src/core/coverage.ts`):

1. **Term derivation — query + foothold, never domain tables.** Query terms
   via `extractCoverageTerms` (generic stopwords + INTENT-SHAPE words
   excluded — the classifier's own cue vocabulary like
   "hindsight/considered/mistake" is query SHAPE, not topic, and measurably
   hijacks retrieval toward retro/postmortem meta-content if kept). Query
   proper nouns (capitalized mid-sentence / ALL-CAPS: "Bun", "RDS", "March",
   "Mary") become **anchors** with a 2× scoring boost — pure statistics
   cannot tell topic nouns from modifiers ("early" is rarer than "bun" on
   the PaySwift core slice).
2. **Expansion** — per-seed TF-IDF over scoped events (tf in the seed's
   text × idf over the scope, boilerplate cut at df > max(3, 25% of scope)),
   validated by association support (a term below the seed's top-3 survives
   only if it co-occurs with a query/top-3 anchor in another event, or is a
   proper noun in the seed), pruned for coherence (with footholds: query
   seeds that share no vocabulary with the probe-verified foothold are
   competing interpretations the probe already rejected; without footholds:
   majority-quorum outlier drop), then combined by weighted round-robin
   (footholds get 2 slots/round, self-discovered seeds 1). A bounded
   second hop (foothold mode only) mines the top-3 first-hop hits for ≤6
   more terms — the entity-bridge pattern; measured on q27 that a second
   hop WITHOUT footholds drifts (11→9 gold), so it is gated on footholds.
3. **Selection** — Phase 0: footholds always included (probe-verified).
   Phase A: per-shard chronological 12-bucket × top-2 term-anchored picks
   (timeline spread; port of `selectChronologicalCoverageIds`). Phase B:
   global top scorers always join the pool (buckets alone clip tight gold
   clusters — q04's e0011–e0014 are minutes apart). Phase C: breadth spread
   for summary/aggregation/starvation (port of `spreadAcrossTimeline`).
   Final: score-ranked cap, GLOBAL chronological sort (parsed dates;
   undated last; natural-order ID tiebreaks so BEAM's `#turn-10` sorts
   after `#turn-2`), soft token cap dropping lowest-score entries.
4. **Scoring** — IDF-weighted whole-token overlap on content+tags (tags are
   the signal the router/probe already trust), anchor boost, +1.0 locality
   bonus for events in a probe-verified foothold shard (the same trust the
   baseline's shard-local expansion stack encodes).

Scope rule: the assembler consumes whatever snapshots the CALLER provides.
`ask()` passes the probed candidates' snapshots (zero additional storage
loads — they are already in memory for probing); the bridge/baseline may
pass all shards to reproduce the capsule's `includeAllShards` behaviour
until T2's router upgrade lands. This keeps scale policy out of core.

Option (a), as designed (not wired): `coverageRecallPrompt` in
`src/core/prompts.ts` + `coverageRecallResultSchema` in
`src/core/schemas.ts` (schemaName `"CoverageRecallResult"`). It asks the
shard for the normal claims PLUS a `timeline` array (one entry per relevant
event, dates COPIED from the digest lines, never computed). Wave-2 gating:
PaySwift 30q A/B + T3 recall@k, vs the deterministic assembler as control.
Merge-window note: `CSM_JSON_SCHEMAS` in `GeminiProvider.ts` (T4's file)
gets the `"CoverageRecallResult"` entry then; absence degrades gracefully.

### Q3 — Budget reallocation: intent-conditional, with token math

**Decision: leave point queries at `maxRecallTokensPerShard = 1200`
(byte-identical); coverage-shaped queries get 3,200
(`CSM_COVERAGE_RECALL_TOKENS`), resolved per query in `ask()`.**

Why 1200 starves coverage: a recall digest line is
`- [id] (role date) <content ≤480 chars> tags=[…]` ≈ 125–150 tokens. At
1,200 tokens ≈ 8–10 events/shard reach the recall LLM. q27 needs 13 gold
events (≤6 in the worst single shard); a 1,200 digest plus probe-hint
priority ordering routinely truncates the trailing gold.

Token math against the 8,192 internal-model cap (`CSM_AMB_MODEL_CONTEXT`):

| Recall-call component | Point | Coverage |
|---|---:|---:|
| `SHARD_SYSTEM_PROMPT` | ~140 | ~140 |
| Shard header + summary | ~80 | ~80 |
| Event digest | ≤1,200 | ≤3,200 |
| `recallPrompt` + question | ~450 | ~450 |
| **Total input** | **~1,870** | **~3,870** |

Headroom at coverage: 8,192 − 3,870 ≈ 4.3K. Output stays 4,096. Synth worst
case (4 recalls × ~900 output tokens of claims JSON + ~500 prompt ≈ 4.1K)
also fits. 3,200 tokens ≈ 21–26 events/shard — covers the q27 class with
slack.

Pipeline-cost impact (BEAM telemetry: 13,885 input tokens/query avg, ~3.55
recalls/query): coverage queries pay +2,000 × 3.55 ≈ **+7.1K input tokens
(+51%) on affected queries**. Summarization + event_ordering ≈ 80/400 BEAM
rows (20%) plus a starvation-net tail (est. 5–10%) → **≈ +10–15% pipeline
input averaged over a BEAM run**, ~0 on PaySwift point lookups. Why not
raise the default for everyone: (i) the gate surface would be every
category instead of two; (ii) point-lookup failures are recall conservatism,
not budget, so the spend buys nothing there; (iii) +51% × 100% of queries
vs +51% × ~25%.

Timeline budgets (packet side): `resolveCoverageMaxEntries` → 24 entries for
summary/aggregation (mirrors `CSM_AMB_SUMMARY_RETURN_K=24` / capsule summary
snippets), 32 for ordering/temporal and starvation recovery (mirrors
`CSM_AMB_REASONING_RETURN_K=32`); soft token cap 1,400 (≈24 lines × ~45
tokens + refs/dates) via lowest-score-first trimming. The timeline is packet
content consumed by the answer model, not re-fed to recall, so it does not
interact with the 8,192 cap; in the 8K MCQ context it costs ≤1.4K of the
~7.7K context budget.

### Q4 — Packet shape: additive optional `timeline`, deterministic date math

**Decision: add `timeline?: MemoryPacketTimelineEntry[]` to `MemoryPacket`
(additive `types.ts` + `schemas.ts`), with
`MemoryPacketTimelineEntry = { date: string | null; eventRef: string;
line: string }` and `eventRef` always `"shard_id@snapshot_id:event_id"`.**

Why `keyClaims` + ordered `recommendedMainContext` cannot carry it:

- `keyClaims` is LLM-authored and the synthesizer's contract is to MERGE
  duplicates and rank by confidence — a timeline needs guaranteed
  chronological order, one entry per event, and deterministic provenance;
  all three contradict the claims contract (and the mock synthesizer
  actively dedupes by claim-text containment).
- `recommendedMainContext` is one free-text paragraph with no citation
  discipline.
- An optional field is additive: every existing consumer, cached response,
  and serialized packet parses unchanged (`memoryPacketSchema.timeline` is
  optional and per-item-tolerant like the claims arrays).

Citation discipline: `eventRef` uses the exact `sources` convention from
`MemoryPacketClaim`, so consumers parse ONE format (`parseEventRef` in
core; first-colon-after-@ so event IDs containing colons survive).

Temporal arithmetic stays deterministic — `computeTemporalRelation` ports
`parseDatePhrase` + anchor pairing (content date phrases, falling back to
`createdAt`; segment-matched pairs for "between X and Y" queries) and emits
a `MemoryPacketClaim` (`temporalRelationToClaim`, confidence 0.95 — the
arithmetic is exact; date EXTRACTION from prose can mis-anchor) with both
anchor refs as sources. Packaging it as a claim means the baseline's
existing `collectCitedEventIds` automatically pulls both anchor events into
the retrieval order — no new consumer code. The LLM is never asked to do
date math unaided; the timeline shows it per-event dates and the claim shows
it the computed difference.

### Q5 — Migration path for `scripts/amb-csm-retrieve.ts`

Order of operations (each step gated; see §4 for gates):

1. **Merge window step 1 (core):** land `coverage.ts` + the `ask()` wiring
   (this branch's two commits). Bridge untouched; capsule still active.
   `CSM_COVERAGE` stays default-off until the PaySwift 30q gate passes.
2. **Merge window step 2 (bridge consumes core):** `executeAmbRetrieve`
   passes `CSM_COVERAGE=1`-mode results through: `selectAmbEvidenceIds`'s
   coverage expansion collapses to "append `collectTimelineEventIds(packet)`
   to baseIds"; `buildEvidenceCapsule` becomes a ~25-line renderer of
   `packet.timeline` (+ the temporal claim) into the capsule document
   format AMB expects. Gate: T3 BEAM-slice recall@k on summarization +
   event_ordering, old capsule vs core coverage, no-regression on the
   other categories' retrieval.
3. **Step 3 (delete):** remove the replaced selection/term machinery and the
   domain tables (list below).
4. **Step 4 (post-BEAM-rerun):** once a paired BEAM 100K run confirms ≥
   parity, optionally drop the capsule pseudo-document entirely in favour of
   returning timeline-cited events directly (AMB-protocol decision; keep the
   capsule format if the answer model benefits from the digest).

**Stays bridge-side permanently (AMB doc-shaping & protocol only):**
`AmbDocument`/`AmbRetrieveRequest` types, `main`/`parseArgs`/IO,
`scopeDocuments`, `buildCorpus`, `documentToEvents`, `splitTurns`,
`extractTimestamp`, `executeAmbRetrieve` payload shaping,
`resolveAmbReturnMax` (AMB k protocol), `expandChronologicalNeighbors` +
`resolveAmbNeighborWindow` + `sortedShardEvents` + `turnNumber` (turn-window
smoothing of returned ids), `preferUserTurns` + `eventRole` + `turnLabel`
(BEAM turn grammar), `createBridgeProvider` (mock guard), an ~8-line
protocol-facet shim (`abstentionRisk`, `userCentric`) and the thin capsule
renderer.

**Deletable post-merge (line numbers at `0b11754`; ≈640 of 1,224 lines):**

| Lines | Symbol | Replaced by (core) |
|---|---|---|
| 48–53 | `TemporalDateAnchor` | internal `DateAnchor` |
| 327–349 | `detectAmbQueryIntent` body | `classifyQueryIntent` (+protocol shim) |
| 361–374 | coverage blocks in `selectAmbEvidenceIds` | timeline consumption (edit, not deletion) |
| 426–468 | `selectChronologicalCoverageIds` | `assembleChronicle` phases A/C |
| 481–558 | `buildEvidenceCapsule` body | `packet.timeline` + thin renderer |
| 560–587 | `selectCapsuleCoverageEvents` | `assembleChronicle` |
| 589–602 | `selectTopCoverageIds` | `assembleChronicle` phase B |
| 604–612 | `capsuleSnippetLimit` | `resolveCoverageMaxEntries` |
| 614–642 | `spreadAcrossTimeline` | `assembleChronicle` phase C |
| 644–673 | `selectBroadSummaryEvidence` | phases B+C |
| 675–684 | `dedupeBenchEvents` | (unused after above) |
| 686–707 | `prioritizeTemporalEvidence` | scoring + temporal anchors |
| 709–736 | `buildTemporalRelationLine` | `computeTemporalRelation` |
| 738–765 | `collectTemporalDateAnchors` | `computeTemporalRelation` |
| 767–778 | `selectSegmentMatchedTemporalPair` | core equivalent |
| 780–796 | `bestAnchorForTerms` | core equivalent |
| 798–809 | `selectTopTemporalPair` | core equivalent |
| 811–823 | `extractBetweenSegmentTerms` | core equivalent |
| 825–850 | `parseDatePhrase` | core `parseDatePhrase` |
| 852–877 | `dateCenteredExcerpt` | `termCenteredExcerpt` |
| 879–888 | `formatEvidenceSnippet` | timeline `line` rendering |
| 890–916 | `relevantExcerpt` | `termCenteredExcerpt` |
| 918–925 | `matchedHighSignalTerms` | (dropped with HIGH_SIGNAL_TERMS) |
| 927–937 | `highSignalWeight` | IDF weighting |
| 939–952 | `extractContentTerms` | `extractCoverageTerms` |
| 954–1008 | `expandCoverageTerms` — **the domain tables** | query+foothold TF-IDF expansion |
| 1010–1020 | `coverageScore` | IDF-weighted scoring |
| 1049–1060 | `extractDatePhrases` | core `extractDatePhrases` |
| 1077–1115 | `AMB_STOP_WORDS` | `COVERAGE_STOP_WORDS` |
| 1117–1132 | `HIGH_SIGNAL_TERMS` — **domain table** | (gone) |
| 1134–1147 | `MONTH_INDEX` | core `MONTH_INDEX` |

---

## 2. What was built (this branch)

| Commit | Content |
|---|---|
| `0821754` (mainline-intended) | `src/core/coverage.ts` (classifier, assembler, temporal arithmetic, budgets, packet helpers); additive `types.ts` (`MemoryPacketTimelineEntry`, `MemoryPacket.timeline?`, `QueryIntent`); additive `schemas.ts` (`memoryPacketSchema.timeline` optional, `coverageRecallResultSchema`); additive `prompts.ts` (`coverageRecallPrompt`, design-only); tests `coverageIntent` / `coverageAssembler` / `coveragePayswift` |
| `f239bef` (MERGE-WINDOW demo) | `ask.ts` wiring (intent + budget swap + one `attachCoverage` call); `coverage.ts` `attachCoverage` helper; `src/eval/baselines/csm.ts` (timeline tier in retrieval order, TIMELINE context-header block, meta fields); tests `coverageAskWiring` / `coverageReadOnly` |

Flag surface (all default-off / no-op): `CSM_COVERAGE`,
`CSM_COVERAGE_RECALL_TOKENS`, `CSM_COVERAGE_MAX_ENTRIES`,
`CSM_COVERAGE_STARVATION_FLOOR`.

## 3. Offline validation results (run on this branch)

- `npm test`: **259/259** (224 at branch point + 29 core coverage + 6
  wiring/mutation tests), including `mutationSafety.test.ts` and
  `prefixCacheContract.test.ts` untouched and green, plus a new
  `CSM_COVERAGE=1` hash-pattern mutation test.
- `npm run lint`: clean.
- `npm run eval`: router_recall@3 = 100%, packet_keyword_coverage = 100%.
- `npm run bench:smoke`: completes with the flag off AND on.
- Brief's fixture bar, on the REAL PaySwift core corpus
  (`tests/coveragePayswift.test.ts`): q27 assembler surfaces **12/13** gold
  across 3 shards (bar ≥10), date-ordered, fully cited; q04 surfaces
  **5/6** with one probe foothold (bar ≥5) and 4/6 with none.
- End-to-end through the bench harness (MockProvider, csm-only, q04+q27,
  100K/8K; runs `t1-coverage-off` / `t1-coverage-on`):

| Query | Metric | OFF | ON |
|---|---|---:|---:|
| q04 | gold in `csmRetrievedEventIds` | 2/6 | **5/6** |
| q04 | gold in `packedEventIds` | 1/6 | **4/6** |
| q27 | gold in `csmRetrievedEventIds` | 7/13 | **12/13** |
| q27 | gold in `packedEventIds` | 2/13 | **5/13** |

`packedEventIds` is bounded by the 8K answer context (~12–15 raw events);
the TIMELINE header additionally places all 24–32 cited, date-stamped lines
in the answer context, which raw-event packing does not capture. The live
experiment therefore measures both, plus answer accuracy.

## 4. Live experiment protocol (WRITE-ONLY — do not run without orchestrator sign-off)

No step below has been executed. Everything uses `gemini-3.5-flash`
(`CSM_GEMINI_MODEL` pinned), temperature 0, seed 42. The `.env` lives only
on the orchestrator machine.

### Arm 1 — PaySwift 30q A/B at 100K/8K, 1 trial

```bash
# Baseline (flag off — byte-identical to current mainline behaviour)
npx tsx src/cli/index.ts bench run \
  --systems csm --trials 1 --corpus-sizes 100K --model-contexts 8K \
  --model gemini-3.5-flash --run-id t1-live-baseline

# Coverage-enabled
CSM_COVERAGE=1 npx tsx src/cli/index.ts bench run \
  --systems csm --trials 1 --corpus-sizes 100K --model-contexts 8K \
  --model gemini-3.5-flash --run-id t1-live-coverage
```

Env (both arms): `CSM_PROVIDER=gemini`, `CSM_GEMINI_MODEL=gemini-3.5-flash`,
`CSM_GEMINI_THINKING=low`, plus the coverage flags above (defaults; no
overrides). Cache note: the two arms differ in recall-prompt bytes for
coverage/starved queries only, so the content-hashed cache cannot
cross-contaminate; baseline reuses any existing 30q cache entries.

**Success criteria:**
1. q04 and q27 `meta.packedEventIds` recover gold events (q04 ≥4/6, q27
   ≥8/13 — the offline MockProvider floor, which a real probe model should
   meet or beat via better footholds);
2. **zero accuracy regressions on the other 28 queries** (every query
   correct in baseline stays correct in coverage);
3. citation F1 (scorer.ts citation precision/recall over `citedEventIds`
   vs `relevantEventIds`) non-degrading on the 28, improving on q04/q27;
4. pipeline input tokens within +20% overall (predicted +10–15%).

### Arm 2 — 3-trial repeat of any flip

For every query whose correctness CHANGED in either direction in Arm 1:

```bash
CSM_COVERAGE=1 npx tsx src/cli/index.ts bench run \
  --systems csm --trials 3 --corpus-sizes 100K --model-contexts 8K \
  --model gemini-3.5-flash --queries <flipped,ids> --run-id t1-live-flips-on
npx tsx src/cli/index.ts bench run \
  --systems csm --trials 3 --corpus-sizes 100K --model-contexts 8K \
  --model gemini-3.5-flash --queries <flipped,ids> --run-id t1-live-flips-off
```

A flip counts only if stable across ≥2/3 trials in the same direction
(`npm run bench:trials` for the summary).

### Arm 3 — BEAM-slice retrieval recall@k (via the T3 harness)

Blocked on T3 landing. Run the T3 retrieval-recall harness on the
summarization + event_ordering slices at 100K, retrieval-only, A/B:

```bash
# exact command owned by T3; expected shape:
CSM_AMB_ALLOW_MOCK=0 CSM_COVERAGE=0 npx tsx scripts/<t3-harness> --categories summarization,event_ordering --split 100k --run-id t1-beam-recall-off
CSM_AMB_ALLOW_MOCK=0 CSM_COVERAGE=1 npx tsx scripts/<t3-harness> --categories summarization,event_ordering --split 100k --run-id t1-beam-recall-on
```

Success: recall@24 and recall@32 up on both categories vs the capsule
baseline; `returnedEventIds` gold coverage ≥ capsule's. This is the gate for
migration step 2 (bridge consumes core coverage). ~80 queries × ~14K input
≈ 1.1M tokens per arm, retrieval-only.

### Arm 4 — budget & cost expectation

| Item | Estimate |
|---|---|
| Arm 1, per arm | 30q × ~15K pipeline input ≈ 0.45–0.5M input tokens |
| Arm 1 coverage surcharge | ~8–10 affected queries × +7.1K ≈ +0.06M |
| Arm 2 (≤6 flips × 3 × 2 arms) | ≤0.7M |
| Arm 3 (two arms) | ≈2.2M retrieval-only |
| **Total** | **≈3.9M input tokens** (≈$1.2 at current flash input pricing — verify against live pricing before running; thinking=low output is small) |

Abort criteria: any Arm 1 regression on the 28 control queries that
survives Arm 2 → coverage stays default-off and the classifier's offending
cue is narrowed before re-gating; Arm 3 regression on either category →
bridge migration (step 2) does not proceed.

### Risks & expected non-effects

- BABILong: Tasks 1–3 questions are point-shaped ("Where is the milk?") —
  classifier yields `point`, and with healthy citations the starvation net
  stays idle → no behavioral change expected. If a BABILong check is wanted
  before merge, a 30q `bench:babilong:csm` A/B costs ~0.3M tokens.
- BEAM `createdAt` is pinned to 2024-01-01 for undated turns, so the
  chronicle's date sort degrades to shard/turn natural order there —
  exactly the bridge's current behaviour (`turnNumber` sort); content-date
  phrases still drive temporal anchors.
- The starvation net fires on starved point queries and adds timeline
  context; if Arm 1 shows control-query noise traced to it, set
  `CSM_COVERAGE_STARVATION_FLOOR=0` to isolate intent-mode effects and
  re-gate.

## 5. Merge-window diff plan (exact files)

1. `src/core/coverage.ts`, `src/core/types.ts`, `src/core/schemas.ts`,
   `src/core/prompts.ts`, the five `tests/coverage*.test.ts` files, this
   doc — land as-is from `rd/t1-coverage` (mainline-intended commit
   `0821754` + the helper from `f239bef`).
2. `src/core/ask.ts` — orchestrator applies the three-part diff from
   `f239bef` (imports + intent/budget resolution; three
   `recallTokensPerShard` call sites; one `attachCoverage` block). ~40
   lines, all dead without `CSM_COVERAGE`.
3. `src/eval/baselines/csm.ts` — orchestrator applies the three-part diff
   from `f239bef` (timeline tier in `baseRetrievalOrder`; TIMELINE block in
   `formatPacketHeader`; two meta fields).
4. `src/providers/GeminiProvider.ts` (T4's file) — add the
   `"CoverageRecallResult"` entry to `CSM_JSON_SCHEMAS` ONLY when the LLM
   coverage-recall variant is wired (wave 2); nothing needed for the
   deterministic path.
5. `scripts/amb-csm-retrieve.ts` — migration steps 2–3 (see §1 Q5), gated
   on Arm 3.
