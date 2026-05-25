/**
 * Re-score citation P/R/F1 in completed runs after the citation-id parser fix.
 *
 * THE BUG: the answering model sometimes echoes its context's bracketed citation
 * style — e.g. "CITATIONS: [e0002], [e0003]". The old parser split on ,/; and
 * trimmed whitespace but kept the brackets, so "[e0002]" failed exact-match
 * against the bare id "e0002" in relevantEventIds → zero citation overlap
 * despite the model citing the right events. This is an artifact of output
 * FORMATTING, not retrieval quality, and it was systemic: CSM emitted some
 * bracketed ids too (so its published citation F1 was UNDER-counted), and the
 * LightRAG sidecar — which packs context as "[e0002] …" — was hit hardest
 * (q01 cited [e0002],[e0003], both relevant, yet scored F1=0).
 *
 * THE FIX: src/eval/mcq.ts now strips wrapper punctuation at parse time
 * (normalizeCitationId). This script applies the SAME normalisation to the
 * already-recorded citedEventIds of a completed run and recomputes citation
 * P/R/F1 with the EXACT scoreCitations() the harness uses — so every system is
 * re-scored by an identical, auditable transform. It rewrites ONLY the citation
 * fields; `correct` (accuracy) and all retrieval metadata are untouched. The
 * original results.jsonl is backed up once to *.prebracketfix. Idempotent.
 *
 * Usage: npx tsx scripts/rescore-citations.ts <runId> [<runId> ...]
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getPaths } from "../src/storage/paths.js";
import { normalizeCitationId } from "../src/eval/mcq.js";
import { scoreCitations } from "../src/eval/scorer.js";
import { replayResults } from "../src/eval/runner.js";

interface RescoreStat {
  system: string;
  rows: number;
  f1Before: number;
  f1After: number;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

async function rescoreRun(runId: string): Promise<void> {
  const dir = join(getPaths().data, "eval", "runs", runId);
  const path = join(dir, "results.jsonl");
  if (!existsSync(path)) {
    console.error(`[rescore] no results.jsonl for run "${runId}" at ${path}`);
    return;
  }

  const lines = readFileSync(path, "utf8").split("\n");
  const out: string[] = [];
  let changed = 0;
  let total = 0;
  // Per-system before/after citation-F1 means, for an auditable summary.
  const bySystem = new Map<string, { f1b: number[]; f1a: number[] }>();

  for (const line of lines) {
    if (!line.trim()) {
      out.push(line);
      continue;
    }
    total++;
    const r = JSON.parse(line) as Record<string, unknown>;
    const system = String(r.system ?? "?");
    const rawCited = ((r.citedEventIds as string[] | undefined) ?? []).map(String);
    const cleaned = rawCited
      .map(normalizeCitationId)
      .filter((s) => s.length > 0);
    const relevant = ((r.relevantEventIds as string[] | undefined) ?? []).map(String);

    const f1Before = Number(r.citationF1 ?? 0);
    const sc = scoreCitations(cleaned, relevant);

    if (JSON.stringify(rawCited) !== JSON.stringify(cleaned) || f1Before !== sc.citationF1) {
      changed++;
    }
    r.citedEventIds = cleaned;
    r.citationPrecision = sc.citationPrecision;
    r.citationRecall = sc.citationRecall;
    r.citationF1 = sc.citationF1;

    const agg = bySystem.get(system) ?? { f1b: [], f1a: [] };
    agg.f1b.push(f1Before);
    agg.f1a.push(sc.citationF1);
    bySystem.set(system, agg);

    out.push(JSON.stringify(r));
  }

  const bak = `${path}.prebracketfix`;
  if (!existsSync(bak)) copyFileSync(path, bak);
  writeFileSync(path, out.join("\n"), "utf8");

  const stats: RescoreStat[] = [...bySystem.entries()].map(([system, a]) => ({
    system,
    rows: a.f1a.length,
    f1Before: mean(a.f1b),
    f1After: mean(a.f1a),
  }));
  console.log(`\n[rescore] ${runId}: ${changed}/${total} rows updated (backup: ${bak})`);
  for (const s of stats.sort((a, b) => b.f1After - a.f1After)) {
    const delta = s.f1After - s.f1Before;
    const arrow = delta > 1e-9 ? `↑ +${delta.toFixed(3)}` : delta < -1e-9 ? `↓ ${delta.toFixed(3)}` : "=";
    console.log(
      `  ${s.system.padEnd(10)} n=${s.rows}  citationF1 ${s.f1Before.toFixed(3)} → ${s.f1After.toFixed(3)}  ${arrow}`,
    );
  }

  // Regenerate summary.json from the rescored rows so the summary can never drift
  // from results.jsonl (the bug this script's first version left behind).
  if (existsSync(join(dir, "config.json"))) {
    await replayResults({ outputDir: dir });
    console.log(`  ↳ regenerated summary.json from rescored rows`);
  } else {
    console.log(`  ↳ no config.json — skipped summary regen (run \`npm run bench:replay -- ${runId}\` if needed)`);
  }
}

async function main(): Promise<void> {
  const runIds = process.argv.slice(2);
  if (runIds.length === 0) {
    console.error("usage: npx tsx scripts/rescore-citations.ts <runId> [<runId> ...]");
    process.exit(1);
  }
  for (const id of runIds) await rescoreRun(id);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
