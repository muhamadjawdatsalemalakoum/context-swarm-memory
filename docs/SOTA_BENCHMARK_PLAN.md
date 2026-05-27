# SOTA Benchmark Status

This is the public bar for answering the uncomfortable question:

> Does CSM provide something current memory systems do not, or are we just
> beating old RAG baselines?

Short answer: RAG and hybrid RAG are controls, not the SOTA bar. The credible
claim must be tested against current memory and graph-memory systems, plus
long-memory benchmarks that stress scale, updates, and provenance.

## 2026 Freshness Gate

As of 2026-05-25, the repo does **not** have enough current frontier-model
coverage to claim 2026 SOTA. LightRAG is a useful 2025 graph-RAG comparator, and
BABILong is useful external evidence, but the committed BABILong Space
leaderboard snapshot is historical rather than a live 2026 frontier-model board.

Any future SOTA claim must pass `docs/BENCHMARK_FRESHNESS.md`: current model
families, exact model IDs, run dates, same-harness rows where possible, and
stale leaderboards labeled as stale.

## Selected 2026 Benchmark Decision

Use two external tracks, because they test different parts of the CSM thesis:

1. **Primary scale/SOTA track: Agent Memory Benchmark (AMB) + BEAM.**
   AMB is the best immediate public harness because it publishes datasets,
   prompts, scoring logic, results, and a live leaderboard, while explicitly
   targeting memory systems rather than old 32K-context retrieval tests. BEAM is
   the key dataset inside this family for CSM's scale claim: coherent
   conversations up to 10M tokens, 100 conversations, and 2,000 validated
   questions. This is the first benchmark to integrate for the claim "CSM stays
   useful when the memory is larger than native context."

2. **Primary agentic/task track: Microsoft STATE-Bench Memory Track.**
   STATE-Bench was released in May 2026 and evaluates whether memory improves
   realistic multi-turn enterprise tasks, not just whether a system can retrieve
   a fact. Its Memory Track adds train trajectories and a retrieval hook for
   procedural learnings while keeping task simulators, tools, judges, and
   metrics consistent. This is the right benchmark for "does memory make an
   agent perform better with experience?"

3. **Secondary academic checks: MemoryAgentBench and MemoryArena/AMA-Bench.**
   These are important 2026 academic references for paper polish and breadth,
   but they should not become the README headline until CSM has clean adapters
   and saved per-row results.

This means the README should stop treating BABILong as the next SOTA headline.
BABILong remains useful external diagnostic evidence. The first AMB/BEAM 100K
CSM-vs-Hindsight run is now complete locally; the next public bar is independent
replication/official submission for that result, then STATE-Bench.

## North Star Comparator

Treat **Hindsight** as the named system to beat. Its public positioning is the
right bar for CSM: agent memory that learns over time, not just chat-history
recall; a two-line wrapper path; retain/recall/reflect APIs; and a benchmark
story centered on state-of-the-art long-term memory performance. The CSM claim
must therefore be sharper than "better than RAG":

- Beat Hindsight on the same AMB/BEAM rows, or say clearly where it does not.
- Compare retrieval quality, answer quality, cost, latency, and indexing/update
  cost.
- Preserve CSM's differentiators: read-only query path, Committer-only writes,
  immutable snapshots, event-level citations, and no LLM indexing by default.
- If Hindsight wins on answer quality, use the row-level failures to improve CSM
  rather than weakening the benchmark.

## Current Claim Boundary

The repo now includes two real head-to-head evidence bundles:

- LightRAG ran on the same 30-query PaySwift benchmark and CSM won on that
  saved run.
- AMB/BEAM 100K ran to completion for CSM and was compared against the accepted
  local Hindsight artifact on the same split, answer model, judge model, and
  scoring code. CSM scored 0.757573 with 342/400 correct rows versus Hindsight
  at 0.733658 with 326/400 correct rows. See
  [`docs/BEAM_100K_CSM_VS_HINDSIGHT.md`](BEAM_100K_CSM_VS_HINDSIGHT.md).
- BABILong is now driven as public external diagnostic evidence on a 120-row
  task1/task2 subset with Gemini 3.5 Flash and 4K physical context. The public
  Space leaderboard snapshot is not current 2026 SOTA. See
  [`docs/BABILONG_RESULTS.md`](BABILONG_RESULTS.md).
- Mem0 and HippoRAG 2 sidecars are wired, but the public evidence treats their
  local failures as blocked integrations, not as CSM wins.
- The present public claim is therefore: CSM beats LightRAG on this traceable
  project-memory task and beats the accepted local Hindsight BEAM 100K artifact
  on AMB score/correct rows, while being slower and more internally token
  intensive. It is not yet a field-wide "beats every SOTA memory system" claim
  or an externally certified leaderboard placement.

That distinction matters. If a stronger system wins on the same harness, we
publish it and learn from it.

## Target SOTA Set

As of 2026-05-25, these are the systems and benchmarks that should define the
next comparison ladder. Use primary sources when updating this table.

| Target | Why it matters | Repo status | Source |
|---|---|---|---|
| LightRAG | Graph-based dual-level retrieval; already the cleanest runnable 2025 graph-RAG comparator. | Integrated and published as `lightrag`. | <https://arxiv.org/abs/2410.05779> |
| Mem0 / Mem0 Graph | Production agent memory with dynamic extraction, consolidation, retrieval, and LoCoMo claims. | Sidecar wired; local run blocked and disclosed. | <https://arxiv.org/abs/2504.19413> |
| HippoRAG 2 | ICML 2025 graph/RAG memory system claiming factual, sense-making, and associative-memory gains. | Sidecar wired; local packaging/indexing blocked and disclosed. | <https://arxiv.org/abs/2502.14802> |
| Microsoft GraphRAG / DRIFT | Canonical Microsoft graph-RAG stack with global/local/DRIFT query modes and expensive LLM indexing. | Not integrated yet. Priority P1 sidecar. | <https://microsoft.github.io/graphrag/> |
| Graphiti / Zep | Temporal context graph for evolving agent memory, provenance, and historical queries. | Not integrated yet. Priority P1 sidecar. | <https://github.com/getzep/graphiti> |
| APEX-MEM | Conversational memory system combining append-only temporal property graphs with multi-tool retrieval. | Not integrated yet. Priority P1 after Graphiti/GraphRAG because it stresses temporal conflicts directly. | <https://arxiv.org/abs/2604.14362> |
| LightMem / LIGHT | 2026 memory-augmented generation system focused on accuracy/cost tradeoffs. | Not integrated yet. Priority P1 after code path is verified. | <https://arxiv.org/abs/2510.18866> |
| Hindsight | North-star agent memory system to beat: retain/recall/reflect, mental-model learning, parallel semantic/keyword/graph/temporal recall, public LongMemEval/AMB-style positioning. | **Full local BEAM 100K comparison complete:** CSM 0.757573 / 342 correct vs accepted Hindsight 0.733658 / 326 correct. Next: package for independent replication and official chart submission. | <https://github.com/vectorize-io/hindsight> |
| Agent Memory Benchmark (AMB) | Open memory-system harness with public datasets, prompts, scoring logic, results, Gemini-based generation/judging, cost/latency tracking, and a live leaderboard. | **Integrated and run:** `integrations/amb/csm_provider.py`, `npm run amb:patch`, `npm run amb:csm:retrieve`, and a completed BEAM 100K CSM row with telemetry. | <https://github.com/vectorize-io/agent-memory-benchmark> |
| BEAM | Benchmark for coherent conversations up to 10M tokens; directly probes the "beyond native context" thesis. | **P0 scale benchmark complete at 100K:** full CSM-vs-Hindsight artifact comparison exists. Next: 500K/1M/10M where API budget allows. | <https://arxiv.org/abs/2510.27246> |
| Microsoft STATE-Bench | May 2026 benchmark for realistic multi-turn enterprise tasks with stateful tools, deterministic assertions, Memory Track train trajectories, retrieval hook, pass@1/pass^5/UX/cost metrics. | **Selected P0 agentic-memory benchmark.** Add an adapter only after AMB/BEAM smoke results exist. | <https://github.com/microsoft/STATE-Bench> |
| MemoryAgentBench | ICLR 2026 incremental multi-turn memory benchmark covering accurate retrieval, test-time learning, long-range understanding, and conflict resolution. | Not integrated yet. Priority P1 academic validation after AMB/BEAM. | <https://github.com/HUST-AI-HYZ/MemoryAgentBench> |
| MemoryArena / AMA-Bench | 2026 agent-memory benchmarks for interdependent multi-session tasks and long-horizon agent trajectories. | Not integrated yet. Priority P1/P2 breadth checks; useful for paper appendix, not the first README headline. | <https://memoryarena.github.io/> |
| LongMemEval | ICLR 2025 long-term chat memory benchmark with information extraction, multi-session reasoning, temporal reasoning, updates, and abstention. | Not integrated yet. Priority P2 diagnostic because 2026 million-token models can sometimes context-stuff it. | <https://arxiv.org/abs/2410.10813> |
| LoCoMo | Common long-term conversational memory benchmark used by Mem0, A-MEM, and related systems. | Not integrated yet; useful but should be treated carefully because it is partly judge-based. | <https://arxiv.org/abs/2402.17753> |
| BABILong | Long-context reasoning-in-haystack benchmark up to 10M tokens; useful but the public Space leaderboard snapshot is not current 2026 SOTA. | **Driven:** task1/task2 at 4K/8K, 30 rows/cell, CSM only. Task1 is solved; task2 exposed and then improved by entity-bridge recall. Needs full QA1-QA5 plus fresh frontier-model rows before any SOTA claim. | <https://arxiv.org/abs/2406.10149> |
| A-MEM | NeurIPS 2025 agentic Zettelkasten-style memory with dynamic linking/evolution. | Not integrated yet; benchmark if the released code can ingest our corpus. | <https://arxiv.org/abs/2502.12110> |
| AgeMem | 2026 RL-trained agentic memory policy for long/short-term memory actions. | Not integrated yet; likely not apples-to-apples unless a runnable inference system is released. | <https://arxiv.org/abs/2601.01885> |
| MemOS / MemoryOS | Memory-as-OS architecture and lifecycle/governance comparator. | Not integrated yet; first compare feature/operational surface, then benchmark if runnable. | <https://arxiv.org/abs/2505.22101> |
| ShardMemo | Closest published cousin to CSM: sharded agentic memory with masked routing. | No runnable adapter found yet; keep as architectural comparator until code is available. | <https://arxiv.org/abs/2601.21545> |

## Benchmark Axes

No single benchmark proves the thesis. Use a ladder:

| Axis | Question answered | Required metrics |
|---|---|---|
| Traceable project-memory QA | Can the system find exact decision facts in an evolving project corpus? | accuracy, citation precision/recall/F1, paired McNemar, per-query rows |
| Scale under fixed context | Does performance degrade as corpus grows beyond the model window? | 100K/1M/2M/9M accuracy, citation precision/recall/F1 slopes, input tokens, latency |
| Indexing and update cost | Does the system require expensive LLM indexing or full graph recomputation? | index wall time, index input/output tokens, disk size, cache hit rate, incremental update time |
| Long conversational memory | Does it handle multi-session, temporal, update, and abstention questions? | LongMemEval/LoCoMo/BEAM category scores, judge prompts if any, raw answers |
| Mutation safety | Does asking mutate durable memory? | before/after hashes, write-path audit, query-run-only log proof |
| Provenance and auditability | Can every answer point to specific source events? | event-level citation F1 and malformed-citation rate |
| Operational viability | Can an outside reviewer install and run it? | lockfiles/container, run command, failure logs, hardware/API assumptions |

## Runnable Commands

Summarize the committed SOTA evidence:

```bash
npm run bench:sota:headline
```

Summarize whether each system improves, stays stable, or degrades as corpus
size grows:

```bash
npm run bench:sota:scaling
```

Smoke-test the CSM-vs-LightRAG SOTA path once the LightRAG sidecar is running:

```bash
npm run bench:sota:smoke
```

Run the currently wired SOTA sidecars at 100K:

```bash
npm run bench:sota:sidecars
```

The sidecar commands require the services documented in `services/README.md`.
They should fail loudly if a sidecar is not running; do not turn sidecar failures
into benchmark wins.

## Go / No-Go Rules

A public "SOTA" claim is allowed only when:

- every compared system has a saved `results.jsonl`, config, and failure-free
  query rows, or is explicitly marked as blocked with reproducible install/run
  evidence;
- CSM and the comparator use the same answering model and scoring code;
- the claim is paired by query ID, not assembled from unrelated leaderboards;
- accuracy claims include confidence intervals and paired significance where
  applicable;
- citation claims use source-event IDs, not LLM-judge vibes;
- cost claims include indexing cost, not only query-time cost;
- any judge-based benchmark saves raw judge prompts and responses.

For the stronger scaling claim ("CSM gets better or more precise with more
data"), the bar is higher:

- at least two corpus sizes per compared system in the same model/context track;
- accuracy, citation precision, citation recall, and citation F1 reported
  separately;
- no "better with scale" claim if accuracy rises but citation F1/recall falls
  without saying so;
- no SOTA scaling claim while the SOTA comparator has only one corpus-size row.

If CSM only ties on accuracy, the claim must say so. The unique value can still
be real if CSM wins on citation grounding, write safety, indexing/update cost,
or scale, but those dimensions must be measured directly.

## Next Implementation Order

1. Package the completed AMB/BEAM 100K CSM-vs-Hindsight run for independent
   replication and official chart submission, preserving the accepted Hindsight
   comparator and the CSM telemetry sidecar.
2. Replace the AMB bridge's per-query Node subprocess with a warm retrieval
   service before larger BEAM runs.
3. Run AMB/BEAM at 500K, 1M, and 10M where feasible, saving per-row
   outputs, prompts, judge responses, token/cost accounting, and leaderboard
   snapshot metadata.
4. Add Microsoft STATE-Bench Memory Track adapter and run one domain smoke test
   before broadening to all 450 tasks.
5. Add MemoryAgentBench smoke coverage for AR/TTL/LRU/CR as an academic
   validation set.
6. Extend BABILong beyond the committed task1/task2 4K/8K subset: add task3,
   32K/128K lengths, and paired long-context/RAG baselines.
7. Add a Graphiti/Zep sidecar using the existing `/index` and `/query` protocol.
8. Add a Microsoft GraphRAG sidecar with global/local/DRIFT modes.
9. Attempt LightMem with the authors' released code and record install/runtime
   blockers if it cannot run cleanly.
10. Re-run CSM, LightRAG, Graphiti/GraphRAG, Mem0/HippoRAG if unblocked, and
   baseline controls with 3 trials.
11. Re-run the BEAM 100K comparison with a warm service and repeated trials if
   the official submission path requests confidence intervals beyond the
   accepted full-row artifact.

## What Would Be Meaningful

The strongest CSM thesis is not "we beat vanilla RAG on a tiny leaderboard."
It is:

- event-level citations remain sharp as memory grows;
- reads are provably non-mutating;
- durable writes are explicit and auditable;
- indexing does not require LLM extraction over the corpus;
- the system still works where full-context and LLM-indexed graph systems become
  operationally expensive.

That is the thing worth proving. Everything else is table stakes.
