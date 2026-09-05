// Measure how much of each 10M unit Hindsight's published contexts actually
// draw from — recomputed from primary artifacts, never from memory.
//
// WHY THIS EXISTS: the repo previously asserted that Hindsight's 10M contexts
// "reference turns spanning 98-99.9% of each unit's full turn range". That
// number was carried in a human's head, was never computed by any committed
// script, and is WRONG — the real figure is 64-90%. This script exists so the
// claim is a computation, not a recollection.
//
// It bears on the upstream 10M loader defect (maintainer PR #38), which implies
// the published 10M results measured a ~0.27%-loaded corpus. Retrieval that
// draws from across 64-90% of each unit's turn range is not consistent with
// that reading of the published artifacts. This script does NOT resolve the
// upstream question; it just puts a reproducible number on our side of it.
//
//   node scripts/measure-hindsight-10m-span.mjs
//
// Inputs (both gitignored, both re-fetchable):
//   data/eval/corpus-beam-slice/10m/documents.json.gz  (scripts/fetch-beam-slice.ts)
//   data/eval/external/hindsight-10m.json              (upstream AMB outputs)
import { readFileSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const DOCS = "data/eval/corpus-beam-slice/10m/documents.json.gz";
const HS = "data/eval/external/hindsight-10m.json";

for (const p of [DOCS, HS]) {
  if (!existsSync(p)) {
    console.error(`SKIP: ${p} not present (gitignored; see the header for how to fetch).`);
    process.exit(0);
  }
}

/** Denominator: the highest `Turn N]` index present in each unit's document.
 *
 *  BUG FIXED 2026-09-05: the first version matched `| Turn N]`, which only hits
 *  the ~100 DATED markers per unit (`[July-01-2024 | Turn 0]`); the other
 *  ~19,800 turns are `[Turn N]` with no date. That made the denominator the
 *  last dated turn rather than the last turn, overstating span coverage by
 *  ~1 point (64.3-89.7% published; 63.5-88.8% correct). Both marker shapes
 *  end in `Turn N]`, so that is what we match now. */
const raw = JSON.parse(gunzipSync(readFileSync(DOCS)).toString());
const docs = Array.isArray(raw) ? raw : (raw.documents ?? Object.values(raw).find(Array.isArray));
const maxTurn = new Map();
const datedOnly = new Map();
for (const d of docs) {
  const all = [...String(d.content).matchAll(/Turn (\d+)\]/g)].map((m) => Number(m[1]));
  const dated = [...String(d.content).matchAll(/\| Turn (\d+)\]/g)].map((m) => Number(m[1]));
  if (all.length) maxTurn.set(`u${d.id}`, Math.max(...all));
  if (dated.length) datedOnly.set(`u${d.id}`, { count: dated.length, max: Math.max(...dated) });
}

/** Numerator: chunk ids `beam-10m-u<unit>_<conv>_<idx>` cited inside each context. */
const hs = JSON.parse(readFileSync(HS, "utf8"));
const rows = hs.results ?? Object.values(hs).find(Array.isArray);
const refs = new Map();
for (const r of rows) {
  for (const m of String(r.context ?? "").matchAll(/beam-10m-u(\d+)_(\d+)_(\d+)/g)) {
    const u = `u${m[1]}`;
    if (!refs.has(u)) refs.set(u, []);
    refs.get(u).push(Number(m[3]));
  }
}

const units = [...refs.keys()].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
console.log(`rows: ${rows.length}   units with retrieved refs: ${units.length}\n`);
console.log("unit   maxRefIdx   maxTurnIdx   spanCoverage   distinctRefs   refDensity");
const spans = [];
const densities = [];
for (const u of units) {
  const v = refs.get(u);
  const maxRef = Math.max(...v);
  const total = maxTurn.get(u);
  const span = (maxRef / total) * 100;
  const distinct = new Set(v).size;
  const density = (distinct / total) * 100;
  spans.push(span);
  densities.push(density);
  console.log(
    u.padEnd(6),
    String(maxRef).padStart(9),
    String(total).padStart(12),
    `${span.toFixed(1)}%`.padStart(14),
    String(distinct).padStart(14),
    `${density.toFixed(1)}%`.padStart(12),
  );
}

const fmt = (a) => `${Math.min(...a).toFixed(1)}%-${Math.max(...a).toFixed(1)}%`;
const anyDated = [...datedOnly.values()];
if (anyDated.length) {
  console.log(
    `
(dated markers per unit: ${Math.min(...anyDated.map((x) => x.count))}-${Math.max(...anyDated.map((x) => x.count))}; ` +
      `the retired regex used their max as the denominator, which is why the first published range was ~1 point too high)`,
  );
}
console.log(`\nspan coverage  (highest turn index reached / unit's last turn): ${fmt(spans)}`);
console.log(`ref density    (distinct turns retrieved / unit's total turns): ${fmt(densities)}`);
console.log(
  `\nRead it as: retrieval reaches across ${fmt(spans)} of each unit's timeline,\n` +
    `while actually surfacing ${fmt(densities)} of its turns. The first number is\n` +
    `the one that bears on "was the corpus loaded"; the second is selectivity.`,
);
