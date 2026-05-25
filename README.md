# Context Swarm Memory (CSM)

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Tests](https://img.shields.io/badge/tests-196%20passing-brightgreen.svg)
![Node](https://img.shields.io/badge/node-%E2%89%A520-339933.svg)
![Status](https://img.shields.io/badge/status-R%26D%20prototype-orange.svg)

<p align="center">
  <img src="docs/assets/context-swarm-memory-cover.png" width="960" alt="Context Swarm Memory cover showing memory shards passing through a CSM memory lens into a cited memory packet">
</p>

**A memory whose edge *grows* as it scales — instead of degrading.**

CSM is an R&D memory system where bounded LLM-context **memory shards** act as read-only witnesses. A Memory Manager routes a query to candidate shards, probes them cheaply, recalls from only the useful ones, and synthesizes a compact, **cited** answer. Durable memory changes only through an explicit Committer protocol. It is an alternative to / complement of classic RAG, built for narrative, evolving project memory.

---

## The headline

Conventional memory degrades as it fills up — more history means more to sift, and retrieval/context quality falls off. **CSM is built so it doesn't.** Scaling the corpus 10× (100K → 1M tokens) at a fixed 8K-token window, CSM is the only system that keeps its accuracy, while vanilla RAG degrades and brute-force long-context collapses.

<p align="center"><img src="docs/assets/scaling.svg" width="560" alt="Accuracy as memory scales 10x: CSM holds (90->93%), vanilla RAG degrades (97->83%), long-context stays collapsed (37->30%)"></p>

At 1M tokens, CSM **overtakes vanilla RAG** (they were tied at 100K) and beats long-context **28–9, exact McNemar p<0.0001** — at **zero LLM-indexing cost** (keyword indexing, no LLM calls), where long-context physically can't fit the corpus (8K = 0.06% of 1M) and embedding-RAG degrades under the added distractors. *The more CSM remembers, the more its edge shows.*

> Honest calibration: single-trial; CSM's absolute accuracy is ~27–30/30 across runs (Gemma at temp=0 is not bitwise-deterministic across processes), so the robust claim is **"does not degrade as memory grows, while the alternatives do"** — not that its raw score climbs.

## Results — beating the 2025 SOTA

Same 30-query benchmark, same 100K-token corpus, same local Gemma 4 31B answering for **every** system (8K context, temp 0) — only the retrieval/memory layer differs. CSM beats **LightRAG**, a 2025 graph-RAG SOTA, on accuracy (paired exact McNemar **p=0.031**) and leads clearly on **citation grounding quality**:

<p align="center"><img src="docs/assets/citation-f1.svg" width="560" alt="Citation F1 by system at 100K: CSM 0.505, hybrid RAG 0.455, vanilla RAG 0.446, LightRAG 0.265, long-context 0.067"></p>

- **vs LightRAG (2025 SOTA): CSM wins** — citation F1 0.505 vs 0.265, accuracy ≥27/30 vs 24/30 (p=0.031). Mem0 and HippoRAG could not be made to run locally on consumer hardware — documented as **blocked, not beaten** ([`SOTA_COMPARISON.md`](SOTA_COMPARISON.md)).
- **vs vanilla / hybrid RAG: accuracy is a statistical tie** (overlapping CIs; the lead flips run-to-run within nondeterministic noise). CSM's honest edge is *citation quality* + **zero-LLM indexing**, not an accuracy gap — we don't dress a near-tie as a rout.
- **The cost is latency:** CSM is ~3.5× slower than RAG per query (the probe → recall → synth → answer chain). Fine for offline project memory; the open problem for interactive use.

Full numbers, per-query breakdown, significance, and methodology: [`SOTA_COMPARISON.md`](SOTA_COMPARISON.md) · [`PHASE_30Q_RESULTS.md`](PHASE_30Q_RESULTS.md) · [`docs/BENCHMARK_METHODOLOGY.md`](docs/BENCHMARK_METHODOLOGY.md).

## How it works

```mermaid
flowchart TD
    Q[User query] --> D[Memory Directory<br/>read-only manifest of shards]
    D --> R[Router · keyword + tag scorer<br/>no LLM]
    R --> P[Probe · cheap relevance pass per shard]
    P --> RC[Recall · structured answer from selected shards]
    RC --> S[Synthesize · merge, dedupe, flag conflicts]
    S --> MP([MemoryPacket → agent])
    C[Committer · explicit, gated] -. new immutable snapshot .-> D
```

- **The read path is branch-and-discard.** `ask()` never mutates durable memory — it only appends a query-run log. Enforced by `tests/mutationSafety.test.ts` with SHA-256 file hashes.
- **Writes are Committer-gated.** Durable memory changes only via `appendEventAndSnapshot` (user `remember`) or `applyCommitDecision` (Committer). Snapshots are immutable and versioned; the storage layer refuses overwrites.
- **Indexing is LLM-free.** Routing is a keyword/tag scorer, so index cost stays ~0 regardless of corpus size — which is *why* CSM scales where LLM-indexed systems (LightRAG, Mem0, HippoRAG) cannot on consumer hardware.

## Quickstart

```bash
npm install
npm test                       # 196 tests, no API keys (deterministic MockProvider)

npm run csm -- init
npm run csm -- shard create --name "Project X" --tags x,architecture
npm run csm -- remember --shard <shardId> --text "Decision: ..." --tags ...
npm run csm -- ask "What did we decide about X?"
```

The default provider is a deterministic MockProvider (no network). To run the real local benchmark on Ollama + Gemma 4 (RTX 4090, zero API cost), see [`docs/REPRODUCING.md`](docs/REPRODUCING.md).

## Evaluation

- **Corpus — PaySwift:** a synthetic 22K-event / ~9M-token project log with 30 multiple-choice queries (40 options each) and gold source-event citations. Released **CC0**. (A BABILong free-form path is wired but not yet driven.)
- **Baselines:** long-context, vanilla RAG, hybrid RAG, CSM — plus 2025-SOTA sidecars (LightRAG runs; Mem0 / HippoRAG blocked locally).
- **Scoring is programmatic:** exact-match accuracy + citation precision/recall/F1 + bootstrap 95% CIs + paired exact McNemar. The same answering model is used for every system, so only retrieval differs.
- **Reproducible + cached:** every (model, prompt) is content-hashed, so replays cost zero LLM calls (`npm run bench:replay -- <runId>`). Charts regenerate via `npx tsx scripts/build-readme-charts.ts`.

## Limitations

- **Single-trial + measured nondeterminism.** CSM is ~27–30/30 across runs (temp=0 is not bitwise-deterministic across processes); a 3-trial run to pin a mean ± CI is pending.
- **Latency.** CSM's pipeline is ~3.5× slower than RAG per query.
- **Scope.** All numbers are Gemma 4 31B Q4_K_M on one RTX 4090, at 100K + 1M corpus sizes; other models and the full corpus × context sweep are future work.

## Documentation

| Doc | What |
|---|---|
| [`SOTA_COMPARISON.md`](SOTA_COMPARISON.md) | CSM vs 2025 SOTA — LightRAG head-to-head, Mem0/HippoRAG findings, McNemar significance, integration audit |
| [`PHASE_30Q_RESULTS.md`](PHASE_30Q_RESULTS.md) | Full results — per-query breakdown, scaling table, embedding-floor analysis |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 5-minute architecture overview |
| [`docs/BENCHMARK_METHODOLOGY.md`](docs/BENCHMARK_METHODOLOGY.md) | Authoritative methodology + threats to validity |
| [`docs/REPRODUCING.md`](docs/REPRODUCING.md) | Step-by-step reproduction on a local 4090 |
| [`docs/COST_ACCOUNTING.md`](docs/COST_ACCOUNTING.md) | Token/latency cost model |
| [`specs/`](specs/) | Full design spec, benchmark + release plan, corpus design |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`CHANGELOG.md`](CHANGELOG.md) | Contributor guide · release notes |

## License

This project is open source under the **MIT License** ([`LICENSE`](LICENSE)). You may use, copy, modify, merge, publish, distribute, sublicense, and sell copies of the software under the license terms. The synthetic benchmark corpus under `data/eval/corpus-synthetic/` is original work released under **CC0**.

Author/contact: Mohamad Jawdat Alakoum ([LinkedIn](https://www.linkedin.com/in/akoum/)).
