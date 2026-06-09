# EXP-T3: Local BEAM-slice retrieval eval harness

Status: **offline harness built and validated 2026-06-10** (branch
`rd/t3-beam-harness`). The live retrieval-only run in §8 is **written, not
run** — the orchestrator executes it.

Mission (portfolio Brief T3): measure CSM **retrieval** quality on real BEAM
data for the two losing categories (summarization 0.7086 vs 0.7929,
event_ordering 0.7375 vs 0.8047 against Hindsight) without the AMB Python
stack, without answer/judge models, and with gold strictly eval-side. This
harness is the gate T1 (coverage recall) and T2 (router v1) cite: a sub-$1,
minutes-long check instead of a 400-query AMB run.

---

## 1. Gold-structure findings memo (design question 1)

Verified against AMB `45fa380523afab9b1acd667a03de51c5ea63f4d2`
(`data/beam/100k/queries.json.gz`, 400 records, plus the upstream loader
`src/memory_bench/dataset/beam.py`).

**BEAM queries do NOT carry per-query evidence references.** A query record
has exactly these fields (content redacted to structure):

```jsonc
{
  "id": "1_abstention_0",            // {conversation}_{category}_{index}
  "query": "str(len≈70-120)",
  "user_id": "1",                    // conversation id (unit scoping key)
  "gold_answers": ["str(len≈110)"],  // 0..1 reference answers
  "gold_ids": ["1"],                 // ALWAYS == [user_id]
  "meta": {
    "question_category": "abstention",
    "conversation_id": "1",
    "rubric": ["LLM response should …: str(len≈110)", …],  // 1..9 items
    // + category-specific: why_unanswerable | tests_for |
    //   ordering_tested ("1st: …", "2nd: …") | total_mentions |
    //   instruction_being_tested | compliance_indicators |
    //   preference_being_tested | time_points | calculation_required
  }
}
```

Hard counts on the 100k split (the other splits share the schema):

- `gold_ids == [user_id]` on **400/400** records, list length always 1. The
  upstream loader hard-codes it: `gold_ids=[conv_id]`
  (`beam.py:355`). So `gold_ids` is the conversation id — information the
  retrieval side already has via user scoping. **Event/turn-level recall@k
  against gold ids is impossible, and doc-level recall is degenerate
  (≡ 1.0 under user-scoped retrieval).**
- `gold_answers` is empty on **160/400** records (categories where the
  rubric is the only gold).
- `meta.rubric` exists on **400/400** records. Per-category facet counts on
  the two target categories: summarization rubric 3–8 items (mean 4.9);
  event_ordering rubric 3–9 (mean 5.3) with `ordering_tested` mirroring it
  (mean 5.3, items shaped `"1st: <topic>"`).
- Rubric items are templated: `"LLM response should state/contain/mention:
  <fact>"` (797/~800 items); abstention rubrics are `"Based on the provided
  chat, there is no information about <topic>"`.

**Consequence:** recall@k must be a documented proxy. We use **gold-facet
retrieval coverage** (§3): the rubric items are the *judge's actual scoring
units* in AMB (`get_judge_prompt_fn` checks them; `score_result` averages
per-rubric-item 0/0.5/1 judgments), so "did retrieval surface text
supporting each rubric facet" is the closest retrieval-level analogue of
the end-to-end score, while staying deterministic and LLM-free.

Document records, for completeness (100k): `{id: "1_s0_0", content,
user_id: "1", timestamp: null}` — one document per session chunk
(≤100K chars), content formatted by the upstream loader as
`[{time_anchor} | Turn {id}] Role: text` blocks joined by blank lines. The
bridge's `documentToEvents` splits exactly on those turn markers; ids
become `"{docId}#turn-{chunkIndex}"` (or the bare doc id for single-chunk
docs).

One divergence worth recording: the **committed** `documents.json.gz` rows
carry `context: null`, while AMB's **live** loader (HF download path)
synthesizes `context="Conversation N — {user_info} (session i/j)"`, which
the bridge prepends to every event (`Context: …`). The harness feeds the
committed rows, so harness events lack that constant prefix. For A/B gating
(old-CSM vs T1/T2-CSM inside this harness) the comparison is internally
consistent; absolute numbers may differ slightly from a live-AMB run.

## 2. Dataset slicing (design question 2)

- `scripts/fetch-beam-slice.ts` pins the AMB clone at `45fa38052`
  (blobless + sparse: `data/beam`, `src/memory_bench/dataset`), copies the
  requested splits **byte-identical** (still gzipped, sha256-manifested)
  into gitignored `data/eval/corpus-beam-slice/`, and writes `census.json`
  covering **every** split present upstream. Default fetch: `100k`.
  500k/1m/10m are present upstream and fetch on demand
  (`--splits 500k,1m,10m`).
- Query selection (`selectBeamQueries` in `src/eval/corpus/beam.ts`):
  category filter → per-category mulberry32(seed=42) shuffle →
  `--per-category-limit` / `--query-limit` caps → regroup by unit so the
  runner builds one scoped corpus per unit. Deterministic for a given seed;
  selection-by-category mirrors AMB's own `--category` flag and feeds
  nothing into retrieval.

## 3. Metric definitions (design question 3)

Let `F(q)` be the facet list for query `q`, in priority order:

1. `meta.rubric` items, prefix-stripped (`"LLM response should …: X"` → X);
2. `meta.ordering_tested` items (`"1st: X"` → X) — event_ordering;
3. `meta.time_points` — temporal_reasoning;
4. fallback when 1–3 are empty: sentences of `gold_answers[0]`.

For an event text `e` and facet `f` with distinctive terms `T(f)`
(lowercased tokens ≥4 chars or digit-bearing, stop-worded, ≤24 terms):

- `supports(e, f)` ⇔ ≥50 % of `T(f)` match `e` on word boundaries AND at
  least `min(2, |T(f)|)` terms match.

Per query (from a saved payload row):

| Metric | Definition |
|---|---|
| `coverage@k` for k ∈ {10, 24, 32} | fraction of `F(q)` supported by ≥1 event among the first k of `returnedEventIds` (post-capsule bridge output — what AMB's answer model would see) |
| `packedCoverage` | same over `meta.packedEventIds` (what CSM packed into its own context — the T1 target; the q04/q27 class shows up here) |
| `retrievedCoverage` | same over `meta.csmRetrievedEventIds` (pipeline + augmentation order, pre-budget) |
| `oracleCoverage` | same over ALL events of the query's unit — the **lexical ceiling** of the proxy; the paraphrase gap is `1 − oracle` |
| `normalized@k` | `coverage@k / oracleCoverage` (null when oracle = 0) — fraction of lexically-achievable gold actually retrieved |

Telemetry passthrough per row: `inputTokens`, `outputTokens`, `latencyMs`,
`probeCount`, `recallCount`, `evidenceCapsule`, returned/packed counts.

Aggregation: per-category means with seeded-bootstrap 95 % CIs
(mulberry32(42), 10 000 resamples — `scorer.ts` conventions, re-implemented
inside the gold module because importing `scorer.ts` would breach the
firewall; see §5). Abstention is excluded by default (its facet is "there
is no information", so retrieval coverage is meaningless there);
`--include-abstention` overrides.

Known k interaction: the bridge caps `returnedEventIds` at
`max(requestedK, 24)` for summary intent and `max(requestedK, 32)` for
temporal/contradiction intent (BEAM-run env: `CSM_AMB_SUMMARY_RETURN_K=24`,
`CSM_AMB_REASONING_RETURN_K=32`), so for summarization rows
`coverage@32 == coverage@24` unless the summary return-k is raised. The
scorer records `returnedCount` so this is auditable per row.

## 4. Modes (design question 4)

| Mode | How | Status |
|---|---|---|
| mock (plumbing/CI) | `CSM_AMB_ALLOW_MOCK=1` (+ no provider config ⇒ MockProvider; the bridge's integrity guard refuses mock without the opt-in) | **run** — see §7 |
| live retrieval-only | real provider env (mirrors the BEAM-100K bridge env), same runner command | **written, not run** — §8 |
| replay | `scripts/score-beam-slice.ts` recomputes every metric from `payloads.jsonl`; changing `--ks`, thresholds, category filters costs zero LLM calls | **run** as part of §7 |

## 5. Leakage firewall (the hardest rule)

- The ONLY module that reads `gold_answers` / `rubric` / hints is
  `src/eval/retrievalScore.ts`. It is a **leaf**: imports node: builtins
  only — no project modules, no npm packages. Needed logic (bridge turn
  splitting, mulberry32 bootstrap) is **duplicated, on purpose**.
- The retrieval-side loader (`src/eval/corpus/beam.ts`) **redacts at parse
  time**: `BeamRetrievalQuery` carries exactly
  `{id, question, category, userId, questionSha256}`; `gold_answers`,
  `gold_ids`, and ALL of `meta` are dropped on the floor
  (`BEAM_QUERY_REDACTED_FIELDS`).
- Runner and scorer are **separate processes**; the only interface is
  `payloads.jsonl` (ids + telemetry, no document text, no gold).
- `tests/beamLeakageFirewall.test.ts` enforces it statically over the real
  import graph (runtime imports; `import type` is erased and exempt):
  1. gold module = node-builtin leaf;
  2. `retrievalScore.ts` unreachable from `scripts/amb-csm-retrieve.ts`,
     `scripts/amb-csm-server.ts`, `scripts/run-beam-slice.ts`, and
     `src/eval/corpus/beam.ts`;
  3. gold-module closure ∩ retrieval-path closure = ∅ (the brief's exact
     wording, at its strictest);
  4. reverse-dependency scan over all of `src/` + `scripts/`: only
     `scripts/score-beam-slice.ts` may import the gold module;
  5. the eval CLI's closure contains no `src/core/**`, `src/providers/**`,
     `src/eval/baselines/**`, `scripts/amb-*`;
  6. no retrieval-path module references the score artifacts by name.
- **No harness output ever feeds back into retrieval logic.** Score
  artifacts live in `data/eval/runs/<runId>/` (gitignored); nothing on the
  retrieval path reads run directories. Event-id alignment between the two
  sides is proven by `tests/beamCorpus.test.ts`
  (`beam_eval_index_ids_match_bridge_buildCorpus_ids`), which may import
  both sides because tests sit outside both paths.

## 6. Scale census (design question 5 — the T2/T8 input)

From `data/eval/corpus-beam-slice/census.json` (AMB `45fa38052`, computed
2026-06-10 over every split present in `data/beam`). "tokens (est.)" is the
chars/4 estimator (`estimateTokens`); "tokens (upstream)" is
`stats.json.gz`'s tokenizer count.

| split | units | docs (sessions) | docs/unit min/avg/max | tokens/unit (est.) min/avg/max | total tokens (est.) | total tokens (upstream) | queries | per category |
|---|---:|---:|---|---|---:|---:|---:|---:|
| 100k | 20 | 170 | 5 / 9 / 12 | 101,555 / 154,431 / 227,310 | 3.09 M | 2,634,217 | 400 | 40 |
| 500k | 35 | 962 | 19 / 27 / 40 | 328,040 / 560,086 / 864,624 | 19.60 M | 17,850,416 | 700 | 70 |
| 1m | 35 | 1,830 | 34 / 52 / 82 | 720,573 / 1,155,117 / 1,860,818 | 40.43 M | 36,517,787 | 700 | 70 |
| 10m | 10 | 10 | 1 / 1 / 1 | 8,576,625 / 11,707,222 / 14,336,398 | 117.07 M | 109,652,017 | 200 | 20 |

Every split is 20 queries/unit (2 per category per unit). gz on disk:
100k 2.62 MB, 500k 17.34 MB, 1m 34.08 MB, 10m 88.83 MB (~143 MB total).

**Scale findings for T2/T8:**

- 500k/1m raise sessions/unit to 27/52 — the alphabetical-top-8 routing
  cliff (Discovery A) means CSM would probe ≤8 of 27–82 sessions: the
  router upgrade is load-bearing exactly as predicted.
- **10m is structurally different: ONE flat mega-document per unit** (no
  session lists upstream → the AMB loader's fallback path emits a single
  ~11M-token document). Under the bridge, that becomes ONE shard with tens
  of thousands of turn events — shard-count routing is moot and per-shard
  snapshot/index budgets become the binding constraint. T8 needs a
  unit-chunking strategy for 10m *before* routing work matters there.

## 7. What was built + offline validation

Files (branch `rd/t3-beam-harness`):

| File | Role |
|---|---|
| `scripts/fetch-beam-slice.ts` | pinned sparse clone → slice copy + sha256 manifest + all-splits census (`npm run bench:beam:fetch`) |
| `src/eval/corpus/beam.ts` | retrieval-side loader (documents pass-through; queries redacted at parse); deterministic selection |
| `src/eval/retrievalScore.ts` | THE gold module (leaf): gold/facet extraction, event-text index (duplicated turn-split), facet coverage, bootstrap aggregation, payload parsing |
| `scripts/run-beam-slice.ts` | retrieval-side runner over `executeAmbRetrieve` (import-only); resumable `payloads.jsonl` (`npm run bench:beam:run`) |
| `scripts/score-beam-slice.ts` | eval-side scoring CLI = replay mode (`npm run bench:beam:score`) |
| `tests/beamCorpus.test.ts` | loader round-trip + redaction + cross-firewall event-id alignment (synthetic fixture) |
| `tests/retrievalScore.test.ts` | facet/scoring/aggregation unit tests incl. edge cases |
| `tests/beamSliceRun.test.ts` | mock-mode e2e + resume + mock-guard |
| `tests/beamLeakageFirewall.test.ts` | static import-graph firewall (§5) |
| `tests/fixtures/beam/100k/*.json` | tiny SYNTHETIC BEAM-shaped fixture (never real rows) |

Validation (2026-06-10): `npm test` **251/251** (224 pre-existing + 27
new), `npm run lint` clean. Mock-mode artifact run on the REAL 100k slice:
see `data/eval/runs/beam-slice-100k-mock-v1/` (local-only, gitignored —
real BEAM content derivatives are never committed); summary below.

Mock run (`CSM_AMB_ALLOW_MOCK=1 CSM_PROVIDER=mock`, all 80
summarization + event_ordering queries, k=24, full augmentation incl.
MiniLM):

- 80/80 queries, 20 units, 109 s wall (includes one-time MiniLM embedding
  of ~5,000 events; embeddings are disk-cached so re-runs are seconds).
- `run-summary.json`: unitsTouched 20, queriesRun 80, resume-skip verified
  (second invocation runs 0).
- Scores (`retrieval-scores.md`, self-labeled MOCK):

| category | n | cov@10 | cov@24 | cov@32 | packed | retrieved | oracle | ret.n | packed.n | retr.n |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| event_ordering | 40 | 0.307 | 0.433 | 0.461 | 0.492 | 0.779 | **0.961** | 30.2 | 7.2 | 24.0 |
| summarization | 40 | 0.429 | 0.669 | 0.669 | 0.349 | 0.669 | **0.926** | 24.0 | 7.3 | 24.0 |

Mock numbers validate plumbing only — MockProvider's keyword probes/recalls
are not real retrieval. Three readouts already earn their keep:

1. **The proxy ceiling is high**: oracle facet coverage is 0.961 / 0.926 —
   92–96 % of gold facets ARE lexically findable in the unit, so the
   lexical proxy has only a 4–8 % paraphrase blind spot on these
   categories.
2. **The capsule story is visible provider-independently**: on
   summarization, `packedCoverage` 0.349 vs post-capsule `cov@24` 0.669 —
   the deterministic `selectAmbEvidenceIds` expansion (the external
   machinery T1 is replacing) nearly doubles facet coverage over what
   CSM's own packet packs.
3. **A real bridge behavior surfaced**: on event_ordering,
   `retrievedCoverage` 0.779 exceeds `cov@32` 0.461 because these queries
   trip `countLike && userCentric` intent → `preferUserTurns` reorders
   user turns ahead of assistant turns before the k-cut, dropping
   assistant-turn evidence past position 32. Worth re-examining once live
   numbers exist (assistant turns often carry the facts being ordered).

## 8. Live retrieval-only protocol (WRITE — the orchestrator runs this)

**Baseline gate run** — all summarization + event_ordering queries at 100k
(80 queries), retrieval-only, no answer/judge model anywhere.

Environment (PowerShell; mirrors `docs/BEAM_100K_CSM_VS_HINDSIGHT.md`
retrieval settings; requires the repo `.env` with `GEMINI_API_KEY`):

```powershell
# provider (or rely on the repo .env auto-load)
$env:CSM_PROVIDER = "gemini"
$env:CSM_AMB_MODEL = "gemini-3.5-flash"
$env:CSM_GEMINI_MODEL = "gemini-3.5-flash"
$env:CSM_GEMINI_THINKING = "low"
$env:CSM_GEMINI_TIMEOUT_MS = "600000"
$env:CSM_GEMINI_MAX_RETRIES = "2"
# retrieval shape — BEAM-100K run values
$env:CSM_AMB_MODEL_CONTEXT = "8192"
$env:CSM_AMB_MAX_OUTPUT_TOKENS = "512"
$env:CSM_AMB_SUMMARY_RETURN_K = "24"
$env:CSM_AMB_REASONING_RETURN_K = "32"
$env:CSM_AMB_NEIGHBOR_WINDOW = "1"
# make sure mock is NOT allowed
Remove-Item Env:CSM_AMB_ALLOW_MOCK -ErrorAction SilentlyContinue

npm run bench:beam:fetch                       # no-op if already fetched
npm run bench:beam:run -- --split 100k `
  --categories summarization,event_ordering `
  --run-id beam-slice-100k-live-v1 --k 24
npm run bench:beam:score -- --run-id beam-slice-100k-live-v1 --split 100k
```

The runner is resumable (`payloads.jsonl` is the ledger; rerunning skips
completed queries), and `--units 1,2,3` / `--per-category-limit N` give a
cheap pilot (e.g. `--per-category-limit 5` ≈ 10 queries first).

**Cost estimate** (from the BEAM-100K telemetry: pipeline avg 13,885 input
+ 2,513 output tokens/query, retrieve-only mode):

- input: 80 × 13,885 ≈ **1.11 M tokens**
- output: 80 × 2,513 ≈ **0.20 M tokens**
- at Gemini 3.5 Flash list rates (verify current pricing before the run;
  flash-class input has been ~$0.30/M and output ~$2.50/M): ≈ $0.33 input
  + $0.50 output ≈ **$0.85, comfortably <$1**; wall-clock ≈ 80 ×
  7–9 s ≈ **10–12 min** with the latency-sprint pipeline.

**Outputs:** `data/eval/runs/beam-slice-100k-live-v1/{config.json,
payloads.jsonl, run-summary.json, retrieval-scores.json,
retrieval-scores.md}` — keep `payloads.jsonl`; every future threshold
experiment replays from it for free.

**The same command is T1/T2's A/B gate:** run once on the baseline branch
and once with the candidate (worktree wiring / env flag), then compare
`retrieval-scores.json` per-category `coverage@k`, `packedCoverage`
(T1's target — the q04/q27 class), and `retrievedCoverage` (T2's routing
target), CIs included. Decision bar (from the portfolio): recall@k up on
summarization + event_ordering with no regression on the other categories
when run with `--categories` widened.

**Rules:** no gold in env or args; the runner process never imports the
gold module (statically enforced); no harness output feeds back into
retrieval logic; mock rows must never be presented as retrieval quality
(`createBridgeProvider` hard-refuses mock without `CSM_AMB_ALLOW_MOCK=1`,
and `retrieval-scores.md` self-labels mock runs).

## 9. Portfolio-doc corrections / clarifications from this work

1. Brief T3 said "fetch 100k now, record availability of 500k/1m". Upstream
   `data/beam` at `45fa38052` actually ships **four** splits —
   100k/500k/1m/**10m** — all censused above (10m exists in-repo, not just
   as a HF dataset).
2. The 10m split is one flat mega-document per unit (census §6) — T8's
   "BEAM 500K/1M/10M" line should treat 10m as a *different problem shape*
   (single-shard chunking), not just "more sessions".
3. BEAM gold carries NO sub-conversation evidence refs (§1) — the
   portfolio's "recall@k" for T3 is necessarily the facet-coverage proxy
   defined here; T1/T2 briefs citing "T3 recall@k" inherit that definition.
4. The committed BEAM documents lack the `context` field the live AMB
   loader synthesizes (§1, divergence note) — harness absolute numbers may
   differ slightly from live-AMB bridge runs; A/B deltas inside the harness
   are unaffected.
