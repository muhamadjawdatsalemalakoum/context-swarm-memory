#!/usr/bin/env tsx
// T2 offline router-recall@K evaluation — Phase-0 lexical router vs hybrid
// (content-derived descriptors + local MiniLM centroid fusion).
//
// Spec §15.2 metric: Router Recall@K — correct shard appears in top K
// candidates. Spec §22 acceptance bar: correct shard in top 3 ≥ 85%.
//
// GOLD IS EVAL-SIDE ONLY. The gold mapping (queries.json relevantEventIds →
// owning shardIds) is computed here, AFTER routing, and is never passed to
// any routing function. The routers see exactly what production sees: the
// directory (+ content-derived index built without gold).
//
// Modes:
//   --mode compare      old vs hybrid on PaySwift (default)
//   --mode calibrate    grid-sweep fusion weights, report top configs
//   --mode fusion       weighted-sum vs RRF vs lexical-with-embedding-tiebreak
//   --mode beam-fixture 12 thin-metadata BEAM-shaped shards, REAL MiniLM
//   --mode interplay    router-rank vs probe-verdict analysis from run artifacts
// Flags:
//   --corpus-tokens 100K|1M|...   (default 100K)
//   --max-terms N                 descriptor terms per shard (default 16)
//
// Offline-only: MockProvider-free (no LLM at all); MiniLM runs locally and is
// disk-cached under data/eval/embeddings/ (existing precedent).

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadAllEvents, sampleFromEvents, type Corpus } from "../src/eval/corpus.js";
import { embed, EMBED_MODEL_NAME } from "../src/eval/embed.js";
import { selectCandidates, scoreEntryLexical, termMatchesAnyTag, tokenize } from "../src/core/router.js";
import {
  buildRouterIndex,
  selectCandidatesHybrid,
  satLex,
  DEFAULT_HYBRID_WEIGHTS,
  type HybridWeights,
  type RouterIndex,
} from "../src/core/routerEmbed.js";
import { centroidOf, deriveShardDescriptors } from "../src/core/descriptors.js";
import { estimateEventsTokens, fullnessPct } from "../src/core/tokenBudget.js";
import type { MemoryDirectory, MemoryDirectoryEntry } from "../src/core/types.js";
import type { MemoryEvent } from "../src/core/types.js";

const CORPUS_DIR = join(process.cwd(), "data", "eval", "corpus-synthetic");
const RUNS_DIR = join(process.cwd(), "data", "eval", "runs");

// ─── arg parsing ─────────────────────────────────────────────────────────────

function argValue(name: string, fallback: string): string {
  const ix = process.argv.indexOf(`--${name}`);
  if (ix === -1 || ix + 1 >= process.argv.length) return fallback;
  return process.argv[ix + 1]!;
}

function parseTokens(s: string): number {
  const m = s.trim().toUpperCase().match(/^(\d+(?:\.\d+)?)([KMB]?)$/);
  if (!m) throw new Error(`bad --corpus-tokens: ${s}`);
  const mult = m[2] === "K" ? 1e3 : m[2] === "M" ? 1e6 : m[2] === "B" ? 1e9 : 1;
  return Math.round(Number(m[1]) * mult);
}

// ─── directory synthesis (mirrors baselines/csm.ts buildShardsFromCorpus) ───

const SYNTHETIC_CONTEXT_LIMIT = 128_000;

export function buildDirectory(corpus: Corpus): MemoryDirectory {
  const createdAt = "2024-01-01T00:00:00.000Z";
  const entries: MemoryDirectoryEntry[] = [];
  const shardIds = [...corpus.byShard.keys()].sort();
  for (const shardId of shardIds) {
    const events = [...(corpus.byShard.get(shardId) ?? [])].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    const tagsUnion: string[] = [];
    const seen = new Set<string>();
    for (const e of events) {
      for (const t of e.tags ?? []) {
        const low = t.toLowerCase();
        if (!seen.has(low)) {
          seen.add(low);
          tagsUnion.push(low);
        }
      }
    }
    const memoryEvents: MemoryEvent[] = events.map((e) => ({
      eventId: e.id,
      role: "user" as const,
      content: e.content,
      createdAt: e.timestamp ?? createdAt,
      importance: e.isCore ? 0.8 : 0.4,
      tags: e.tags ?? [],
    }));
    const tokens = estimateEventsTokens(memoryEvents);
    const summary = `Synthetic shard ${shardId} (${events.length} events).`;
    entries.push({
      id: shardId,
      name: shardId,
      description: `Benchmark shard ${shardId}`,
      tags: tagsUnion,
      createdAt,
      updatedAt: createdAt,
      status: "active",
      snapshotId: "S001",
      tokenCountEstimate: tokens,
      contextLimitEstimate: SYNTHETIC_CONTEXT_LIMIT,
      fullnessPct: Math.round(fullnessPct(tokens, SYNTHETIC_CONTEXT_LIMIT) * 100) / 100,
      summaryShort: summary,
      knownConflicts: [],
      parentId: null,
      children: [],
      trustLevel: "imported_doc",
      staleness: "current",
    });
  }
  return { version: 1, entries };
}

// ─── hybrid index build (content-derived; no gold anywhere) ──────────────────

export async function buildIndexFromCorpus(
  corpus: Corpus,
  maxTerms: number,
): Promise<{ index: RouterIndex; embedMs: number }> {
  const sources = [...corpus.byShard.entries()].map(([shardId, events]) => ({
    shardId,
    events: events.map((e) => ({ content: e.content, tags: e.tags })),
  }));
  const descriptors = deriveShardDescriptors(sources, { maxTerms });

  const t0 = Date.now();
  // Embed every event once (same cache keys the embed-floor uses).
  const allVecs = await embed(corpus.events.map((e) => e.content), EMBED_MODEL_NAME);
  const embedMs = Date.now() - t0;
  const vecByEventId = new Map<string, Float32Array>();
  corpus.events.forEach((e, i) => vecByEventId.set(e.id, allVecs[i]!));

  const shards = [...corpus.byShard.entries()].map(([shardId, events]) => {
    const vecs = events
      .map((e) => vecByEventId.get(e.id))
      .filter((v): v is Float32Array => Boolean(v));
    return {
      shardId,
      terms: descriptors.get(shardId)?.terms ?? [],
      centroid: centroidOf(vecs),
    };
  });

  const index = await buildRouterIndex({
    shards,
    embed: (texts) => embed(texts, EMBED_MODEL_NAME),
    model: EMBED_MODEL_NAME,
  });
  return { index, embedMs };
}

// ─── gold + metrics (EVAL-SIDE ONLY) ─────────────────────────────────────────

export interface BenchQuery {
  id: string;
  question: string;
  relevantEventIds?: string[];
  category?: string;
}

export async function loadQueries(): Promise<BenchQuery[]> {
  const raw = JSON.parse(await readFile(join(CORPUS_DIR, "queries.json"), "utf8")) as {
    queries: BenchQuery[];
  };
  return raw.queries;
}

export function goldShards(q: BenchQuery, corpus: Corpus): { all: Set<string>; primary: string | null } {
  const counts = new Map<string, number>();
  for (const id of q.relevantEventIds ?? []) {
    const shardId = corpus.byId.get(id)?.shardId;
    if (!shardId) continue;
    counts.set(shardId, (counts.get(shardId) ?? 0) + 1);
  }
  if (counts.size === 0) return { all: new Set(), primary: null };
  const primary = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0] < b[0] ? -1 : 1;
  })[0]![0];
  return { all: new Set(counts.keys()), primary };
}

interface PerQueryRank {
  queryId: string;
  category: string;
  ranking: string[]; // full shard ordering
  gold: Set<string>;
  primary: string | null;
}

interface Metrics {
  n: number;
  primaryAt1: number;
  primaryAt3: number;
  primaryAt8: number;
  anyGoldAt3: number;
  anyGoldAt8: number;
  mrrPrimary: number;
  goldCoverageAt8: number;
}

function computeMetrics(rows: PerQueryRank[]): Metrics {
  const scored = rows.filter((r) => r.primary !== null);
  const n = scored.length;
  let p1 = 0, p3 = 0, p8 = 0, any3 = 0, any8 = 0, mrr = 0, cov = 0;
  for (const r of scored) {
    const rank = r.ranking.indexOf(r.primary!);
    if (rank === 0) p1++;
    if (rank > -1 && rank < 3) p3++;
    if (rank > -1 && rank < 8) p8++;
    if (rank > -1) mrr += 1 / (rank + 1);
    const top3 = new Set(r.ranking.slice(0, 3));
    const top8 = new Set(r.ranking.slice(0, 8));
    if ([...r.gold].some((g) => top3.has(g))) any3++;
    if ([...r.gold].some((g) => top8.has(g))) any8++;
    cov += [...r.gold].filter((g) => top8.has(g)).length / r.gold.size;
  }
  return {
    n,
    primaryAt1: p1 / n,
    primaryAt3: p3 / n,
    primaryAt8: p8 / n,
    anyGoldAt3: any3 / n,
    anyGoldAt8: any8 / n,
    mrrPrimary: mrr / n,
    goldCoverageAt8: cov / n,
  };
}

function fmt(x: number): string {
  return (Math.round(x * 1000) / 1000).toFixed(3);
}

function printComparison(label: string, old: Metrics, hyb: Metrics): void {
  console.log(`\n### Router recall@K — ${label} (n=${old.n} queries with gold)\n`);
  console.log("| metric | old (lexical) | hybrid | delta |");
  console.log("|---|---|---|---|");
  const rows: Array<[string, number, number]> = [
    ["primary recall@1", old.primaryAt1, hyb.primaryAt1],
    ["primary recall@3", old.primaryAt3, hyb.primaryAt3],
    ["primary recall@8", old.primaryAt8, hyb.primaryAt8],
    ["any-gold recall@3", old.anyGoldAt3, hyb.anyGoldAt3],
    ["any-gold recall@8", old.anyGoldAt8, hyb.anyGoldAt8],
    ["MRR (primary)", old.mrrPrimary, hyb.mrrPrimary],
    ["gold coverage@8", old.goldCoverageAt8, hyb.goldCoverageAt8],
  ];
  for (const [name, o, h] of rows) {
    console.log(`| ${name} | ${fmt(o)} | ${fmt(h)} | ${h - o >= 0 ? "+" : ""}${fmt(h - o)} |`);
  }
}

// ─── pre-computed per-(query, shard) signals for sweeps ─────────────────────

interface SignalRow {
  queryId: string;
  category: string;
  gold: Set<string>;
  primary: string | null;
  shardIds: string[];
  lex: number[];        // phase-0 lexical score per shard
  termOverlap: number[]; // derived-term overlap count per shard
  emb: number[];        // cosine (can be negative) per shard
}

async function computeSignals(
  queries: BenchQuery[],
  corpus: Corpus,
  directory: MemoryDirectory,
  index: RouterIndex,
): Promise<SignalRow[]> {
  const ref = new Date();
  const out: SignalRow[] = [];
  for (const q of queries) {
    const queryTerms = new Set(tokenize(q.question));
    const [queryVec] = await embed([q.question], EMBED_MODEL_NAME);
    const shardIds: string[] = [];
    const lex: number[] = [];
    const termOverlap: number[] = [];
    const embSims: number[] = [];
    for (const entry of directory.entries) {
      shardIds.push(entry.id);
      lex.push(scoreEntryLexical(queryTerms, entry, ref).score);
      const shard = index.byShard.get(entry.id);
      let ov = 0;
      if (shard && shard.terms.length > 0) {
        const termSet = new Set(shard.terms);
        for (const t of queryTerms) if (termMatchesAnyTag(t, termSet)) ov++;
      }
      termOverlap.push(ov);
      let sim = 0;
      if (shard?.centroid && queryVec) {
        for (let i = 0; i < queryVec.length; i++) sim += queryVec[i]! * shard.centroid[i]!;
      }
      embSims.push(sim);
    }
    const { all, primary } = goldShards(q, corpus);
    out.push({
      queryId: q.id,
      category: q.category ?? "?",
      gold: all,
      primary,
      shardIds,
      lex,
      termOverlap,
      emb: embSims,
    });
  }
  return out;
}

function rankWithWeights(row: SignalRow, w: HybridWeights): string[] {
  const scored = row.shardIds.map((id, i) => {
    const lexTotal = row.lex[i]! + row.termOverlap[i]! * w.termWeight;
    const emb = Math.max(0, row.emb[i]!);
    return { id, hybrid: w.wLex * satLex(lexTotal, w.lexSat) + w.wEmb * emb, lexTotal };
  });
  scored.sort((a, b) => {
    if (b.hybrid !== a.hybrid) return b.hybrid - a.hybrid;
    if (b.lexTotal !== a.lexTotal) return b.lexTotal - a.lexTotal;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return scored.map((s) => s.id);
}

function toRankRows(signals: SignalRow[], ranker: (row: SignalRow) => string[]): PerQueryRank[] {
  return signals.map((row) => ({
    queryId: row.queryId,
    category: row.category,
    ranking: ranker(row),
    gold: row.gold,
    primary: row.primary,
  }));
}

// ─── modes ───────────────────────────────────────────────────────────────────

async function setup(corpusTokens: number, maxTerms: number) {
  console.log(`Loading PaySwift corpus (target ${corpusTokens.toLocaleString()} tokens, seed 42)…`);
  const allEvents = await loadAllEvents(CORPUS_DIR);
  const corpus = sampleFromEvents(allEvents, { targetTokens: corpusTokens, seed: 42 });
  console.log(
    `  sampled events=${corpus.events.length} shards=${corpus.byShard.size} totalTokens=${corpus.totalTokens.toLocaleString()}`,
  );
  const directory = buildDirectory(corpus);
  const queries = await loadQueries();
  console.log(`  building hybrid index (TF-IDF terms + MiniLM centroids)…`);
  const t0 = Date.now();
  const { index, embedMs } = await buildIndexFromCorpus(corpus, maxTerms);
  console.log(
    `  index built in ${Date.now() - t0} ms (event embedding pass: ${embedMs} ms, disk-cached for reuse)`,
  );
  return { corpus, directory, queries, index };
}

async function modeCompare(corpusTokens: number, maxTerms: number): Promise<void> {
  const { corpus, directory, queries, index } = await setup(corpusTokens, maxTerms);

  const oldRows: PerQueryRank[] = [];
  const hybridRows: PerQueryRank[] = [];
  for (const q of queries) {
    const { all, primary } = goldShards(q, corpus);
    const oldCands = selectCandidates({
      query: q.question,
      directory,
      maxCandidates: directory.entries.length,
    });
    const hybCands = await selectCandidatesHybrid({
      query: q.question,
      directory,
      index,
      maxCandidates: directory.entries.length,
    });
    oldRows.push({
      queryId: q.id, category: q.category ?? "?",
      ranking: oldCands.map((c) => c.entry.id), gold: all, primary,
    });
    hybridRows.push({
      queryId: q.id, category: q.category ?? "?",
      ranking: hybCands.map((c) => c.entry.id), gold: all, primary,
    });
  }

  printComparison(
    `PaySwift @ ${corpusTokens.toLocaleString()} tokens, weights ${JSON.stringify(DEFAULT_HYBRID_WEIGHTS)}`,
    computeMetrics(oldRows),
    computeMetrics(hybridRows),
  );

  // Per-query detail for the starved class + any rank changes.
  console.log("\n### Per-query primary-gold rank (old → hybrid)\n");
  console.log("| query | category | primary gold | old rank | hybrid rank |");
  console.log("|---|---|---|---|---|");
  for (let i = 0; i < oldRows.length; i++) {
    const o = oldRows[i]!;
    const h = hybridRows[i]!;
    if (!o.primary) continue;
    const or = o.ranking.indexOf(o.primary) + 1;
    const hr = h.ranking.indexOf(h.primary!) + 1;
    const flag = or !== hr ? (hr < or ? " ↑" : " ↓") : "";
    console.log(`| ${o.queryId} | ${o.category} | ${o.primary} | ${or} | ${hr}${flag} |`);
  }
}

function weightGrid(): HybridWeights[] {
  const grid: HybridWeights[] = [];
  for (const wLex of [0.5, 1.0, 1.5, 2.0]) {
    for (const wEmb of [0.5, 1.0, 1.5, 2.0, 3.0]) {
      for (const lexSat of [2, 4, 8]) {
        for (const termWeight of [0.5, 1.0, 1.5]) {
          grid.push({ wLex, wEmb, lexSat, termWeight });
        }
      }
    }
  }
  return grid;
}

/** Joint calibration: average metrics over MULTIPLE corpus sizes so the
 *  chosen default is not overfit to a single filler density. */
async function modeCalibrateJoint(sizes: number[], maxTerms: number): Promise<void> {
  const signalSets: SignalRow[][] = [];
  for (const size of sizes) {
    const { corpus, directory, queries, index } = await setup(size, maxTerms);
    signalSets.push(await computeSignals(queries, corpus, directory, index));
  }
  const grid = weightGrid();
  const results = grid.map((w) => {
    const ms = signalSets.map((signals) =>
      computeMetrics(toRankRows(signals, (row) => rankWithWeights(row, w))),
    );
    const avg = (f: (m: Metrics) => number) => ms.reduce((a, m) => a + f(m), 0) / ms.length;
    const min = (f: (m: Metrics) => number) => Math.min(...ms.map(f));
    return {
      w,
      m: {
        n: ms[0]!.n,
        primaryAt1: avg((m) => m.primaryAt1),
        primaryAt3: avg((m) => m.primaryAt3),
        primaryAt8: avg((m) => m.primaryAt8),
        anyGoldAt3: avg((m) => m.anyGoldAt3),
        anyGoldAt8: avg((m) => m.anyGoldAt8),
        mrrPrimary: avg((m) => m.mrrPrimary),
        goldCoverageAt8: avg((m) => m.goldCoverageAt8),
      } as Metrics,
      minP3: min((m) => m.primaryAt3),
    };
  });
  results.sort((a, b) => {
    if (b.minP3 !== a.minP3) return b.minP3 - a.minP3; // worst-case first
    if (b.m.primaryAt3 !== a.m.primaryAt3) return b.m.primaryAt3 - a.m.primaryAt3;
    if (b.m.primaryAt1 !== a.m.primaryAt1) return b.m.primaryAt1 - a.m.primaryAt1;
    return b.m.mrrPrimary - a.m.mrrPrimary;
  });
  console.log(`\n### Joint calibration over sizes [${sizes.map((s) => s.toLocaleString()).join(", ")}] (${grid.length} configs; sort: min-P@3, then avg P@3/P@1/MRR)\n`);
  console.log("| rank | wLex | wEmb | lexSat | termW | minP@3 | avgP@1 | avgP@3 | avgP@8 | avgMRR | avgCov@8 |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|");
  results.slice(0, 15).forEach((r, i) => {
    console.log(
      `| ${i + 1} | ${r.w.wLex} | ${r.w.wEmb} | ${r.w.lexSat} | ${r.w.termWeight} | ${fmt(r.minP3)} | ${fmt(r.m.primaryAt1)} | ${fmt(r.m.primaryAt3)} | ${fmt(r.m.primaryAt8)} | ${fmt(r.m.mrrPrimary)} | ${fmt(r.m.goldCoverageAt8)} |`,
    );
  });
}

async function modeCalibrate(corpusTokens: number, maxTerms: number): Promise<void> {
  const { corpus, directory, queries, index } = await setup(corpusTokens, maxTerms);
  const signals = await computeSignals(queries, corpus, directory, index);

  const grid = weightGrid();

  const results = grid.map((w) => {
    const m = computeMetrics(toRankRows(signals, (row) => rankWithWeights(row, w)));
    return { w, m };
  });
  results.sort((a, b) => {
    if (b.m.primaryAt3 !== a.m.primaryAt3) return b.m.primaryAt3 - a.m.primaryAt3;
    if (b.m.primaryAt1 !== a.m.primaryAt1) return b.m.primaryAt1 - a.m.primaryAt1;
    if (b.m.mrrPrimary !== a.m.mrrPrimary) return b.m.mrrPrimary - a.m.mrrPrimary;
    return b.m.goldCoverageAt8 - a.m.goldCoverageAt8;
  });

  console.log(`\n### Calibration sweep (${grid.length} configs) @ ${corpusTokens.toLocaleString()} tokens\n`);
  console.log("| rank | wLex | wEmb | lexSat | termW | P@1 | P@3 | P@8 | MRR | cov@8 |");
  console.log("|---|---|---|---|---|---|---|---|---|---|");
  results.slice(0, 15).forEach((r, i) => {
    console.log(
      `| ${i + 1} | ${r.w.wLex} | ${r.w.wEmb} | ${r.w.lexSat} | ${r.w.termWeight} | ${fmt(r.m.primaryAt1)} | ${fmt(r.m.primaryAt3)} | ${fmt(r.m.primaryAt8)} | ${fmt(r.m.mrrPrimary)} | ${fmt(r.m.goldCoverageAt8)} |`,
    );
  });

  // Flat-optimum analysis: how many configs achieve the best P@3?
  const best = results[0]!.m.primaryAt3;
  const flat = results.filter((r) => r.m.primaryAt3 === best);
  console.log(`\nConfigs achieving best P@3=${fmt(best)}: ${flat.length}/${grid.length}`);
  const med = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  console.log(
    `Flat-region medians: wLex=${med(flat.map((r) => r.w.wLex))} wEmb=${med(flat.map((r) => r.w.wEmb))} lexSat=${med(flat.map((r) => r.w.lexSat))} termWeight=${med(flat.map((r) => r.w.termWeight))}`,
  );

  // Baseline for reference.
  const baseline = computeMetrics(
    toRankRows(signals, (row) => rankWithWeights(row, { wLex: 1, wEmb: 0, lexSat: 4, termWeight: 0 })),
  );
  console.log(`\nLexical-only reference: P@1=${fmt(baseline.primaryAt1)} P@3=${fmt(baseline.primaryAt3)} P@8=${fmt(baseline.primaryAt8)} MRR=${fmt(baseline.mrrPrimary)}`);
  const embOnly = computeMetrics(
    toRankRows(signals, (row) => rankWithWeights(row, { wLex: 0, wEmb: 1, lexSat: 4, termWeight: 0 })),
  );
  console.log(`Embedding-only reference: P@1=${fmt(embOnly.primaryAt1)} P@3=${fmt(embOnly.primaryAt3)} P@8=${fmt(embOnly.primaryAt8)} MRR=${fmt(embOnly.mrrPrimary)}`);
}

function rrfRank(row: SignalRow, k = 60): string[] {
  // Lexical list ONLY where lex > 0 (an all-zero lexical ranking is
  // alphabetical noise — exactly the Discovery-A failure RRF must not import).
  const lexOrder = row.shardIds
    .map((id, i) => ({ id, s: row.lex[i]! }))
    .filter((x) => x.s > 0)
    .sort((a, b) => (b.s !== a.s ? b.s - a.s : a.id < b.id ? -1 : 1));
  const embOrder = row.shardIds
    .map((id, i) => ({ id, s: row.emb[i]! }))
    .sort((a, b) => (b.s !== a.s ? b.s - a.s : a.id < b.id ? -1 : 1));
  const score = new Map<string, number>();
  lexOrder.forEach((x, r) => score.set(x.id, (score.get(x.id) ?? 0) + 1 / (k + r + 1)));
  embOrder.forEach((x, r) => score.set(x.id, (score.get(x.id) ?? 0) + 1 / (k + r + 1)));
  return [...row.shardIds]
    .sort((a, b) => {
      const sa = score.get(a) ?? 0;
      const sb = score.get(b) ?? 0;
      if (sb !== sa) return sb - sa;
      return a < b ? -1 : 1;
    });
}

function lexTieRank(row: SignalRow): string[] {
  const scored = row.shardIds.map((id, i) => ({
    id,
    lex: row.lex[i]! + row.termOverlap[i]!, // termWeight 1
    emb: Math.max(0, row.emb[i]!),
  }));
  scored.sort((a, b) => {
    if (b.lex !== a.lex) return b.lex - a.lex;
    if (b.emb !== a.emb) return b.emb - a.emb;
    return a.id < b.id ? -1 : 1;
  });
  return scored.map((s) => s.id);
}

async function modeFusion(corpusTokens: number, maxTerms: number): Promise<void> {
  const { corpus, directory, queries, index } = await setup(corpusTokens, maxTerms);
  const signals = await computeSignals(queries, corpus, directory, index);

  const variants: Array<{ name: string; ranker: (r: SignalRow) => string[] }> = [
    { name: "old lexical", ranker: (r) => rankWithWeights(r, { wLex: 1, wEmb: 0, lexSat: 4, termWeight: 0 }) },
    { name: "weighted-sum (default)", ranker: (r) => rankWithWeights(r, DEFAULT_HYBRID_WEIGHTS) },
    { name: "RRF k=60 (lex>0 guard)", ranker: (r) => rrfRank(r) },
    { name: "lexical + embed tiebreak", ranker: (r) => lexTieRank(r) },
    { name: "embedding only", ranker: (r) => rankWithWeights(r, { wLex: 0, wEmb: 1, lexSat: 4, termWeight: 0 }) },
  ];

  console.log(`\n### Fusion strategy comparison @ ${corpusTokens.toLocaleString()} tokens\n`);
  console.log("| strategy | P@1 | P@3 | P@8 | anyGold@3 | MRR | cov@8 |");
  console.log("|---|---|---|---|---|---|---|");
  for (const v of variants) {
    const m = computeMetrics(toRankRows(signals, v.ranker));
    console.log(
      `| ${v.name} | ${fmt(m.primaryAt1)} | ${fmt(m.primaryAt3)} | ${fmt(m.primaryAt8)} | ${fmt(m.anyGoldAt3)} | ${fmt(m.mrrPrimary)} | ${fmt(m.goldCoverageAt8)} |`,
    );
  }
}

// BEAM-shaped fixture with the REAL MiniLM: 12 conversations, thin metadata,
// distinct topical payloads. Gold targets sit alphabetically OUTSIDE the
// old router's top-8 so the alphabetical failure is visible.
async function modeBeamFixture(): Promise<void> {
  const topics: Array<[string, string]> = [
    ["conv-01", "User: Standup notes, nothing notable. Assistant: Acknowledged, see you tomorrow."],
    ["conv-02", "User: Reviewed the quarterly OKR draft. Assistant: Sent comments on the doc."],
    ["conv-03", "User: Lunch options near the office are limited. Assistant: The new place opens Monday."],
    ["conv-04", "User: Reminder to submit expense reports. Assistant: Done, receipts attached."],
    ["conv-05", "User: Calendar sync issue on mobile. Assistant: Reinstalling the app fixed it."],
    ["conv-06", "User: Team offsite agenda brainstorm. Assistant: Added two workshop ideas."],
    ["conv-07", "User: Printer on floor three is jammed again. Assistant: Facilities ticket filed."],
    ["conv-08", "User: Weekly metrics dashboard looks flat. Assistant: Traffic dipped over the holiday."],
    ["conv-09", "User: We chose PBKDF2 with SHA256 for password hashing, 600k iterations. Assistant: Recorded the password-hashing decision."],
    ["conv-10", "User: Database decision: SQLite for the MVP, migrate to Postgres after GA. Assistant: Noted the database plan."],
    ["conv-11", "User: Webhook retries use exponential backoff, capped at six attempts. Assistant: Webhook retry policy saved."],
    ["conv-12", "User: Refund SLA for enterprise accounts is two business days. Assistant: Refund policy noted."],
  ];
  const queries: Array<{ q: string; gold: string }> = [
    { q: "What password hashing algorithm did we choose?", gold: "conv-09" },
    { q: "Which database are we using for the MVP?", gold: "conv-10" },
    { q: "How are webhook retries handled?", gold: "conv-11" },
    { q: "What is the refund SLA for enterprise customers?", gold: "conv-12" },
  ];

  const createdAt = "2024-01-01T00:00:00.000Z";
  const entries: MemoryDirectoryEntry[] = topics.map(([id]) => ({
    id,
    name: id,
    description: `Benchmark shard ${id}`,
    tags: ["amb", "beam", "beam-turn"],
    createdAt,
    updatedAt: createdAt,
    status: "active",
    snapshotId: "S001",
    tokenCountEstimate: 100,
    contextLimitEstimate: SYNTHETIC_CONTEXT_LIMIT,
    fullnessPct: 0,
    summaryShort: `Synthetic shard ${id} (1 events).`,
    knownConflicts: [],
    parentId: null,
    children: [],
    trustLevel: "imported_doc",
    staleness: "current",
  }));
  const directory: MemoryDirectory = { version: 1, entries };

  const descriptors = deriveShardDescriptors(
    topics.map(([shardId, content]) => ({ shardId, events: [{ content }] })),
  );
  const vecs = await embed(topics.map(([, content]) => content), EMBED_MODEL_NAME);
  const index = await buildRouterIndex({
    shards: topics.map(([shardId], i) => ({
      shardId,
      terms: descriptors.get(shardId)?.terms ?? [],
      centroid: vecs[i] ?? null,
    })),
    embed: (texts) => embed(texts, EMBED_MODEL_NAME),
    model: EMBED_MODEL_NAME,
  });

  console.log("\n### BEAM-shaped fixture (12 thin-metadata shards, REAL MiniLM)\n");
  console.log("| query | gold | old rank (top-8 member?) | hybrid rank |");
  console.log("|---|---|---|---|");
  let oldTop3 = 0, hybTop3 = 0;
  for (const { q, gold } of queries) {
    const oldCands = selectCandidates({ query: q, directory, maxCandidates: 12 });
    const hybCands = await selectCandidatesHybrid({ query: q, directory, index, maxCandidates: 12 });
    const oldRank = oldCands.findIndex((c) => c.entry.id === gold) + 1;
    const hybRank = hybCands.findIndex((c) => c.entry.id === gold) + 1;
    if (oldRank > 0 && oldRank <= 3) oldTop3++;
    if (hybRank > 0 && hybRank <= 3) hybTop3++;
    console.log(
      `| ${q} | ${gold} | ${oldRank} (${oldRank > 0 && oldRank <= 8 ? "yes" : "NO — dropped by alphabetical cap"}) | ${hybRank} |`,
    );
  }
  console.log(`\nGold-in-top-3: old ${oldTop3}/${queries.length} → hybrid ${hybTop3}/${queries.length}`);
}

// ─── probe-interplay analysis from existing PaySwift run artifacts ───────────

interface RunRow {
  system: string;
  corpusSize: number;
  queryId: string;
  correct: boolean;
  relevantEventIds?: string[];
  meta?: {
    candidateShardIds?: string[];
    probedShardIds?: string[];
    recalledShardIds?: string[];
    probeAcceptCount?: number;
    probeCount?: number;
    recallCount?: number;
    routerTopScore?: number;
  };
}

async function modeInterplay(): Promise<void> {
  const allEvents = await loadAllEvents(CORPUS_DIR);
  const shardByEvent = new Map(allEvents.map((e) => [e.id, e.shardId]));
  const queries = await loadQueries();
  const goldByQuery = new Map<string, { all: Set<string>; primary: string | null }>();
  for (const q of queries) {
    const counts = new Map<string, number>();
    for (const id of q.relevantEventIds ?? []) {
      const s = shardByEvent.get(id);
      if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    const primary =
      counts.size === 0
        ? null
        : [...counts.entries()].sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : 1))[0]![0];
    goldByQuery.set(q.id, { all: new Set(counts.keys()), primary });
  }

  const runs = ["gemini35-160k-30q-v1", "v020-30q-embedfloor", "scaling-1m"];
  for (const run of runs) {
    let raw: string;
    try {
      raw = await readFile(join(RUNS_DIR, run, "results.jsonl"), "utf8");
    } catch {
      console.log(`\n(run ${run} not found — skipping)`);
      continue;
    }
    const rows = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as RunRow)
      .filter((r) => r.system === "csm");

    const byCorpus = new Map<number, RunRow[]>();
    for (const r of rows) {
      const arr = byCorpus.get(r.corpusSize) ?? [];
      arr.push(r);
      byCorpus.set(r.corpusSize, arr);
    }

    for (const [corpusSize, batch] of byCorpus) {
      let n = 0;
      let goldInCands = 0, goldTop1 = 0, goldTop3 = 0;
      let goldRecalled = 0, goldCandNotRecalled = 0;
      let rank2NotRecalled = 0;
      let correctWhenGoldRecalled = 0, nGoldRecalled = 0;
      let correctWhenNot = 0, nNot = 0;
      let probeSum = 0, recallSum = 0;
      for (const r of batch) {
        const gold = goldByQuery.get(r.queryId);
        if (!gold || !gold.primary) continue;
        n++;
        const cands = r.meta?.candidateShardIds ?? [];
        const recalled = new Set(r.meta?.recalledShardIds ?? []);
        probeSum += r.meta?.probeCount ?? 0;
        recallSum += r.meta?.recallCount ?? 0;
        const rank = cands.indexOf(gold.primary);
        if (rank > -1) goldInCands++;
        if (rank === 0) goldTop1++;
        if (rank > -1 && rank < 3) goldTop3++;
        const wasRecalled = recalled.has(gold.primary);
        if (wasRecalled) {
          goldRecalled++;
          nGoldRecalled++;
          if (r.correct) correctWhenGoldRecalled++;
        } else {
          nNot++;
          if (r.correct) correctWhenNot++;
          if (rank > -1) goldCandNotRecalled++;
          if (rank === 1) rank2NotRecalled++;
        }
      }
      console.log(`\n### Probe interplay — ${run} csm@${corpusSize.toLocaleString()} (n=${n})`);
      console.log(`router: primary gold in candidates ${goldInCands}/${n}, top-1 ${goldTop1}/${n}, top-3 ${goldTop3}/${n}`);
      console.log(`probe+trust: gold recalled ${goldRecalled}/${n}; gold candidate but NOT recalled ${goldCandNotRecalled}/${n} (probe false-negative beyond the top-1 net)`);
      console.log(`top-2 trust-net rescue population: gold at rank 2 and not recalled = ${rank2NotRecalled}/${n}`);
      console.log(`answer accuracy | gold recalled: ${correctWhenGoldRecalled}/${nGoldRecalled}; | gold not recalled: ${correctWhenNot}/${nNot}`);
      console.log(`avg probes/query ${(probeSum / Math.max(1, n)).toFixed(2)}, avg recalls/query ${(recallSum / Math.max(1, n)).toFixed(2)}`);
    }
  }
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const mode = argValue("mode", "compare");
  const maxTerms = Number(argValue("max-terms", "16"));
  const corpusTokens =
    mode === "calibrate-joint" || mode === "beam-fixture" || mode === "interplay"
      ? 0
      : parseTokens(argValue("corpus-tokens", "100K"));

  if (mode === "compare") await modeCompare(corpusTokens, maxTerms);
  else if (mode === "calibrate") await modeCalibrate(corpusTokens, maxTerms);
  else if (mode === "calibrate-joint") {
    const sizes = argValue("corpus-tokens", "100K,1M").split(",").map(parseTokens);
    await modeCalibrateJoint(sizes, maxTerms);
  }
  else if (mode === "fusion") await modeFusion(corpusTokens, maxTerms);
  else if (mode === "beam-fixture") await modeBeamFixture();
  else if (mode === "interplay") await modeInterplay();
  else throw new Error(`unknown --mode ${mode}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
