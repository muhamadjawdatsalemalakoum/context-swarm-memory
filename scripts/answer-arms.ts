#!/usr/bin/env tsx
/**
 * ANSWER STEP of the two-process answer gate — RETRIEVAL SIDE, NEVER READS GOLD.
 *
 * Replays two frozen `payloads.jsonl` arms, renders each arm's retrieved
 * documents into excerpts, and asks a model to ANSWER the query from them.
 * Writes `answers.jsonl`. It never sees rubric items or gold answers.
 *
 * The judge lives in a separate process (`scripts/judge-arms.ts`) which reads
 * gold but cannot reach the retrieval bridge. That is the same one-way,
 * file-mediated split the repo already uses for retrieval scoring
 * (run-beam-slice -> payloads.jsonl -> score-beam-slice), and it is what keeps
 * `tests/beamLeakageFirewall.test.ts` meaningful: no single module holds both
 * the corpus and the gold.
 *
 * Retrieval already happened and is frozen in the payloads, so nothing here can
 * influence what was retrieved.
 *
 *   npx tsx scripts/answer-arms.ts --a <runIdA> --b <runIdB> [--split 100k]
 *     [--categories a,b] [--limit N] [--jobs 6] [--model claude-sonnet-5]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

import { buildCorpus } from "./amb-csm-retrieve.js";
import { cacheGet, cacheSet } from "../src/eval/cache.js";

interface PayloadRow {
  harness: { queryId: string; category: string; userId: string };
  documents: Array<{ id: string; contentChars: number }>;
}

const SIDECAR = process.env.CSM_AGENT_BASE_URL ?? "http://127.0.0.1:8787";

/** Bumped when the answer prompt changes; part of the cache key. */
const ANSWER_PROMPT_VERSION = "v1";

const ANSWER_SYSTEM =
  "You answer questions using ONLY the provided memory excerpts. " +
  "If the excerpts do not contain the answer, say so plainly. " +
  "Be specific and complete: name the concrete items, values and dates the " +
  "excerpts support. When the question asks about a sequence, present the " +
  "items in the order the excerpts indicate. Do not speculate beyond the " +
  "excerpts.";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : fallback;
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
      /* torn tail line from an interrupted run */
    }
  }
  return out;
}

/**
 * Event-id -> text, resolved through the bridge's OWN `buildCorpus`.
 *
 * An earlier version of the gate re-derived the turn split as
 * `split(/\n(?=\[)/)`, which also fires on markdown like "[link]" and produced
 * turn indices misaligned with the bridge's — every excerpt was the wrong text.
 * Import the single source of truth instead.
 */
function loadDocText(split: string): { text: Map<string, string>; query: Map<string, string> } {
  const dir = resolve(process.cwd(), "data", "eval", "corpus-beam-slice", split);
  const readMaybeGz = (base: string): unknown => {
    const gz = join(dir, `${base}.json.gz`);
    const plain = join(dir, `${base}.json`);
    if (existsSync(gz)) return JSON.parse(gunzipSync(readFileSync(gz)).toString("utf8"));
    return JSON.parse(readFileSync(plain, "utf8"));
  };
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

  // Query text only — the `meta.rubric` on these rows is GOLD and is
  // deliberately not read here. The judge process reads it instead.
  const query = new Map<string, string>();
  for (const q of readMaybeGz("queries") as Array<{ id: string; query: string }>) {
    query.set(q.id, q.query);
  }
  return { text, query };
}

async function answer(prompt: string, model: string): Promise<string> {
  const keyInput = {
    model: `answer:${ANSWER_PROMPT_VERSION}:${model}`,
    prompt,
    system: ANSWER_SYSTEM,
    temperature: 0,
    maxOutputTokens: 2048,
    seed: 42,
  };
  const hit = await cacheGet(keyInput);
  if (hit) return hit.response;
  const started = Date.now();
  const res = await fetch(`${SIDECAR}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system: ANSWER_SYSTEM, prompt, model, jsonMode: false }),
  });
  const body = (await res.json()) as { text?: string; error?: string };
  if (!res.ok || body.error) throw new Error(`sidecar: ${body.error ?? res.status}`);
  const text = body.text ?? "";
  if (text.trim().length >= 5) {
    await cacheSet(keyInput, { response: text, latencyMs: Date.now() - started });
  }
  return text;
}

async function main(): Promise<void> {
  const runA = arg("a");
  const runB = arg("b");
  const split = arg("split", "100k")!;
  const model = arg("model", "claude-sonnet-5")!;
  const jobs = Math.max(1, Number.parseInt(arg("jobs", "6")!, 10));
  const limit = Number.parseInt(arg("limit", "0")!, 10);
  const cats = arg("categories")?.split(",").map((s) => s.trim()).filter(Boolean);
  if (!runA || !runB) throw new Error("--a <runId> and --b <runId> are required");

  const A = readPayloads(runA);
  const B = readPayloads(runB);
  const { text, query } = loadDocText(split);

  let shared = [...A.keys()].filter((id) => B.has(id) && query.has(id));
  if (cats) shared = shared.filter((id) => cats.includes(A.get(id)!.harness.category));
  shared.sort();
  if (limit > 0) shared = shared.slice(0, limit);
  if (shared.length === 0) throw new Error("no shared queries between the two runs");

  console.log(
    `answer step: A=${runA} B=${runB} split=${split} model=${model} ` +
      `paired=${shared.length} jobs=${jobs}`,
  );

  const render = (row: PayloadRow): string =>
    row.documents
      .map((d, i) => `[excerpt ${i + 1}]\n${text.get(d.id) ?? `(id ${d.id} unavailable)`}`)
      .join("\n\n")
      .slice(0, 120_000);

  const out: Array<{
    queryId: string;
    category: string;
    answerA: string;
    answerB: string;
    docsA: number;
    docsB: number;
  }> = [];
  let cursor = 0;
  let failures = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= shared.length) return;
      const id = shared[i]!;
      const q = query.get(id)!;
      const ra = A.get(id)!;
      const rb = B.get(id)!;
      try {
        const [answerA, answerB] = await Promise.all([
          answer(`Memory excerpts:\n\n${render(ra)}\n\nQuestion: ${q}\n\nAnswer:`, model),
          answer(`Memory excerpts:\n\n${render(rb)}\n\nQuestion: ${q}\n\nAnswer:`, model),
        ]);
        out.push({
          queryId: id,
          category: ra.harness.category,
          answerA,
          answerB,
          docsA: ra.documents.length,
          docsB: rb.documents.length,
        });
      } catch (err) {
        // Counted and reported — a silent drop would un-pair the comparison and
        // bias the delta if failures correlate with one arm.
        failures++;
        console.log(`  ${id.padEnd(24)} ERROR ${String((err as Error).message).slice(0, 70)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, shared.length) }, () => worker()));

  out.sort((x, y) => x.queryId.localeCompare(y.queryId));
  const dest = resolve(process.cwd(), "data", "eval", "runs", runB, "answers.jsonl");
  writeFileSync(
    dest,
    out
      .map((r) => JSON.stringify({ ...r, runA, runB, split, model, promptVersion: ANSWER_PROMPT_VERSION }))
      .join("\n") + "\n",
    "utf8",
  );
  console.log(
    `\nwrote ${dest}\n  answered ${out.length}/${shared.length} pairs` +
      (failures > 0 ? `  (${failures} failed and are excluded)` : ""),
  );
  console.log(`\nnext: npx tsx scripts/judge-arms.ts --run ${runB} --split ${split}`);
}

main().catch((err) => {
  console.error(`answer-arms failed: ${String((err as Error).message ?? err)}`);
  process.exit(1);
});
