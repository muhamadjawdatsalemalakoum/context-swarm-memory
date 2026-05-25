#!/usr/bin/env tsx
/**
 * Merge `queries-batch-{a,b,c}.json` into a single canonical `queries.json`,
 * validate against `McqQueriesFileZ`, and report per-question stats.
 *
 * Run: npx tsx scripts/merge-query-batches.ts
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { McqQueriesFileZ, validateMcqQuery, type McqQuery } from "../src/eval/mcq.js";

const CORPUS_DIR = "data/eval/corpus-synthetic";
const BATCH_FILES = [
  "queries-batch-a.json",
  "queries-batch-b.json",
  "queries-batch-c.json",
];
const OUTPUT_FILE = "queries.json";

async function main(): Promise<void> {
  const all: McqQuery[] = [];

  for (const batch of BATCH_FILES) {
    const path = join(CORPUS_DIR, batch);
    const text = await readFile(path, "utf8");
    const parsed = McqQueriesFileZ.parse(JSON.parse(text));
    console.log(`  ${batch}: ${parsed.queries.length} queries`);
    for (const q of parsed.queries) {
      validateMcqQuery(q);
      all.push(q);
    }
  }

  // Sort by id for stable merged output (q01, q02, ... q30).
  all.sort((a, b) => a.id.localeCompare(b.id));

  // Uniqueness check on IDs.
  const ids = new Set<string>();
  for (const q of all) {
    if (ids.has(q.id)) {
      console.error(`ABORT: duplicate query id ${q.id}`);
      process.exit(1);
    }
    ids.add(q.id);
  }

  // Final validation — round-trip the assembled file through the schema.
  const merged = { version: 1 as const, queries: all };
  McqQueriesFileZ.parse(merged);

  await writeFile(
    join(CORPUS_DIR, OUTPUT_FILE),
    `${JSON.stringify(merged, null, 2)}\n`,
    "utf8",
  );

  // Stats.
  const byCategory = new Map<string, number>();
  let totalOptions = 0;
  for (const q of all) {
    const cat = q.category ?? "uncategorised";
    byCategory.set(cat, (byCategory.get(cat) ?? 0) + 1);
    totalOptions += q.options.length;
  }

  console.log(`\nMerged: ${all.length} queries, ${totalOptions} option strings.`);
  console.log("Per category:");
  for (const [cat, count] of byCategory) {
    console.log(`  ${cat.padEnd(15)} ${count}`);
  }
  console.log(`\nWrote ${join(CORPUS_DIR, OUTPUT_FILE)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
