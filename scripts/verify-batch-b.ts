#!/usr/bin/env tsx
/**
 * Standalone verification for queries-batch-b.json. Runs the project's own
 * Zod schema + range check, plus extra structural checks the spec requires.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { McqQueriesFileZ, validateMcqQuery } from "../src/eval/mcq.js";

async function main(): Promise<void> {
  const path = resolve(
    process.cwd(),
    "data/eval/corpus-synthetic/queries-batch-b.json"
  );
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw);
  const file = McqQueriesFileZ.parse(parsed);

  if (file.queries.length !== 10) {
    throw new Error(
      `Expected 10 queries in batch-b, got ${file.queries.length}`
    );
  }

  for (const q of file.queries) {
    validateMcqQuery(q);
    if (q.options.length !== 40) {
      throw new Error(`${q.id}: expected 40 options, got ${q.options.length}`);
    }
    const seen = new Set<string>();
    for (const opt of q.options) {
      const key = opt.trim().toLowerCase();
      if (seen.has(key)) {
        throw new Error(`${q.id}: duplicate option detected`);
      }
      seen.add(key);
    }
    for (const opt of q.options) {
      const words = opt.trim().split(/\s+/).length;
      if (words < 5 || words > 50) {
        throw new Error(
          `${q.id}: option outside 5-50 word window (got ${words})`
        );
      }
    }
  }

  console.log(`OK: ${file.queries.length} queries pass all checks.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
