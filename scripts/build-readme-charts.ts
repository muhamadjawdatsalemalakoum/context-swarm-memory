#!/usr/bin/env tsx
/**
 * Build the README result charts as committed SVGs (crisp, GitHub-native, no
 * external deps). Pure Vega-Lite -> SVG via the same path as render-plots.ts.
 *
 *   writes: docs/assets/scaling.svg
 *           docs/assets/citation-f1.svg
 *           docs/assets/gemini-accuracy-scaling.svg
 *           docs/assets/gemini-citation-grounding.svg
 *           docs/assets/gemini-babilong-ablation.svg
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
  blue: "#2563eb",
  amber: "#f59e0b",
  red: "#dc2626",
};

interface SummaryCell {
  accuracy: number;
  corpusSize?: number;
  meanCitationF1: number;
  meanCitationPrecision?: number;
  meanCitationRecall?: number;
  meanInputTokens?: number;
  modelContext?: number;
  system: string;
  task?: string;
  length?: string;
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

function pct(value: number): number {
  return Number((value * 100).toFixed(1));
}

function corpusLabel(corpusSize: number): string {
  if (corpusSize === 100000) return "100K";
  if (corpusSize === 1000000) return "1M";
  if (corpusSize === 2000000) return "2M";
  return `${Math.round(corpusSize / 1000)}K`;
}

const geminiRunId = "gemini35-160k-30q-v1";
const geminiSummary = readSummary(geminiRunId);
const geminiSystems = [
  { id: "csm", label: "CSM" },
  { id: "hybrid", label: "hybrid RAG" },
  { id: "rag", label: "vanilla RAG" },
  { id: "longctx", label: "long-context" },
];
const geminiCorpusSizes = [100000, 1000000, 2000000];

function geminiCell(system: string, corpusSize: number): SummaryCell {
  const cell = geminiSummary.cells.find(
    (c) =>
      c.system === system &&
      c.corpusSize === corpusSize &&
      c.modelContext === 160000,
  );
  if (!cell) {
    throw new Error(`Missing Gemini ${system}/${corpusSize} summary cell`);
  }
  return cell;
}

const geminiAccuracy = geminiSystems.flatMap((system) =>
  geminiCorpusSizes.map((corpusSize) => {
    const cell = geminiCell(system.id, corpusSize);
    return {
      system: system.label,
      corpus: corpusLabel(corpusSize),
      acc: pct(cell.accuracy),
      correct: Math.round(cell.accuracy * 30),
    };
  }),
);

const geminiCitation = geminiSystems.flatMap((system) =>
  geminiCorpusSizes.flatMap((corpusSize) => {
    const cell = geminiCell(system.id, corpusSize);
    return [
      {
        system: system.label,
        corpus: corpusLabel(corpusSize),
        metric: "Precision",
        value: Number((cell.meanCitationPrecision ?? 0).toFixed(3)),
      },
      {
        system: system.label,
        corpus: corpusLabel(corpusSize),
        metric: "Recall",
        value: Number((cell.meanCitationRecall ?? 0).toFixed(3)),
      },
      {
        system: system.label,
        corpus: corpusLabel(corpusSize),
        metric: "F1",
        value: Number(cell.meanCitationF1.toFixed(3)),
      },
    ];
  }),
);

function babilongCells(runId: string, label: string): Array<{
  run: string;
  taskLength: string;
  taskOrder: number;
  acc: number;
}> {
  const summary = readSummary(runId);
  return summary.cells
    .map((cell) => ({
      run: label,
      taskLength: `${cell.task} ${cell.length}`,
      taskOrder:
        cell.task === "task1" && cell.length === "4K"
          ? 1
          : cell.task === "task1" && cell.length === "8K"
            ? 2
            : cell.task === "task2" && cell.length === "4K"
              ? 3
              : 4,
      acc: pct(cell.accuracy),
    }))
    .sort((a, b) => a.taskOrder - b.taskOrder);
}

const babilongAblation = [
  ...babilongCells("babilong-csm-gemini35-4k8k-t1t2-30q-v1", "before bridge"),
  ...babilongCells(
    "babilong-csm-gemini35-4k8k-t1t2-30q-v2-entitybridge",
    "entity bridge",
  ),
];

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

const geminiAccuracySpec: TopLevelSpec = {
  $schema: "https://vega.github.io/schema/vega-lite/v5.json",
  width: 560,
  height: 315,
  background: "white",
  padding: 8,
  title: {
    text: "Gemini 3.5 Flash: accuracy as corpus scales",
    subtitle:
      "Same 30 PaySwift queries; native model context capped at 160K tokens",
    fontSize: 15,
    subtitleFontSize: 11,
    subtitleColor: "#6b7280",
    anchor: "start",
  },
  data: { values: geminiAccuracy },
  encoding: {
    x: {
      field: "corpus",
      type: "ordinal",
      sort: ["100K", "1M", "2M"],
      scale: { type: "point", padding: 0.5 },
      title: "Corpus size",
      axis: {
        labelFontSize: 13,
        titleFontSize: 12,
        labelAngle: 0,
        grid: false,
        domain: false,
        ticks: false,
      },
    },
    y: {
      field: "acc",
      type: "quantitative",
      scale: { domain: [0, 100] },
      title: "Accuracy (%)",
      axis: {
        labelFontSize: 11,
        titleFontSize: 12,
        values: [0, 20, 40, 60, 80, 100],
        gridColor: "#eef2f7",
      },
    },
    color: {
      field: "system",
      type: "nominal",
      scale: {
        domain: ["CSM", "hybrid RAG", "vanilla RAG", "long-context"],
        range: [C.csm, C.amber, C.blue, C.red],
      },
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
    { mark: { type: "point", filled: true, size: 85 } },
    {
      transform: [{ filter: "datum.corpus == '2M'" }],
      mark: {
        type: "text",
        align: "left",
        dx: 9,
        fontSize: 11,
        fontWeight: "bold",
      },
      encoding: { text: { field: "correct", type: "quantitative", format: "d" } },
    },
  ],
};

const geminiCitationSpec: TopLevelSpec = {
  $schema: "https://vega.github.io/schema/vega-lite/v5.json",
  background: "white",
  padding: 8,
  title: {
    text: "Gemini 3.5 Flash: citation grounding detail",
    subtitle:
      "Precision, recall, and F1 from exact gold source-event citations",
    fontSize: 15,
    subtitleFontSize: 11,
    subtitleColor: "#6b7280",
    anchor: "start",
  },
  data: { values: geminiCitation },
  facet: {
    column: {
      field: "metric",
      type: "nominal",
      sort: ["Precision", "Recall", "F1"],
      title: null,
      header: { labelFontSize: 13, labelFontWeight: "bold" },
    },
  },
  spec: {
    width: 170,
    height: 245,
    encoding: {
      x: {
        field: "corpus",
        type: "ordinal",
        sort: ["100K", "1M", "2M"],
        title: null,
        axis: { labelAngle: 0, labelFontSize: 11, domain: false, ticks: false },
      },
      y: {
        field: "value",
        type: "quantitative",
        scale: { domain: [0, 0.9] },
        title: "Citation score",
        axis: {
          labelFontSize: 10,
          titleFontSize: 11,
          values: [0, 0.2, 0.4, 0.6, 0.8],
          gridColor: "#eef2f7",
        },
      },
      color: {
        field: "system",
        type: "nominal",
        scale: {
          domain: ["CSM", "hybrid RAG", "vanilla RAG", "long-context"],
          range: [C.csm, C.amber, C.blue, C.red],
        },
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
      { mark: { type: "line", strokeWidth: 2.5 } },
      { mark: { type: "point", filled: true, size: 60 } },
    ],
  },
  resolve: { scale: { y: "shared" } },
};

const babilongAblationSpec: TopLevelSpec = {
  $schema: "https://vega.github.io/schema/vega-lite/v5.json",
  width: 560,
  height: 285,
  background: "white",
  padding: 8,
  title: {
    text: "Gemini 3.5 Flash + CSM on BABILong",
    subtitle:
      "External benchmark subset; entity bridge ablation, 30 rows per task/length",
    fontSize: 15,
    subtitleFontSize: 11,
    subtitleColor: "#6b7280",
    anchor: "start",
  },
  data: { values: babilongAblation },
  encoding: {
    x: {
      field: "taskLength",
      type: "nominal",
      sort: ["task1 4K", "task1 8K", "task2 4K", "task2 8K"],
      title: "BABILong cell",
      axis: { labelAngle: 0, labelFontSize: 12, titleFontSize: 12 },
    },
    xOffset: { field: "run" },
    y: {
      field: "acc",
      type: "quantitative",
      scale: { domain: [0, 100] },
      title: "Exact-match accuracy (%)",
      axis: {
        labelFontSize: 11,
        titleFontSize: 12,
        values: [0, 20, 40, 60, 80, 100],
        gridColor: "#eef2f7",
      },
    },
    color: {
      field: "run",
      type: "nominal",
      scale: {
        domain: ["before bridge", "entity bridge"],
        range: ["#94a3b8", C.csm],
      },
      legend: {
        orient: "bottom",
        direction: "horizontal",
        title: null,
        labelFontSize: 12,
      },
    },
  },
  layer: [
    { mark: { type: "bar", cornerRadiusEnd: 3 } },
    {
      mark: {
        type: "text",
        dy: -5,
        fontSize: 10,
        fontWeight: "bold",
        color: "#374151",
      },
      encoding: {
        text: { field: "acc", type: "quantitative", format: ".0f" },
      },
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
  await render(geminiAccuracySpec, "gemini-accuracy-scaling.svg");
  await render(geminiCitationSpec, "gemini-citation-grounding.svg");
  await render(babilongAblationSpec, "gemini-babilong-ablation.svg");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
