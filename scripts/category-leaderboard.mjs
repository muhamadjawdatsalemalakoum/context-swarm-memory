// Per-CATEGORY, per-TIER head-to-head: CSM vs Hindsight across the full BEAM
// ladder, recomputed from raw artifacts on both sides.
//
// WHY: the ladder doc reports one overall score per tier plus a few 1M->10M
// deltas. That is not enough to steer work — "where does CSM already lead, and
// which category is closest to flipping" is a per-cell question, and the answer
// decides which lever is worth building next.
//
// CSM side: the official run outputs committed under data/eval/runs/.
// Hindsight side: Vectorize's OWN committed artifacts, same answer model
// (gemini-3.1-pro-preview), same judge (gemini-2.5-flash-lite), oracle=false.
// Nothing here trusts a secondary claim or a blog table.
//
//   node scripts/category-leaderboard.mjs            # fetches Hindsight
//   node scripts/category-leaderboard.mjs --offline  # CSM side only
import https from "node:https";
import zlib from "node:zlib";
import { readFileSync, existsSync, writeFileSync } from "node:fs";

const HINDSIGHT_BASE =
  "https://raw.githubusercontent.com/vectorize-io/agent-memory-benchmark/main/outputs/beam/hindsight/single-query";

const CSM_PATHS = {
  "100k": "data/eval/runs/amb-beam-100k-official-v2/amb-outputs/beam/amb-beam-100k-official-v2/rag/100k.json",
  "500k": "data/eval/runs/amb-beam-500k-official-v1/amb-outputs/beam/amb-beam-500k-official-v1/rag/500k.json",
  "1m": "data/eval/runs/amb-beam-1m-official-v1/amb-outputs/beam/amb-beam-1m-official-v1/rag/1m.json",
  "10m": "data/eval/runs/amb-beam-10m-official-v1/amb-outputs/beam/amb-beam-10m-official-v1/rag/10m.json",
};
const TIERS = ["100k", "500k", "1m", "10m"];
const offline = process.argv.includes("--offline");

function fetchBuf(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "csm-verify" } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      })
      .on("error", reject);
  });
}

/**
 * BEAM encodes the category in the query id as `{unit}_{category}_{index}`
 * (e.g. `1_abstention_0`, `10_knowledge_update_1`). Both sides' artifacts carry
 * the same ids, which makes this the one join key that cannot drift between
 * them — the row-level `category` field is absent on these artifacts and the
 * top-level one is the whole run's filter, not the row's.
 */
export function categoryOfQueryId(id) {
  const m = String(id ?? "").match(/^\d+_(.+)_\d+$/);
  return m ? m[1] : "unknown";
}

/** Per-category mean of the judge score, plus n. Scores are already 0..1. */
function byCategory(results) {
  const acc = new Map();
  for (const r of results) {
    const cat = categoryOfQueryId(r.query_id);
    const score = typeof r.score === "number" ? r.score : r.correct ? 1 : 0;
    const cur = acc.get(cat) ?? { sum: 0, n: 0 };
    cur.sum += score;
    cur.n += 1;
    acc.set(cat, cur);
  }
  const out = new Map();
  for (const [cat, { sum, n }] of acc) out.set(cat, { mean: sum / n, n });
  return out;
}

function loadCsm(tier) {
  const p = CSM_PATHS[tier];
  if (!existsSync(p)) return null;
  const j = JSON.parse(readFileSync(p, "utf8"));
  return { byCat: byCategory(j.results ?? []), meta: j };
}

const csm = {};
for (const t of TIERS) csm[t] = loadCsm(t);

const hind = {};
if (!offline) {
  for (const t of TIERS) {
    try {
      const buf = await fetchBuf(`${HINDSIGHT_BASE}/${t}.json.gz`);
      const j = JSON.parse(zlib.gunzipSync(buf).toString("utf8"));
      hind[t] = { byCat: byCategory(j.results ?? []), meta: j };
      console.error(
        `fetched hindsight ${t}: answer=${j.answer_llm} judge=${j.judge_llm} oracle=${j.oracle} n=${(j.results ?? []).length}`,
      );
    } catch (err) {
      console.error(`hindsight ${t} unavailable: ${err.message}`);
      hind[t] = null;
    }
  }
}

// Model-parity guard: an apples-to-apples claim is only valid if both sides
// used the same answer and judge model. Report mismatches loudly rather than
// letting them ride into a comparison table.
for (const t of TIERS) {
  const a = csm[t]?.meta;
  const b = hind[t]?.meta;
  if (!a || !b) continue;
  const aAns = a.answer_llm ?? a.answer_model;
  const aJud = a.judge_llm ?? a.judge_model;
  if (aAns && b.answer_llm && aAns !== b.answer_llm)
    console.error(`WARNING ${t}: answer model differs — CSM ${aAns} vs Hindsight ${b.answer_llm}`);
  if (aJud && b.judge_llm && aJud !== b.judge_llm)
    console.error(`WARNING ${t}: judge model differs — CSM ${aJud} vs Hindsight ${b.judge_llm}`);
}

const cats = new Set();
for (const t of TIERS) {
  for (const c of csm[t]?.byCat.keys() ?? []) cats.add(c);
  for (const c of hind[t]?.byCat.keys() ?? []) cats.add(c);
}

const rows = [];
for (const cat of [...cats].sort()) {
  const row = { category: cat, tiers: {} };
  for (const t of TIERS) {
    const c = csm[t]?.byCat.get(cat);
    const h = hind[t]?.byCat.get(cat);
    row.tiers[t] = {
      csm: c?.mean ?? null,
      hindsight: h?.mean ?? null,
      n: c?.n ?? h?.n ?? 0,
      delta: c && h ? c.mean - h.mean : null,
    };
  }
  rows.push(row);
}

const f = (v) => (v === null || v === undefined ? "  —  " : v.toFixed(3));
const mark = (d) => (d === null ? " " : d > 0.0005 ? "W" : d < -0.0005 ? "L" : "=");

console.log(`\ncategory                   ${TIERS.map((t) => t.padStart(16)).join("")}`);
console.log(`${" ".repeat(27)}${TIERS.map(() => "   csm   hind   d  ").join("")}`);
for (const r of rows) {
  let line = r.category.padEnd(27);
  for (const t of TIERS) {
    const c = r.tiers[t];
    line += ` ${f(c.csm)} ${f(c.hindsight)} ${mark(c.delta)} `;
  }
  console.log(line);
}

console.log(`\nCategories CSM LEADS, per tier:`);
for (const t of TIERS) {
  const led = rows.filter((r) => r.tiers[t].delta !== null && r.tiers[t].delta > 0.0005);
  console.log(
    `  ${t.padEnd(5)} ${String(led.length).padStart(2)} — ${led.map((r) => `${r.category}(+${r.tiers[t].delta.toFixed(3)})`).join(", ") || "(none)"}`,
  );
}

// The steering output: per tier, the nearest LOSSES ranked by how small the gap
// is. These are where a lever has the best chance of flipping a cell.
console.log(`\nNearest flips (smallest deficits) per tier:`);
for (const t of TIERS) {
  const near = rows
    .filter((r) => r.tiers[t].delta !== null && r.tiers[t].delta <= 0.0005)
    .sort((a, b) => b.tiers[t].delta - a.tiers[t].delta)
    .slice(0, 4);
  console.log(
    `  ${t.padEnd(5)} ${near.map((r) => `${r.category} ${r.tiers[t].delta.toFixed(3)}`).join("  |  ") || "(none)"}`,
  );
}

writeFileSync(
  "data/eval/runs/category-leaderboard.json",
  `${JSON.stringify({ generatedFrom: { csm: CSM_PATHS, hindsight: HINDSIGHT_BASE }, rows }, null, 2)}\n`,
  "utf8",
);
console.log(`\nwrote data/eval/runs/category-leaderboard.json`);
