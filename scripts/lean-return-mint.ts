#!/usr/bin/env tsx
/**
 * LEAN-RETURN VIRTUAL-ARM MINTER — RETRIEVAL SIDE, NEVER READS GOLD.
 *
 * Mints a paired A/B for a RENDERING-ONLY lever without re-running retrieval.
 *
 * Why: probe verdicts are nondeterministic (audit F11 — identical inputs,
 * different accept counts on 10/43 queries), so re-running the pipeline per
 * rendering arm would confound a pure rendering change with retrieval variance
 * and burn LLM spend re-deriving ids that cannot legitimately change. The
 * lean transform is a deterministic function of the FROZEN returnedEventIds,
 * so both arms are minted from one source run: same ids, different rendering.
 *
 * Output per config: data/eval/runs/<srcRun>-lean-<config>/
 *   payloads.jsonl         — harness row per query; documents = capsule entries
 *                            + the lean-rendered doc ids
 *   synthesized-docs.jsonl — the TEXT of every document, keyed (queryId, id).
 *                            answer-arms resolves this file FIRST, before the
 *                            corpus, so the answer model reads exactly the
 *                            lean rendering — including for the control arm,
 *                            whose texts are written explicitly so both arms
 *                            flow through the identical resolution path.
 *   config.json            — provenance: source run + lean options.
 *
 * The capsule text is identical in every arm (reconstructed once: coverage
 * timeline lines from payload meta + the cached preference profile). An
 * approximate capsule is FAIR here because it is byte-identical across arms —
 * the comparison isolates the raw-turn rendering.
 *
 *   npx tsx scripts/lean-return-mint.ts --run r1mI-cleanvocab-v1 --split 1m \
 *     --configs control,dd-k16,dd-k12
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import type { BenchEvent } from "../src/eval/corpus.js";
import { buildCorpus, buildLeanDocs } from "./amb-csm-retrieve.js";
import { LEAN_GRID } from "./lean-return-render.js";

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
  const srcRun = arg("run");
  const split = arg("split", "1m")!;
  const wanted = (arg("configs", "control,dd-k16,dd-k12") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!srcRun) throw new Error("--run <runId> is required");
  const configs = LEAN_GRID.filter((c) => wanted.includes(c.name));
  const unknown = wanted.filter((w) => !LEAN_GRID.some((c) => c.name === w));
  if (unknown.length > 0) throw new Error(`unknown configs: ${unknown.join(", ")}`);

  const runsDir = resolve(process.cwd(), "data", "eval", "runs");
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
  const queryText = new Map<string, string>();
  for (const q of readMaybeGz(sliceDir, "queries") as Array<{ id: string; query: string }>) {
    queryText.set(q.id, q.query);
  }
  const profileByUser = new Map<string, string>();
  const profileDir = resolve(process.cwd(), "data", "eval", "preference-profiles");
  if (existsSync(profileDir)) {
    for (const f of readdirSync(profileDir)) {
      const m = new RegExp(`^${split}-u(.+?)-[0-9a-f]{16}\\.txt$`).exec(f);
      if (m) profileByUser.set(m[1]!, readFileSync(join(profileDir, f), "utf8"));
    }
  }

  const srcRows = readFileSync(join(runsDir, srcRun, "payloads.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map(
      (l) =>
        JSON.parse(l) as {
          harness: Record<string, unknown> & { queryId: string; userId: string };
          documents: Array<{ id: string }>;
          raw_response: {
            returnedEventIds?: string[];
            meta?: { coverageTimeline?: Array<{ line?: string }> };
          };
        },
    );

  for (const cfg of configs) {
    const armId = `${srcRun}-lean-${cfg.name}`;
    const armDir = join(runsDir, armId);
    mkdirSync(armDir, { recursive: true });
    const payloadLines: string[] = [];
    const synthLines: string[] = [];

    for (const row of srcRows) {
      const query = queryText.get(row.harness.queryId);
      if (!query) continue;
      const ids = row.raw_response.returnedEventIds ?? [];
      const events = ids
        .map((id) => corpus.byId.get(id))
        .filter((e): e is BenchEvent => Boolean(e));
      const rendered = buildLeanDocs(events, query, cfg.opts);

      // Capsule: byte-identical in every arm by construction — timeline lines
      // + folded preference profile, matching arm I's capsule composition.
      const timelineText = (row.raw_response.meta?.coverageTimeline ?? [])
        .map((t) => t.line ?? "")
        .filter(Boolean)
        .join("\n");
      const profile = profileByUser.get(row.harness.userId) ?? "";
      const capsuleText = [
        profile ? `User preference profile (write-time, source-derived):\n${profile}` : "",
        timelineText ? `CSM chronological evidence timeline:\n${timelineText}` : "",
      ]
        .filter(Boolean)
        .join("\n\n---\n\n");

      const documents: Array<{ id: string; contentChars: number }> = [];
      if (capsuleText) {
        documents.push({ id: "csm-evidence-capsule", contentChars: capsuleText.length });
        synthLines.push(
          JSON.stringify({
            queryId: row.harness.queryId,
            id: "csm-evidence-capsule",
            content: capsuleText,
          }),
        );
      }
      for (const d of rendered) {
        documents.push({ id: d.id, contentChars: d.content.length });
        // Every text written explicitly — both arms resolve through the synth
        // file first, so control and treatment share one resolution path.
        synthLines.push(
          JSON.stringify({ queryId: row.harness.queryId, id: d.id, content: d.content }),
        );
      }
      payloadLines.push(
        JSON.stringify({
          harness: row.harness,
          documents,
          raw_response: { minted: true, sourceRun: srcRun, leanConfig: cfg.name },
        }),
      );
    }

    writeFileSync(join(armDir, "payloads.jsonl"), payloadLines.join("\n") + "\n", "utf8");
    writeFileSync(join(armDir, "synthesized-docs.jsonl"), synthLines.join("\n") + "\n", "utf8");
    writeFileSync(
      join(armDir, "config.json"),
      JSON.stringify(
        {
          harness: "lean-return-mint-v1",
          runId: armId,
          sourceRun: srcRun,
          split,
          leanConfig: cfg.name,
          leanOptions: cfg.opts,
          note:
            "Virtual arm minted from a frozen run. Rendering-only lever; ids and " +
            "retrieval identical to sourceRun by construction (no probe variance).",
        },
        null,
        2,
      ),
      "utf8",
    );
    console.log(`minted ${armId}: ${payloadLines.length} queries`);
  }
  console.log(
    `\nnext: CSM_PROVIDER=agent-sdk npx tsx scripts/answer-arms.ts --a ${srcRun}-lean-control --b ${srcRun}-lean-<cfg> --split ${split}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`lean-return-mint failed: ${String((err as Error).message ?? err)}`);
    process.exitCode = 1;
  });
}
