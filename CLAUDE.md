# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project
This repo implements **Context Swarm Memory (CSM)**, an R&D system where LLM-backed memory shards are queried as read-only witnesses. A Memory Manager routes a user query to candidate shards, probes them, recalls from useful ones, synthesizes a compact `MemoryPacket`, and only mutates durable memory through an explicit Committer protocol.

See `specs/context_swarm_memory_spec.md` for the full design and `README.md` for the CLI quickstart, provider env-var matrix, and the local Gemma-on-4090-class setup.

## Architecture invariants
- Memory query runs are branch-and-discard. The query path NEVER appends events, writes snapshots, or mutates the chronicle.
- Durable memory changes only through `appendEventAndSnapshot` (initiated by the user via `csm remember`) or `applyCommitDecision` (Committer).
- Shard snapshots are immutable and versioned (`S001`, `S002`, …). The storage layer refuses overwrites.
- Summaries are indexes, not sources of truth.
- Recall must cite shard ID, snapshot ID, and event IDs.
- `query-runs.jsonl` is the only file the read-only `csm ask` path is allowed to append to. `tests/mutationSafety.test.ts` enforces this with SHA-256 file hashes — if you change anything in the read path, run that test.

## Where things live
- `src/core/types.ts` — single source of truth for data types
- `src/core/schemas.ts` — Zod schemas for every LLM JSON output
- `src/core/router.ts` — keyword/tag scorer (Phase 0)
- `src/core/probe.ts`, `recall.ts`, `synthesize.ts` — pipeline stages, all routed through `LlmProvider`
- `src/core/ask.ts` — end-to-end read-only orchestrator (router → probe → recall → synth)
- `src/core/commit.ts` — the only durable-write entry point (`appendEventAndSnapshot`, `dryRunCommit`, `applyCommitDecision`)
- `src/core/split.ts` — Phase 3 fullness recommendations
- `src/core/{prompts,providerJson,tokenBudget}.ts` — prompt constants, retry+extractJson+Zod helper, token budgeting
- `src/storage/jsonlStorage.ts` — JSON / JSONL filesystem layer (refuses snapshot overwrites)
- `src/providers/` — `LlmProvider`, `MockProvider`, `OpenAIProvider` (real fetch, also backs Ollama via OpenAI-compat endpoint), `OllamaProvider` (thin wrapper with Gemma-4090 defaults), `AnthropicProvider` (stub)
- `src/cli/index.ts` — the `csm` CLI; `src/cli/args.ts` — tiny argv parser
- `src/utils/` — `ids.ts`, `json.ts` (incl. `extractJson`, `stableStringify`), `time.ts`
- `src/eval/` — full benchmark harness:
  - `mcq.ts` — `Query` discriminated union (`McqQuery | FreeFormQuery`), `Answer` union, prompt formatters, output parsers, type guards
  - `answer.ts` — `buildPrompt` + `parseAnswer` dispatchers used by every baseline
  - `scorer.ts` — programmatic scoring (exact-match for MCQ; normalised exact-match for free-form), bootstrap CI, paired McNemar, Benjamini-Hochberg
  - `cache.ts` — content-hashed Ollama response cache, atomic writes
  - `corpus.ts` — `BenchEvent` schema, tiered sampling, sweep constants, `loadAllEvents`
  - `corpus/babilong.ts` — BABILong loader for Tasks 1–3 (free-form needle-in-haystack)
  - `embed.ts` — `@xenova/transformers` embedding helper (disk-cached)
  - `cachedLlm.ts` — cache-wrapping LLM caller used by every baseline
  - `runner.ts` — sweep-aware matrix runner with adaptive 50%-accuracy early-stop, resumable, replayable
  - `plotter.ts` — Vega-Lite spec generator for Graphs A–F of the context-scaling study
  - `baselines/{types.ts, longContext.ts, vanillaRag.ts, hybridRag.ts, csm.ts}` — 4 baseline runners sharing a common interface
  - `runEval.ts` + `fixtures.ts` — the legacy smoke eval (preserved for `npm run eval`)
- `scripts/` — one-shot helpers: `merge-phase-events.ts`, `merge-query-batches.ts`, `expand-filler.ts`, `build-corpus.ts`, `verify-corpus.ts`, `verify-no-leakage.ts`, `fetch-babilong.ts`, `run-babilong-bench.ts`, `render-plots.ts` (Vega-Lite spec → SVG)
- `data/eval/corpus-synthetic/` — PaySwift corpus (163 core events + tier-1/2/3 filler), `decisions.md`, `queries.json`
- `data/eval/corpus-babilong/` — BABILong raw downloads + README (filled by `scripts/fetch-babilong.ts`)
- `tests/` — flat layout, vitest, includes `mutationSafety.test.ts`

## Commands
- `npm test` — vitest, runs without API keys (uses MockProvider)
- `npm run test:watch` — vitest in watch mode
- `npx vitest run tests/router.test.ts` — single file
- `npx vitest run -t "router_recall"` — single test by name
- `npm run lint` — `tsc --noEmit` (there is no eslint/prettier in this repo; the type-check IS the lint)
- `npm run build` — `tsc -p tsconfig.json` to `dist/`
- `npm run eval` — runs the smoke eval (`src/eval/runEval.ts`); rerun after changing router, probe, recall, synthesis, or split thresholds
- `npm run csm -- <subcommand>` — runs the CLI via tsx without building (e.g. `npm run csm -- ask "…"`); `npm run dev` is the same thing
- `npm run bench:smoke` — fast end-to-end smoke against MockProvider on the real PaySwift corpus (validates plumbing; produces wrong answers because mock doesn't follow MCQ format, but exercises every code path)
- `npm run bench:full` — full sweep matrix on local Ollama (Gemma 4); ~30–50 min on a 4090 once filler is at 10M+; Ollama must be running with `gemma4:31b` and `gemma4:e4b` pulled
- `npm run bench:replay <runId>` — recompute summary from cached responses, no LLM calls (<5 min)
- `npm run bench:report <runId>` — generate Vega-Lite spec files + `report.md` from a run's summary
- `npx tsx scripts/fetch-babilong.ts` — one-shot download of BABILong Tasks 1–3 at the chosen context lengths (logs every URL it tries; falls back to manual placement instructions if HF returns 404)
- `npx tsx scripts/render-plots.ts <runId>` — render the Vega-Lite spec files in `data/eval/runs/<runId>/plots/` to SVGs alongside the JSON. Pure server-side render; no canvas/browser/PNG step. SVGs embed directly into Markdown.

## Development workflow
- Start in plan mode for architectural changes that touch the read-only invariants.
- For mutation paths, add tests. Hash before/after if you're not sure — `tests/mutationSafety.test.ts` shows the pattern.
- Run `npm test` and `npm run build` (or at least `npm run lint`) before declaring done.
- Run `npm run eval` after changing router/probe/recall/synthesis/split thresholds.
- All LLM JSON outputs MUST go through a Zod schema in `src/core/schemas.ts` and the `providerJson` retry/parse helper. Never `JSON.parse` provider output directly.

## Mock provider convention
`MockProvider` returns deterministic results pre-computed by Phase 0 keyword logic, embedded in a `<<MOCK_RESULT>>...<</MOCK_RESULT>>` fence inside the prompt. The mock provider extracts from the fence; real providers (OpenAI/Ollama) have it stripped before send. **Do not "clean up" or remove these fences** when editing prompts in `src/core/prompts.ts` — tests depend on them.

## MVP stack
- TypeScript (NodeNext modules), Node 20+, ES modules (`"type": "module"`)
- JSON + JSONL files under `data/` (created by `csm init`)
- `zod` for schema validation, `vitest` for tests
- `@modelcontextprotocol/sdk` is a declared dependency but **not yet imported** anywhere in `src/` — it's there for the planned HTTP/MCP server (see README "Future work"). Don't be surprised by the unused dep.
- No DB, no vector store, no web UI, no eslint/prettier, no CI in MVP

## Phase status (2026-05-11)
- Phase 0 (mock runtime): done
- Phase 1 (provider interface, schemas, retry/parse): done; OpenAI provider has real fetch; OllamaProvider thin wrapper with Gemma-4090 defaults; Anthropic still stub
- Phase 2 (Committer dry-run + apply): done; not autonomous
- Phase 3 (split/compact): threshold check only (`csm split check`), no automatic action
- **Phase 4 (eval suite expansion): MCQ benchmark harness shipped** — 4 baselines (CSM, longctx, vanilla RAG, hybrid RAG), sweep-aware runner with adaptive 50%-accuracy early-stop, cache-first design, Vega-Lite plotter; synthetic 22K-event / 9M-token PaySwift corpus with 30 MCQ queries (40 options each); BABILong free-form support for Tasks 1–3. Real Ollama benchmark runs are documented in the results docs.

## Query kinds & scoring
- The benchmark supports two query kinds via a discriminated union in `src/eval/mcq.ts`:
  - **MCQ** (`kind: "mcq"` or absent): 40 options, exact-match on `chosenOption`. Used by PaySwift.
  - **Free-form** (`kind: "free-form"`): short-answer string match after normalisation. Used by BABILong (and any future short-answer benchmark).
- Scoring routes through `scoreAnswer(query, answer)` in `scorer.ts`, which dispatches on `kind`.
- Each baseline calls `buildPrompt(query, context).prompt` and `parseAnswer(query, rawOutput)` — no baseline branches on kind itself.
