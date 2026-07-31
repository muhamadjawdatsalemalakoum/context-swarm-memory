#!/usr/bin/env tsx
/**
 * LEAN-RETURN SWEEP, RENDER STEP — RETRIEVAL SIDE, NEVER READS GOLD.
 *
 * Replays a frozen run's returned event ids through `buildLeanDocs` (the SAME
 * function the production bridge uses — what is measured is what ships) for a
 * grid of lean-return configs, and writes the RENDERED TEXTS per (query,
 * config) to `<run>/lean-render.jsonl`.
 *
 * The texts — not the ids — are what the gold-side scorer must score:
 * excerpting changes the text a facet must be found in, so an id-based proxy
 * would silently score the full turn and overstate excerpt configs.
 *
 * Gold never enters this process. The sibling `scripts/lean-return-score.ts`
 * reads gold but cannot reach the bridge — the same one-way, file-mediated
 * split as answer-arms/judge-arms.
 *
 *   npx tsx scripts/lean-return-render.ts --run <runId> --split 1m
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import type { BenchEvent } from "../src/eval/corpus.js";
import {
  buildCorpus,
  buildLeanDocs,
  type LeanReturnOptions,
} from "./amb-csm-retrieve.js";

/** The sweep grid. Control MUST be first — the scorer pairs everything to it.
 *  profileDedupe is on for every non-control config: the profile preamble is
 *  22.6% of the payload and duplicating it 24× is never the right rendering. */
export const LEAN_GRID: ReadonlyArray<{ name: string; opts: LeanReturnOptions }> = [
  { name: "control", opts: { k: 0, excerptChars: 0, profileDedupe: false } },
  { name: "dd", opts: { k: 0, excerptChars: 0, profileDedupe: true } },
  { name: "dd-k16", opts: { k: 16, excerptChars: 0, profileDedupe: true } },
  { name: "dd-k12", opts: { k: 12, excerptChars: 0, profileDedupe: true } },
  { name: "dd-k8", opts: { k: 8, excerptChars: 0, profileDedupe: true } },
  { name: "dd-ex360", opts: { k: 0, excerptChars: 360, profileDedupe: true } },
  { name: "dd-k12-ex360", opts: { k: 12, excerptChars: 360, profileDedupe: true } },
];

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : fallback;
}

function readMaybeGz(dir: string, base: string): unknown {
  const gz = join(dir, `${base}.json.gz`);
  if (existsSync(gz)) return JSON.parse(gunzipSync(readFileSync(gz)).toString("utf8"));
  return JSON.parse(readFileSync(join(dir, `${base}.json`), "utf8"));
}

async function main(): Promise<void> {
  const runId = arg("run");
  const split = arg("split", "1m")!;
  if (!runId) throw new Error("--run <runId> is required");

  const runDir = resolve(process.cwd(), "data", "eval", "runs", runId);
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
  // Query TEXT only — `meta.rubric` on these rows is GOLD and is deliberately
  // not read here. The scorer process reads it instead.
  const queryText = new Map<string, string>();
  for (const q of readMaybeGz(sliceDir, "queries") as Array<{ id: string; query: string }>) {
    queryText.set(q.id, q.query);
  }

  // The CAPSULE is constant across lean configs (the transform touches raw
  // turns only), but it must still be IN every config's text set: it carries
  // the distilled coverage that makes cutting raw turns viable at all — 93.4%
  // of its snippets overlap the returned turns on the official artifact.
  // Scoring configs without it would charge every cut for facets the capsule
  // still covers. Reconstruction, in fidelity order:
  //   1. `<run>/synthesized-docs.jsonl` when the run wrote it (exact text);
  //   2. else the coverage-timeline LINE TEXTS from payload meta (the capsule
  //      renders exactly these) plus the disk-cached preference profile the
  //      arm folded in. Legacy-path snippet excerpts are approximated by the
  //      turns themselves, which they overlap almost entirely.
  const synthDocs = new Map<string, string[]>();
  const synthPath = join(runDir, "synthesized-docs.jsonl");
  if (existsSync(synthPath)) {
    for (const line of readFileSync(synthPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as { queryId: string; content: string };
      const list = synthDocs.get(r.queryId) ?? [];
      list.push(r.content);
      synthDocs.set(r.queryId, list);
    }
  }
  const profileByUser = new Map<string, string>();
  const profileDir = resolve(process.cwd(), "data", "eval", "preference-profiles");
  if (existsSync(profileDir)) {
    for (const f of readdirSync(profileDir)) {
      const m = new RegExp(`^${split}-u(.+?)-[0-9a-f]{16}\\.txt$`).exec(f);
      if (m) profileByUser.set(m[1]!, readFileSync(join(profileDir, f), "utf8"));
    }
  }

  const lines: string[] = [];
  let rows = 0;
  let exactCapsules = 0;
  let reconstructed = 0;
  for (const line of readFileSync(join(runDir, "payloads.jsonl"), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as {
      harness: { queryId: string; userId: string };
      raw_response: {
        returnedEventIds?: string[];
        meta?: { coverageTimeline?: Array<{ line?: string }> };
      };
    };
    const query = queryText.get(row.harness.queryId);
    if (!query) continue;
    const ids = row.raw_response.returnedEventIds ?? [];
    const events = ids
      .map((id) => corpus.byId.get(id))
      .filter((e): e is BenchEvent => Boolean(e));

    let constantTexts = synthDocs.get(row.harness.queryId);
    if (constantTexts && constantTexts.length > 0) {
      exactCapsules++;
    } else {
      constantTexts = [];
      const timeline = row.raw_response.meta?.coverageTimeline ?? [];
      const timelineText = timeline
        .map((t) => t.line ?? "")
        .filter(Boolean)
        .join("\n");
      if (timelineText) constantTexts.push(timelineText);
      const profile = profileByUser.get(row.harness.userId);
      if (profile) constantTexts.push(profile);
      if (constantTexts.length > 0) reconstructed++;
    }

    rows++;
    for (const cfg of LEAN_GRID) {
      const rendered = buildLeanDocs(events, query, cfg.opts);
      lines.push(
        JSON.stringify({
          queryId: row.harness.queryId,
          config: cfg.name,
          docCount: rendered.length,
          // chars counts the VARIABLE part only — the capsule is identical in
          // every config, so including it would just flatten the ±chars column.
          chars: rendered.reduce((n, d) => n + d.content.length, 0),
          texts: [...constantTexts, ...rendered.map((d) => d.content)],
        }),
      );
    }
  }

  const outPath = join(runDir, "lean-render.jsonl");
  writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
  console.log(
    `rendered ${rows} queries x ${LEAN_GRID.length} configs -> ${outPath}` +
      ` (capsule text: ${exactCapsules} exact from synthesized-docs.jsonl, ` +
      `${reconstructed} reconstructed from timeline meta + cached profiles)`,
  );
  console.log(`next: npx tsx scripts/lean-return-score.ts --run ${runId} --split ${split}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`lean-return-render failed: ${String((err as Error).message ?? err)}`);
    process.exitCode = 1;
  });
}
