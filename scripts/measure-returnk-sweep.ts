#!/usr/bin/env tsx
/**
 * RETURN_K sweep — token-free proof of the BEAM "severe loss" cause.
 *
 * The diagnosis: CSM loses summarization + event_ordering to Hindsight because
 * the answer-visible context is the COUNT slice
 *   returnedEventIds = dedupeInOrder(csmRetrievedEventIds).slice(0, RETURN_K)
 * (amb-csm-retrieve.ts:198), with RETURN_K = 24 (summary) / 32 (reasoning).
 * The pipeline RETRIEVES ~40-70 events at ~0.80-0.83 facet coverage, but the
 * count slice throws most of it away before the answer model sees it.
 *
 * This script simulates raising RETURN_K WITHOUT any LLM call: it re-scores
 * cov@K over the FULL csmRetrievedEventIds ranking (not the already-capped
 * returnedEventIds) for K in a sweep, reusing the EXACT scorer in
 * src/eval/retrievalScore.ts (coverageOver / textSupportsFacet) so there is
 * zero metric drift. cov@K here = "what the answer-visible coverage WOULD be if
 * RETURN_K were K". The ceiling is retrievedCoverage (K = all).
 *
 *   npx tsx scripts/measure-returnk-sweep.ts [runId]
 *   default runId = beam-slice-100k-live-coverage-bridge-v1
 */

import { join, resolve } from "node:path";
import {
  aggregateByCategory,
  buildBeamEventIndex,
  loadBeamGold,
  readPayloadRows,
  scorePayloadRow,
  type RowScore,
} from "../src/eval/retrievalScore.js";

const RUN_ID = process.argv[2] ?? "beam-slice-100k-live-coverage-bridge-v1";
const SPLIT = "100k";
const KS = [10, 24, 32, 40, 48, 64, 96, 256]; // 256 ~= "return everything retrieved"
const TARGET_CATS = new Set(["summarization", "event_ordering"]);
// Current production caps (resolveAmbReturnMax): summary 24, reasoning 32.
const CURRENT_CAP: Record<string, number> = { summarization: 24, event_ordering: 32 };

function pct(x: number): string {
  return (x * 100).toFixed(1).padStart(5) + "%";
}

async function main(): Promise<void> {
  const runsDir = resolve(process.cwd(), "data", "eval", "runs");
  const rows = readPayloadRows(join(runsDir, RUN_ID, "payloads.jsonl"));
  const gold = loadBeamGold(SPLIT, {});
  const index = buildBeamEventIndex(SPLIT, {});

  const scores: RowScore[] = [];
  for (const row of rows) {
    const g = gold.get(row.queryId);
    if (!g || !TARGET_CATS.has(g.category)) continue;
    // Simulate RETURN_K = K: score cov@K over the FULL retrieved ranking, not
    // the already-capped returnedEventIds. Everything else is the real scorer.
    const simRow = { ...row, returnedEventIds: row.csmRetrievedEventIds };
    const s = scorePayloadRow(simRow, g, index, KS);
    if (s) scores.push(s);
  }

  const aggs = aggregateByCategory(scores, KS);

  console.log(`RETURN_K sweep — run ${RUN_ID} (${SPLIT}); token-free, LLM-free`);
  console.log(`cov@K = facet coverage of the first K of csmRetrievedEventIds (= answer-visible coverage if RETURN_K were K)\n`);
  const header = ["category", "n", ...KS.map((k) => `@${k}`), "retr(all)", "oracle", "retr.n"];
  console.log(header.map((h) => h.padStart(9)).join(""));
  for (const a of aggs) {
    const cells = [
      a.category.padStart(9),
      String(a.n).padStart(9),
      ...KS.map((k) => pct(a.coverageAtK[`@${k}`]!.mean).padStart(9)),
      pct(a.retrievedCoverage.mean).padStart(9),
      pct(a.oracleCoverage.mean).padStart(9),
      a.meanRetrievedCount.toFixed(1).padStart(9),
    ];
    console.log(cells.join(""));
  }

  console.log("\n── Recoverable coverage by raising RETURN_K (vs current production cap) ──");
  for (const a of aggs) {
    const cap = CURRENT_CAP[a.category] ?? 24;
    const atCap = a.coverageAtK[`@${cap}`]!.mean;
    const ceil = a.retrievedCoverage.mean;
    const at64 = a.coverageAtK["@64"]!.mean;
    console.log(
      `  ${a.category.padEnd(16)} current @${cap} = ${pct(atCap)}  →  @64 = ${pct(at64)}  →  ceiling(all ${a.meanRetrievedCount.toFixed(0)}) = ${pct(ceil)}   ` +
        `[recoverable to @64: +${((at64 - atCap) * 100).toFixed(1)} pts; to ceiling: +${((ceil - atCap) * 100).toFixed(1)} pts]`,
    );
  }
  console.log(
    "\nNote: these are LEXICAL-PROXY coverage deltas, not predicted BEAM answer-score deltas.\n" +
      "They prove the count-slice (RETURN_K) is the binding constraint on answer-visible breadth.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
