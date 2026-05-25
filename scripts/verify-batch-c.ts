#!/usr/bin/env tsx
/**
 * Verify queries-batch-c.json conforms to the McqQueriesFileZ schema and the
 * per-question contract: 40 options, correctOption in [1,40] pointing at the
 * correct text, no duplicates, and adversarials having >=2 negative distractors.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { McqQueriesFileZ, validateMcqQuery } from "../src/eval/mcq.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const filePath = path.resolve(
  here,
  "..",
  "data",
  "eval",
  "corpus-synthetic",
  "queries-batch-c.json"
);

const raw = readFileSync(filePath, "utf8");
const parsed = JSON.parse(raw) as unknown;
const file = McqQueriesFileZ.parse(parsed);

console.log(`Parsed ${file.queries.length} queries`);
if (file.queries.length !== 10) {
  throw new Error(`expected 10 queries, got ${file.queries.length}`);
}

const expectedIds = new Set([
  "q21",
  "q22",
  "q23",
  "q24",
  "q25",
  "q26",
  "q27",
  "q28",
  "q29",
  "q30",
]);

for (const q of file.queries) {
  validateMcqQuery(q);
  if (!expectedIds.has(q.id)) {
    throw new Error(`unexpected id ${q.id}`);
  }
  if (q.options.length !== 40) {
    throw new Error(`${q.id}: expected 40 options, got ${q.options.length}`);
  }
  if (q.correctOption < 1 || q.correctOption > 40) {
    throw new Error(
      `${q.id}: correctOption ${q.correctOption} out of range 1..40`
    );
  }
  const dupCheck = new Set<string>();
  for (const o of q.options) {
    if (dupCheck.has(o)) {
      throw new Error(`${q.id}: duplicate option: ${o.slice(0, 60)}`);
    }
    dupCheck.add(o);
  }
  console.log(
    `  ${q.id} OK — ${q.options.length} opts, correctOption=${q.correctOption}, category=${q.category}, shardHints=${JSON.stringify(q.shardHints)}`
  );
  // Show the correct option text (first 100 chars).
  const correctText = q.options[q.correctOption - 1] ?? "";
  console.log(`     correct: "${correctText.slice(0, 100)}${correctText.length > 100 ? "…" : ""}"`);
}

// Confirm adversarial queries have >=2 negative-style options total.
const negKeywords = [
  "rejected",
  "evaluated",
  "vetoed",
  "considered",
  "deferred",
  "paused",
  "rolled it back",
  "no such decision",
  "never proposed",
  "never integrated",
];
for (const q of file.queries) {
  if (q.category !== "adversarial") continue;
  const negs = q.options.filter((o) =>
    negKeywords.some((k) => o.toLowerCase().includes(k))
  );
  console.log(`  ${q.id} adversarial negative-style count: ${negs.length}`);
  if (negs.length < 3) {
    throw new Error(
      `${q.id}: need >=3 negative-style options (correct + 2 distractors), got ${negs.length}`
    );
  }
}

console.log("\nALL CHECKS PASSED");
