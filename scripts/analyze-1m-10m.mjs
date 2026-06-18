// Fair-to-both analysis: per-category mean judge score at 1M and 10M for CSM
// (local artifacts) and Hindsight (raw AMB gz), with the 1M->10M delta side by
// side. Answers: did CSM stop declining at the extreme while Hindsight fell?
import fs from "node:fs";
import https from "node:https";
import zlib from "node:zlib";

const HIND = "https://raw.githubusercontent.com/vectorize-io/agent-memory-benchmark/main/outputs/beam/hindsight/single-query";
const CSM = {
  "1m": "data/eval/runs/amb-beam-1m-official-v1/amb-outputs/beam/amb-beam-1m-official-v1/rag/1m.json",
  "10m": "data/eval/runs/amb-beam-10m-official-v1/amb-outputs/beam/amb-beam-10m-official-v1/rag/10m.json",
};

function fetchBuf(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "csm" } }, (res) => {
      if (res.statusCode !== 200) return reject(new Error("HTTP " + res.statusCode));
      const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve(Buffer.concat(c)));
    }).on("error", reject);
  });
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const cat = (r) => (r.meta && r.meta.question_category) || (r.category_axes && r.category_axes.question_category) || "?";
const sc = (r) => (typeof r.score === "number" ? r.score : (r.correct ? 1 : 0));

function byCat(rows) {
  const m = {};
  for (const r of rows) (m[cat(r)] = m[cat(r)] || []).push(sc(r));
  const out = {};
  for (const k of Object.keys(m)) out[k] = mean(m[k]);
  return out;
}

const csm1m = byCat(JSON.parse(fs.readFileSync(CSM["1m"], "utf8")).results);
const csm10m = byCat(JSON.parse(fs.readFileSync(CSM["10m"], "utf8")).results);
const h1m = byCat(JSON.parse(zlib.gunzipSync(await fetchBuf(`${HIND}/1m.json.gz`)).toString("utf8")).results);
const h10m = byCat(JSON.parse(zlib.gunzipSync(await fetchBuf(`${HIND}/10m.json.gz`)).toString("utf8")).results);

const cats = [...new Set([...Object.keys(csm1m), ...Object.keys(h1m)])].sort();
const f = (x) => (x == null ? "  -  " : x.toFixed(3));
const d = (a, b) => (a == null || b == null ? "  -  " : ((b - a >= 0 ? "+" : "") + (b - a).toFixed(3)));
console.log("category".padEnd(26) + "CSM1M  CSM10M  CSMΔ   | HIND1M HIND10M HINDΔ");
for (const c of cats) {
  console.log(
    c.padEnd(26) +
    `${f(csm1m[c])}  ${f(csm10m[c])}  ${d(csm1m[c], csm10m[c])} | ${f(h1m[c])}  ${f(h10m[c])}  ${d(h1m[c], h10m[c])}`,
  );
}
const aMean = (o) => mean(Object.values(o));
console.log("\nAGG mean 1M -> 10M:");
console.log(`  CSM      ${aMean(csm1m).toFixed(4)} -> ${aMean(csm10m).toFixed(4)}  (Δ ${(aMean(csm10m)-aMean(csm1m)).toFixed(4)})`);
console.log(`  Hindsight ${aMean(h1m).toFixed(4)} -> ${aMean(h10m).toFixed(4)}  (Δ ${(aMean(h10m)-aMean(h1m)).toFixed(4)})`);
