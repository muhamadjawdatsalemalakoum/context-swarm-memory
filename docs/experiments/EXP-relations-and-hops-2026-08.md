# EXP — relations between information & hop reduction (2026-08-01)

Question asked: does CSM under-use *relations between information*, can hop
reduction go further, and would adopting pgGraph (github.com/Evokoa/pgGraph)
help? Method: four parallel research passes — the pgGraph repo itself, an audit
of CSM's existing relation machinery, the measured graph-memory literature, and
a hop-by-hop inventory of the query path. Verdicts below; sources cited inline.

## Verdict 1 — pgGraph: NO (decline)

What it actually is: a **Rust extension inside PostgreSQL** (pgrx), not a
library — SQL-only API in a `graph` schema, no HTTP API, no Node/TS bindings.
It builds in-memory CSR projections over *Postgres tables only* (no JSON/JSONL
ingestion) with a `graph.build()`/sync lifecycle.

Why it does not fit:
- **Adoption is structural, not incremental**: run Postgres 14–18 + custom
  extension, ETL the JSONL chronicle into tables, manage build/sync workers,
  hand-write SQL. Violates the MVP invariant (*no DB, no vector store*) and
  moves durable state outside the files `tests/mutationSafety.test.ts` hashes.
- **Zero published performance numbers.** The project's own contributor guide
  forbids citing its WIP benchmark harness as comparative evidence. "O(1)
  adjacency via CSR" is an architectural claim.
- **Maturity risk**: repo is ~2.5 months old, v1.0.0 is one week old,
  effectively one committer (431 of ~433 commits), open defects include
  `graph.build()` failing on composite-PK junction tables — exactly the shape
  relationship data takes. 698 stars vs 5 watchers/2 contributors is an
  unusual engagement profile.
- **License**: intent is Apache-2.0 (both copyright and patent grants present)
  but the LICENSE file is a condensed rewording — GitHub reports NOASSERTION.
- At CSM's scale (per-user corpora, thousands of events) any traversal we need
  is an **in-process TS adjacency map built from the JSONL at load time** —
  microseconds, no server. pgGraph becomes rational only if storage ever
  migrates to Postgres wholesale, which nothing on the roadmap wants.

## Verdict 2 — relations: YES, but only two mechanisms are evidence-backed

The measured literature (as opposed to vendor claims) is unusually clean about
what graph structure buys a memory system:

**(a) Multi-hop candidate generation — the one thing no reranker can do.**
BABILong QA2/3 fails because the intermediate fact ("Mary travelled to the
hallway") shares no lexical or semantic overlap with the query ("Where is the
milk?") — a candidate-generation miss, invisible to any reranker (incl. our L3
cross-encoder). Measured fixes are associative: HippoRAG's PPR over an entity
graph (+11/+20 R@2/R@5 on 2WikiMultihopQA, arxiv.org/abs/2405.14831); Zyphra's
**non-LLM** graph — shared-noun/entity co-occurrence + embedding-similarity
adjacency, PPR-seeded — holds ~45–55% on QA2/3 at 128k–1M where vanilla RAG is
below random at 8k (zyphra.com/our-work/understanding-graph-based-rag).
LazyGraphRAG (Microsoft) showed the same: noun-phrase co-occurrence at 0.1% of
GraphRAG's indexing cost, equal or better quality. **No LLM extraction needed.**

**(b) Knowledge-update correctness lives at WRITE time, not in topology.**
Zep invalidates contradicted edges bi-temporally at ingest (t_valid/t_invalid,
arxiv.org/abs/2501.13956); Mem0g runs an LLM update-resolver at add-time; the
ForgetEval 13-configuration study (arxiv.org/pdf/2606.15903) finds a
mutation-time LLM hook worth +22–24pts on forgetting correctness *regardless of
storage substrate*, and deterministic date-stamped supersession already scores
100%. In CSM terms this is **Committer-side**, precisely where our write
protocol already lives.

**Everything else is measurably redundant or harmful** for a system with a
strong hybrid retriever: Mem0's own graph variant LOST single-hop (65.7 vs
67.1) *and* multi-hop (47.2 vs 51.2) to its vector base at 2× tokens / 3.3×
search latency (arxiv.org/abs/2504.19413); LightRAG's summary graph scores 6.6
F1 vs 59.8 on simple QA (arxiv.org/abs/2502.14802); Hindsight and Zep publish
**no ablation isolating their graph legs**. Verbatim single-hop retrieval at 1M
is CSM's crown jewel — a graph leg can actively damage it, so any relation
lever gates on the answer metric (the coverage-proxy-anticorrelated lesson).

### What CSM already has (audit)

CSM is relation-*implicit*: entityBridge / lexicalBridge (shard-local term
co-occurrence), shardExpand (dense adjacency), coverage chronicle (date-ordered
temporal relation with in-code date arithmetic, 2-hop term chaining), hybrid
router (query→shard lexical+embedding). All **recomputed per query and
discarded**. Three write-time artifacts encode real relations *as prose*: fact
registry ("metric: v1 -> v2; LATEST: v3"), preference profile ("CURRENT;
previously"), Observation. Only the profile touches disk. Dormant hooks already
exist for persistence: `DirectoryDescriptorFields` has a read path
(`routerIndexFromDirectory`) and **no production writer**; `knownConflicts` is
declared and never populated; shard `parentId/children` never non-trivial.
Bridges are shard-local by construction (csm.ts:204,248) — cross-shard entity
chains are genuinely new machinery. No entity ids/aliasing exist (capitalized
-token heuristics only).

### Planned experiments (relations arc = sharpened L4)

- **R1 — structural co-occurrence graph leg** (no LLM, corpus-derived,
  invariant-compliant): adjacency = shared noun/identifier terms + embedding
  similarity between events, built at ingest (write path — legal); query time
  = 1-hop expansion (or PPR) seeded from retrieved candidates, *before* rerank.
  Gate: BABILong task2/3 (the weakness it targets) with task1 + BEAM
  instruction_following as do-no-harm guards. Mem0g's numbers say expect the
  guard to matter.
- **R2 — write-time supersession edges**: the fact-registry map stage already
  emits pipe-delimited `FACT | metric | value | turn-ref` lines — one step from
  a machine-readable value-history store with valid/invalid stamps written at
  Committer time; recall filters/annotates by validity. Deterministic
  supersession = 100% on ForgetEval without any LLM. Targets knowledge_update.

Neither changes CSM's identity: shards, witnesses, capsule, Committer all
stay; R1 is an additive router/recall signal exactly like the embedding leg
was; R2 deepens the Committer protocol CSM already owns. We are *not* adopting
LLM fact-extraction at ingest (Hindsight's retain()) — that is 75% of
GraphRAG-class indexing cost and LazyGraphRAG showed it is mostly skippable.

## Verdict 3 — hops: mostly won; the remainder is enumerated

Full inventory (18 hops traced): after the 2026-06 fixes only **three real LLM
barriers** remain on the warm path — probe fan-out (72% of pipeline input;
being dismantled by L2a/L2b/L3), recall fan-out (top-1 overlapped via
speculative recall; 94% of 1M queries are single-recall), and the synthesis
tail (~3–4s, fires on only 6.1% of queries — PERF_BREAKDOWN's #1 remaining
latency lever). Warm server overhead is 0–30ms/query.

Actionable leftovers found:
1. **Lazy write-time builds run on the first query** (hybrid router index,
   Observation, fact registry — the 10M-tier registry is ~60 LLM calls charged
   to one arbitrary query's wall clock). Move to `/ingest`; zero answer-visible
   change.
2. **Warm server never passes `preferenceProfile`** — `grep preferenceProfile
   scripts/amb-csm-server.ts` returns nothing while `executeAmbRetrieve`
   supports it and `run-beam-slice.ts` wires it. Confirms readiness-plan P3
   ("profile builder onto server path") as a *correctness* gap, not a nicety:
   an official AMB run through the warm server silently loses the
   knowledge_update lever. Must land before the final Gemini ladder.
3. One-shot bridge (per-query spawn, ~0.6–2s) is historical; A/B-only.
4. Sidecar input-token telemetry confirmed broken (21–25 tok/query reported);
   never synthesize token conclusions from agent-sdk runs' meta.

## Method note

Four independent research agents (repo read, code audit, literature, telemetry
inventory), synthesized against the campaign's standing rules: answer-metric
gating, MDE discipline, corpus-derived-only retrieval signals, write-path-only
persistence. Several literature numbers came through secondary sources
(GraphRAG $33k/5GB figure; Zyphra chart readings; ForgetEval extraction) —
re-verify before quoting publicly.
