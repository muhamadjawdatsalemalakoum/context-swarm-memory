/**
 * Combined SOTA head-to-head headline.
 *
 * Reads per-query results.jsonl from one or more runs, pulls each system's
 * rows, and emits a single unified table (accuracy + bootstrap 95% CI,
 * citation P/R/F1, latency, input tokens) plus paired McNemar significance of
 * CSM vs every other system. This is the "did we beat the SOTA" report.
 *
 * Why a separate script: the headline mixes systems that were benched in
 * different runs (CSM + RAG baselines in v020-30q-embedfloor; each SOTA
 * sidecar baseline in its own run because they index for hours). This stitches
 * them back together by queryId so the comparison + McNemar pairing is valid.
 *
 * Usage:
 *   npx tsx scripts/sota-headline.ts                 # default v0.2.0 run map
 *   npx tsx scripts/sota-headline.ts csm=run1 mem0=run2 ...
 *
 * Reuses the validated stats in src/eval/scorer.ts (bootstrap CI + exact
 * McNemar) so the numbers match the rest of the harness.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getPaths } from "../src/storage/paths.js";
import {
  aggregate,
  mcNemar,
  type McqScore,
} from "../src/eval/scorer.js";

/** Which run each system's rows are pulled from. CSM + RAG baselines share the
 *  embedding-floor run; each SOTA sidecar has its own (hours-long) run. */
const DEFAULT_RUN_MAP: Record<string, string> = {
  csm: "v020-30q-embedfloor",
  rag: "v020-30q-embedfloor",
  hybrid: "v020-30q-embedfloor",
  // Use the representative-slice long-context run. The v020 run still contains
  // the earlier id-sorted packing artifact, which front-loaded core facts.
  longctx: "scaling-rq1",
  mem0: "mem0-30q",
  lightrag: "lightrag-30q",
  hipporag: "hipporag-30q",
};

/** Display order + labels. */
const LABELS: Record<string, string> = {
  csm: "CSM (pipeline + embedding floor)",
  mem0: "Mem0 (SOTA — agentic memory)",
  hipporag: "HippoRAG 2 (SOTA — graph QA)",
  lightrag: "LightRAG (SOTA — dual-level graph)",
  rag: "vanilla RAG",
  hybrid: "hybrid RAG",
  longctx: "long-context",
};

interface Row {
  score: McqScore;
  inputTokens: number;
  latencyMs: number;
}

function loadSystem(runId: string, system: string): Map<string, Row> | null {
  const runsDir = join(getPaths().data, "eval", "runs", runId);
  const path = join(runsDir, "results.jsonl");
  if (!existsSync(path)) return null;
  const out = new Map<string, Row>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as Record<string, unknown>;
    if (r.system !== system) continue;
    out.set(r.queryId as string, {
      score: {
        correct: Boolean(r.correct),
        citationPrecision: Number(r.citationPrecision ?? 0),
        citationRecall: Number(r.citationRecall ?? 0),
        citationF1: Number(r.citationF1 ?? 0),
      },
      inputTokens: Number(r.inputTokens ?? 0),
      latencyMs: Number(r.latencyMs ?? 0),
    });
  }
  return out.size > 0 ? out : null;
}

function parseArgs(): Record<string, string> {
  const map = { ...DEFAULT_RUN_MAP };
  for (const arg of process.argv.slice(2)) {
    const [sys, run] = arg.split("=");
    if (sys && run) map[sys] = run;
  }
  return map;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function main(): void {
  const runMap = parseArgs();
  const loaded: Record<string, Map<string, Row>> = {};
  for (const [sys, run] of Object.entries(runMap)) {
    const rows = loadSystem(run, sys);
    if (rows) loaded[sys] = rows;
  }
  const systems = Object.keys(LABELS).filter((s) => loaded[s]);
  if (!systems.includes("csm")) {
    console.error("No CSM rows found — cannot anchor the comparison.");
    process.exit(1);
  }

  // Common query set across all loaded systems (so McNemar pairs align).
  const csmQs = [...loaded.csm!.keys()].sort();

  type Agg = ReturnType<typeof aggregate>;
  const aggs: Record<string, Agg & { tok: number; lat: number; n: number }> = {};
  for (const sys of systems) {
    const m = loaded[sys]!;
    const qs = csmQs.filter((q) => m.has(q));
    const scores = qs.map((q) => m.get(q)!.score);
    const a = aggregate(scores, { bootstrapResamples: 10_000, seed: 42 });
    aggs[sys] = {
      ...a,
      tok: mean(qs.map((q) => m.get(q)!.inputTokens)),
      lat: mean(qs.map((q) => m.get(q)!.latencyMs)) / 1000,
      n: qs.length,
    };
  }

  // --- Table ---
  const ordered = systems.sort((a, b) => aggs[b]!.accuracy - aggs[a]!.accuracy);
  const lines: string[] = [];
  lines.push("# SOTA head-to-head — combined headline\n");
  lines.push(
    "| System | Accuracy | 95% CI | Citation F1 | Citation P | Citation R | Latency | Input tokens |",
  );
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const sys of ordered) {
    const a = aggs[sys]!;
    const ci = `[${(a.accuracyCi95[0] * 100).toFixed(0)}, ${(a.accuracyCi95[1] * 100).toFixed(0)}]%`;
    const acc = `${Math.round(a.accuracy * a.n)}/${a.n} (${(a.accuracy * 100).toFixed(0)}%)`;
    const bold = sys === "csm" ? "**" : "";
    lines.push(
      `| ${bold}${LABELS[sys]}${bold} | ${bold}${acc}${bold} | ${ci} | ${bold}${a.meanCitationF1.toFixed(3)}${bold} | ${a.meanCitationPrecision.toFixed(3)} | ${a.meanCitationRecall.toFixed(3)} | ${a.lat.toFixed(0)} s | ${a.tok.toFixed(0)} |`,
    );
  }

  // --- McNemar: CSM vs each other system, BH-corrected ---
  lines.push("\n## Significance — CSM vs each system (paired McNemar, exact)\n");
  lines.push("| Comparison | CSM-only wins | other-only wins | p-value | verdict |");
  lines.push("|---|---|---|---|---|");
  const csm = loaded.csm!;
  for (const sys of ordered) {
    if (sys === "csm") continue;
    const m = loaded[sys]!;
    const qs = csmQs.filter((q) => m.has(q));
    const aScores = qs.map((q) => csm.get(q)!.score);
    const bScores = qs.map((q) => m.get(q)!.score);
    const mc = mcNemar(aScores, bScores);
    const verdict =
      mc.winner === "A" ? "CSM wins (sig.)" : mc.winner === "B" ? `${sys} wins (sig.)` : "tie (n.s.)";
    lines.push(
      `| CSM vs ${LABELS[sys]} | ${mc.aOnly} | ${mc.bOnly} | ${mc.pValue.toFixed(3)} | ${verdict} |`,
    );
  }

  // --- Citation-F1 dominance note (the headline metric) ---
  const csmF1 = aggs.csm!.meanCitationF1;
  const others = ordered.filter((s) => s !== "csm");
  if (others.length) {
    const best = others.reduce((b, s) =>
      aggs[s]!.meanCitationF1 > aggs[b]!.meanCitationF1 ? s : b,
    );
    lines.push(
      `\n**Citation F1**: CSM ${csmF1.toFixed(3)} vs next-best ${LABELS[best]} ${aggs[best]!.meanCitationF1.toFixed(3)} ` +
        `(${(csmF1 / Math.max(aggs[best]!.meanCitationF1, 1e-9)).toFixed(1)}×).`,
    );
  }

  // --- Combined cross-system token-cost-vs-quality graph + markdown ---
  // Token cost is a first-class trade-off metric; show CSM vs every system on
  // one plot (x = input tokens, y = citation F1, point size = accuracy). This
  // is the cross-system version of plotter Graph H, embedding its own data so
  // it renders standalone via scripts/render-plots-spec or the VL editor.
  const outDir = join(getPaths().data, "eval", "runs", "sota-combined", "plots");
  mkdirSync(outDir, { recursive: true });
  const points = ordered.map((s) => ({
    system: LABELS[s] ?? s,
    accuracy: aggs[s]!.accuracy,
    citationF1: aggs[s]!.meanCitationF1,
    citationPrecision: aggs[s]!.meanCitationPrecision,
    inputTokens: Math.round(aggs[s]!.tok),
    latencyMs: Math.round(aggs[s]!.lat * 1000),
  }));
  const spec = {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    title: {
      text: "CSM vs SOTA — Cost vs Citation Quality",
      subtitle:
        "x = mean input tokens/call (log), y = citation F1, point size = accuracy. Up-and-left wins.",
    },
    data: { values: points },
    width: 680,
    height: 460,
    layer: [
      {
        mark: { type: "point", filled: true, opacity: 0.85 },
        encoding: {
          x: {
            field: "inputTokens",
            type: "quantitative",
            scale: { type: "log", nice: false },
            axis: { title: "Mean input tokens per call (log)", format: ",d" },
          },
          y: {
            field: "citationF1",
            type: "quantitative",
            scale: { domain: [0, 1] },
            axis: { title: "Citation F1" },
          },
          color: { field: "system", type: "nominal", legend: { title: "System" } },
          size: {
            field: "accuracy",
            type: "quantitative",
            scale: { range: [80, 700] },
            legend: { title: "Accuracy", format: "%" },
          },
          tooltip: [
            { field: "system", type: "nominal" },
            { field: "accuracy", type: "quantitative", format: ".1%" },
            { field: "citationF1", type: "quantitative", format: ".3f" },
            { field: "inputTokens", type: "quantitative", format: ",d" },
          ],
        },
      },
      {
        mark: { type: "text", dy: -16, fontSize: 11, fontWeight: "bold" },
        encoding: {
          x: { field: "inputTokens", type: "quantitative", scale: { type: "log", nice: false } },
          y: { field: "citationF1", type: "quantitative" },
          text: { field: "system", type: "nominal" },
          color: { field: "system", type: "nominal", legend: null },
        },
      },
    ],
  };
  writeFileSync(
    join(outDir, "sota-cost-vs-quality.vl.json"),
    JSON.stringify(spec, null, 2),
    "utf8",
  );
  writeFileSync(
    join(getPaths().data, "eval", "runs", "sota-combined", "headline.md"),
    lines.join("\n") + "\n",
    "utf8",
  );

  console.log(lines.join("\n"));
  console.log(
    `\n[sota-headline] wrote combined table → data/eval/runs/sota-combined/headline.md` +
      ` and graph spec → data/eval/runs/sota-combined/plots/sota-cost-vs-quality.vl.json`,
  );
}

main();
