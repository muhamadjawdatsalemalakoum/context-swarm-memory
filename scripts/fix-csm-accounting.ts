#!/usr/bin/env tsx
/**
 * Retroactively fix CSM token/latency accounting in a results.jsonl produced
 * by the old `csm.ts` baseline (which reported only the final MCQ call's
 * tokens/latency at the top level, with pipeline cost buried in
 * `meta.packetCost`).
 *
 * The fixed code in `src/eval/baselines/csm.ts` now sums pipeline + final
 * automatically, so this script is only needed for runs captured BEFORE that
 * fix landed.
 *
 * Usage:
 *   npx tsx scripts/fix-csm-accounting.ts <runId>
 *
 * Effect:
 *   - Reads  data/eval/runs/<runId>/results.jsonl
 *   - For every cell with system === "csm" AND no `finalCallInputTokens`
 *     marker in meta (i.e. the buggy ones), rewrites top-level
 *     inputTokens/outputTokens/latencyMs to include `meta.packetCost.*`,
 *     and adds the per-stage `finalCall*` / `pipeline*` fields to meta.
 *   - Backs up the original file to `results.jsonl.pre-fix-accounting`.
 *   - Re-runs the summary computation via `bench replay`.
 */

import { existsSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface PacketCost {
  inputTokensEstimate?: number;
  outputTokensEstimate?: number;
  estimatedUsd?: number;
  latencyMs?: number;
}

interface CellLike {
  system: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  meta?: {
    packetCost?: PacketCost;
    finalCallInputTokens?: number;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

async function main(): Promise<void> {
  const runId = process.argv[2];
  if (!runId) {
    console.error("Usage: npx tsx scripts/fix-csm-accounting.ts <runId>");
    process.exit(1);
  }
  const runDir = join("data", "eval", "runs", runId);
  const resultsPath = join(runDir, "results.jsonl");
  if (!existsSync(resultsPath)) {
    console.error(`Not found: ${resultsPath}`);
    process.exit(1);
  }

  // Snapshot the original.
  const backupPath = join(runDir, "results.jsonl.pre-fix-accounting");
  if (!existsSync(backupPath)) {
    await copyFile(resultsPath, backupPath);
    console.log(`Backed up original → ${backupPath}`);
  } else {
    console.log(`Backup already exists at ${backupPath} (not overwriting)`);
  }

  const text = await readFile(resultsPath, "utf8");
  let fixedCount = 0;
  let skippedAlreadyFixed = 0;
  let csmTotal = 0;
  const outLines: string[] = [];

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      outLines.push("");
      continue;
    }
    const cell = JSON.parse(trimmed) as CellLike;
    if (cell.system !== "csm") {
      outLines.push(line);
      continue;
    }
    csmTotal++;

    // Already fixed by the new csm.ts: skip.
    if (cell.meta?.finalCallInputTokens !== undefined) {
      skippedAlreadyFixed++;
      outLines.push(line);
      continue;
    }

    const pc = cell.meta?.packetCost ?? {};
    const pIn = pc.inputTokensEstimate ?? 0;
    const pOut = pc.outputTokensEstimate ?? 0;
    const pLat = pc.latencyMs ?? 0;
    const fIn = cell.inputTokens ?? 0;
    const fOut = cell.outputTokens ?? 0;
    const fLat = cell.latencyMs ?? 0;

    const fixed: CellLike = {
      ...cell,
      inputTokens: pIn + fIn,
      outputTokens: pOut + fOut,
      latencyMs: pLat + fLat,
      meta: {
        ...(cell.meta ?? {}),
        finalCallInputTokens: fIn,
        finalCallOutputTokens: fOut,
        finalCallLatencyMs: fLat,
        pipelineInputTokens: pIn,
        pipelineOutputTokens: pOut,
        pipelineLatencyMs: pLat,
      },
    };
    outLines.push(JSON.stringify(fixed));
    fixedCount++;
  }

  await writeFile(resultsPath, outLines.join("\n"), "utf8");
  console.log(`\nRewrote ${resultsPath}`);
  console.log(`  CSM cells total       : ${csmTotal}`);
  console.log(`  Fixed (added pipeline): ${fixedCount}`);
  console.log(`  Skipped (already had finalCall* in meta): ${skippedAlreadyFixed}`);
  console.log(
    `\nNext: regenerate summary with  npx tsx src/cli/index.ts bench replay ${runId}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
