// Independently verify Hindsight's full BEAM ladder from the AMB repo's raw
// committed artifacts. Fetches each gz, gunzips, recomputes the mean per-query
// judge score + correct/total, and prints the answer/judge models so we can
// confirm apples-to-apples with our CSM ladder. No trust in secondary claims.
import https from "node:https";
import zlib from "node:zlib";

const BASE =
  "https://raw.githubusercontent.com/vectorize-io/agent-memory-benchmark/main/outputs/beam/hindsight/single-query";
const TIERS = ["100k", "500k", "1m", "10m"];

function fetchBuf(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "csm-verify" } }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      })
      .on("error", reject);
  });
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

for (const tier of TIERS) {
  try {
    const buf = await fetchBuf(`${BASE}/${tier}.json.gz`);
    const j = JSON.parse(zlib.gunzipSync(buf).toString("utf8"));
    const r = j.results || [];
    const scores = r.map((x) => (typeof x.score === "number" ? x.score : (x.correct ? 1 : 0)));
    const correct = r.filter((x) => x.correct).length;
    console.log(
      `${tier.padEnd(5)} provider=${j.memory_provider} answer=${j.answer_llm} judge=${j.judge_llm} oracle=${j.oracle}`,
    );
    console.log(
      `      rows=${r.length} | field accuracy=${j.accuracy != null ? Number(j.accuracy).toFixed(4) : "?"} | recomputed meanScore=${mean(scores).toFixed(4)} | correct=${correct}/${r.length} (${(100 * correct / r.length).toFixed(1)}%) | avg_ctx=${j.avg_context_tokens != null ? Math.round(j.avg_context_tokens) : "?"}`,
    );
  } catch (e) {
    console.log(`${tier.padEnd(5)} FETCH/PARSE FAILED: ${e.message}`);
  }
}
