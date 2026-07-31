#!/usr/bin/env tsx
/**
 * Render a slice run's `payloads.jsonl` into the official-artifact shape
 * (`{results: [{query_id, query, context, ...}]}`) so a freshly-run CSM config
 * can be dropped into `scripts/headtohead-arms.ts` against Hindsight.
 *
 * RETRIEVAL SIDE, NEVER READS GOLD. It resolves event ids to text through the
 * bridge's own `buildCorpus` and copies the query string; `meta.rubric` on the
 * slice queries is gold and is deliberately not read here — the head-to-head
 * script reads rubric itself, in its own process.
 *
 *   npx tsx scripts/payloads-to-artifact.ts --run r1mC-deschybrid-v1 --split 1m
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

import { buildCorpus } from "./amb-csm-retrieve.js";

interface PayloadRow {
  harness: { queryId: string; category: string; userId: string };
  documents: Array<{ id: string }>;
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : fallback;
}

function main(): void {
  const runId = arg("run");
  const split = arg("split", "100k")!;
  if (!runId) throw new Error("--run <runId> is required");

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

  // Query STRING only. No rubric, no gold_answers.
  const qtext = new Map<string, string>();
  for (const q of readMaybeGz("queries") as Array<{ id: string; query: string }>) {
    qtext.set(q.id, q.query);
  }

  const path = resolve(process.cwd(), "data", "eval", "runs", runId, "payloads.jsonl");
  const rows = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => {
      try {
        return JSON.parse(l) as PayloadRow;
      } catch {
        return null;
      }
    })
    .filter((r): r is PayloadRow => r !== null);

  const results = rows.map((r) => ({
    query_id: r.harness.queryId,
    query: qtext.get(r.harness.queryId) ?? "",
    // Rendered exactly like scripts/answer-arms.ts so the two paths agree.
    context: r.documents
      .map((d, i) => `[excerpt ${i + 1}]\n${text.get(d.id) ?? `(id ${d.id} unavailable)`}`)
      .join("\n\n")
      .slice(0, 200_000),
    context_tokens: 0,
    meta: {},
  }));

  const dest = resolve(process.cwd(), "data", "eval", "runs", runId, "as-artifact.json");
  writeFileSync(
    dest,
    JSON.stringify(
      { dataset: "beam", split, memory_provider: "csm", run_name: runId, total_queries: results.length, results },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`wrote ${dest}  (${results.length} rows)`);
}

main();
