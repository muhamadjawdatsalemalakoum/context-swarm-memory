#!/usr/bin/env tsx
/**
 * Render the Vega-Lite spec files for a benchmark run to SVG files.
 *
 *   reads:  data/eval/runs/<runId>/plots/*.vl.json
 *   writes: data/eval/runs/<runId>/plots/*.svg
 *
 * Pure server-side render — no canvas, no browser, no PNG step. SVGs can be
 * embedded directly into Markdown (e.g. the README results section) or
 * rasterised later if you want PNGs.
 *
 * Usage:
 *   npx tsx scripts/render-plots.ts <runId>
 */

import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import * as vega from "vega";
import { compile, type TopLevelSpec } from "vega-lite";

async function renderVlToSvg(vlSpec: TopLevelSpec): Promise<string> {
  const { spec } = compile(vlSpec);
  const view = new vega.View(vega.parse(spec), { renderer: "none" });
  return view.toSVG();
}

async function main(): Promise<void> {
  const runId = process.argv[2];
  if (!runId) {
    console.error("Usage: npx tsx scripts/render-plots.ts <runId>");
    process.exit(1);
  }
  const plotsDir = join("data", "eval", "runs", runId, "plots");
  if (!existsSync(plotsDir)) {
    console.error(`No plots dir at ${plotsDir}`);
    process.exit(1);
  }

  const files = await readdir(plotsDir);
  const vlFiles = files.filter((f) => f.endsWith(".vl.json"));
  if (vlFiles.length === 0) {
    console.error("No .vl.json files found");
    process.exit(1);
  }

  console.log(`Rendering ${vlFiles.length} plots to SVG (run=${runId})...`);
  let ok = 0;
  let fail = 0;
  for (const file of vlFiles) {
    const path = join(plotsDir, file);
    const text = await readFile(path, "utf8");
    const spec = JSON.parse(text) as TopLevelSpec;
    try {
      const svg = await renderVlToSvg(spec);
      const outPath = join(plotsDir, file.replace(/\.vl\.json$/, ".svg"));
      await writeFile(outPath, svg, "utf8");
      console.log(
        `  ${file} → ${file.replace(/\.vl\.json$/, ".svg")} (${svg.length.toLocaleString()} bytes)`,
      );
      ok++;
    } catch (err) {
      console.error(
        `  ${file}: ERROR ${err instanceof Error ? err.message : String(err)}`,
      );
      fail++;
    }
  }
  console.log(`\nDone: ${ok} ok, ${fail} failed.`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
