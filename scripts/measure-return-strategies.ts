#!/usr/bin/env tsx
/**
 * Return-slice strategy lab — token-free R&D for beating Hindsight on the two
 * losing BEAM categories (summarization, event_ordering).
 *
 * Compares return-slice strategies at EQUAL answer-visible token cost. The
 * ranking code is imported from src/eval/ambReturnRank.ts — the SAME module the
 * production bridge uses — so these numbers are exactly what production does.
 *
 * Leakage-safe: ranking uses ONLY the query text (loadBeamGold.question, an
 * inference-time input) and event text (corpus). Gold facets are used ONLY to
 * SCORE (eval-side), never to rank.
 *
 *   npx tsx scripts/measure-return-strategies.ts [runId]
 */

import { join, resolve } from "node:path";
import {
  loadBeamGold,
  buildBeamEventIndex,
  readPayloadRows,
  scorePayloadRow,
  type BeamEventIndex,
} from "../src/eval/retrievalScore.js";
import { estReturnTokens, greedyCoverageOrder } from "../src/eval/ambReturnRank.js";

const RUN_ID = process.argv[2] ?? "beam-slice-100k-live-coverage-bridge-v1";
const SPLIT = "100k";
const TARGET = new Set(["summarization", "event_ordering"]);
const BUDGETS = [10000, 13000, 16000];
const HINDSIGHT_TOKENS = 17654;
const HINDSIGHT_SCORE: Record<string, number> = { summarization: 0.793, event_ordering: 0.805 };

type Strategy = (ids: string[], query: string, getText: (id: string) => string) => string[];
const STRATEGIES: Array<{ name: string; fn: Strategy }> = [
  { name: "baseline", fn: (ids) => ids },
  { name: "mmr-diversity", fn: (ids, q, g) => greedyCoverageOrder(ids, g, q, 1, 0) },
  { name: "mmr-sqrt-q", fn: (ids, q, g) => greedyCoverageOrder(ids, g, q, 4, 0.5) },
  { name: "mmr-perTok-q", fn: (ids, q, g) => greedyCoverageOrder(ids, g, q, 4, 1) },
];

function packToBudget(order: string[], budget: number, getText: (id: string) => string): string[] {
  const out: string[] = [];
  let used = 0;
  for (const id of order) {
    const t = estReturnTokens(getText(id));
    if (out.length > 0 && used + t > budget) break;
    out.push(id);
    used += t;
  }
  return out;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function pc(x: number): string {
  return (x * 100).toFixed(1).padStart(5);
}

async function main(): Promise<void> {
  const runsDir = resolve(process.cwd(), "data", "eval", "runs");
  const rows = readPayloadRows(join(runsDir, RUN_ID, "payloads.jsonl"));
  const gold = loadBeamGold(SPLIT, {});
  const index: BeamEventIndex = buildBeamEventIndex(SPLIT, {});
  const getText = (id: string): string => index.textById.get(id) ?? "";

  const byCat = new Map<string, typeof rows>();
  for (const row of rows) {
    const g = gold.get(row.queryId);
    if (!g || !TARGET.has(g.category)) continue;
    const arr = byCat.get(g.category) ?? [];
    arr.push(row);
    byCat.set(g.category, arr);
  }

  console.log(`Return-slice strategy lab — run ${RUN_ID} (${SPLIT}); token-free, LLM-free`);
  console.log(`Ranking = src/eval/ambReturnRank.ts (same as production). Scoring = gold facets (eval-side).`);
  console.log(`Each cell = mean facet coverage when packed to that TOKEN budget. Hindsight ~${HINDSIGHT_TOKENS} tok.\n`);
  const BIGK = 100000;

  for (const [cat, catRows] of [...byCat.entries()].sort()) {
    const oracle = mean(catRows.map((r) => scorePayloadRow(r, gold.get(r.queryId)!, index, [24])!.oracleCoverage));
    const retr = mean(catRows.map((r) => scorePayloadRow(r, gold.get(r.queryId)!, index, [24])!.retrievedCoverage));
    console.log(`════ ${cat}  (n=${catRows.length}, oracle ${pc(oracle)}%, retrieved-ceiling ${pc(retr)}%, Hindsight score ${HINDSIGHT_SCORE[cat]})`);
    console.log(`  strategy          ` + BUDGETS.map((b) => `${b / 1000}k:cov  n`).join("    "));
    for (const { name, fn } of STRATEGIES) {
      const cells: string[] = [];
      for (const b of BUDGETS) {
        const covs: number[] = [];
        const ns: number[] = [];
        for (const row of catRows) {
          const g = gold.get(row.queryId)!;
          const ordered = fn(row.csmRetrievedEventIds, g.question, getText);
          const packed = packToBudget(ordered, b, getText);
          const s = scorePayloadRow({ ...row, returnedEventIds: packed }, g, index, [BIGK]);
          if (s) covs.push(s.coverageAtK[`@${BIGK}`]!);
          ns.push(packed.length);
        }
        cells.push(`${pc(mean(covs))}% ${String(Math.round(mean(ns))).padStart(3)}`);
      }
      console.log(`  ${name.padEnd(16)} ${cells.join("   ")}`);
    }
    console.log("");
  }
  console.log("cov = facet coverage at equal token spend; n = mean events packed. Higher cov at same budget = better.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
