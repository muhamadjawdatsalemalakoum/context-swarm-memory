# CSM R&D Portfolio — Plan of Record (2026-06-10)

Produced by a full-repo planning pass (grounded at `493b004`, 224/224 tests
green; the latency-sprint gate ledger in `docs/PERF_BREAKDOWN.md` landed in
parallel and is reflected in the addendum at the bottom). Wave-1 briefs below
are binding for the assigned R&D agents.

## Wave-1 outcomes & errata (added at merge window, 2026-06-10)

All four agents delivered; branches merged to main (333/333 tests), every
feature behind a default-off flag. Verdicts and corrections that supersede
statements below:

- **T2/router:** mechanism proven offline (recall@3 0.714→0.857 at both 100K
  and 1M; BEAM thin-metadata fixture gold-top-3 0/4→4/4) but **no measurable
  effect at 100k scale** — PaySwift parity at +6.4% tokens, BEAM-slice 100k
  inside CIs, because ~9-session units make alphabetical top-8 nearly
  exhaustive. `CSM_ROUTER_HYBRID` stays default-off; re-gate on a 500k slice
  (27 sessions/unit) before scale runs. Correction: q04 is recall/packing
  starvation (T1 class), not router starvation — the router-starved class is
  q03/q16/q17/q24/q30. The Gemma-era probe false-negative narrative is dead:
  gemini-3.5-flash probes accept gold candidates at 98%, so the router-trust
  top-2 extension is not worth its cost.
- **T4/caching: Discovery B and the T4 row's "40-60% input-cost cut" did not
  survive verification.** gemini-3.5-flash has a 4,096-token implicit-cache
  floor (verified 2026-06-10); every CSM call is sub-floor (probe avg 557
  tok, recall 1,384, synth 636), so today's pipeline gets exactly ZERO
  caching and no restructuring under 4,096 earns anything. Best restructuring
  arm ≈ −8% run cost with accuracy risk; explicit caching RAISES cost at
  current budgets (break-even only vs full-context plans, where it is 6.1x
  cheaper) and degrades with scale/router diversity. Caching is a
  context-expansion enabler for T1-style bigger digests, not a cost lever,
  and not a T8 funding source. Observability (cachedInputTokens /
  thoughtsTokens) merged default-off; ~$2.00/run of thinking spend was
  previously invisible.
- **T3/harness:** BEAM has NO sub-conversation evidence refs (gold_ids ==
  [user_id] on 400/400), so "recall@k" gates are the documented rubric-facet
  coverage proxy (lexical ceiling 92-96%). Upstream ships FOUR splits incl.
  10m — and 10m is one mega-document per unit (single shard; routing moot;
  T8 needs unit chunking there). Found: event_ordering queries trip the
  bridge's `preferUserTurns` k-cut and lose assistant-turn evidence —
  re-examine with live numbers. Live 100k baselines (hybrid-off):
  event_ordering packed 0.565 / cov@32 0.615; summarization packed 0.415 /
  cov@24 0.561; ~12-13 s and ~16K input tokens per coverage-class query.
- **T1/coverage:** deterministic chronicle assembler met both bars offline
  (q27 12/13 gold, q04 5/6 with a probe foothold); ~640 of the bridge's
  1,224 lines (incl. both domain tables) become deletable after its gates.
  Correction: q04 and q27 are different failure classes (point-starved vs
  coverage-shaped) — handled by separate triggers (starvation net vs intent
  mode); live gates should not expect the intent classifier to fire on q04.
- **Dispatch-process fix for future waves:** agent worktrees were cut from a
  stale HEAD; all four self-corrected by fast-forwarding. Briefs must pin the
  intended base SHA, and fresh worktrees need the gitignored caches (MiniLM
  model, data/eval/embeddings) seeded or tests flake.

## Two load-bearing discoveries

**Discovery A — the router is a no-op on AMB/BEAM corpora.** Bridge-built
shards get tags `["amb","beam","beam-turn","conversation:<uid>"]`
(`scripts/amb-csm-retrieve.ts` `documentToEvents`), name/description
`"Benchmark shard <docId>"`, summary `"Synthetic shard <id> (N events)"`
(`src/eval/baselines/csm.ts` `buildShardsFromCorpus`), and `createdAt` pinned
to 2024-01-01, so the recency boost is 0. Query terms essentially never match,
every shard scores ~0, and `selectCandidates` passes ALL active shards
(`src/core/router.ts`: `score > 0 || entry.status === "active"`), stable-sorts
the all-zero scores (preserving alphabetical shardId order), and slices to
`maxCandidateShards = 8`. On BEAM, CSM probes the **alphabetically-first ≤8
sessions of a unit** (telemetry: probe count avg 7.25, max 8 = the cap). The
100K score survived because the external capsule heuristics scan all shards
(`selectChronologicalCoverageIds` with `includeAllShards=true`). At 500K/1M,
alphabetical-8 selection is a score cliff → the router upgrade is a
**scale-survival prerequisite**.

**Discovery B — Gemini caching is impossible by construction.** Probe system
prompts embed a query-ranked event index (`src/core/probe.ts`
`compactEventIndex(snapshot, 1200, userQuery)`), and recall digests are
probe-hint-ordered (`src/core/recall.ts`), so per-shard prompt bytes change
every query — defeating implicit prefix caching beyond the ~140-token
`SHARD_SYSTEM_PROMPT`. `GeminiProvider` neither sends `cachedContent` nor
parses `usageMetadata.cachedContentTokenCount`/`thoughtsTokenCount`, so cache
hits and thinking spend are invisible. Each BEAM unit re-probes the same ~5-8
shards across ~20 queries — ~20x reuse potential, but it requires
accuracy-gated prompt restructuring, not just a provider flag.

## Portfolio table

Effort: S < 1 day, M = 1-3 days, L = 1-2 weeks of focused agent work.
"Score" = AMB/BEAM + PaySwift accuracy.

| # | Topic | Impact axis | Expected magnitude | Effort | Invariant risk | Rank |
|---|---|---|---|---|---|---|
| T1 | Coverage/chronicle recall in core | Score, capability | Summarization −0.084 + event_ordering −0.067 ≈ ~40 rows each of 400; closing to Hindsight parity ≈ +0.015 AMB overall (0.7576→~0.773); fixes q04 (0/6 gold packed) / q27 (2/13) class; replaces the 1,223-line regex capsule incl. BEAM-domain term tables | L | Medium (LLM-input change → full gates) | **1** |
| T2 | Router v1: content-derived descriptors + local-embedding hybrid scorer | Score at scale, cost | PaySwift starved class (q03/q04/q17 ≈ up to +0.10 on 30q); at 500K+ the difference between informed top-8 and alphabetical top-8; confident routing can shrink probe fan-out below 8 | M | Low-medium (no LLM at index time; local MiniLM stays inside the README "zero LLM-indexing" claim) | **2** |
| T3 | Local BEAM-slice retrieval-recall@k harness | Credibility, enabler | The gate T1/T2 cite; recall@k on the two losing categories at retrieval-only cost; delivers the 500K/1M census T8 needs | M | None (gold stays eval-side, leakage firewall enforced by test) | **3** |
| T4 | Gemini context caching + provider usage observability | Cost, latency, enabler | Pipeline input 13,885 tok/query avg (5.55M/BEAM-100K); ~60-75% is shard content re-sent ~20x/unit → est. 40-60% internal input-cost cut; observability also fixes invisible thinking-token accounting | M | Low in wave 1 (default-off flag + measurement) | **4** |
| T5 | MCP server + product surface (retain=Committer, recall=ask, multi-tenant scoping) | Capability, credibility | Makes CSM consumable by agents; SDK dep declared+unused; spec §20 defines the surface; warm server proves the pattern | M | Low-medium (write tools route through Committer, dry-run default) | 5 (wave-2 lead; parallel-safe anytime) |
| T6 | Contradiction/temporal-conflict handling | Score, capability | 0.65→0.80 ≈ +0.015 overall; plumbing exists unused (`memoryType: "conflicting"`, `conflicts`, `knownConflicts`) | M | Medium | 6 (wave 2, after T1 — shares synthesize.ts and coverage machinery) |
| T7 | Probe batching + calibration | Cost, score | Probes ≈ 5K of 13.9K input/query; batching cuts calls 4-7x; false-negative risk interacts with router-trust net | S/M | Medium | 7 (wave 2, blocked on T3 + probe-model verdict) |
| T8 | Scale readiness: BEAM 500K/1M/10M | Capability at scale | Known cliffs: alphabetical-8 routing, whole-corpus MiniLM embed first-pass cost, server RAM corpus cache | M-L | Low | 8 (blocked on T2+T3+T4) |
| T9 | Statistical rigor: 3-trial CIs | Credibility | Converts the admitted single-trial weakness into CIs; bench:confirm/bench:trials already wired — mostly spend | S + $$ | None | 9 (after T1/T2 land, so trials aren't paid twice) |
| T10 | Committer autonomy + split/compact + aging | Capability | Phase 2 dry-run+apply only; Phase 3 threshold-only; `staleness` never set; zero AMB impact (bridge never commits) | L | **High** (the write path) | 10 (wave 3) |

Not proposed (owned by the latency stream): recall-as-probes-complete
pipelining (landed as opt-in eager recalls, measured no-op on PaySwift),
probe-model routing (gated, documented opt-in), recall/synth thinking-level
matrix (natural extension of that stream's gate).

## Wave 1 = T1 + T2 + T3 + T4

**File-ownership matrix (mainline):**

| File / dir | Owner |
|---|---|
| `src/core/ask.ts`, `src/eval/baselines/csm.ts`, `scripts/amb-csm-retrieve.ts`, `scripts/amb-csm-server.ts`, `integrations/amb/csm_provider.py` | Orchestrator (latency stream) — frozen to wave-1 agents on mainline; worktree copies may be wired freely; integration happens in the merge window |
| `src/providers/GeminiProvider.ts` | T4 sole owner; additive + default-off only |
| `src/core/coverage.ts` (new), additive `prompts.ts`/`types.ts`/`schemas.ts` | T1 |
| `src/core/routerEmbed.ts` + `src/core/descriptors.ts` (new), additive export from `src/eval/embed.ts` | T2 |
| `scripts/fetch-beam-slice.ts`, `src/eval/corpus/beam.ts`, `src/eval/retrievalScore.ts` (new) | T3 |
| `scripts/measure-gemini-caching.ts` (new), docs caching notes | T4 |
| `src/core/router.ts` | T2 additive exports only; `selectCandidates` behavior change ships in the merge window |

Known seam: if T1 introduces a new LLM JSON schema name, the
`CSM_JSON_SCHEMAS` map in `GeminiProvider.ts` (T4's file) gets the entry in
the merge window — absence degrades gracefully (providerJson retry+Zod still
validates).

---

## Brief T1 — First-class coverage & chronicle recall in CSM core

**Mission.** CSM loses to Hindsight on exactly two BEAM categories —
summarization (0.7086 vs 0.7929) and event_ordering (0.7375 vs 0.8047) — and
the current mitigation is an external regex heuristic ("evidence capsule") in
`scripts/amb-csm-retrieve.ts` that is overfit to BEAM content domains.
Locally, the same failure shows as multi-event coverage collapse: PaySwift
q04 packs 0 of 6 gold events, q27 packs 2 of 13. Design and prototype a
general, in-core capability that makes the read path produce **broad
chronological/coverage evidence with event-ID citations** for
summary/ordering/temporal-shaped queries, so the external capsule can
eventually be deleted.

**Read first (in order).**
1. `CLAUDE.md` (invariants; mock-fence convention; provider-JSON rule)
2. `docs/BEAM_100K_CSM_VS_HINDSIGHT.md` + `data/eval/runs/sota-combined/amb-beam-100k-csm-vs-hindsight.json` (telemetry: avg 24.9 retrieved events, 26 returned docs, pipeline 13.9K input tokens)
3. `scripts/amb-csm-retrieve.ts` in full — especially `detectAmbQueryIntent`, `selectAmbEvidenceIds`, `selectChronologicalCoverageIds`, `buildEvidenceCapsule`, `buildTemporalRelationLine`, and the hardcoded `expandCoverageTerms` domain tables you are replacing
4. `src/core/ask.ts` (pipeline flow; recall trigger; router-trust net), `src/core/recall.ts` (1200-token digest cap; hint-as-priority-order; date-stamping), `src/core/synthesize.ts` (synth skip rules; `packetFromSingleRecall`), `src/core/prompts.ts`, `src/core/types.ts`, `src/core/schemas.ts`, `src/core/tokenBudget.ts` (`DEFAULT_RECALL_BUDGET`)
5. `src/eval/baselines/csm.ts` (retrieval-order augmentation stack and `buildContextString`)
6. `data/eval/corpus-synthetic/queries.json` (q04, q27, q19, q23) and `decisions.md`
7. `tests/mutationSafety.test.ts`, `tests/recallScope.test.ts`, `tests/routerTrust.test.ts` (ScriptedProvider stub patterns)

**Design questions (written analysis required).**
1. Query-intent classification in core: deterministic lexical (generalized port of `detectAmbQueryIntent`, no domain tables) vs probe-stage side-output (changes LLM inputs → gate) vs both. Where does it live so `ask()` callers and the bridge share it?
2. Coverage recall mechanism — pick and justify one primary: (a) "coverage mode" recall prompt variant asking for a date-ordered digest of all matching events (LLM, cited, gated); (b) deterministic chronicle assembler: date/turn-sorted, term-scored selection across all candidate shards, bucketed for timeline spread (port of `selectChronologicalCoverageIds` + `spreadAcrossTimeline` into core, fed by router/probe footholds — zero LLM cost); (c) hybrid: deterministic assembly feeding a single synth pass. Term source must be query+foothold-derived (the `extractBridgeTerms` pattern), never hardcoded domains.
3. Budget reallocation: `maxRecallTokensPerShard=1200` starves 13-event answers. Propose intent-conditional budgets and show the token math against the 8192 `CSM_AMB_MODEL_CONTEXT` cap.
4. Packet shape: does `MemoryPacket` need an optional `timeline: Array<{date, eventRef, line}>` (additive `types.ts`/`schemas.ts` with full citation discipline) or can `keyClaims` + ordered `recommendedMainContext` carry it? Temporal arithmetic: keep deterministic date-anchor computation (port `parseDatePhrase`/anchor pairing) — never ask the LLM to do date math unaided.
5. Migration path: which parts of `selectAmbEvidenceIds`/`buildEvidenceCapsule` become redundant, in what order, and what stays bridge-side permanently (AMB doc-shaping only)?

**Prototype (worktree) vs design-only.** Prototype: `src/core/coverage.ts`
(intent classifier + deterministic chronicle assembler + budget logic) with
unit tests; worktree-only wiring into `ask()`/`retrieveContext` to produce
end-to-end packets on PaySwift via MockProvider/ScriptedProvider. Design-only:
the LLM coverage-recall prompt variant (write the prompt + schema, no API
spend), the bridge deletion plan.

**Offline validation (must run).** `npm test` (mutationSafety green),
`npm run lint`, `npm run eval`, `npm run bench:smoke`; new vitest files
proving: intent classifier fixtures; assembler returns date-ordered,
citation-complete, budget-respecting selections on synthetic shards; a
q04/q27-shaped fixture where the assembler surfaces ≥5/6 and ≥10/13 gold
events; zero writes (hash pattern from `mutationSafety.test.ts`).

**Live experiment protocol (WRITE, do not run)** — as
`docs/experiments/EXP-T1-coverage.md`: (1) PaySwift csm-only 30q at 100K/8K,
1 trial, gemini-3.5-flash, baseline vs coverage-enabled (env-flagged);
success = q04/q27 packedEventIds recover gold events with zero regressions on
the other 28, citation F1 non-degrading; (2) 3-trial repeat of any flip; (3)
BEAM-slice retrieval recall@k on summarization+event_ordering via the T3
harness; (4) exact commands, env vars, expected token budget (~0.5M input).

**Out of scope.** Mainline edits to `ask.ts`/`csm.ts`/`amb-csm-*.ts`;
contradiction handling (T6); AMB scoring/judge changes; new schema entries in
`GeminiProvider.ts` (merge window); changes to existing probe/recall prompts
(only additive new constants — never touch `<<MOCK_RESULT>>` fences).

**Definition of done.** Design doc with chosen mechanism + budget math +
migration plan; `src/core/coverage.ts` + tests green unwired; worktree branch
with end-to-end wiring demonstrated offline; written live protocol; list of
`amb-csm-retrieve.ts` lines deletable post-merge.

---

## Brief T2 — Router v1: content-derived descriptors + local-embedding hybrid scoring

**Mission.** The Phase-0 keyword/tag router fails two ways: on PaySwift,
generic-vocabulary queries score ≤2 and the right shard never gets probed
(q04-class — the documented embedding-floor origin story in
`src/eval/baselines/csm.ts`); on AMB/BEAM, bridge-synthesized directory
metadata is so thin that all shards score ~0, `selectCandidates` passes every
active shard, and the top-8 cut is effectively alphabetical (Discovery A).
Build (a) content-derived shard descriptors (auto-tags/terms + a
local-embedding centroid per shard) and (b) a hybrid router that fuses
lexical and embedding scores deterministically, with no LLM at index time,
preserving the README's "zero LLM-indexing cost" claim (local MiniLM is
explicitly inside that claim).

**Read first.** `src/core/router.ts` (scorer weights, the `score > 0 ||
active` filter); `src/eval/baselines/csm.ts` (`InMemoryStorageReader` — the
degenerate descriptors you must enrich; the augmentation stack the router
upgrade should shrink); `scripts/amb-csm-retrieve.ts` (`buildCorpus`/
`documentToEvents` — BEAM tags); `src/eval/embed.ts` (disk-cached MiniLM;
`ensureEmbeddings` already writes the cache from the read path — precedent
that embedding-cache writes are not durable-memory mutation; cross-check what
`tests/mutationSafety.test.ts` hashes); `src/eval/rerank.ts` (opt-in
pattern); `src/core/ask.ts` (call site you may NOT edit on mainline);
`tests/router.test.ts`, `tests/routerTrust.test.ts`,
`tests/embeddingFloor.test.ts`; spec §8.2 + §15.2 (Router Recall@K);
`data/eval/corpus-synthetic/queries.json`.

**Design questions.**
1. Descriptor derivation: per-shard top-TF-IDF/log-odds terms vs tag-union vs MiniLM centroid vs medoid events. Where computed: bridge/baseline adapter at corpus build, and `csm shard`/commit-time for durable stores (Committer-side directory update — the spec's "directory drift" mitigation). Storage shape in `MemoryDirectoryEntry` (additive optional fields) so the directory remains the only memory object the router reads.
2. Fusion: weighted sum vs RRF vs lexical-with-embedding-tiebreak. Calibrate weights offline against PaySwift 30q router-recall@K and the T3 BEAM-slice recall@k.
3. The `score > 0 || active` passthrough: keep "probe everything up to cap" for low-confidence cases while high-confidence routing shrinks the probe set below 8 (cost win)? Quantify expected probe-call savings from telemetry.
4. Async boundary: `selectCandidates` is sync; embeddings are async. Design the drop-in (`selectCandidatesHybrid` async, or a pre-computed `RouterIndex` passed by callers) so the eventual `ask.ts` integration is a ≤5-line coordinated edit.
5. Probe-interplay analysis: from PaySwift run artifacts, quantify router-rank vs probe-verdict agreement and false-negative rates; decide whether the router-trust net should extend to top-2 under the new scorer — analysis only.
6. Scale: centroid cost at 10M tokens / thousands of shards; incremental update on commit; index memory footprint (feeds T8).

**Prototype vs design-only.** Prototype: `src/core/descriptors.ts` +
`src/core/routerEmbed.ts` with tests; offline eval script computing
router-recall@K on PaySwift (gold = relevantEventIds→shard mapping,
eval-side) old vs new; worktree wiring into the baseline adapter. Design-only:
mainline integration plan; durable-store descriptor refresh via Committer.

**Offline validation.** `npm test`, `npm run lint`, `npm run eval`,
`npm run bench:smoke`; new tests: descriptor determinism, hybrid ordering on
fixtures, router-recall@K ≥ old router on PaySwift (target spec §22 "correct
shard in top 3 ≥85%"; q03/q04/q17 shards entering top-8), BEAM-shaped fixture
where 12 thin-metadata shards exist and the gold shard ranks top-3 by
embedding signal alone.

**Live protocol (WRITE only)** — `docs/experiments/EXP-T2-router.md`:
PaySwift 30q A/B (old vs hybrid) at 100K and 1M, 1 trial then 3-trial on
flips; BEAM-slice recall@k on ALL categories; explicit no-regression bar on
the 7 winning BEAM categories; token budget; rule: embeddings local-only, no
Gemini calls at index time.

**Out of scope.** Mainline behavior edits to `ask.ts`/`csm.ts`/`router.ts`
(additive exports only); LLM-based routing or LLM-generated summaries;
cross-encoder shard reranking (note as wave-2 option); probe prompt/batching
changes (T7).

**Definition of done.** Descriptor+router modules with tests green; offline
recall@K report (PaySwift + BEAM fixture); calibrated default weights with
the calibration script committed; integration plan naming exact merge-window
diffs; written live protocol; probe-interplay analysis memo.

---

## Brief T3 — Local BEAM-slice retrieval eval harness (recall@k for the losing categories)

**Mission.** Build an offline-first eval harness that measures CSM
**retrieval** quality (recall@k / coverage of gold evidence) on real BEAM
data for summarization and event_ordering — without the full AMB stack,
without answer/judge models, and with gold data used **strictly eval-side**
(never visible to retrieval — the project's hardest rule). This becomes the
gate T1 and T2 cite, replacing "run 400-query AMB" with a <$1, minutes-long
check.

**Read first.** `docs/AMB_OFFICIALIZATION_STATUS.md` (AMB layout:
`data/beam/` committed at HEAD `45fa38052`; sparse-checkout only `data/beam`
+ the dataset loader under `src/memory_bench/`); `scripts/amb-csm-retrieve.ts`
(exported `buildCorpus`, `scopeDocuments`, `executeAmbRetrieve`,
`AmbDocument` — your import surface; `documentToEvents` turn-splitting so
your events match the bridge's); `integrations/amb/csm_provider.py` (how AMB
feeds documents/queries); `tests/ambServer.test.ts` (offline patterns);
`src/eval/scorer.ts` (citation P/R conventions); `src/eval/runner.ts`
(results.jsonl row shape); `docs/BENCHMARK_METHODOLOGY.md` §8;
`scripts/fetch-babilong.ts` (fetch-script pattern: log every URL, fall back
to manual instructions, never commit raw data).

**Design questions.**
1. **Gold structure discovery:** inspect BEAM query records — do they carry per-query evidence references (doc ids, turn ids, sessions)? If yes: recall@k = |retrieved ∩ gold|/|gold| at event/turn level. If no: define a documented proxy (answer-string/entity containment, eval-side) labeled clearly as a proxy. Either way: a leakage firewall — the gold-touching module must be import-isolated from anything the retrieval path imports, enforced by a test that checks the import graph.
2. Dataset slicing: per-category query selection across units; deterministic seeded subsampling; fetch 100k now, record availability of 500k/1m for the census.
3. Metrics: recall@k for k∈{10,24,32}, gold-coverage of `packedEventIds` vs `returnedEventIds` (pre/post capsule), per-category aggregates with bootstrap CIs (reuse `scorer.ts`), plus latency/token telemetry already in `raw_response`.
4. Modes: (a) mock mode (`CSM_AMB_ALLOW_MOCK=1`) for plumbing CI; (b) live retrieval-only mode (the orchestrator runs it); (c) replay from saved payload JSONL so threshold experiments are free.
5. Scale census: units × sessions/shards × tokens per unit at each split — the input T8 and T2 need.

**Prototype vs design-only.** Prototype everything offline: fetch script
(data lands in gitignored `data/eval/corpus-beam-slice/`), loader, scorer,
mock-mode end-to-end, replay mode, census script. The live run itself is
written-not-run.

**Offline validation.** `npm test` + new tests: loader round-trip on a tiny
committed SYNTHETIC BEAM-shaped fixture (never commit real BEAM rows), scorer
unit tests incl. P/R edge cases, leakage-firewall test, mock-mode smoke
producing a results JSONL; `npm run lint`.

**Live protocol (WRITE only)** — `docs/experiments/EXP-T3-beam-slice.md`:
baseline = all summarization + event_ordering queries at 100k (~80 queries ×
~14K input ≈ 1.1M tokens, retrieval-only), saving payload JSONL for replay;
the same command then becomes T1/T2's A/B gate. Include exact env (mirror the
BEAM doc's retrieval settings), cost estimate, and the rule that no harness
output ever feeds back into retrieval logic.

**Out of scope.** Running AMB's Python harness; answer/judge models; score
reproduction; committing BEAM data; touching in-flight files (import-only);
modifying `executeAmbRetrieve`.

**Definition of done.** Fetch+loader+scorer+replay merged and green;
gold-structure findings memo (leakage firewall demonstrated by a test);
mock-mode run artifact; written live protocol; scale census table for every
split present in AMB `data/beam`.

---

## Brief T4 — Gemini context caching for shard content + provider usage observability

**Mission.** CSM re-sends the same shard content to Gemini dozens of times
per BEAM unit (≈20 queries/unit × 7.25 probes + 3.55 recalls; pipeline avg
13,885 input tokens/query; 5.55M over the 100K run), yet caching is
structurally impossible today (Discovery B), and `GeminiProvider` cannot even
observe cache hits or thinking spend. Deliver: (1) zero-risk observability,
(2) a measured cost model of implicit vs explicit caching on
gemini-3.5-flash, (3) a design + written gated experiment for cache-friendly
prompt restructuring, (4) optional default-off explicit-cache support.

**Read first.** `src/providers/GeminiProvider.ts` (request body, usage
parsing, thinking config, CSM_JSON_SCHEMAS); `src/core/probe.ts` +
`src/core/recall.ts` (the prefix-cache contract comments — an Ollama-era
contract whose stable prefix is only ~140 tokens; the query-aware ranking
rationale you must not regress); `tests/prefixCacheContract.test.ts`,
`tests/geminiProvider.test.ts`; `docs/PERF_BREAKDOWN.md` (thinking-level
measurements; `scripts/probe-thinking-levels.ts` as the measurement-script
pattern); the BEAM telemetry aggregate; `docs/GEMINI.md`;
`docs/COST_ACCOUNTING.md` (estimatedUsd currently hardcoded 0 — your cost
model can fix that).

**Design questions.**
1. Observability: parse `usageMetadata.cachedContentTokenCount` and `thoughtsTokenCount` into `ProviderUsage` (additive; check every consumer incl. cost-accounting tests and the telemetry sidecar). Does today's pipeline get ANY implicit hits? (Hypothesis: ~0 beyond the 140-token prefix; prove it.)
2. Current API facts (verify against live web docs — training data may be stale): implicit-caching minimum prefix tokens and discount for gemini-3.5-flash; explicit `cachedContents` pricing (storage/hour + cached-input rate); whether `systemInstruction` participates in implicit prefix matching or only `contents`; interaction with `thinkingConfig` and `responseJsonSchema`.
3. Restructuring design: make the per-shard prompt prefix byte-stable per snapshot — system = `SHARD_SYSTEM_PROMPT` + shard header + stable (complete or stably-truncated) event index/digest, with the query and ranking hints moved to the user turn. Tension: stable truncation reintroduces the failure query-aware ranking fixed; options: full index under a size threshold, stable two-tier index, or explicit-cache the full snapshot text. Quantify token deltas per option from BEAM telemetry.
4. Cost model: per-unit arithmetic for implicit vs explicit vs status quo at 100K and projected 500K/1M, including cached-prefill TTFT latency.
5. Provider mechanics: cache-key lifecycle keyed by `shardId@snapshotId` (immutable snapshots are perfect cache keys — a real architectural synergy), TTL per BEAM unit, eviction, env-flag surface (`CSM_GEMINI_CACHE=off|implicit-observe|explicit`), default off so all in-flight gates stay byte-identical.

**Prototype vs design-only.** Prototype: usage-parsing additions with unit
tests (fixture responses incl. cached/thoughts fields);
`scripts/measure-gemini-caching.ts` (probe/recall-shaped payloads, repeated
calls with stable vs varying prefixes, reporting cache counters/latency);
optional `cachedContents` plumbing behind the flag. Design-only: the
probe/recall prompt restructuring (collides with T1's prompt territory;
wave-2, gated).

**Offline validation.** `npm test` (provider + cost-accounting green;
`prefixCacheContract.test.ts` untouched and passing), `npm run lint`;
mock-provider paths byte-identical with flag off; new tests for usage parsing
and (if built) cache-key lifecycle.

**Live protocol (WRITE only)** — `docs/experiments/EXP-T4-gemini-caching.md`:
(1) measurement matrix via the script (~50-100 small calls) establishing
implicit-hit thresholds and discounts on gemini-3.5-flash; (2) observability
soak: one PaySwift 3-query pipeline run logging cached/thoughts tokens per
stage; (3) the future restructuring A/B (30q gate + T3 recall@k +
token-accounting comparison), fully specified and labeled wave-2-gated.

**Out of scope.** Editing probe/recall/prompts on mainline; changing default
thinking behavior; non-Gemini providers; rate-limit/retry redesign; README
claims before measurement.

**Definition of done.** Usage observability merged (default behavior
byte-identical); measurement script merged; measured cost-model memo with a
go/no-go between implicit-restructure vs explicit-cache vs do-nothing incl.
500K/1M break-even math; written gated experiment; flag surface documented in
`docs/GEMINI.md`.

---

## Sequencing

**Merge window (wave 1.5, orchestrator-owned).** Integrate T1 (`ask.ts`
wiring + capsule replacement begins) and T2 (`selectCandidates` swap +
adapter descriptors) as two separate, serially-gated changes — each gated on
`npm test` + `npm run eval` + PaySwift 30q + T3 recall@k + (T1) 3-trial
confirmation on flipped queries. T1's schema names get `CSM_JSON_SCHEMAS`
entries here. Expected combined effect: summarization/event_ordering recall@k
up, BEAM projection toward ~0.77+, probe fan-out possibly below 7.25.

**Wave 2 order:** T5 MCP server (can start anytime — zero overlap), T4
phase-2 restructuring (with T1's merged prompts), T6 contradiction (reuses
T1 machinery, owns synthesize.ts), T7 probe batching (if still a bottleneck),
T9 evidence refresh (3-trial rows once T1/T2 settle).

**Wave 3 / blocked:** T8 scale (blocked on T2+T3+T4), T10 Committer autonomy
(after the score campaign; plan-mode start), AMB officialization resume (the
terminal milestone — after T1+T2 land and the latency stack re-measures at
the ~6-7s BEAM target; T3 predicts category scores before the full-run spend).

**Standing rules for every brief:** read path never mutates durable memory
(`tests/mutationSafety.test.ts` is the oracle); writes only via
`appendEventAndSnapshot`/`applyCommitDecision`; all LLM JSON through Zod +
`providerJson`; never strip `<<MOCK_RESULT>>` fences; recall cites
shard/snapshot/event IDs; no benchmark gold in retrieval logic ever;
gemini-3.5-flash stays the workhorse, cheaper models only behind measured
gates; JSON/JSONL only, no DB/vector-store dependency (T2's index stays
flat-file/in-memory per the `data/eval/embeddings/` precedent); LLM-input
changes need accuracy gates, schedule-only changes need token-identity proof.

## Addendum — state at dispatch (HEAD `19e3ac1`)

Landed after the planner's grounding commit and binding on all briefs:

- `src/core/ask.ts` now contains opt-in eager tier-2 recalls
  (`CSM_EAGER_RECALLS`, measured no-op on PaySwift, default off), the
  extracted `probeQualifiesForRecall()` predicate, `resolveEagerRecalls()`,
  and `AskRunResult.discardedRecalls`. The "recall-as-probes-complete" lever
  is RESOLVED — the merge window is not blocked on it.
- Probe-model verdict: `CSM_PROBE_MODEL=gemini-2.5-flash-lite` is gated
  (29/30, 7.15 s avg pipeline, −9% input tokens) and documented as the
  recommended opt-in; not a hard default pending BABILong/BEAM checks.
- Gate ledger lives in `docs/PERF_BREAKDOWN.md`.
