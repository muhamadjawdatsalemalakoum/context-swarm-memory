/**
 * Vega-Lite spec generator for the Phase C scaling-study graphs.
 *
 * The runner aggregates per-cell results into a `ResultDataset`. The plotter
 * is a pure function: dataset in, Vega-Lite JSON spec out. The reporter
 * writes the specs to disk, where they can be (a) rendered to SVG via the
 * `vega-lite` runtime, (b) pasted into the online editor at
 * https://vega.github.io/editor/, or (c) consumed by any other VL-aware tool.
 *
 * Keeping renderer dependencies out of this file lets the plotter run during
 * tests (and from the runner) without pulling in `vega` (~5 MB).
 */

export interface ResultRow {
  system: string;
  corpusSize: number;
  modelContext: number;
  /** Mean accuracy across trials for this cell. */
  accuracy: number;
  /** 95% bootstrap CI lower bound. */
  accuracyCiLow: number;
  /** 95% bootstrap CI upper bound. */
  accuracyCiHigh: number;
  meanCitationPrecision: number;
  meanCitationRecall: number;
  meanCitationF1: number;
  /** Mean input tokens per LLM call (post-truncation/retrieval). */
  meanInputTokens: number;
  meanLatencyMs: number;
  /** Number of (query × trial) pairs underlying this cell. */
  n: number;
  /** True when this cell was skipped because the system already failed at a smaller corpus. */
  earlyStopped?: boolean;
}

export interface ResultDataset {
  rows: ResultRow[];
  /** "Still working" threshold. Default 0.8. The graphs reference this. */
  accuracyThreshold?: number;
  /** Early-stop threshold the runner used. Default 0.5 (matches `EARLY_STOP_ACCURACY`). */
  earlyStopThreshold?: number;
}

export type VegaLiteSpec = Record<string, unknown>;

const ACCURACY_THRESHOLD_DEFAULT = 0.8;
const VL_SCHEMA = "https://vega.github.io/schema/vega-lite/v5.json";

// --------------------------------------------------------------------------
// Graph A — Effective Context Window (HEADLINE)
// X: corpus size (log) · Y: accuracy · color: system · fixed: model_context
// --------------------------------------------------------------------------

export function graphAEffectiveContextWindow(
  data: ResultDataset,
  opts?: { modelContext?: number },
): VegaLiteSpec {
  const target = opts?.modelContext ?? 8192;
  const threshold = data.accuracyThreshold ?? ACCURACY_THRESHOLD_DEFAULT;
  const filtered = data.rows.filter((r) => r.modelContext === target);
  return {
    $schema: VL_SCHEMA,
    description: `Graph A — Effective context window at model_ctx=${formatTokens(target)}`,
    title: {
      text: `Effective Context Window (model context = ${formatTokens(target)})`,
      subtitle: "Where each system can still answer above the accuracy threshold",
    },
    data: { values: filtered },
    width: 720,
    height: 400,
    layer: [
      {
        mark: { type: "errorband", opacity: 0.18, interpolate: "monotone" },
        encoding: {
          x: { field: "corpusSize", type: "quantitative", scale: { type: "log" } },
          y: { field: "accuracyCiLow", type: "quantitative" },
          y2: { field: "accuracyCiHigh" },
          color: { field: "system", type: "nominal" },
        },
      },
      {
        mark: { type: "line", point: { size: 60 }, strokeWidth: 2.5, interpolate: "monotone" },
        encoding: {
          x: {
            field: "corpusSize",
            type: "quantitative",
            scale: { type: "log" },
            axis: { title: "Corpus size (tokens, log scale)", format: "~s" },
          },
          y: {
            field: "accuracy",
            type: "quantitative",
            scale: { domain: [0, 1] },
            axis: { title: "Accuracy", format: "%" },
          },
          color: { field: "system", type: "nominal", legend: { title: "System" } },
          tooltip: [
            { field: "system", type: "nominal" },
            { field: "corpusSize", type: "quantitative", format: ",d" },
            { field: "accuracy", type: "quantitative", format: ".1%" },
            { field: "accuracyCiLow", type: "quantitative", format: ".1%", title: "CI low" },
            { field: "accuracyCiHigh", type: "quantitative", format: ".1%", title: "CI high" },
            { field: "n", type: "quantitative", title: "trials" },
          ],
        },
      },
      {
        mark: { type: "rule", strokeDash: [6, 4], color: "#666" },
        encoding: { y: { datum: threshold } },
      },
    ],
  };
}

// --------------------------------------------------------------------------
// Graph B — Physical Context Efficiency
// X: model context (log) · Y: accuracy · color: system · fixed: corpus_size
// --------------------------------------------------------------------------

export function graphBPhysicalContextEfficiency(
  data: ResultDataset,
  opts?: { corpusSize?: number },
): VegaLiteSpec {
  const target = opts?.corpusSize ?? 1_000_000;
  const threshold = data.accuracyThreshold ?? ACCURACY_THRESHOLD_DEFAULT;
  const filtered = data.rows.filter((r) => r.corpusSize === target);
  return {
    $schema: VL_SCHEMA,
    description: `Graph B — Physical context efficiency at corpus_size=${target} tokens`,
    title: {
      text: `Physical Context Efficiency (corpus = ${formatTokens(target)})`,
      subtitle: "How small can the model's native context be before each system breaks",
    },
    data: { values: filtered },
    width: 720,
    height: 400,
    layer: [
      {
        mark: { type: "errorband", opacity: 0.18, interpolate: "monotone" },
        encoding: {
          x: { field: "modelContext", type: "quantitative", scale: { type: "log" } },
          y: { field: "accuracyCiLow", type: "quantitative" },
          y2: { field: "accuracyCiHigh" },
          color: { field: "system", type: "nominal" },
        },
      },
      {
        mark: { type: "line", point: { size: 60 }, strokeWidth: 2.5, interpolate: "monotone" },
        encoding: {
          x: {
            field: "modelContext",
            type: "quantitative",
            scale: { type: "log" },
            axis: { title: "Model native context (tokens, log scale)", format: "~s" },
          },
          y: {
            field: "accuracy",
            type: "quantitative",
            scale: { domain: [0, 1] },
            axis: { title: "Accuracy", format: "%" },
          },
          color: { field: "system", type: "nominal", legend: { title: "System" } },
          tooltip: [
            { field: "system", type: "nominal" },
            { field: "modelContext", type: "quantitative", format: ",d" },
            { field: "accuracy", type: "quantitative", format: ".1%" },
          ],
        },
      },
      {
        mark: { type: "rule", strokeDash: [6, 4], color: "#666" },
        encoding: { y: { datum: threshold } },
      },
    ],
  };
}

// --------------------------------------------------------------------------
// Graph C — Effective Context Multiplier (BAR CHART, headline number)
// One bar per system. multiplier = max corpus at threshold / model context.
// --------------------------------------------------------------------------

export interface MultiplierRow {
  system: string;
  modelContext: number;
  /** Highest corpus_size at which the system stayed at/above threshold. */
  maxCorpusAtThreshold: number;
  /** maxCorpusAtThreshold / modelContext. */
  multiplier: number;
}

export function computeMultipliers(
  data: ResultDataset,
  opts?: { modelContext?: number; threshold?: number },
): MultiplierRow[] {
  const target = opts?.modelContext ?? 8192;
  const threshold = opts?.threshold ?? data.accuracyThreshold ?? ACCURACY_THRESHOLD_DEFAULT;
  const bySystem = new Map<string, ResultRow[]>();
  for (const r of data.rows) {
    if (r.modelContext !== target) continue;
    const arr = bySystem.get(r.system);
    if (arr) arr.push(r);
    else bySystem.set(r.system, [r]);
  }
  const out: MultiplierRow[] = [];
  for (const [system, rows] of bySystem) {
    rows.sort((a, b) => a.corpusSize - b.corpusSize);
    let maxAt = 0;
    for (const r of rows) {
      if (r.accuracy >= threshold) maxAt = Math.max(maxAt, r.corpusSize);
    }
    out.push({
      system,
      modelContext: target,
      maxCorpusAtThreshold: maxAt,
      multiplier: target > 0 ? maxAt / target : 0,
    });
  }
  out.sort((a, b) => b.multiplier - a.multiplier);
  return out;
}

export function graphCEffectiveContextMultiplier(
  data: ResultDataset,
  opts?: { modelContext?: number; threshold?: number },
): VegaLiteSpec {
  const target = opts?.modelContext ?? 8192;
  const threshold = opts?.threshold ?? data.accuracyThreshold ?? ACCURACY_THRESHOLD_DEFAULT;
  const multipliers = computeMultipliers(data, { modelContext: target, threshold });
  return {
    $schema: VL_SCHEMA,
    description: `Graph C — Effective context multiplier (threshold=${threshold}, model_ctx=${formatTokens(target)})`,
    title: {
      text: `Effective Context Multiplier`,
      subtitle: `How many times the model's native context (${formatTokens(target)}) each system can stretch at ≥${(threshold * 100).toFixed(0)}% accuracy`,
    },
    data: { values: multipliers },
    width: 600,
    height: { step: 40 },
    mark: { type: "bar", cornerRadiusEnd: 3 },
    encoding: {
      y: {
        field: "system",
        type: "nominal",
        sort: "-x",
        axis: { title: null, labelFontSize: 13 },
      },
      x: {
        field: "multiplier",
        type: "quantitative",
        scale: { type: "log" },
        axis: { title: "Effective context multiplier (× native, log scale)", format: ".2~s" },
      },
      color: { field: "system", type: "nominal", legend: null },
      tooltip: [
        { field: "system", type: "nominal" },
        { field: "multiplier", type: "quantitative", format: ".2f", title: "× multiplier" },
        { field: "maxCorpusAtThreshold", type: "quantitative", format: ",d", title: "Max corpus" },
        { field: "modelContext", type: "quantitative", format: ",d", title: "Model ctx" },
      ],
    },
  };
}

// --------------------------------------------------------------------------
// Graph D — Operating Region Heatmap (faceted by system)
// X: corpus_size · Y: model_context · color: accuracy · facet: system
// --------------------------------------------------------------------------

export function graphDOperatingRegionHeatmap(data: ResultDataset): VegaLiteSpec {
  return {
    $schema: VL_SCHEMA,
    description: "Graph D — Operating-region heatmap per system",
    title: {
      text: "Operating Regions",
      subtitle: "Accuracy across the (corpus size × model context) plane, per system",
    },
    data: { values: data.rows },
    facet: { field: "system", type: "nominal", columns: 2, header: { title: null } },
    spec: {
      width: 320,
      height: 240,
      mark: { type: "rect" },
      encoding: {
        x: {
          field: "corpusSize",
          type: "ordinal",
          axis: { title: "Corpus size (tokens)", labelExpr: "format(datum.value, '~s')" },
        },
        y: {
          field: "modelContext",
          type: "ordinal",
          sort: "descending",
          axis: { title: "Model context", labelExpr: "format(datum.value, '~s')" },
        },
        color: {
          field: "accuracy",
          type: "quantitative",
          scale: { scheme: "viridis", domain: [0, 1] },
          legend: { title: "Accuracy", format: "%" },
        },
        tooltip: [
          { field: "system", type: "nominal" },
          { field: "corpusSize", type: "quantitative", format: ",d" },
          { field: "modelContext", type: "quantitative", format: ",d" },
          { field: "accuracy", type: "quantitative", format: ".1%" },
        ],
      },
    },
  };
}

// --------------------------------------------------------------------------
// Graph E — Cost at Iso-Accuracy
// X: corpus_size · Y: input tokens (log) · color: system · filtered: accuracy ≥ threshold
// --------------------------------------------------------------------------

export function graphECostAtIsoAccuracy(
  data: ResultDataset,
  opts?: { threshold?: number },
): VegaLiteSpec {
  const threshold = opts?.threshold ?? data.accuracyThreshold ?? ACCURACY_THRESHOLD_DEFAULT;
  const filtered = data.rows.filter((r) => r.accuracy >= threshold);
  return {
    $schema: VL_SCHEMA,
    description: `Graph E — Input tokens per LLM call at ≥${threshold} accuracy`,
    title: {
      text: "Cost at Iso-Accuracy",
      subtitle: `Input tokens per LLM call where accuracy ≥ ${(threshold * 100).toFixed(0)}% — lower = more efficient retrieval`,
    },
    data: { values: filtered },
    width: 720,
    height: 380,
    mark: { type: "line", point: { size: 60 }, strokeWidth: 2.5, interpolate: "monotone" },
    encoding: {
      x: {
        field: "corpusSize",
        type: "quantitative",
        scale: { type: "log" },
        axis: { title: "Corpus size (tokens, log scale)", format: "~s" },
      },
      y: {
        field: "meanInputTokens",
        type: "quantitative",
        scale: { type: "log" },
        axis: { title: "Mean input tokens per call (log scale)", format: ",d" },
      },
      color: { field: "system", type: "nominal", legend: { title: "System" } },
      tooltip: [
        { field: "system", type: "nominal" },
        { field: "corpusSize", type: "quantitative", format: ",d" },
        { field: "meanInputTokens", type: "quantitative", format: ",d" },
        { field: "accuracy", type: "quantitative", format: ".1%" },
      ],
    },
  };
}

// --------------------------------------------------------------------------
// Graph F — Component Ablation at Scale (CSM internals)
// Same shape as Graph A but lines = ablation variants.
// Caller passes a dataset whose `system` column carries the variant name
// (e.g. "csm-full", "csm-no-router", "csm-no-probe", ...).
// --------------------------------------------------------------------------

export function graphFAblationAtScale(
  data: ResultDataset,
  opts?: { modelContext?: number },
): VegaLiteSpec {
  const target = opts?.modelContext ?? 8192;
  const threshold = data.accuracyThreshold ?? ACCURACY_THRESHOLD_DEFAULT;
  const filtered = data.rows.filter((r) => r.modelContext === target);
  return {
    $schema: VL_SCHEMA,
    description: `Graph F — CSM component ablation at model_ctx=${formatTokens(target)}`,
    title: {
      text: "CSM Component Ablation at Scale",
      subtitle: "Which architectural piece pays off most as the corpus grows",
    },
    data: { values: filtered },
    width: 720,
    height: 400,
    layer: [
      {
        mark: { type: "line", point: { size: 60 }, strokeWidth: 2.5, interpolate: "monotone" },
        encoding: {
          x: {
            field: "corpusSize",
            type: "quantitative",
            scale: { type: "log" },
            axis: { title: "Corpus size (tokens, log scale)", format: "~s" },
          },
          y: {
            field: "accuracy",
            type: "quantitative",
            scale: { domain: [0, 1] },
            axis: { title: "Accuracy", format: "%" },
          },
          color: { field: "system", type: "nominal", legend: { title: "Variant" } },
          strokeDash: {
            condition: { test: "datum.system === 'csm-full'", value: [1, 0] },
            value: [4, 4],
          },
          tooltip: [
            { field: "system", type: "nominal" },
            { field: "corpusSize", type: "quantitative", format: ",d" },
            { field: "accuracy", type: "quantitative", format: ".1%" },
          ],
        },
      },
      {
        mark: { type: "rule", strokeDash: [6, 4], color: "#666" },
        encoding: { y: { datum: threshold } },
      },
    ],
  };
}

// --------------------------------------------------------------------------
// Graph G — Token Cost per System (BAR, single headline cell)
// One bar per system: mean input tokens per answering call. The token-cost
// axis of the head-to-head — CSM trades tokens for retrieval/citation quality.
// --------------------------------------------------------------------------

/** Pick the rows for a single (corpusSize × modelContext) cell. Defaults to the
 *  headline 100K/8K cell; if nothing matches (e.g. a sweep with different
 *  points, or a single-cell run at other coords) falls back to the densest
 *  modelContext's largest corpus so the bar/scatter graphs always have data. */
function pickHeadlineCell(
  rows: ResultRow[],
  opts?: { corpusSize?: number; modelContext?: number },
): ResultRow[] {
  const corpus = opts?.corpusSize ?? 100_000;
  const ctx = opts?.modelContext ?? 8192;
  const exact = rows.filter(
    (r) => r.corpusSize === corpus && r.modelContext === ctx,
  );
  if (exact.length > 0) return exact;
  if (rows.length === 0) return rows;
  // Fallback: the (ctx, corpus) cell with the most systems present.
  const byCell = new Map<string, ResultRow[]>();
  for (const r of rows) {
    const key = `${r.modelContext}|${r.corpusSize}`;
    const arr = byCell.get(key);
    if (arr) arr.push(r);
    else byCell.set(key, [r]);
  }
  let best: ResultRow[] = [];
  for (const arr of byCell.values()) if (arr.length > best.length) best = arr;
  return best;
}

export function graphGTokenCostPerSystem(
  data: ResultDataset,
  opts?: { corpusSize?: number; modelContext?: number },
): VegaLiteSpec {
  const rows = pickHeadlineCell(data.rows, opts);
  const cell = rows[0];
  const subtitle = cell
    ? `Mean input tokens per answering call (corpus ${formatTokens(cell.corpusSize)}, model ctx ${formatTokens(cell.modelContext)}) — lower is cheaper`
    : "Mean input tokens per answering call — lower is cheaper";
  return {
    $schema: VL_SCHEMA,
    description: "Graph G — Mean input tokens per LLM call, per system",
    title: { text: "Token Cost per System", subtitle },
    data: { values: rows },
    width: 600,
    height: { step: 40 },
    mark: { type: "bar", cornerRadiusEnd: 3 },
    encoding: {
      y: {
        field: "system",
        type: "nominal",
        sort: "-x",
        axis: { title: null, labelFontSize: 13 },
      },
      x: {
        field: "meanInputTokens",
        type: "quantitative",
        axis: { title: "Mean input tokens per answering call", format: ",d" },
      },
      color: { field: "system", type: "nominal", legend: null },
      tooltip: [
        { field: "system", type: "nominal" },
        { field: "meanInputTokens", type: "quantitative", format: ",d", title: "Input tokens" },
        { field: "accuracy", type: "quantitative", format: ".1%" },
        { field: "meanCitationF1", type: "quantitative", format: ".3f", title: "Citation F1" },
        { field: "meanLatencyMs", type: "quantitative", format: ",d", title: "Latency (ms)" },
      ],
    },
  };
}

// --------------------------------------------------------------------------
// Graph H — Cost vs Quality (SCATTER, single headline cell)
// X: mean input tokens (log) · Y: citation F1 · point per system, sized by
// accuracy. The "is the extra token cost worth it" view: top-left = cheap +
// high-quality citations; CSM should sit top-right (pricier, best citations).
// --------------------------------------------------------------------------

export function graphHCostVsQuality(
  data: ResultDataset,
  opts?: { corpusSize?: number; modelContext?: number },
): VegaLiteSpec {
  const rows = pickHeadlineCell(data.rows, opts);
  return {
    $schema: VL_SCHEMA,
    description: "Graph H — Token cost vs citation quality, per system",
    title: {
      text: "Cost vs Quality",
      subtitle: "Citation F1 vs token cost per call — up = better citations, left = cheaper. Point size = accuracy.",
    },
    data: { values: rows },
    width: 640,
    height: 440,
    layer: [
      {
        mark: { type: "point", filled: true, opacity: 0.85 },
        encoding: {
          x: {
            field: "meanInputTokens",
            type: "quantitative",
            scale: { type: "log", nice: false },
            axis: { title: "Mean input tokens per call (log scale)", format: ",d" },
          },
          y: {
            field: "meanCitationF1",
            type: "quantitative",
            scale: { domain: [0, 1] },
            axis: { title: "Citation F1" },
          },
          color: { field: "system", type: "nominal", legend: { title: "System" } },
          size: {
            field: "accuracy",
            type: "quantitative",
            scale: { range: [80, 600] },
            legend: { title: "Accuracy", format: "%" },
          },
          tooltip: [
            { field: "system", type: "nominal" },
            { field: "meanInputTokens", type: "quantitative", format: ",d", title: "Input tokens" },
            { field: "meanCitationF1", type: "quantitative", format: ".3f", title: "Citation F1" },
            { field: "accuracy", type: "quantitative", format: ".1%" },
          ],
        },
      },
      {
        mark: { type: "text", dy: -14, fontSize: 12, fontWeight: "bold" },
        encoding: {
          x: { field: "meanInputTokens", type: "quantitative", scale: { type: "log", nice: false } },
          y: { field: "meanCitationF1", type: "quantitative" },
          text: { field: "system", type: "nominal" },
          color: { field: "system", type: "nominal", legend: null },
        },
      },
    ],
  };
}

// --------------------------------------------------------------------------
// Bundling helper
// --------------------------------------------------------------------------

export interface AllGraphsBundle {
  graphA: VegaLiteSpec;
  graphB: VegaLiteSpec;
  graphC: VegaLiteSpec;
  graphD: VegaLiteSpec;
  graphE: VegaLiteSpec;
  /** Token cost per system (bar) — always present. */
  graphG: VegaLiteSpec;
  /** Token cost vs citation quality (scatter) — always present. */
  graphH: VegaLiteSpec;
  /** Only present when the dataset is an ablation run (system names start with "csm-"). */
  graphF?: VegaLiteSpec;
}

export function generateAllGraphs(
  data: ResultDataset,
  opts?: {
    /** Model context to use for graphs A, C, F. Default 8192. */
    headlineModelContext?: number;
    /** Corpus size to use for graph B. Default 1M. */
    headlineCorpusSize?: number;
    /** Set true if this dataset is the CSM ablation suite (will include Graph F). */
    isAblation?: boolean;
  },
): AllGraphsBundle {
  const headlineCtx = opts?.headlineModelContext ?? 8192;
  const headlineCorpus = opts?.headlineCorpusSize ?? 1_000_000;
  const bundle: AllGraphsBundle = {
    graphA: graphAEffectiveContextWindow(data, { modelContext: headlineCtx }),
    graphB: graphBPhysicalContextEfficiency(data, { corpusSize: headlineCorpus }),
    graphC: graphCEffectiveContextMultiplier(data, { modelContext: headlineCtx }),
    graphD: graphDOperatingRegionHeatmap(data),
    graphE: graphECostAtIsoAccuracy(data),
    graphG: graphGTokenCostPerSystem(data, { modelContext: headlineCtx }),
    graphH: graphHCostVsQuality(data, { modelContext: headlineCtx }),
  };
  if (opts?.isAblation) {
    bundle.graphF = graphFAblationAtScale(data, { modelContext: headlineCtx });
  }
  return bundle;
}

// --------------------------------------------------------------------------
// Internal helpers
// --------------------------------------------------------------------------

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(0)}B tokens`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M tokens`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K tokens`;
  return `${n} tokens`;
}
