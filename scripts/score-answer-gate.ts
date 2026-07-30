#!/usr/bin/env tsx
/**
 * END-TO-END ANSWER GATE — turns a retrieval-coverage proxy into an actual
 * answer-quality delta.
 *
 * Every CSM retrieval improvement so far is measured as gold-facet coverage,
 * which is a PROXY. The prior lever died exactly here ("proxy-only, conversion
 * unproven"). This replays two frozen payloads.jsonl runs (arm A vs arm B),
 * asks a model to ANSWER each query from that arm's retrieved documents, then
 * asks a model to JUDGE the answer against gold, and reports the PAIRED delta.
 *
 * Held constant across arms: answer model, judge model, prompts, query set.
 * Only the retrieved documents differ. That is what makes it a valid internal
 * A/B even when the models are not BEAM's own.
 *
 * SCOPE: this validates "does the change improve answers?". It does NOT produce
 * a number comparable to Hindsight — that requires BEAM's exact answer/judge
 * models (gemini-3.1-pro-preview / gemini-2.5-flash-lite) and is a separate,
 * paid confirmation run.
 *
 * LEAKAGE: the ANSWER call sees only query + retrieved documents. Gold is read
 * ONLY by the JUDGE call, after the answer exists. Retrieval already happened
 * and is frozen in the payloads, so nothing here can influence it.
 *
 *   npx tsx scripts/score-answer-gate.ts --a <runIdA> --b <runIdB> [--split 100k]
 *     [--categories a,b] [--limit N] [--jobs 4] [--model claude-opus-5]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

import { buildCorpus } from "./amb-csm-retrieve.js";

interface PayloadRow {
  harness: { queryId: string; category: string; userId: string };
  documents: Array<{ id: string; contentChars: number }>;
  raw_response?: { returnedEventIds?: string[] };
}

interface GoldRow {
  id: string;
  query: string;
  gold_answers: string[];
  user_id?: string;
  meta?: { category?: string };
}

const SIDECAR = process.env.CSM_AGENT_BASE_URL ?? "http://127.0.0.1:8787";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}

function readPayloads(runId: string): Map<string, PayloadRow> {
  const p = resolve(process.cwd(), "data", "eval", "runs", runId, "payloads.jsonl");
  if (!existsSync(p)) throw new Error(`no payloads.jsonl for run ${runId}`);
  const out = new Map<string, PayloadRow>();
  for (const line of readFileSync(p, "utf8").trim().split("\n")) {
    try {
      const row = JSON.parse(line) as PayloadRow;
      out.set(row.harness.queryId, row);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

/** Gold + full document text, loaded once. Gold is used ONLY by the judge. */
function loadSlice(split: string): { gold: Map<string, GoldRow>; text: Map<string, string> } {
  const dir = resolve(process.cwd(), "data", "eval", "corpus-beam-slice", split);
  const readMaybeGz = (base: string): unknown => {
    const gz = join(dir, `${base}.json.gz`);
    const plain = join(dir, `${base}.json`);
    if (existsSync(gz)) {
      return JSON.parse(gunzipSync(readFileSync(gz)).toString("utf8"));
    }
    return JSON.parse(readFileSync(plain, "utf8"));
  };
  const gold = new Map<string, GoldRow>();
  for (const r of readMaybeGz("queries") as GoldRow[]) gold.set(r.id, r);

  // Resolve "<docId>#turn-N" ids through the bridge's OWN buildCorpus rather
  // than re-deriving the split. An earlier version re-implemented it as
  // split(/\n(?=\[)/), which also fires on markdown like "[link]" and produced
  // turn indices misaligned with the bridge's — every excerpt was the wrong
  // text, and the gate scored ~0.03 on BOTH arms, i.e. no discriminative power
  // at all. Import the single source of truth instead.
  const docs = readMaybeGz("documents") as Array<{
    id: string;
    content: string;
    user_id?: string | null;
    timestamp?: string | null;
  }>;
  const corpus = buildCorpus(
    docs.map((d) => ({
      id: d.id,
      content: d.content,
      user_id: d.user_id ?? null,
      timestamp: d.timestamp ?? null,
    })) as Parameters<typeof buildCorpus>[0],
  );
  const text = new Map<string, string>();
  for (const [id, ev] of corpus.byId) text.set(id, ev.content);
  for (const d of docs) if (!text.has(d.id)) text.set(d.id, String(d.content));
  return { gold, text };
}

async function callSidecar(system: string, prompt: string, model: string): Promise<string> {
  const res = await fetch(`${SIDECAR}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system, prompt, model, jsonMode: false }),
  });
  const body = (await res.json()) as { text?: string; error?: string };
  if (!res.ok || body.error) throw new Error(`sidecar: ${body.error ?? res.status}`);
  return body.text ?? "";
}

const ANSWER_SYSTEM =
  "You answer questions using ONLY the provided memory excerpts. " +
  "If the excerpts do not contain the answer, say so plainly. " +
  "Be concise and factual. Do not speculate beyond the excerpts.";

const JUDGE_SYSTEM =
  "You grade a candidate answer against reference answers. " +
  "Reply with ONLY a single integer 0-10 and nothing else. " +
  "10 = fully equivalent to a reference answer in substance. " +
  "0 = contradicts it or is entirely unrelated. " +
  "Judge substance, not wording or length. " +
  "If the references say the information is absent and the candidate also says " +
  "it is absent, that is a 10.";

async function main(): Promise<void> {
  const runA = arg("a");
  const runB = arg("b");
  const split = arg("split", "100k")!;
  const model = arg("model", "claude-opus-5")!;
  const limit = Number.parseInt(arg("limit", "0")!, 10);
  const jobs = Math.max(1, Number.parseInt(arg("jobs", "4")!, 10));
  const cats = arg("categories")?.split(",").map((s) => s.trim()).filter(Boolean);
  if (!runA || !runB) throw new Error("--a <runId> and --b <runId> are required");

  const A = readPayloads(runA);
  const B = readPayloads(runB);
  const { gold, text } = loadSlice(split);

  let shared = [...A.keys()].filter((id) => B.has(id) && gold.has(id));
  if (cats) shared = shared.filter((id) => cats.includes(A.get(id)!.harness.category));
  shared.sort();
  if (limit > 0) shared = shared.slice(0, limit);
  if (shared.length === 0) throw new Error("no shared queries between the two runs");

  console.log(
    `answer gate: A=${runA} B=${runB} split=${split} model=${model} ` +
      `paired-queries=${shared.length} jobs=${jobs}`,
  );

  const render = (row: PayloadRow): string =>
    row.documents
      .map((d, i) => `[excerpt ${i + 1}]\n${text.get(d.id) ?? `(id ${d.id} unavailable)`}`)
      .join("\n\n")
      .slice(0, 120_000);

  const scoreArm = async (row: PayloadRow, g: GoldRow): Promise<number> => {
    const answer = await callSidecar(
      ANSWER_SYSTEM,
      `Memory excerpts:\n\n${render(row)}\n\nQuestion: ${g.query}\n\nAnswer:`,
      model,
    );
    const verdict = await callSidecar(
      JUDGE_SYSTEM,
      `Question: ${g.query}\n\nReference answer(s):\n${g.gold_answers
        .map((a, i) => `${i + 1}. ${a}`)
        .join("\n")}\n\nCandidate answer:\n${answer}\n\nScore (0-10):`,
      model,
    );
    const n = Number.parseInt((verdict.match(/\d+/) ?? ["0"])[0]!, 10);
    return Number.isFinite(n) ? Math.max(0, Math.min(10, n)) / 10 : 0;
  };

  const results: Array<{ id: string; category: string; a: number; b: number }> = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= shared.length) return;
      const id = shared[i]!;
      const g = gold.get(id)!;
      try {
        const [a, b] = await Promise.all([scoreArm(A.get(id)!, g), scoreArm(B.get(id)!, g)]);
        results.push({ id, category: A.get(id)!.harness.category, a, b });
        const d = b - a;
        console.log(
          `  ${id.padEnd(24)} A=${a.toFixed(1)} B=${b.toFixed(1)} ` +
            `${d > 0 ? "B+" : d < 0 ? "A+" : "tie"}`,
        );
      } catch (err) {
        console.log(`  ${id.padEnd(24)} ERROR ${String((err as Error).message).slice(0, 80)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, shared.length) }, () => worker()));

  // Paired sign test — deltas are sparse (most queries tie), so the discordant
  // pair count is the effective N, not the row count.
  const byCat = new Map<string, typeof results>();
  for (const r of results) {
    if (!byCat.has(r.category)) byCat.set(r.category, []);
    byCat.get(r.category)!.push(r);
  }
  const report: string[] = ["", "category            n   meanA   meanB   delta   B>A  A>B  tie"];
  const line = (name: string, rows: typeof results): string => {
    const mA = rows.reduce((s, r) => s + r.a, 0) / rows.length;
    const mB = rows.reduce((s, r) => s + r.b, 0) / rows.length;
    const win = rows.filter((r) => r.b > r.a).length;
    const loss = rows.filter((r) => r.b < r.a).length;
    return (
      `${name.padEnd(18)} ${String(rows.length).padStart(3)}   ` +
      `${mA.toFixed(3)}   ${mB.toFixed(3)}   ${(mB - mA >= 0 ? "+" : "") + (mB - mA).toFixed(3)}   ` +
      `${String(win).padStart(3)}  ${String(loss).padStart(3)}  ${String(rows.length - win - loss).padStart(3)}`
    );
  };
  for (const [cat, rows] of [...byCat].sort()) report.push(line(cat, rows));
  if (byCat.size > 1) report.push(line("ALL", results));
  console.log(report.join("\n"));

  const out = resolve(process.cwd(), "data", "eval", "runs", runB, "answer-gate.json");
  writeFileSync(
    out,
    JSON.stringify({ runA, runB, split, model, results }, null, 2),
    "utf8",
  );
  console.log(`\nWrote ${out}`);
}

main().catch((err) => {
  console.error(`score-answer-gate failed: ${String(err)}`);
  process.exit(1);
});
