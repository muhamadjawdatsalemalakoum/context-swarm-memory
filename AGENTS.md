# AGENTS.md

## Project mission
Build and test Context Swarm Memory: a memory system using bounded, read-only LLM context shards, manager routing, probe/recall, synthesis, and explicit commit-only writes.

Current state, blockers and the live claim set: [`docs/STATUS.md`](docs/STATUS.md).

## Non-negotiables
- Querying memory must not mutate durable memory.
- All memory writes must go through the Committer (`src/core/commit.ts`).
- Shard snapshots are immutable; the storage layer refuses to overwrite them.
- Keep provider APIs behind `LlmProvider`. Gemini/OpenAI-compatible/Ollama/llama.cpp are real; Anthropic is still a stub.
- An unrecognised `CSM_*` config value is an ERROR, never a default — all reads go through `src/utils/env.ts`.
- No corpus-specific vocabulary in the retrieval path; expansion and term weighting must be corpus-derived or structural.
- A component that cannot discriminate must SAY so — ranking goes through `src/core/selection.ts:select()`, never a bare `.sort().slice()`.
- Add evals before optimizing.
- No tool-using shards. No autonomous swarm.

## Measurement discipline (non-negotiable)
- A delta below its **minimum detectable effect** is NOT an effect. Say
  "directional", never "lead".
- n=25 is a pointer, not a verdict. Category claims need the full n=70.
- Re-measure the same arm before believing a delta — re-scoring identical
  contexts has moved an arm 0.06.
- Never grade an arm on a context you cannot re-render byte-for-byte.
- Levers do not transfer across tiers; component gains do not transfer into
  assembled systems. Both require their own evidence.
- Numbers from different instruments are never pooled.

## Commands
- `npm install`
- `npm test`
- `npm run build`
- `npm run eval`
- `npx tsx src/cli/index.ts <command>` or `npm run csm -- <command>`

## Style
- Small files with explicit interfaces.
- Validate all LLM JSON outputs (`src/core/schemas.ts`).
- Log cost, latency, token estimates, shard IDs, snapshot IDs.
- Never bypass `appendEventAndSnapshot` / `applyCommitDecision` for durable writes.
