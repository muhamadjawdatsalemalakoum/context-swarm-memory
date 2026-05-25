#!/usr/bin/env tsx
/**
 * Expand a tier-N filler events file into tier-(N+1) by programmatic
 * templating — no LLM calls. Each input event yields `factor` variants by
 * substituting the kind of token that's locally swappable without changing
 * the *structure* of the event:
 *
 *  - dollar amounts (e.g. "$87K" → "$112K", "$53K") with ±30% jitter
 *  - dates (e.g. "Mar 12" → "Mar 19", "Feb 26") with ±60 day shift
 *  - integer counts (e.g. "5 attempts" → "8 attempts", "3 attempts")
 *  - swappable proper-noun-ish tokens via a small substitution dictionary
 *
 * The output is plausibly different but recognisably similar to the seed.
 * Quality is "filler-grade" — meant to inflate corpus token volume so the
 * scaling sweep has something to chew on, not to be human-readable in
 * isolation.
 *
 * Usage:
 *   npx tsx scripts/expand-filler.ts \
 *     --input data/eval/corpus-synthetic/events-tier1.jsonl \
 *     --output data/eval/corpus-synthetic/events-tier2.jsonl \
 *     --tier 2 \
 *     --factor 10 \
 *     --seed 42
 *
 * Run multiple times to walk tier-1 → tier-2 → tier-3 → tier-4.
 */

import { readFile, writeFile } from "node:fs/promises";

import { z } from "zod";
import { estimateTokens } from "../src/core/tokenBudget.js";

// --------------------------------------------------------------------------
// CLI args
// --------------------------------------------------------------------------

interface Args {
  input: string;
  output: string;
  tier: 2 | 3 | 4;
  factor: number;
  seed: number;
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = { factor: 10, seed: 42 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = argv[i + 1];
    switch (a) {
      case "--input":
        out.input = next!;
        i++;
        break;
      case "--output":
        out.output = next!;
        i++;
        break;
      case "--tier": {
        const t = Number(next);
        if (![2, 3, 4].includes(t)) throw new Error(`--tier must be 2, 3, or 4 (got ${next})`);
        out.tier = t as 2 | 3 | 4;
        i++;
        break;
      }
      case "--factor":
        out.factor = Number(next);
        i++;
        break;
      case "--seed":
        out.seed = Number(next);
        i++;
        break;
      default:
        throw new Error(`Unknown flag: ${a}`);
    }
  }
  if (!out.input || !out.output || !out.tier) {
    throw new Error("Required: --input <path> --output <path> --tier <2|3|4>");
  }
  return out as Args;
}

// --------------------------------------------------------------------------
// Schema for input/output events (more permissive than corpus.ts so we don't
// bind to a single tier literal)
// --------------------------------------------------------------------------

const FillerEventZ = z.object({
  id: z.string().min(1),
  shardId: z.string().min(1),
  content: z.string().min(1),
  tokenCount: z.number().int().nonnegative(),
  isCore: z.boolean(),
  tier: z.number().int().min(0).max(4),
  timestamp: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

type FillerEvent = z.infer<typeof FillerEventZ>;

// --------------------------------------------------------------------------
// Substitution pools
// --------------------------------------------------------------------------

const VENDOR_SWAPS = [
  ["Stripe", "Adyen", "Worldpay", "Braintree", "Checkout"],
  ["Postgres", "MySQL", "CockroachDB", "PlanetScale"],
  ["AWS", "GCP", "Azure", "Fly.io", "Render"],
  ["Datadog", "Honeycomb", "Lightstep", "New Relic"],
  ["Stripe Connect", "Marketplace API", "Connect Express"],
  ["Twilio", "Vonage", "MessageBird", "Plivo"],
  ["Slack", "Discord", "Mattermost", "Zulip"],
];

const PRODUCT_SUFFIX_SWAPS = [
  ["v1", "v2", "v3", "v4"],
  ["beta", "alpha", "RC1", "GA"],
  ["MVP", "v0.5", "preview", "0.9"],
];

const SEVERITY_SWAPS = [["P0", "P1", "P2"], ["critical", "high", "medium", "low"]];

const COUNT_PATTERN = /\b(\d+)\s+(attempts|seconds|minutes|hours|days|weeks|months|customers|partners|requests|webhooks|engineers|tickets|merchants)\b/g;
const DOLLAR_PATTERN = /\$(\d+(?:\.\d+)?)\s*([KkMmBb]?)\b/g;
const PERCENT_PATTERN = /\b(\d+(?:\.\d+)?)%/g;
const DATE_PATTERN = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\b/g;
const ISO_DATE_PATTERN = /\b(202[5-7])-(\d{2})-(\d{2})\b/g;

// --------------------------------------------------------------------------
// Mulberry32 (matches scorer.ts / corpus.ts)
// --------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

// --------------------------------------------------------------------------
// Mutators
// --------------------------------------------------------------------------

function jitterDollars(content: string, rng: () => number): string {
  return content.replace(DOLLAR_PATTERN, (_match, num, suffix) => {
    const n = Number.parseFloat(num);
    const factor = 0.7 + rng() * 0.6; // ±30%
    const next = n * factor;
    const rounded = next < 10 ? next.toFixed(1) : Math.round(next).toString();
    return `$${rounded}${suffix}`;
  });
}

function jitterCounts(content: string, rng: () => number): string {
  return content.replace(COUNT_PATTERN, (_match, num, unit) => {
    const n = Number.parseInt(num, 10);
    if (n <= 1) return _match; // keep "1 attempt" etc. unchanged
    const factor = 0.5 + rng() * 1.5; // 0.5x .. 2.0x
    const next = Math.max(1, Math.round(n * factor));
    return `${next} ${unit}`;
  });
}

function jitterPercents(content: string, rng: () => number): string {
  return content.replace(PERCENT_PATTERN, (_match, num) => {
    const n = Number.parseFloat(num);
    const delta = (rng() - 0.5) * Math.max(0.5, n * 0.4);
    const next = Math.max(0, n + delta);
    const formatted = n < 10 ? next.toFixed(1) : Math.round(next).toString();
    return `${formatted}%`;
  });
}

function shiftDates(content: string, rng: () => number): string {
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const shiftDays = Math.floor((rng() - 0.5) * 120); // ±60d

  let out = content.replace(DATE_PATTERN, (_match, mon, day) => {
    const dayN = Number.parseInt(day, 10);
    let monthIdx = monthNames.indexOf(mon);
    if (monthIdx < 0) return _match;
    const date = new Date(2026, monthIdx, dayN);
    date.setDate(date.getDate() + shiftDays);
    return `${monthNames[date.getMonth()]} ${date.getDate()}`;
  });
  out = out.replace(ISO_DATE_PATTERN, (_match, y, m, d) => {
    const date = new Date(`${y}-${m}-${d}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + shiftDays);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  });
  return out;
}

function swapVendors(content: string, rng: () => number): string {
  let out = content;
  for (const group of VENDOR_SWAPS) {
    for (const term of group) {
      // Word-boundary replacement.
      const re = new RegExp(`\\b${term}\\b`, "g");
      if (re.test(out)) {
        const candidates = group.filter((t) => t !== term);
        const replacement = pick(rng, candidates);
        out = out.replace(re, replacement);
        break; // one swap per group per pass
      }
    }
  }
  for (const group of PRODUCT_SUFFIX_SWAPS) {
    for (const term of group) {
      const re = new RegExp(`\\b${term}\\b`, "g");
      if (re.test(out)) {
        const replacement = pick(rng, group.filter((t) => t !== term));
        out = out.replace(re, replacement);
        break;
      }
    }
  }
  for (const group of SEVERITY_SWAPS) {
    for (const term of group) {
      const re = new RegExp(`\\b${term}\\b`, "g");
      if (re.test(out)) {
        const replacement = pick(rng, group.filter((t) => t !== term));
        out = out.replace(re, replacement);
        break;
      }
    }
  }
  return out;
}

function shiftIsoTimestamp(iso: string, rng: () => number): string {
  const shiftDays = Math.floor((rng() - 0.5) * 120);
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  d.setUTCDate(d.getUTCDate() + shiftDays);
  return d.toISOString();
}

function deriveVariant(seed: FillerEvent, variantIndex: number, newTier: 2 | 3 | 4, rng: () => number): FillerEvent {
  let content = seed.content;
  content = jitterDollars(content, rng);
  content = jitterCounts(content, rng);
  content = jitterPercents(content, rng);
  content = shiftDates(content, rng);
  content = swapVendors(content, rng);

  const newId = `f${newTier}-${seed.id.replace(/^f\d+-/, "")}-v${String(variantIndex).padStart(3, "0")}`;
  const newTimestamp = seed.timestamp ? shiftIsoTimestamp(seed.timestamp, rng) : seed.timestamp;

  return {
    id: newId,
    shardId: seed.shardId,
    content,
    tokenCount: estimateTokens(content),
    isCore: false,
    tier: newTier,
    timestamp: newTimestamp,
    tags: seed.tags,
  };
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`Reading ${args.input} ...`);
  const text = await readFile(args.input, "utf8");
  const seeds: FillerEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    seeds.push(FillerEventZ.parse(JSON.parse(trimmed)));
  }
  console.log(`Loaded ${seeds.length} seed events.`);

  const variants: FillerEvent[] = [];
  let totalTokens = 0;
  for (const seed of seeds) {
    // Per-seed RNG so output is fully deterministic & re-runnable.
    const seedHash = hashStringToInt(seed.id) ^ args.seed;
    const rng = mulberry32(seedHash);
    for (let i = 0; i < args.factor; i++) {
      const v = deriveVariant(seed, i, args.tier, rng);
      variants.push(v);
      totalTokens += v.tokenCount;
    }
  }

  await writeFile(
    args.output,
    `${variants.map((v) => JSON.stringify(v)).join("\n")}\n`,
    "utf8",
  );

  console.log(
    `Wrote ${args.output}: ${variants.length} tier-${args.tier} events, ${totalTokens.toLocaleString()} tokens.`,
  );
}

function hashStringToInt(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
