#!/usr/bin/env tsx
/**
 * LEAN-RETURN SWEEP, SCORE STEP — GOLD SIDE, NEVER TOUCHES THE BRIDGE.
 *
 * Reads the rendered texts written by `scripts/lean-return-render.ts` (which
 * never saw gold), scores each config's facet coverage over the TEXT the answer
 * model would actually see, and reports every config paired against the
 * control on the same queries.
 *
 * Scoring texts rather than ids is the point: excerpting changes the text a
 * facet must be found in. An id-based proxy would score the full turn and
 * overstate every excerpt config. (It also means excerpt configs are penalised
 * exactly as hard as the answer model would be — if the facet's terms fall
 * outside the 360-char window, neither this scorer nor the model can see them.)
 *
 * Token-free, LLM-free. Imports only the gold leaf + node builtins — this
 * script appears in `EVAL_SIDE_GOLD_CONSUMERS` in
 * tests/beamLeakageFirewall.test.ts and must keep that closure.
 *
 *   npx tsx scripts/lean-return-score.ts --run <runId> --split 1m
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { facetTerms, loadBeamGold, textSupportsFacet } from "../src/eval/retrievalScore.js";

interface RenderRow {
  queryId: string;
  config: string;
  docCount: number;
  chars: number;
  texts: string[];
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : fallback;
}

function pct(x: number): string {
  return (x * 100).toFixed(1).padStart(6) + "%";
}

async function main(): Promise<void> {
  const runId = arg("run");
  const split = arg("split", "1m")!;
  if (!runId) throw new Error("--run <runId> is required");

  const renderPath = resolve(process.cwd(), "data", "eval", "runs", runId, "lean-render.jsonl");
  const rows: RenderRow[] = readFileSync(renderPath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RenderRow);
  const gold = loadBeamGold(split, {});

  // coverage per (queryId, config) over rendered TEXTS
  type Cell = { coverage: number; chars: number; docCount: number; category: string };
  const byConfig = new Map<string, Map<string, Cell>>();
  for (const row of rows) {
    const g = gold.get(row.queryId);
    if (!g || g.facets.length === 0) continue;
    const termsPerFacet = g.facets.map(facetTerms);
    let covered = 0;
    for (const terms of termsPerFacet) {
      if (row.texts.some((t) => textSupportsFacet(t, terms))) covered++;
    }
    let m = byConfig.get(row.config);
    if (!m) byConfig.set(row.config, (m = new Map()));
    m.set(row.queryId, {
      coverage: covered / termsPerFacet.length,
      chars: row.chars,
      docCount: row.docCount,
      category: g.category,
    });
  }

  const control = byConfig.get("control");
  if (!control) throw new Error("render file has no 'control' config — re-render");
  const configs = [...byConfig.keys()];
  const ids = [...control.keys()].sort();

  console.log(`lean-return sweep — run ${runId} (${split}); token-free, text-scored, paired vs control`);
  console.log(`${ids.length} queries; facet coverage over RENDERED text (capsule excluded — constant across configs)\n`);
  const header = ["config", "cov", "Δcov", "W/L/T", "chars/q", "±chars", "docs/q"];
  console.log(header.map((h) => h.padStart(10)).join(""));
  for (const cfg of configs) {
    const cells = byConfig.get(cfg)!;
    let cov = 0;
    let chars = 0;
    let docs = 0;
    let dCov = 0;
    let w = 0;
    let l = 0;
    let t = 0;
    for (const id of ids) {
      const c = cells.get(id);
      const base = control.get(id)!;
      if (!c) continue;
      cov += c.coverage;
      chars += c.chars;
      docs += c.docCount;
      const d = c.coverage - base.coverage;
      dCov += d;
      if (d > 1e-9) w++;
      else if (d < -1e-9) l++;
      else t++;
    }
    const n = ids.length;
    const baseChars = ids.reduce((s, id) => s + control.get(id)!.chars, 0) / n;
    console.log(
      [
        cfg.padStart(10),
        pct(cov / n).padStart(10),
        ((dCov / n) * 100).toFixed(1).padStart(9) + "%",
        `${w}/${l}/${t}`.padStart(10),
        Math.round(chars / n).toLocaleString().padStart(10),
        (((chars / n) / baseChars - 1) * 100).toFixed(0).padStart(9) + "%",
        (docs / n).toFixed(1).padStart(10),
      ].join(""),
    );
  }

  // per-category detail for the non-trivial configs
  const cats = [...new Set([...control.values()].map((c) => c.category))].sort();
  console.log("\nper-category Δcov vs control:");
  console.log(["config", ...cats.map((c) => c.slice(0, 14))].map((h) => h.padStart(16)).join(""));
  for (const cfg of configs) {
    if (cfg === "control") continue;
    const cells = byConfig.get(cfg)!;
    const row = [cfg.padStart(16)];
    for (const cat of cats) {
      const catIds = ids.filter((id) => control.get(id)!.category === cat);
      const d =
        catIds.reduce((s, id) => s + ((cells.get(id)?.coverage ?? 0) - control.get(id)!.coverage), 0) /
        Math.max(catIds.length, 1);
      row.push(((d * 100).toFixed(1) + "%").padStart(16));
    }
    console.log(row.join(""));
  }

  console.log(
    "\nNote: LEXICAL-PROXY coverage on rendered text, not predicted judge score." +
      "\nRule: a config is a sidecar-arm CANDIDATE only if Δcov ≈ 0 while chars drop.",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`lean-return-score failed: ${String((err as Error).message ?? err)}`);
    process.exitCode = 1;
  });
}
