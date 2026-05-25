# SOTA Benchmark Plan

This is the public bar for answering the uncomfortable question:

> Does CSM provide something current memory systems do not, or are we just
> beating old RAG baselines?

Short answer: RAG and hybrid RAG are controls, not the SOTA bar. The credible
claim must be tested against current memory and graph-memory systems, plus
long-memory benchmarks that stress scale, updates, and provenance.

## Current Claim Boundary

The repo already includes one real SOTA head-to-head:

- LightRAG ran on the same 30-query PaySwift benchmark and CSM won on that
  saved run.
- Mem0 and HippoRAG 2 sidecars are wired, but the public evidence treats their
  local failures as blocked integrations, not as CSM wins.
- The present public claim is therefore: CSM beats LightRAG on this traceable
  project-memory task, and CSM has tested mutation-safety and citation
  discipline. It is not yet a field-wide "beats every SOTA memory system" claim.

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
| BEAM | Benchmark for coherent conversations up to 10M tokens; directly probes the "beyond native context" thesis. | Not integrated yet. Priority P0 dataset/driver. | <https://arxiv.org/abs/2510.27246> |
| LongMemEval | ICLR 2025 long-term chat memory benchmark with information extraction, multi-session reasoning, temporal reasoning, updates, and abstention. | Not integrated yet. Priority P0 dataset/driver. | <https://arxiv.org/abs/2410.10813> |
| LoCoMo | Common long-term conversational memory benchmark used by Mem0, A-MEM, and related systems. | Not integrated yet; useful but should be treated carefully because it is partly judge-based. | <https://arxiv.org/abs/2402.17753> |
| BABILong | Long-context reasoning-in-haystack benchmark up to 10M tokens; already partially wired as free-form support. | Fetch/run path exists; needs canonical public run. | <https://arxiv.org/abs/2406.10149> |
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

1. Add public LongMemEval and BEAM dataset drivers.
2. Finish the BABILong public run path already sketched in the repo.
3. Add a Graphiti/Zep sidecar using the existing `/index` and `/query` protocol.
4. Add a Microsoft GraphRAG sidecar with global/local/DRIFT modes.
5. Attempt LightMem with the authors' released code and record install/runtime
   blockers if it cannot run cleanly.
6. Re-run CSM, LightRAG, Graphiti/GraphRAG, Mem0/HippoRAG if unblocked, and
   baseline controls with 3 trials.
7. Archive the evidence bundle and update `docs/EVIDENCE.md` only after the
   full result rows are saved.

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
