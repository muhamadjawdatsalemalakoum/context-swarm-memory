#!/usr/bin/env tsx
/**
 * Quick sanity check on the merged synthetic corpus.
 *
 *  - Loads `events.jsonl` via the canonical `loadAllEvents` path.
 *  - Reports event count, total tokens, per-shard distribution, ID range.
 *  - Probes `loadCorpus` at a sample size that fits the core, to verify the
 *    sampling path returns a coherent `Corpus`.
 *
 *  Run with:  npx tsx scripts/verify-corpus.ts
 */

import { loadAllEvents, sampleFromEvents } from "../src/eval/corpus.js";

const CORPUS_DIR = "data/eval/corpus-synthetic";

async function main(): Promise<void> {
  const all = await loadAllEvents(CORPUS_DIR);
  const totalTokens = all.reduce((s, e) => s + e.tokenCount, 0);

  console.log(`Loaded ${all.length} events from ${CORPUS_DIR}/events.jsonl`);
  console.log(`Total tokens: ${totalTokens.toLocaleString()}`);

  // Per-shard distribution.
  const perShard = new Map<string, { count: number; tokens: number }>();
  for (const e of all) {
    const cur = perShard.get(e.shardId) ?? { count: 0, tokens: 0 };
    cur.count++;
    cur.tokens += e.tokenCount;
    perShard.set(e.shardId, cur);
  }
  console.log("\nPer-shard:");
  for (const [shard, p] of [...perShard.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${shard.padEnd(16)} ${String(p.count).padStart(3)} events  ${p.tokens.toLocaleString().padStart(7)} tokens`);
  }

  // Tier distribution.
  const perTier = new Map<number, number>();
  for (const e of all) perTier.set(e.tier, (perTier.get(e.tier) ?? 0) + 1);
  console.log("\nPer-tier:");
  for (const [tier, count] of [...perTier.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  tier ${tier}: ${count} events`);
  }

  // Core breakdown.
  const coreCount = all.filter((e) => e.isCore).length;
  const coreTokens = all
    .filter((e) => e.isCore)
    .reduce((s, e) => s + e.tokenCount, 0);
  console.log(
    `\nisCore=true: ${coreCount}/${all.length} events, ${coreTokens.toLocaleString()} tokens`,
  );

  // ID range and uniqueness.
  const ids = all.map((e) => e.id).sort();
  const dup = ids.filter((id, i) => i > 0 && id === ids[i - 1]);
  console.log(`\nID range: ${ids[0]} ... ${ids[ids.length - 1]}`);
  console.log(`Unique IDs: ${dup.length === 0 ? "yes" : `NO — duplicates: ${dup.join(", ")}`}`);

  // Sampling probe at the smallest target the core fits in.
  const targetTokens = Math.ceil(coreTokens * 1.05); // tiny headroom over core
  console.log(
    `\nSampling probe at targetTokens=${targetTokens.toLocaleString()} (= core × 1.05):`,
  );
  const sample = sampleFromEvents(all, { targetTokens, seed: 42 });
  console.log(
    `  events selected: ${sample.events.length} (core=${sample.coreEvents.length}, filler=${sample.fillerEvents.length})`,
  );
  console.log(`  totalTokens: ${sample.totalTokens.toLocaleString()}`);
  console.log(`  byShard: ${sample.byShard.size} shards`);

  // What's the smallest size loadCorpus can be called with?
  console.log(
    `\nMinimum viable targetTokens for loadCorpus: ${coreTokens.toLocaleString()} (= current core total)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
