# AGENTS.md

## Project mission
Build and test Context Swarm Memory: a memory system using bounded, read-only LLM context shards, manager routing, probe/recall, synthesis, and explicit commit-only writes.

## Non-negotiables
- Querying memory must not mutate durable memory.
- All memory writes must go through the Committer (`src/core/commit.ts`).
- Shard snapshots are immutable; the storage layer refuses to overwrite them.
- Keep provider APIs behind `LlmProvider`. Real providers are stubs in MVP.
- Add evals before optimizing.
- No tool-using shards. No autonomous swarm.

## First implementation target
Phase 0 + Phase 1 MVP, with Phase 2/3 skeletons:
- TypeScript CLI under `src/cli/`
- JSONL/JSON local storage under `data/`
- Directory, shards, snapshots, chronicle
- Mock provider (default), placeholder real providers
- Probe/recall/synthesize pipeline behind a provider seam
- Mutation-safety tests

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
