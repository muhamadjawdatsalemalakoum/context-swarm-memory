#!/usr/bin/env tsx
/**
 * Verify that no filler-tier event accidentally contains an answer-bearing
 * fact from the PaySwift core. Fails if any banned proper noun, brand, or
 * person name from the core appears in filler content.
 *
 * Run AFTER tier-1 generation and AFTER each filler expansion.
 *
 * Usage: `npx tsx scripts/verify-no-leakage.ts`
 *
 * Exit code: 0 if clean, 1 if any contamination found.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const CORPUS_DIR = "data/eval/corpus-synthetic";

/**
 * Banned terms — proper nouns and brand-specific phrases that uniquely
 * identify the PaySwift corpus. Any filler event mentioning these is leaking
 * answer-bearing context.
 *
 * Be conservative — overly-broad bans cause false positives (e.g. "Postgres"
 * is fine in filler since it's a generic tech). Only ban terms that are
 * uniquely PaySwift-specific OR that would directly answer a query.
 */
const BANNED_TERMS = [
  // Company / product names
  "PaySwift",
  "ChairSync",
  "FitFlow",
  // PaySwift-specific vendor choices that ANSWER queries
  "Persona",
  "Lucia",
  "pgroll",
  // PaySwift team
  "Alex Park",
  "Mei Chen",
  "Devon Reyes",
  "Sarah Kim",
  "Jordan Liu",
  // PaySwift external voices
  "Mosaic Ventures",
  // Note: first names alone (Alex, Mei, Devon, Sarah, Jordan, Marcus, Nico, Riley, Priya)
  // are NOT banned — too many false-positive risks; the subagent prompt covered them as
  // a soft guideline. Last names + product names + vendor specifics are the hard ban.
];

/**
 * Soft warnings — terms that *could* be in filler legitimately but suggest
 * potential overlap. Reported but not failing.
 */
const SOFT_WARN_TERMS: string[] = [
  // (intentionally empty for v1; add as needed)
];

interface Hit {
  file: string;
  eventId: string;
  term: string;
  excerpt: string;
}

async function scanFile(path: string): Promise<{ hits: Hit[]; warns: Hit[]; eventCount: number }> {
  const text = await readFile(path, "utf8");
  const hits: Hit[] = [];
  const warns: Hit[] = [];
  let eventCount = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    eventCount++;
    let event: { id: string; content: string };
    try {
      event = JSON.parse(trimmed) as { id: string; content: string };
    } catch {
      continue;
    }
    for (const term of BANNED_TERMS) {
      const idx = event.content.indexOf(term);
      if (idx >= 0) {
        hits.push({
          file: path,
          eventId: event.id,
          term,
          excerpt: event.content.slice(Math.max(0, idx - 30), idx + term.length + 30),
        });
      }
    }
    for (const term of SOFT_WARN_TERMS) {
      const idx = event.content.indexOf(term);
      if (idx >= 0) {
        warns.push({
          file: path,
          eventId: event.id,
          term,
          excerpt: event.content.slice(Math.max(0, idx - 30), idx + term.length + 30),
        });
      }
    }
  }
  return { hits, warns, eventCount };
}

async function main(): Promise<void> {
  const fillerFiles = ["events-tier1.jsonl", "events-tier2.jsonl", "events-tier3.jsonl", "events-tier4.jsonl"];
  let totalEvents = 0;
  const allHits: Hit[] = [];
  const allWarns: Hit[] = [];

  for (const fname of fillerFiles) {
    const path = join(CORPUS_DIR, fname);
    if (!existsSync(path)) {
      console.log(`(skip) ${fname} not present`);
      continue;
    }
    const { hits, warns, eventCount } = await scanFile(path);
    totalEvents += eventCount;
    console.log(
      `${fname}: ${eventCount} events, ${hits.length} ban-hits, ${warns.length} soft-warns`,
    );
    allHits.push(...hits);
    allWarns.push(...warns);
  }

  console.log(`\nScanned ${totalEvents} filler events total.`);

  if (allWarns.length > 0) {
    console.log(`\nSoft warnings (${allWarns.length}):`);
    for (const w of allWarns.slice(0, 10)) {
      console.log(`  ${w.eventId} (${w.term}): "...${w.excerpt}..."`);
    }
    if (allWarns.length > 10) console.log(`  ... and ${allWarns.length - 10} more`);
  }

  if (allHits.length > 0) {
    console.error(`\nFAIL — ${allHits.length} ban-hits in filler:`);
    for (const h of allHits.slice(0, 25)) {
      console.error(`  ${h.eventId} contains "${h.term}": "...${h.excerpt}..."`);
    }
    if (allHits.length > 25) console.error(`  ... and ${allHits.length - 25} more`);
    console.error(`\nFiller events must not contain answer-bearing PaySwift specifics.`);
    process.exit(1);
  }

  console.log(`\n✓ Clean — no banned terms found in filler.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
