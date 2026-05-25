#!/usr/bin/env tsx
/**
 * Merge `data/eval/corpus-synthetic/events-p{1..6}.jsonl` into a single
 * `events.jsonl`, normalising any inconsistencies the phase-parallel
 * subagents introduced:
 *
 *   - `isCore` forced to `true` (every phase event is tier-0 core regardless
 *     of how the subagent interpreted "core").
 *   - `tier` forced to `0`.
 *   - `tokenCount` recomputed via the canonical `estimateTokens` so it
 *     matches what the runner uses.
 *   - Duplicate IDs across phases abort the merge.
 *
 * Run with:  npx tsx scripts/merge-phase-events.ts
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { estimateTokens } from "../src/core/tokenBudget.js";
import type { BenchEvent } from "../src/eval/corpus.js";

const CORPUS_DIR = "data/eval/corpus-synthetic";
const PHASE_FILES = [
  "events-p1.jsonl",
  "events-p2.jsonl",
  "events-p3.jsonl",
  "events-p4.jsonl",
  "events-p5.jsonl",
  "events-p6.jsonl",
];
const OUTPUT_FILE = "events.jsonl";

const PhaseEventZ = z.object({
  id: z.string().min(1),
  shardId: z.string().min(1),
  content: z.string().min(1),
  tokenCount: z.number().int().nonnegative(),
  isCore: z.boolean(),
  tier: z.number().int().min(0).max(4),
  timestamp: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

interface MergeStats {
  perPhase: Map<string, { count: number; tokens: number }>;
  perShard: Map<string, number>;
  isCoreFixed: number;
  tierFixed: number;
  tokenCountFixed: number;
  duplicateIds: string[];
}

async function main(): Promise<void> {
  const stats: MergeStats = {
    perPhase: new Map(),
    perShard: new Map(),
    isCoreFixed: 0,
    tierFixed: 0,
    tokenCountFixed: 0,
    duplicateIds: [],
  };
  const seenIds = new Set<string>();
  const merged: BenchEvent[] = [];

  for (const phaseFile of PHASE_FILES) {
    const path = join(CORPUS_DIR, phaseFile);
    if (!existsSync(path)) {
      console.error(`MISSING: ${path}`);
      process.exit(1);
    }
    const text = await readFile(path, "utf8");
    let phaseCount = 0;
    let phaseTokens = 0;

    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let parsed: z.infer<typeof PhaseEventZ>;
      try {
        parsed = PhaseEventZ.parse(JSON.parse(trimmed));
      } catch (err) {
        console.error(`Parse error in ${phaseFile}:\n  ${trimmed.slice(0, 200)}`);
        throw err;
      }

      // Normalise.
      if (!parsed.isCore) {
        parsed.isCore = true;
        stats.isCoreFixed++;
      }
      if (parsed.tier !== 0) {
        parsed.tier = 0;
        stats.tierFixed++;
      }
      const expected = estimateTokens(parsed.content);
      if (expected !== parsed.tokenCount) {
        parsed.tokenCount = expected;
        stats.tokenCountFixed++;
      }

      // Uniqueness.
      if (seenIds.has(parsed.id)) {
        stats.duplicateIds.push(parsed.id);
      } else {
        seenIds.add(parsed.id);
      }

      merged.push(parsed as BenchEvent);
      phaseCount++;
      phaseTokens += parsed.tokenCount;
      stats.perShard.set(
        parsed.shardId,
        (stats.perShard.get(parsed.shardId) ?? 0) + 1,
      );
    }

    stats.perPhase.set(phaseFile, { count: phaseCount, tokens: phaseTokens });
  }

  if (stats.duplicateIds.length > 0) {
    console.error(
      `ABORT: duplicate IDs across phases: ${stats.duplicateIds.join(", ")}`,
    );
    process.exit(1);
  }

  // Sort by id for stable merged output.
  merged.sort((a, b) => a.id.localeCompare(b.id));

  await writeFile(
    join(CORPUS_DIR, OUTPUT_FILE),
    `${merged.map((e) => JSON.stringify(e)).join("\n")}\n`,
    "utf8",
  );

  let totalEvents = 0;
  let totalTokens = 0;
  console.log("Per phase:");
  for (const [phase, p] of stats.perPhase) {
    console.log(`  ${phase}: ${p.count} events, ${p.tokens.toLocaleString()} tokens`);
    totalEvents += p.count;
    totalTokens += p.tokens;
  }
  console.log(
    `Total: ${totalEvents} events, ${totalTokens.toLocaleString()} tokens`,
  );

  console.log("\nPer shard:");
  const shardEntries = [...stats.perShard.entries()].sort(
    (a, b) => b[1] - a[1],
  );
  for (const [shard, count] of shardEntries) {
    console.log(`  ${shard}: ${count}`);
  }

  console.log("\nNormalisations:");
  console.log(`  isCore=true forced     : ${stats.isCoreFixed} events`);
  console.log(`  tier=0 forced          : ${stats.tierFixed} events`);
  console.log(`  tokenCount recomputed  : ${stats.tokenCountFixed} events`);

  console.log(`\nWrote ${join(CORPUS_DIR, OUTPUT_FILE)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
