#!/usr/bin/env tsx
/**
 * Concatenate the core events.jsonl-equivalent file (`events-core.jsonl`)
 * and any present filler tiers (`events-tier{1,2,3,4}.jsonl`) into the
 * canonical `events.jsonl` that `loadAllEvents` reads.
 *
 *  - Re-validates every event against `BenchEventZ` (the same Zod schema
 *    `loadAllEvents` enforces).
 *  - Aborts on duplicate IDs across files.
 *  - Sorts by id for stable output.
 *  - Reports size + per-tier breakdown.
 *
 * If `events-core.jsonl` is missing but `events.jsonl` exists, we treat the
 * existing `events.jsonl` as the core (back-compat with the state right
 * after Phase B.3 merge).
 *
 * Usage: `npx tsx scripts/build-corpus.ts`
 */

import { existsSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const CORPUS_DIR = "data/eval/corpus-synthetic";

const BenchEventZ = z.object({
  id: z.string().min(1),
  shardId: z.string().min(1),
  content: z.string().min(1),
  tokenCount: z.number().int().nonnegative(),
  isCore: z.boolean(),
  tier: z.union([
    z.literal(0),
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
  ]),
  timestamp: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

type BenchEvent = z.infer<typeof BenchEventZ>;

const SOURCE_FILES = [
  { path: "events-core.jsonl", expectedTier: 0, label: "core" },
  { path: "events-tier1.jsonl", expectedTier: 1, label: "tier-1" },
  { path: "events-tier2.jsonl", expectedTier: 2, label: "tier-2" },
  { path: "events-tier3.jsonl", expectedTier: 3, label: "tier-3" },
  { path: "events-tier4.jsonl", expectedTier: 4, label: "tier-4" },
];

async function loadJsonl(path: string): Promise<BenchEvent[]> {
  const text = await readFile(path, "utf8");
  const out: BenchEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    out.push(BenchEventZ.parse(JSON.parse(trimmed)));
  }
  return out;
}

async function main(): Promise<void> {
  // Back-compat: if events-core.jsonl is missing but events.jsonl exists, copy
  // events.jsonl → events-core.jsonl so subsequent runs are idempotent.
  const corePath = join(CORPUS_DIR, "events-core.jsonl");
  const eventsPath = join(CORPUS_DIR, "events.jsonl");
  if (!existsSync(corePath) && existsSync(eventsPath)) {
    console.log(
      `events-core.jsonl missing; treating existing events.jsonl as core and snapshotting it.`,
    );
    await copyFile(eventsPath, corePath);
  }

  const merged: BenchEvent[] = [];
  const seen = new Set<string>();
  const stats: Array<{ label: string; count: number; tokens: number; present: boolean }> = [];

  for (const src of SOURCE_FILES) {
    const path = join(CORPUS_DIR, src.path);
    if (!existsSync(path)) {
      stats.push({ label: src.label, count: 0, tokens: 0, present: false });
      continue;
    }
    const events = await loadJsonl(path);
    let count = 0;
    let tokens = 0;
    for (const e of events) {
      if (e.tier !== src.expectedTier) {
        console.warn(
          `WARN: ${src.path} contains event ${e.id} with tier=${e.tier}, expected ${src.expectedTier}`,
        );
      }
      if (seen.has(e.id)) {
        console.error(`ABORT: duplicate event id ${e.id} (in ${src.path})`);
        process.exit(1);
      }
      seen.add(e.id);
      merged.push(e);
      count++;
      tokens += e.tokenCount;
    }
    stats.push({ label: src.label, count, tokens, present: true });
  }

  // Stable order: sort by tier ascending, then id (so core events come first).
  merged.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    return a.id.localeCompare(b.id);
  });

  await writeFile(
    eventsPath,
    `${merged.map((e) => JSON.stringify(e)).join("\n")}\n`,
    "utf8",
  );

  console.log(`Built ${eventsPath}\n`);
  console.log("Per source:");
  let totalCount = 0;
  let totalTokens = 0;
  for (const s of stats) {
    const presence = s.present ? "" : "  (missing — skipped)";
    console.log(
      `  ${s.label.padEnd(8)} ${String(s.count).padStart(7)} events  ${s.tokens.toLocaleString().padStart(13)} tokens${presence}`,
    );
    totalCount += s.count;
    totalTokens += s.tokens;
  }
  console.log(`  ${"TOTAL".padEnd(8)} ${String(totalCount).padStart(7)} events  ${totalTokens.toLocaleString().padStart(13)} tokens`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
