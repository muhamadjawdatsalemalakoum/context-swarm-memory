#!/usr/bin/env tsx
/**
 * Slice run -> AMB-artifact-shaped contexts. RETRIEVAL SIDE, NEVER READS GOLD.
 *
 * WHY THIS EXISTS: `scripts/headtohead-arms.ts` compares CSM against Hindsight
 * on ONE reader by loading two artifacts that each carry a `context` string per
 * query. CSM's published artifacts are frozen at the 2026-06-18 configuration —
 * before the hybrid router, ID repair, the preference profile, lean return and
 * batched probe. Comparing those against Hindsight measures a CSM that no
 * longer exists.
 *
 * A slice run (`scripts/run-beam-slice.ts`) produces today's retrieval, but
 * stores document IDS, not text. This renders those ids into the exact context
 * the answer gate would show, and writes it in the artifact shape the
 * head-to-head already accepts — so no gold-side code changes at all.
 *
 * FIREWALL: the head-to-head is a GOLD consumer and must never import the
 * retrieval bridge. This script is the opposite half: it imports the bridge
 * (for `buildCorpus`, the single source of truth for turn splitting) and never
 * reads `meta.rubric`. The rubric is supplied on the gold side from the
 * Hindsight artifact, which carries it for the same query ids.
 *
 *   npx tsx scripts/emit-run-contexts.ts --run <runId> --split 500k \
 *     [--out data/eval/runs/<runId>/contexts.json]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { renderExcerpts, synthKey } from "./answer-arms.js";
import { buildCorpus } from "./amb-csm-retrieve.js";

interface PayloadRow {
  harness: { queryId: string; category: string; userId: string };
  documents: Array<{ id: string; contentChars: number }>;
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : fallback;
}

function readMaybeGz(dir: string, base: string): unknown {
  const gz = join(dir, `${base}.json.gz`);
  const plain = join(dir, `${base}.json`);
  if (existsSync(gz)) return JSON.parse(gunzipSync(readFileSync(gz)).toString("utf8"));
  return JSON.parse(readFileSync(plain, "utf8"));
}

function main(): void {
  const runId = arg("run");
  const split = arg("split");
  if (!runId || !split) throw new Error("--run <runId> and --split <tier> are required");
  const runDir = resolve(process.cwd(), "data", "eval", "runs", runId);
  const out = arg("out", join(runDir, "contexts.json"))!;

  const payloads = readFileSync(join(runDir, "payloads.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as PayloadRow);

  // Synthesised (`csm-*`) text exists in no corpus — it is per-run and per-query.
  const synth = new Map<string, string>();
  const synthPath = join(runDir, "synthesized-docs.jsonl");
  if (existsSync(synthPath)) {
    for (const line of readFileSync(synthPath, "utf8").trim().split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as { queryId: string; id: string; content: string };
      synth.set(synthKey(r.queryId, r.id), r.content);
    }
  }

  const sliceDir = resolve(process.cwd(), "data", "eval", "corpus-beam-slice", split);
  const docs = readMaybeGz(sliceDir, "documents") as Array<{
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

  // Query text only. `meta.rubric` on these rows is GOLD and is deliberately
  // NOT read here — the head-to-head takes it from the Hindsight artifact.
  const queryText = new Map<string, string>();
  for (const q of readMaybeGz(sliceDir, "queries") as Array<{ id: string; query: string }>) {
    queryText.set(q.id, q.query);
  }

  const results = payloads.map((row) => {
    const qid = row.harness.queryId;
    return {
      query_id: qid,
      query: queryText.get(qid) ?? "",
      // Hard-fails on any unresolvable id rather than emitting a placeholder —
      // the render-gap lesson: a context you cannot reproduce must not be graded.
      context: renderExcerpts(`${runId}/${qid}`, row.documents, (id) =>
        synth.get(synthKey(qid, id)) ?? text.get(id),
      ),
    };
  });

  writeFileSync(out, `${JSON.stringify({ run: runId, split, results }, null, 2)}\n`, "utf8");
  console.log(`wrote ${out}\n  ${results.length} contexts rendered from ${runId} (${split})`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
