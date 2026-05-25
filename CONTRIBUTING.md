# Contributing to Context Swarm Memory

Thanks for your interest in CSM. This document covers what you need to know to make a useful contribution.

## Welcome and scope

CSM is an active R&D prototype, not a stable product. The design is still moving, and small, well-scoped contributions land much more easily than sweeping rewrites.

The contributions most useful right now are:

- Strengthening the benchmark harness (`src/eval/`) — baselines, scorers, plot fixes.
- Expanding the corpus (`data/eval/corpus-synthetic/`) — new shards, MCQ queries, adversarial cases.
- Improving documentation (`README.md`, `specs/`, this file).

If you want to make a larger architectural change — anything that touches the read-only invariants, the storage layer, or the provider interface — please open an issue first to discuss before opening a PR. It saves both sides time.

## Contribution flow

Contributions follow the standard GitHub fork-and-PR flow. For larger architectural changes, open an issue first so the read-only memory invariants and provider boundaries stay intact.

## Dev environment setup

Requirements:

- **Node.js 20 or later** (`node --version` to check). The repo uses ES modules and NodeNext resolution.
- **npm** (ships with Node).

```bash
npm install
```

That installs `zod`, `vitest`, `tsx`, `typescript`, and `@xenova/transformers`. No global tools are required.

Optional, for running real benchmarks against local models:

- **Ollama** with the `gemma4:31b` and `gemma4:e4b` models pulled. The README has the full 4090 setup notes. The default test and eval paths use `MockProvider` and do not need Ollama.

API keys are not needed for tests; `MockProvider` is deterministic.

## Common commands

All scripts are defined in `package.json`.

| Command | What it does |
| --- | --- |
| `npm test` | Full vitest suite — runs without API keys via `MockProvider`. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run lint` | `tsc --noEmit` — this *is* the lint in this repo. |
| `npm run build` | Compile to `dist/`. |
| `npm run dev` | Run the `csm` CLI via `tsx` without building. Same as `npm run csm`. |
| `npm run eval` | Smoke eval (`src/eval/runEval.ts`). Rerun after touching router/probe/recall/synth/split thresholds. |
| `npm run bench:smoke` | Tiny benchmark slice (1 trial, 100K corpus, 8K context, 3 queries). |
| `npm run bench:replay <runId>` | Recompute summary from cached results (no LLM calls). |
| `npm run bench:report <runId>` | Generate the report for a finished benchmark run. |

Single test patterns:

```bash
npx vitest run tests/router.test.ts        # one file
npx vitest run -t "router_recall"          # one test by name
```

## Code conventions

- **TypeScript strict mode**, NodeNext modules. Add the `.js` extension on relative imports (e.g. `import { ask } from "./ask.js"`) — that is required by NodeNext resolution.
- **All LLM JSON outputs go through a Zod schema** in `src/core/schemas.ts` and the `providerJson` retry/parse helper. Never call `JSON.parse` on provider output directly. The retry/parse helper handles `extractJson`, Zod validation, and one repair-prompt retry on schema failure.
- **Small files with explicit interfaces.** Most modules in `src/core/` are well under 300 lines. Prefer adding a sibling file over growing an existing one past that.
- **The lint is the type-check.** There is no ESLint, Prettier, or formatter in this repo. Match the style of the surrounding code: 2-space indent, double quotes, semicolons, trailing newline.
- **No new dependencies without discussion.** The MVP stack is intentionally small (zod, vitest, tsx, typescript, plus `@xenova/transformers` for the eval embeddings).

## Invariants that must not be broken

These are load-bearing. Violating them silently is the worst possible regression — please review them before changing anything in the read path or storage layer.

1. **The read path (`csm ask`) must not mutate durable storage.** `tests/mutationSafety.test.ts` hashes every durable file with SHA-256 before and after a query and asserts byte-equality. `query-runs.jsonl` is the **only** file `csm ask` is allowed to append to. If you change anything in `src/core/ask.ts`, `router.ts`, `probe.ts`, `recall.ts`, or `synthesize.ts`, rerun that test.
2. **Snapshots are immutable.** `src/storage/jsonlStorage.ts` refuses to overwrite an existing snapshot file. Versions move forward as `S001`, `S002`, … and never overwrite.
3. **All durable writes go through one of two entry points:** `appendEventAndSnapshot` (driven by `csm remember`) or `applyCommitDecision` (driven by the Committer). Do not add a third path. If you find yourself wanting one, that is an architecture-change conversation.
4. **Keep the `<<MOCK_RESULT>>...<</MOCK_RESULT>>` fences in `src/core/prompts.ts`.** They look like cruft but `MockProvider` reads them, and tests depend on them. Real providers have them stripped before send. Don't "clean them up."

## PR checklist

Before opening a PR, please confirm:

- [ ] `npm run lint` passes.
- [ ] `npm test` passes.
- [ ] If you touched router / probe / recall / synthesis / split thresholds, you ran `npm run eval` and noted the result in the PR description.
- [ ] If you added a new LLM call, it goes through the response cache and a Zod schema in `src/core/schemas.ts`.
- [ ] You updated `CHANGELOG.md` under `## [Unreleased]`.

## Commit message style

Short, imperative mood, prefix with the subsystem touched. Examples:

```
eval: add bm25 baseline
runner: fix early-stop at exact threshold
storage: refuse to overwrite snapshot file
docs: clarify mock-provider fence convention
```

No mandated emojis, no Conventional Commits scopes, no required body. Just say what the commit does. If the change is non-obvious, add a paragraph below the subject line explaining why.

## License and contribution rights

The project is licensed under the **MIT License** (see `LICENSE`).

By submitting a contribution, you confirm that you have the right to license your contribution under the MIT License — i.e. the code is yours to give, or you have permission from whoever holds the rights. There is no formal CLA process today. This may change as the project matures; if it does, the change will be announced before any new requirement takes effect.

Thanks for contributing.
