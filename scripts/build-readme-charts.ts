#!/usr/bin/env tsx
/**
 * Build the README result charts as committed SVGs (crisp, GitHub-native, no
 * external deps). Pure Vega-Lite -> SVG via the same path as render-plots.ts.
 *
 *   writes: docs/assets/scaling.svg        (RQ1: accuracy vs corpus size)
 *           docs/assets/citation-f1.svg    (citation F1 per system @ 100K)
 *
 * Numbers are the committed benchmark values (sources in comments). Regenerate:
 *   npx tsx scripts/build-readme-charts.ts
 */
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import * as vega from "vega";
import { compile, type TopLevelSpec } from "vega-lite";

const OUT = join("docs", "assets");

// Palette: CSM highlighted; LightRAG (the 2025 SOTA) distinct; baselines muted.
const C = {
  csm: "#0e7c66", // teal — CSM
  rag: "#6b7280", // slate
  hybrid: "#9ca3af", // light slate
  lightrag: "#b45309", // amber — the SOTA comparator
  longctx: "#9ca3af", // gray — the strawman
};

interface SummaryCell {
  accuracy: number;
  corpusSize: number;
  meanCitationF1: number;
  modelContext: number;
  system: string;
}

interface BenchSummary {
  cells: SummaryCell[];
}

function readSummary(runId: string): BenchSummary {
  return JSON.parse(
    readFileSync(join("data", "eval", "runs", runId, "summary.json"), "utf8"),
  ) as BenchSummary;
}

function summaryCell(
  runId: string,
  system: string,
  corpusSize: number,
  modelContext = 8000,
): SummaryCell {
  const cell = readSummary(runId).cells.find(
    (c) =>
      c.system === system &&
      c.corpusSize === corpusSize &&
      c.modelContext === modelContext,
  );
  if (!cell) {
    throw new Error(
      `Missing ${system} ${corpusSize}/${modelContext} cell in run ${runId}`,
    );
  }
  return cell;
}

function accuracyPct(runId: string, system: string, corpusSize: number): number {
  return Math.round(summaryCell(runId, system, corpusSize).accuracy * 100);
}

function citationF1(runId: string, system: string, corpusSize = 100000): number {
  return Number(summaryCell(runId, system, corpusSize).meanCitationF1.toFixed(3));
}

// --- RQ1 scaling: accuracy (%) vs corpus size (8K window). ----------------
//   csm/rag/longctx from runs `scaling-rq1` (100K) + `scaling-1m` (1M).
const scaling = [
  { system: "CSM", corpus: "100K", acc: accuracyPct("scaling-rq1", "csm", 100000), order: 1 },
  { system: "CSM", corpus: "1M", acc: accuracyPct("scaling-1m", "csm", 1000000), order: 2 },
  { system: "vanilla RAG", corpus: "100K", acc: accuracyPct("scaling-rq1", "rag", 100000), order: 1 },
  { system: "vanilla RAG", corpus: "1M", acc: accuracyPct("scaling-1m", "rag", 1000000), order: 2 },
  { system: "long-context", corpus: "100K", acc: accuracyPct("scaling-rq1", "longctx", 100000), order: 1 },
  { system: "long-context", corpus: "1M", acc: accuracyPct("scaling-1m", "longctx", 1000000), order: 2 },
];

const scalingSpec: TopLevelSpec = {
  $schema: "https://vega.github.io/schema/vega-lite/v5.json",
  width: 440,
  height: 300,
  background: "white",
  padding: 8,
  title: {
    text: "Accuracy as memory scales 10× (8K-token window)",
    subtitle: "CSM holds; vanilla RAG degrades; long-context stays collapsed",
    fontSize: 15,
    subtitleFontSize: 11,
    subtitleColor: "#6b7280",
    anchor: "start",
  },
  data: { values: scaling },
  encoding: {
    x: {
      field: "corpus",
      type: "ordinal",
      sort: ["100K", "1M"],
      scale: { type: "point", padding: 0.5 }, // point scale insets the values from the edges
      title: "Corpus size (tokens)",
      axis: { labelFontSize: 13, titleFontSize: 12, labelAngle: 0, grid: false, domain: false, ticks: false },
    },
    y: {
      field: "acc",
      type: "quantitative",
      scale: { domain: [0, 100] },
      title: "Accuracy (%)",
      axis: { labelFontSize: 11, titleFontSize: 12, values: [0, 20, 40, 60, 80, 100], gridColor: "#eee" },
    },
    color: {
      field: "system",
      type: "nominal",
      // three clearly distinct hues: CSM teal, RAG blue, long-context gray
      scale: { domain: ["CSM", "vanilla RAG", "long-context"], range: [C.csm, "#2563eb", "#9ca3af"] },
      legend: {
        orient: "bottom",
        direction: "horizontal",
        title: null,
        labelFontSize: 12,
        symbolType: "stroke",
        symbolStrokeWidth: 3,
      },
    },
  },
  layer: [
    { mark: { type: "line", strokeWidth: 3 } },
    { mark: { type: "point", filled: true, size: 95 } },
    {
      // value labels right of the 1M endpoints
      transform: [{ filter: "datum.corpus == '1M'" }],
      mark: { type: "text", align: "left", dx: 9, fontSize: 11, fontWeight: "bold" },
      encoding: { text: { field: "acc", type: "quantitative", format: "d" } },
    },
    {
      // value labels left of the 100K endpoints
      transform: [{ filter: "datum.corpus == '100K'" }],
      mark: { type: "text", align: "right", dx: -9, fontSize: 11, fontWeight: "bold" },
      encoding: { text: { field: "acc", type: "quantitative", format: "d" } },
    },
  ],
};

// --- Citation F1 per system @ 100K (the quality differentiator). -----------
//   committed headline values (README/SOTA_COMPARISON): csm/rag/hybrid @ v020,
//   lightrag @ lightrag-30q, longctx @ scaling-rq1 (honest representative pack).
const citation = [
  { system: "CSM", f1: citationF1("v020-30q-embedfloor", "csm"), kind: "csm" },
  { system: "hybrid RAG", f1: citationF1("v020-30q-embedfloor", "hybrid"), kind: "hybrid" },
  { system: "vanilla RAG", f1: citationF1("v020-30q-embedfloor", "rag"), kind: "rag" },
  { system: "LightRAG (SOTA)", f1: citationF1("lightrag-30q", "lightrag"), kind: "lightrag" },
  { system: "long-context", f1: citationF1("scaling-rq1", "longctx"), kind: "longctx" },
];

const citationSpec: TopLevelSpec = {
  $schema: "https://vega.github.io/schema/vega-lite/v5.json",
  width: 460,
  height: 300,
  background: "white",
  title: {
    text: "Citation F1 — grounding quality (30 queries, 100K corpus)",
    subtitle: "Did the answer cite the right source events? Higher is better.",
    fontSize: 15,
    subtitleFontSize: 11,
    subtitleColor: "#6b7280",
    anchor: "start",
  },
  data: { values: citation },
  encoding: {
    y: {
      field: "system",
      type: "nominal",
      sort: ["CSM", "hybrid RAG", "vanilla RAG", "LightRAG (SOTA)", "long-context"],
      title: null,
      axis: { labelFontSize: 12 },
    },
    x: {
      field: "f1",
      type: "quantitative",
      scale: { domain: [0, 0.6] },
      title: "Mean citation F1",
      axis: { labelFontSize: 11, titleFontSize: 12 },
    },
    color: {
      field: "kind",
      type: "nominal",
      scale: {
        domain: ["csm", "hybrid", "rag", "lightrag", "longctx"],
        range: [C.csm, C.hybrid, C.rag, C.lightrag, C.longctx],
      },
      legend: null,
    },
  },
  layer: [
    { mark: { type: "bar", cornerRadiusEnd: 3 } },
    {
      mark: { type: "text", align: "left", dx: 4, fontSize: 12, fontWeight: "bold", color: "#374151" },
      encoding: { text: { field: "f1", type: "quantitative", format: ".3f" } },
    },
  ],
};

async function render(spec: TopLevelSpec, file: string): Promise<void> {
  const { spec: vgSpec } = compile(spec);
  const view = new vega.View(vega.parse(vgSpec), { renderer: "none" });
  const svg = await view.toSVG();
  await writeFile(join(OUT, file), svg, "utf8");
  console.log(`wrote ${join(OUT, file)} (${svg.length} bytes)`);
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  await render(scalingSpec, "scaling.svg");
  await render(citationSpec, "citation-f1.svg");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
