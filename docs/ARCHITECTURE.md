# Context Swarm Memory — Architecture Overview

A fast-read distillation. Authoritative design: [`../specs/context_swarm_memory_spec.md`](../specs/context_swarm_memory_spec.md). Current file map: [`../CLAUDE.md`](../CLAUDE.md).

## Framing

CSM stores durable memory as bounded **shards** (saved system prompt + event log +
metadata, frozen as immutable **snapshots**) and queries them as read-only witnesses.
A user query fans out through a four-stage pipeline (**router → probe → recall →
synthesize**) that loads snapshots into disposable LLM calls and returns a compact
`MemoryPacket` to the main agent. Durable memory only changes through an explicit
**Committer** protocol that the read pipeline never touches.

## The pipeline

```
User query
    ↓
Memory Directory  ← read-only manifest of shards
    ↓
Router (router.ts)              keyword + tag + recency − staleness − fullness
    ↓
Probe (probe.ts)                cheap relevance pass per candidate
    ↓
Recall (recall.ts)              full structured answer from selected shards
    ↓
Synthesizer (synthesize.ts)     merge, deduplicate, flag conflicts
    ↓
MemoryPacket → Main Agent
    │
    └── (separately) Committer (commit.ts)  →  new immutable snapshot
                                              + chronicle entry
```

- **Router** — scores `MemoryDirectoryEntry`s against the query (keywords, tags,
  recency, staleness, fullness) and returns the top-N candidates. No LLM call.
- **Probe** — per-candidate cheap LLM pass: `knows? confidence? memoryType?
  relevantEventIds?`. Drops irrelevant shards before the expensive recall.
- **Recall** — full structured LLM answer scoped to `relevantEventIds`, capped
  by `maxRecallTokensPerShard` (default 1200 input tokens).
- **Synthesize** — merges multiple recalls, resolves conflicts, emits the
  `MemoryPacket`. Skipped deterministically when ≤ 1 recall.
- **Orchestrator** — [`src/core/ask.ts`](../src/core/ask.ts) wires the four stages,
  accumulates cost, and appends one record to `query-runs.jsonl`.

## Five core invariants

1. **Branch-and-discard reads.** The query path NEVER appends events, writes
   snapshots, or mutates the chronicle. A query is a temporary branch on a
   snapshot, discarded after the answer.
2. **Single durable-write entry point.** Durable memory only changes through
   `appendEventAndSnapshot` (called by `csm remember`) or `applyCommitDecision`
   (Committer). No other code path is allowed to write a snapshot or chronicle
   event.
3. **Snapshots are immutable and versioned.** IDs go `S001`, `S002`, … The
   storage layer (`JsonlStorage.writeSnapshot`) refuses overwrites at the file
   level.
4. **Summaries are indexes, not sources of truth.** The directory is a fast
   manifest for routing; recall always reads the underlying snapshot events.
5. **Recall must cite shard ID, snapshot ID, and event IDs.** Every claim in a
   `MemoryPacket` is traceable to `<shardId>@<snapshotId>` plus the relevant
   `eventId`s. Unsourced output is treated as a bug.

`tests/mutationSafety.test.ts` enforces invariants 1–2 with SHA-256 hashes of
every durable file before/after `ask()`.

## Storage layout

All on-disk state lives under `data/` (created by `csm init`):

```
data/
  directory.json                       compact MemoryDirectory of all shards
  chronicle.jsonl                      append-only durable-write event log
  query-runs.jsonl                     append-only read-path audit log
  shards/<shardId>/
    manifest.json                      per-shard metadata + current snapshotId
    snapshots/<snapshotId>.json        immutable; one file per version
```

`query-runs.jsonl` is the **only** file the read path is allowed to append to.
Paths are resolved by [`src/storage/paths.ts`](../src/storage/paths.ts); all
filesystem I/O is gated through [`src/storage/jsonlStorage.ts`](../src/storage/jsonlStorage.ts).

## Provider seam

Every LLM call goes through the `LlmProvider` interface
([`src/providers/LlmProvider.ts`](../src/providers/LlmProvider.ts)), so the
pipeline shape does not change between mock and real backends.

- **`MockProvider`** (default) — deterministic; returns Phase-0 keyword results
  embedded in a `<<MOCK_RESULT>>…<</MOCK_RESULT>>` fence inside each prompt.
  Tests run without API keys.
- **`OpenAIProvider`** — real `fetch`, OpenAI-compatible. Doubles as the Ollama
  backend (Ollama exposes an OpenAI-compatible endpoint at `:11434/v1`).
- **`OllamaProvider`** — thin wrapper around `OpenAIProvider` with Gemma-4-on-4090
  defaults (`gemma4:e4b` probe, `gemma4:31b` recall/synth).
- **`GeminiProvider`** — native Gemini API provider; accepts `GEMINI_API_KEY` or
  `GOOGLE_API_KEY` and defaults to `gemini-3.5-flash`.
- **`AnthropicProvider`** — Phase 1 stub.

All LLM JSON outputs are validated through Zod schemas in
[`src/core/schemas.ts`](../src/core/schemas.ts) via the
`providerJson` retry/`extractJson`/parse helper. Never `JSON.parse` provider
output directly.

## Eval harness

[`src/eval/`](../src/eval/) holds the benchmark machinery: `baselines/` (csm,
vanillaRag, hybridRag, longContext), `runner.ts` + `scorer.ts` (orchestration and
grading), `mcq.ts` (multiple-choice helpers), `corpus.ts`/`fixtures.ts`/`embed.ts`
(corpora + embeddings), `cache.ts`/`cachedLlm.ts` (replayable provider-call cache),
`plotter.ts` (charts/tables), and `runEval.ts` (smoke eval; `npm run eval`).
See [`BENCHMARK_METHODOLOGY.md`](./BENCHMARK_METHODOLOGY.md) for the full
methodology, cache/replay flow, and metric definitions.

## Pointers

- Full design spec: [`../specs/context_swarm_memory_spec.md`](../specs/context_swarm_memory_spec.md)
- Complete file map and dev workflow: [`../CLAUDE.md`](../CLAUDE.md)
- CLI quickstart and provider env-var matrix: [`../README.md`](../README.md)
