#!/usr/bin/env tsx
/**
 * Tier 0 — token-free digest-selection harness.
 *
 * Measures, with ZERO LLM calls, whether the Signals levers change WHICH gold
 * evidence (and how much of it) survives the recall digest's 480-char / 1200-
 * token cuts, versus the current blind head-truncation. Pure string ops over
 * the real PaySwift corpus + on-disk gold labels (relevantEventIds, options).
 *
 * It isolates the recall TRUNCATION stage under a declared fixed selection
 * policy: each query is scoped to the shard(s) that actually hold its gold
 * events (no live probe), and the per-shard digest is built three ways:
 *   - blind        : production order + blind 480-char truncation  (baseline)
 *   - salient-order: re-rank events by query salience (lever #1)
 *   - salient-full : lever #1 + salient intra-event truncation (lever #2)
 *
 * What it PROVES: presence — the answer-bearing evidence now lands in-budget.
 * What it does NOT prove: that the LLM then answers better (that is Tier 2,
 * the local-Ollama A/B). If salient never beats blind here, stop — there is
 * nothing for the model to gain.
 *
 *   npx tsx scripts/measure-digest-selection.ts [size ...]
 *   size = "core" (core-only) or a token target like 1000000 (default: core 1000000)
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  loadAllEvents,
  sampleFromEvents,
  type BenchEvent,
  type Corpus,
} from "../src/eval/corpus.js";
import {
  McqQueriesFileZ,
  validateMcqQuery,
  type McqQuery,
  type FreeFormQuery,
} from "../src/eval/mcq.js";
import {
  loadBabilongTask,
  type BabilongContextLabel,
  type BabilongTaskId,
} from "../src/eval/corpus/babilong.js";
import { selectEventDigest, type DigestEvent } from "../src/core/digestSelection.js";
import { tokenize } from "../src/core/router.js";

const CORPUS_DIR = "data/eval/corpus-synthetic";
const OUT_DIR = "data/eval/digest-selection";
const RECALL_BUDGET = 1200; // DEFAULT_RECALL_BUDGET.maxRecallTokensPerShard
const PER_EVENT_CHARS = 480;
const CREATED_AT = "2024-01-01T00:00:00.000Z"; // matches toMemoryEvent default

type Mode = "blind" | "salientOrder" | "salientFull";

/** Reproduce production `toMemoryEvent` exactly (role "user", timestamp fallback). */
function toDigestEvent(e: BenchEvent): DigestEvent {
  return {
    eventId: e.id,
    role: "user",
    content: e.content,
    createdAt: e.timestamp ?? CREATED_AT,
    tags: e.tags ?? [],
  };
}

/** Per shard, events id-sorted then mapped — exactly as buildShardsFromCorpus does. */
function shardDigestEvents(corpus: Corpus, shardId: string): DigestEvent[] {
  const events = corpus.byShard.get(shardId) ?? [];
  return [...events]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(toDigestEvent);
}

function buildDigest(events: DigestEvent[], mode: Mode, query: string, budget = RECALL_BUDGET, hint?: string[]) {
  if (mode === "blind") return selectEventDigest(events, { maxTokens: budget, hint });
  if (mode === "salientOrder")
    return selectEventDigest(events, { maxTokens: budget, reorderBySalience: true, query, hint });
  return selectEventDigest(events, {
    maxTokens: budget,
    reorderBySalience: true,
    salientTruncation: true,
    query,
    hint,
  });
}

function coverage(queryTerms: Set<string>, text: string): number {
  if (queryTerms.size === 0) return 1;
  const have = new Set(tokenize(text));
  let hit = 0;
  for (const t of queryTerms) if (have.has(t)) hit++;
  return hit / queryTerms.size;
}

interface QueryResult {
  id: string;
  category: string;
  goldCount: number;
  goldShards: number;
  longGoldEvents: number; // gold events whose content exceeds the 480 cap
  goldRetained: Record<Mode, number>; // fraction of gold ids whose line survived
  termCoverage: Record<Mode, number>; // question-term coverage of the union digest
  goldContentTermsKept: Record<"blind" | "salientFull", number>; // lever #2 signal
}

function measureQuery(corpus: Corpus, q: McqQuery, budget = RECALL_BUDGET): QueryResult | null {
  const goldIds = q.relevantEventIds.filter((id) => corpus.byId.has(id));
  const qTerms = new Set(tokenize(q.question));

  // Gold shards = the shards that actually hold this query's gold events.
  const goldShards = [...new Set(goldIds.map((id) => corpus.byId.get(id)!.shardId))].sort();
  if (goldShards.length === 0) return null; // q28/q29 (empty relevantEventIds) — excluded

  const modes: Mode[] = ["blind", "salientOrder", "salientFull"];
  const selectedByMode: Record<Mode, Set<string>> = {
    blind: new Set(),
    salientOrder: new Set(),
    salientFull: new Set(),
  };
  const textByMode: Record<Mode, string[]> = { blind: [], salientOrder: [], salientFull: [] };

  for (const shardId of goldShards) {
    const events = shardDigestEvents(corpus, shardId);
    for (const mode of modes) {
      const d = buildDigest(events, mode, q.question, budget);
      for (const id of d.selectedIds) selectedByMode[mode].add(id);
      textByMode[mode].push(d.text);
    }
  }

  const goldRetained = {} as Record<Mode, number>;
  const termCoverage = {} as Record<Mode, number>;
  for (const mode of modes) {
    goldRetained[mode] = goldIds.length
      ? goldIds.filter((id) => selectedByMode[mode].has(id)).length / goldIds.length
      : 1;
    termCoverage[mode] = coverage(qTerms, textByMode[mode].join("\n"));
  }

  // Lever #2: on long gold events, how many of the question terms that appear
  // in the gold event's content survive the per-event truncation?
  let longGold = 0;
  let blindKept = 0;
  let salientKept = 0;
  let denom = 0;
  for (const id of goldIds) {
    const content = corpus.byId.get(id)!.content;
    if (content.length <= PER_EVENT_CHARS) continue;
    longGold++;
    const inContent = new Set([...tokenize(content)].filter((t) => qTerms.has(t)));
    if (inContent.size === 0) continue;
    denom += inContent.size;
    // Single-event digests isolate the per-event truncation for this gold event.
    const ev = toDigestEvent(corpus.byId.get(id)!);
    const blindBody = new Set(tokenize(buildDigest([ev], "blind", q.question).text));
    const salientBody = new Set(tokenize(buildDigest([ev], "salientFull", q.question).text));
    for (const t of inContent) {
      if (blindBody.has(t)) blindKept++;
      if (salientBody.has(t)) salientKept++;
    }
  }

  return {
    id: q.id,
    category: q.category ?? "uncategorised",
    goldCount: goldIds.length,
    goldShards: goldShards.length,
    longGoldEvents: longGold,
    goldRetained,
    termCoverage,
    goldContentTermsKept: {
      blind: denom ? blindKept / denom : 1,
      salientFull: denom ? salientKept / denom : 1,
    },
  };
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

async function loadQueries(): Promise<McqQuery[]> {
  const raw = JSON.parse(await readFile(join(CORPUS_DIR, "queries.json"), "utf8"));
  return McqQueriesFileZ.parse(raw).queries.map(validateMcqQuery);
}

function parseSize(tok: string, coreTokens: number): { label: string; target: number } {
  if (tok === "core") return { label: "core-only", target: coreTokens };
  const n = Number(tok.replace(/[_,]/g, ""));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`bad size arg: ${tok}`);
  return { label: n.toLocaleString(), target: n };
}

// ─── BABILong needle-in-haystack (free-form) ────────────────────────────────

const BABILONG_TASKS: BabilongTaskId[] = [1, 2];
const BABILONG_LENGTHS: BabilongContextLabel[] = ["4K", "8K"];

function babilongShards(events: BenchEvent[]): Map<string, DigestEvent[]> {
  const byShard = new Map<string, DigestEvent[]>();
  for (const e of events) {
    const de = toDigestEvent(e);
    const arr = byShard.get(e.shardId);
    if (arr) arr.push(de);
    else byShard.set(e.shardId, [de]);
  }
  for (const arr of byShard.values()) {
    arr.sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
  }
  return byShard;
}

async function measureBabilong(): Promise<void> {
  const modes: Mode[] = ["blind", "salientOrder", "salientFull"];
  let ran = false;
  for (const task of BABILONG_TASKS) {
    for (const label of BABILONG_LENGTHS) {
      let loaded;
      try {
        loaded = await loadBabilongTask(task, label, { sampleSize: 30, seed: 42 });
      } catch {
        continue; // split not on disk — skip silently
      }
      ran = true;
      const byShard = babilongShards(loaded.events);

      const rows = loaded.queries.map((q: FreeFormQuery) => {
        const shardId = q.shardHints?.[0] ?? "";
        const events = byShard.get(shardId) ?? [];
        const needle = q.correctAnswer.toLowerCase();
        const goldIds = q.relevantEventIds;
        const needleSurvived = {} as Record<Mode, boolean>;
        const goldRetained = {} as Record<Mode, number>;
        for (const mode of modes) {
          const d = buildDigest(events, mode, q.question);
          needleSurvived[mode] = d.text.toLowerCase().includes(needle);
          const sel = new Set(d.selectedIds);
          goldRetained[mode] = goldIds.length
            ? goldIds.filter((id) => sel.has(id)).length / goldIds.length
            : 1;
        }
        return { id: q.id, needleSurvived, goldRetained, instanceEvents: events.length };
      });

      const survBlind = rows.filter((r) => r.needleSurvived.blind).length;
      const survFull = rows.filter((r) => r.needleSurvived.salientFull).length;
      const rescued = rows.filter((r) => !r.needleSurvived.blind && r.needleSurvived.salientFull).length;
      const lost = rows.filter((r) => r.needleSurvived.blind && !r.needleSurvived.salientFull).length;
      const avgEvents = Math.round(mean(rows.map((r) => r.instanceEvents)));

      console.log(`════ BABILong task${task} @ ${label}  (${rows.length} instances, ~${avgEvents} sentences each) ════`);
      console.log(`  needle survival in 1200-tok digest  blind ${survBlind}/${rows.length} (${pct(survBlind / rows.length)}) → salient ${survFull}/${rows.length} (${pct(survFull / rows.length)})`);
      console.log(`  needles rescued by salient: ${rescued}   regressed: ${lost}`);
      console.log(`  gold-fact retention  blind ${pct(mean(rows.map((r) => r.goldRetained.blind)))} → salient ${pct(mean(rows.map((r) => r.goldRetained.salientFull)))}\n`);

      await writeFile(
        join(OUT_DIR, `babilong-task${task}-${label}.json`),
        JSON.stringify({ task, label, instances: rows.length, needleSurvivalBlind: survBlind, needleSurvivalSalient: survFull, rescued, lost, perQuery: rows }, null, 2),
      );
    }
  }
  if (!ran) console.log("(no BABILong splits found on disk — skipped)\n");
}

// ─── Probe-hint safety: does the hint-first rule remove salient regressions? ─

/** Gold-event survival for one query under a given salient hint policy. */
function goldSurvivalSalient(corpus: Corpus, q: McqQuery, hint: string[] | undefined): number {
  const goldIds = q.relevantEventIds.filter((id) => corpus.byId.has(id));
  const goldShards = [...new Set(goldIds.map((id) => corpus.byId.get(id)!.shardId))];
  if (goldShards.length === 0 || goldIds.length === 0) return -1; // skip (q28/q29)
  const sel = new Set<string>();
  for (const shardId of goldShards) {
    const events = shardDigestEvents(corpus, shardId);
    const d = buildDigest(events, "salientFull", q.question, RECALL_BUDGET, hint);
    for (const id of d.selectedIds) sel.add(id);
  }
  return goldIds.filter((id) => sel.has(id)).length / goldIds.length;
}

async function measureOracleHint(all: BenchEvent[], queries: McqQuery[], coreTokens: number): Promise<void> {
  const corpus = sampleFromEvents(all, { targetTokens: coreTokens, seed: 42 });
  const blind: number[] = [];
  const salNoHint: number[] = [];
  const salHint: number[] = [];
  let regressNoHint = 0;
  let regressHint = 0;
  for (const q of queries) {
    const r = measureQuery(corpus, q); // blind + salient(no hint)
    if (!r) continue;
    const b = r.goldRetained.blind;
    const sNo = r.goldRetained.salientFull;
    // Oracle hint = the gold ids (a perfect probe): hint-first must protect them.
    const sHint = goldSurvivalSalient(corpus, q, q.relevantEventIds);
    blind.push(b);
    salNoHint.push(sNo);
    salHint.push(sHint);
    if (sNo < b) regressNoHint++;
    if (sHint < b) regressHint++;
  }
  console.log("──────── Probe-hint safety: salient regressions with vs without a hint ────────");
  console.log(`  mean gold survival   blind ${pct(mean(blind))} → salient(no hint) ${pct(mean(salNoHint))} → salient(oracle hint) ${pct(mean(salHint))}`);
  console.log(`  queries worse than blind:   no-hint ${regressNoHint}   oracle-hint ${regressHint}`);
  console.log(`  (oracle hint = a perfect probe; the live probe lands between these two bounds)\n`);
}

// ─── Token-cut headroom: how far can we shrink the budget under salience? ────

function meanGoldSurvival(
  corpus: Corpus,
  queries: McqQuery[],
  mode: "blind" | "salientFull",
  budget: number,
): number {
  const vals: number[] = [];
  for (const q of queries) {
    const r = measureQuery(corpus, q, budget);
    if (r) vals.push(r.goldRetained[mode]);
  }
  return mean(vals);
}

async function measureBudgetSweep(all: BenchEvent[], queries: McqQuery[], coreTokens: number): Promise<void> {
  const corpus = sampleFromEvents(all, { targetTokens: coreTokens, seed: 42 });
  const budgets = [1200, 1000, 800, 600, 500, 400, 300, 200];
  const blindBaseline = meanGoldSurvival(corpus, queries, "blind", 1200);

  console.log("──────── Token-cut headroom: recall-budget sweep (PaySwift gold survival) ────────");
  console.log(`  baseline = blind @ 1200 tok → ${pct(blindBaseline)} gold-event survival\n`);
  console.log("  budget   blind    salient   salient ≥ blind@1200 ?");
  let isoBudget = 1200;
  for (const b of budgets) {
    const blindB = meanGoldSurvival(corpus, queries, "blind", b);
    const salB = meanGoldSurvival(corpus, queries, "salientFull", b);
    const meets = salB >= blindBaseline;
    if (meets) isoBudget = Math.min(isoBudget, b);
    console.log(`  ${String(b).padStart(4)}    ${pct(blindB).padStart(6)}   ${pct(salB).padStart(6)}    ${meets ? "yes" : "no"}`);
  }
  const cut = Math.round((1 - isoBudget / 1200) * 100);
  console.log(`\n  → salient holds the blind@1200 survival bar down to ${isoBudget} tok = ~${cut}% recall-token cut at iso-survival\n`);
}

async function measureBabilongBudget(): Promise<void> {
  let loaded;
  try {
    loaded = await loadBabilongTask(1, "8K", { sampleSize: 30, seed: 42 });
  } catch {
    return; // split not on disk
  }
  const byShard = babilongShards(loaded.events);
  const budgets = [1200, 800, 400, 200, 100, 50];
  console.log("──────── Token-cut headroom: BABILong task1@8K needle survival vs budget ────────");
  console.log("  budget   blind    salient");
  const n = loaded.queries.length;
  for (const b of budgets) {
    let blindS = 0;
    let salS = 0;
    for (const q of loaded.queries) {
      const events = byShard.get(q.shardHints?.[0] ?? "") ?? [];
      const needle = q.correctAnswer.toLowerCase();
      if (buildDigest(events, "blind", q.question, b).text.toLowerCase().includes(needle)) blindS++;
      if (buildDigest(events, "salientFull", q.question, b).text.toLowerCase().includes(needle)) salS++;
    }
    console.log(`  ${String(b).padStart(4)}    ${pct(blindS / n).padStart(6)}   ${pct(salS / n).padStart(6)}`);
  }
  console.log();
}

async function main(): Promise<void> {
  const all = await loadAllEvents(CORPUS_DIR);
  const coreTokens = all.filter((e) => e.isCore).reduce((s, e) => s + e.tokenCount, 0);
  const queries = await loadQueries();

  const sizeArgs = process.argv.slice(2);
  const sizes = (sizeArgs.length ? sizeArgs : ["core", "1000000"]).map((s) =>
    parseSize(s, coreTokens),
  );

  await mkdir(OUT_DIR, { recursive: true });
  console.log(
    `Digest-selection harness — ${queries.length} PaySwift queries, recall budget ${RECALL_BUDGET} tok, ${PER_EVENT_CHARS}-char/event cap`,
  );
  console.log(`Core tokens: ${coreTokens.toLocaleString()}  (no LLM calls; pure deterministic)\n`);

  for (const { label, target } of sizes) {
    const corpus = sampleFromEvents(all, { targetTokens: target, seed: 42 });
    const results = queries.map((q) => measureQuery(corpus, q)).filter((r): r is QueryResult => r !== null);

    const blindRet = results.map((r) => r.goldRetained.blind);
    const orderRet = results.map((r) => r.goldRetained.salientOrder);
    const fullRet = results.map((r) => r.goldRetained.salientFull);
    const orderWins = results.filter((r) => r.goldRetained.salientOrder > r.goldRetained.blind).length;
    const orderLoss = results.filter((r) => r.goldRetained.salientOrder < r.goldRetained.blind).length;
    const allGoldBlind = results.filter((r) => r.goldRetained.blind >= 1).length;
    const allGoldFull = results.filter((r) => r.goldRetained.salientFull >= 1).length;
    const longGoldQs = results.filter((r) => r.longGoldEvents > 0);

    console.log(`════ corpus = ${label}  (${corpus.totalTokens.toLocaleString()} tok, ${corpus.events.length} events, ${corpus.byShard.size} shards) ════`);
    console.log(`  scored queries (gold present): ${results.length}/${queries.length}`);
    console.log(`  ── Lever #1: gold-event survival in the 1200-tok digest ──`);
    console.log(`     mean gold retained   blind ${pct(mean(blindRet))} → salient-order ${pct(mean(orderRet))} → salient-full ${pct(mean(fullRet))}`);
    console.log(`     ALL gold retained    blind ${allGoldBlind}/${results.length} → salient-full ${allGoldFull}/${results.length}`);
    console.log(`     salient-order vs blind:  ${orderWins} better, ${orderLoss} worse, ${results.length - orderWins - orderLoss} equal`);
    console.log(`  ── Lever #2: question-terms kept from LONG gold events (>${PER_EVENT_CHARS} chars) ──`);
    if (longGoldQs.length) {
      console.log(`     ${longGoldQs.length} queries have long gold events; mean q-term retention  blind ${pct(mean(longGoldQs.map((r) => r.goldContentTermsKept.blind)))} → salient ${pct(mean(longGoldQs.map((r) => r.goldContentTermsKept.salientFull)))}`);
    } else {
      console.log(`     (no gold events exceed ${PER_EVENT_CHARS} chars at this size — lever #2 inert)`);
    }
    console.log(`  ── Digest question-term coverage ──`);
    console.log(`     blind ${pct(mean(results.map((r) => r.termCoverage.blind)))} → salient-full ${pct(mean(results.map((r) => r.termCoverage.salientFull)))}\n`);

    const outPath = join(OUT_DIR, `paySwift-${label.replace(/[^a-z0-9]/gi, "-")}.json`);
    await writeFile(
      outPath,
      JSON.stringify(
        {
          corpus: { label, targetTokens: target, totalTokens: corpus.totalTokens, events: corpus.events.length, shards: corpus.byShard.size },
          budget: { recallTokens: RECALL_BUDGET, perEventChars: PER_EVENT_CHARS },
          aggregate: {
            scoredQueries: results.length,
            meanGoldRetained: { blind: mean(blindRet), salientOrder: mean(orderRet), salientFull: mean(fullRet) },
            allGoldRetained: { blind: allGoldBlind, salientFull: allGoldFull, of: results.length },
            lever1OrderWins: orderWins,
            lever1OrderLosses: orderLoss,
          },
          perQuery: results,
        },
        null,
        2,
      ),
    );
    console.log(`  wrote ${outPath}\n`);
  }

  console.log("──────── BABILong (free-form needle-in-haystack) ────────\n");
  await measureBabilong();

  await measureOracleHint(all, queries, coreTokens);
  await measureBudgetSweep(all, queries, coreTokens);
  await measureBabilongBudget();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
