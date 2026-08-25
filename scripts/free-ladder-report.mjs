// Per-tier report for the FREE apples-to-apples ladder (CSM vs Hindsight,
// one reader + one judge supplied by us, only the retrieved context differs).
//
// Run this AFTER each tier's head-to-head completes. It captures everything
// that would otherwise be lost when a run's transient state is gone:
// score (overall + per category, with MDE and W/L/T), answer-visible token
// cost on BOTH sides, retrieval latency on both sides, CSM's internal call
// counts and token telemetry, exclusions, and full provenance (git sha,
// resolved levers, models, artifact identity).
//
//   node scripts/free-ladder-report.mjs --tier 100k \
//     --csm free100k-v1 --h2h 100k-free --out docs/experiments/free-ladder/
//
// Writes <out>/<tier>.json (machine) and appends a markdown section to
// <out>/REPORT.md (human). Safe to re-run: it overwrites that tier's section.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : fallback;
};

const tier = arg("tier");
const csmRun = arg("csm");
const h2hTier = arg("h2h");
const outDir = resolve(arg("out", "docs/experiments/free-ladder"));
if (!tier || !csmRun || !h2hTier) {
  throw new Error("--tier, --csm <runId> and --h2h <tierLabel> are required");
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const round = (v, d = 0) => (v === null || v === undefined ? null : Number(v.toFixed(d)));
const catOf = (id) => String(id ?? "").match(/^\d+_(.+)_\d+$/)?.[1] ?? "unknown";

// ---- CSM side -------------------------------------------------------------
const runDir = resolve("data/eval/runs", csmRun);
const payloads = readFileSync(join(runDir, "payloads.jsonl"), "utf8")
  .trim()
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));
const config = existsSync(join(runDir, "config.json"))
  ? JSON.parse(readFileSync(join(runDir, "config.json"), "utf8"))
  : {};

const csmMeta = payloads.map((p) => p.raw_response?.meta ?? {});
const pick = (k) => mean(csmMeta.map((m) => m[k]).filter((v) => typeof v === "number"));

// ---- Hindsight side (their own published artifact) ------------------------
const hsPath = resolve(`data/eval/external/hindsight-${tier}.json`);
const hs = JSON.parse(readFileSync(hsPath, "utf8"));
const hsById = new Map(hs.results.map((r) => [r.query_id, r]));

// ---- Head-to-head verdicts (our reader + judge, both arms) ----------------
const h2hPath = resolve(
  "data/eval/judge-calibration",
  `headtohead-csm-vs-hindsight-${h2hTier}.json`,
);
const h2h = JSON.parse(readFileSync(h2hPath, "utf8"));

// Paired stats, mirroring scripts/headtohead-arms.ts so numbers agree.
function paired(rows) {
  const d = rows.map((r) => r.b - r.a); // >0 = Hindsight ahead
  const n = d.length;
  if (n === 0) return null;
  const md = mean(d);
  const sd = Math.sqrt(
    (d.reduce((s, x) => s + (x - md) ** 2, 0) / Math.max(1, n - 1)) || 0,
  );
  const se = sd / Math.sqrt(n);
  return {
    n,
    csm: round(mean(rows.map((r) => r.a)), 4),
    hindsight: round(mean(rows.map((r) => r.b)), 4),
    // Sign flipped for readability: positive = CSM ahead.
    csmAdvantage: round(-md, 4),
    mde: round(2.8 * se, 4),
    csmWins: d.filter((x) => x < -1e-9).length,
    hindsightWins: d.filter((x) => x > 1e-9).length,
    ties: d.filter((x) => Math.abs(x) <= 1e-9).length,
    certified: Math.abs(md) > 2.8 * se ? (md < 0 ? "CSM" : "Hindsight") : "tie (below MDE)",
  };
}

const byCat = new Map();
for (const r of h2h.results) {
  const c = r.category ?? catOf(r.id);
  if (!byCat.has(c)) byCat.set(c, []);
  byCat.get(c).push(r);
}

const scoredIds = new Set(h2h.results.map((r) => r.id));
const csmScored = payloads.filter((p) => scoredIds.has(p.harness.queryId));
const hsScored = [...scoredIds].map((id) => hsById.get(id)).filter(Boolean);

// ANSWER-VISIBLE COST, measured identically on both sides.
//
// TRAP AVOIDED: CSM's `meta.contextTokens` is its INTERNAL budget estimate
// (~7K under CSM_AMB_MODEL_CONTEXT=8192), while Hindsight's `context_tokens`
// is the ACTUAL context string handed to the answer model (~23K). Comparing
// them would have manufactured a ~70% CSM "win". The honest measure is the
// text each system actually put in front of the reader, tokenized the same
// way -- for CSM that is the rendered contexts.json (byte-identical to what
// the head-to-head reader saw), for Hindsight their own context string.
const estTokens = (s) => Math.ceil(String(s ?? "").length / 4);
const ctxPath = join(runDir, "contexts.json");
let csmCtx = [];
let csmCtxSource = "contexts.json (rendered text the reader saw)";
if (existsSync(ctxPath)) {
  const rendered = new Map(
    JSON.parse(readFileSync(ctxPath, "utf8")).results.map((r) => [r.query_id, r.context]),
  );
  csmCtx = [...scoredIds].map((id) => rendered.get(id)).filter(Boolean).map(estTokens);
} else {
  // Fallback: sum the returned documents' declared sizes.
  csmCtxSource = "sum(documents.contentChars)/4 -- contexts.json absent";
  csmCtx = csmScored.map((p) =>
    Math.ceil(p.documents.reduce((s, d) => s + (d.contentChars ?? 0), 0) / 4),
  );
}
// Hindsight: same estimator over their context string, plus their own
// published figure for cross-checking the estimator.
const hsCtx = hsScored.map((r) => estTokens(r.context));
const hsCtxPublished = hsScored
  .map((r) => r.context_tokens)
  .filter((v) => typeof v === "number");
const hsLat = hsScored.map((r) => r.retrieve_time_ms).filter((v) => typeof v === "number");

const report = {
  tier,
  generatedFromCommit: config.gitSha ?? null,
  instrument: {
    reader: h2h.reader,
    judgePromptVersion: h2h.judgePromptVersion,
    note:
      "Both arms answered AND judged by the same reader; only the retrieved " +
      "context differs. Hindsight's arm is its own published context, so its " +
      "memory system is represented exactly as it shipped.",
    hindsightArtifact: {
      path: `data/eval/external/hindsight-${tier}.json`,
      provider: hs.memory_provider,
      runName: hs.run_name,
      originalAnswerLlm: hs.answer_llm,
      originalJudgeLlm: hs.judge_llm,
      originalAccuracy: hs.accuracy,
      totalQueries: hs.total_queries,
    },
    csmInternalsProvider: config.providerName ?? null,
    csmInternalsModel: config.bridgeOpts?.model ?? null,
    resolvedLevers: config.resolvedLevers ?? null,
    envEcho: config.envEcho ?? null,
  },
  score: {
    overall: paired(h2h.results),
    byCategory: Object.fromEntries(
      [...byCat.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([c, rows]) => [c, paired(rows)]),
    ),
    excludedPairs: h2h.excluded ?? 0,
    pairedN: h2h.n,
  },
  // ANSWER-VISIBLE cost: the clean apples-to-apples axis. Both numbers are
  // "tokens of retrieved context handed to the reader".
  answerVisibleTokens: {
    method: "chars/4 over the ACTUAL context text shown to the reader, both sides",
    csmSource: csmCtxSource,
    csmMean: round(mean(csmCtx)),
    hindsightMean: round(mean(hsCtx)),
    hindsightPublishedMean: round(mean(hsCtxPublished)),
    csmVsHindsightPct:
      mean(csmCtx) && mean(hsCtx) ? round((mean(csmCtx) / mean(hsCtx) - 1) * 100, 1) : null,
    csmInternalBudgetEstimate: round(pick("contextTokens")),
    note:
      "csmInternalBudgetEstimate is CSM's own meta.contextTokens (a budget " +
      "figure under CSM_AMB_MODEL_CONTEXT); it is NOT comparable to " +
      "Hindsight's context_tokens and must never be used for the cost claim.",
    n: { csm: csmCtx.length, hindsight: hsCtx.length },
  },
  // CSM internals. Call counts are trustworthy; token figures on the
  // agent-sdk path carry a large per-call harness prefix that is NOT CSM's,
  // so they are reported but must not be published as CSM's token cost.
  csmInternals: {
    probeShardsMean: round(pick("probeCount"), 2),
    recallsMean: round(pick("recallCount"), 2),
    candidatesMean: round(
      mean(csmMeta.map((m) => (m.candidateShardIds ?? []).length)),
      2,
    ),
    documentsReturnedMean: round(mean(payloads.map((p) => p.documents.length)), 2),
    pipelineLatencyMsMean: round(pick("pipelineLatencyMs")),
    pipelineInputTokensMean: round(pick("pipelineInputTokens")),
    pipelineOutputTokensMean: round(pick("pipelineOutputTokens")),
    tokenCaveat:
      "agent-sdk sidecar prefixes ~8.5K harness tokens per call; internal " +
      "token figures here are CSM+harness, not CSM. Publishable internal " +
      "cost must come from the key-based Gemini path.",
  },
  latency: {
    hindsightRetrieveMsMean: round(mean(hsLat)),
    csmRetrieveMsMean: round(mean(payloads.map((p) => p.harness.wallMs))),
    caveat:
      "NOT COMPARABLE. CSM's figure is the free sidecar path, which spawns a " +
      "subprocess per LLM call (~5s each) and includes first-of-unit " +
      "write-time builds. CSM's real published retrieve time is 3.47s at " +
      "100K on Gemini (1.84x faster than Hindsight). Latency claims must " +
      "come from the Gemini path only.",
  },
};

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${tier}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");

// ---- markdown ------------------------------------------------------------
const o = report.score.overall;
const lines = [];
lines.push(`### Tier ${tier.toUpperCase()} — n=${o.n} paired${report.score.excludedPairs ? ` (${report.score.excludedPairs} excluded)` : ""}`);
lines.push("");
lines.push(`**Overall: CSM ${o.csm} vs Hindsight ${o.hindsight} — ${o.csmAdvantage >= 0 ? "+" : ""}${o.csmAdvantage} for CSM, MDE ${o.mde}, ${o.csmWins}W/${o.hindsightWins}L/${o.ties}T → ${o.certified}**`);
lines.push("");
lines.push("| category | CSM | Hindsight | CSM adv | MDE | W/L/T | verdict |");
lines.push("|---|---:|---:|---:|---:|---|---|");
for (const [c, s] of Object.entries(report.score.byCategory)) {
  lines.push(
    `| ${c} | ${s.csm} | ${s.hindsight} | ${s.csmAdvantage >= 0 ? "+" : ""}${s.csmAdvantage} | ${s.mde} | ${s.csmWins}/${s.hindsightWins}/${s.ties} | ${s.certified} |`,
  );
}
lines.push("");
lines.push(
  `**Answer-visible tokens** (chars/4 over the identical text each side showed the reader): CSM ${report.answerVisibleTokens.csmMean} vs Hindsight ${report.answerVisibleTokens.hindsightMean}` +
    (report.answerVisibleTokens.csmVsHindsightPct === null
      ? ""
      : ` (${report.answerVisibleTokens.csmVsHindsightPct >= 0 ? "+" : ""}${report.answerVisibleTokens.csmVsHindsightPct}%)`) +
    `. Hindsight's own published figure: ${report.answerVisibleTokens.hindsightPublishedMean} (estimator cross-check).`,
);
lines.push("");
lines.push(
  `**CSM internals**: ${report.csmInternals.probeShardsMean} shards probed, ${report.csmInternals.recallsMean} recalls, ${report.csmInternals.documentsReturnedMean} docs returned. ` +
    `Internal token figures are CSM+harness on this path — not publishable as CSM's cost.`,
);
lines.push("");
lines.push(
  `**Provenance**: commit \`${report.generatedFromCommit ?? "n/a"}\`, CSM internals ${report.instrument.csmInternalsProvider}/${report.instrument.csmInternalsModel}, reader+judge ${report.instrument.reader}. ` +
    `Hindsight artifact: ${report.instrument.hindsightArtifact.runName} (originally answered by ${report.instrument.hindsightArtifact.originalAnswerLlm}, accuracy ${report.instrument.hindsightArtifact.originalAccuracy}).`,
);
lines.push("");

const mdPath = join(outDir, "REPORT.md");
let md = existsSync(mdPath)
  ? readFileSync(mdPath, "utf8")
  : `# Free apples-to-apples ladder — CSM vs Hindsight\n\nOne reader and one judge supplied by us to BOTH arms; only the retrieved context differs. Hindsight's arm is its own published context, so its system is represented exactly as it shipped. Not an official result and not publishable as a leaderboard claim — this is decision-grade internal evidence.\n\n`;
const marker = `### Tier ${tier.toUpperCase()} —`;
const start = md.indexOf(marker);
if (start >= 0) {
  const next = md.indexOf("\n### Tier ", start + 1);
  md = md.slice(0, start) + lines.join("\n") + (next >= 0 ? md.slice(next + 1) : "");
} else {
  md += `${lines.join("\n")}\n`;
}
writeFileSync(mdPath, md, "utf8");

console.log(`wrote ${join(outDir, `${tier}.json`)} and updated ${mdPath}`);
console.log(
  `${tier}: CSM ${o.csm} vs HS ${o.hindsight} (${o.csmAdvantage >= 0 ? "+" : ""}${o.csmAdvantage}, ${o.certified}) | ctx tokens ${report.answerVisibleTokens.csmMean} vs ${report.answerVisibleTokens.hindsightMean}`,
);
