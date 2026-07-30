#!/usr/bin/env tsx
/**
 * COMPONENT BENCH — the router, in isolation. RETRIEVAL SIDE, NEVER READS GOLD.
 *
 * Bench one component at a time, max it, then re-assemble: this script drives
 * ONLY candidate selection. No probe, no recall, no synthesis, no LLM calls at
 * all (the lexical leg is pure; the embedding leg is a local MiniLM with a disk
 * cache). Runs in seconds and is fully deterministic, so parameter sweeps are
 * free.
 *
 * WHAT IT MEASURES
 * The router's job is to put the shards that actually hold the answer into the
 * top `k` that get probed. This emits, per query, the union of event ids in the
 * top-k routed shards as a `payloads.jsonl` row — the same shape
 * `run-beam-slice.ts` writes — so the EXISTING gold-side scorer
 * (`scripts/score-beam-slice.ts`) grades it as gold-facet coverage with no new
 * gold-touching code. That keeps `tests/beamLeakageFirewall.test.ts` intact:
 * this file never sees a rubric.
 *
 * THE DEFECT UNDER TEST
 * `buildShardsFromCorpus` gives every BEAM shard a boilerplate descriptor —
 * name = shard id, description = "Benchmark shard <id>", summary = "Synthetic
 * shard <id> (n events).", and one identical tag union per user. Since
 * `scoreEntryLexical` scores exactly those fields, the lexical router has zero
 * query signal on BEAM and `selectCandidates` falls through to its
 * `status === "active"` passthrough. The official ladder ran this way
 * (`routerHybrid: false` on every run).
 *
 * VARIANTS
 *   descriptors  off | on    replace boilerplate with the shard's date range +
 *                            top TF-IDF terms, so the lexical leg has signal
 *   hybrid       off | on    add the MiniLM centroid leg (CSM_ROUTER_HYBRID)
 *   partition    doc | session
 *                            `doc` is today's one-shard-per-document. `session`
 *                            splits on the BEAM session spine (`->-> S,T`,
 *                            modal vote per run), which raises shards-per-user
 *                            and is the condition under which routing actually
 *                            binds.
 *
 *   npx tsx scripts/bench-router.ts --variant descriptors+hybrid --partition session
 *   npx tsx scripts/score-beam-slice.ts --run routerbench-session-descriptors+hybrid
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

import { buildCorpus } from "./amb-csm-retrieve.js";
import { buildShardsFromCorpus } from "../src/eval/baselines/csm.js";
import { selectCandidates } from "../src/core/router.js";
import { selectCandidatesHybrid, buildRouterIndex } from "../src/core/routerEmbed.js";
import { embed, EMBED_MODEL_NAME } from "../src/eval/embed.js";
import type { BenchEvent } from "../src/eval/corpus.js";
import type { MemoryDirectoryEntry } from "../src/core/types.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : fallback;
}

/** Local MiniLM, disk-cached — no API key, no network after the first warm. */
const embedFn = (texts: string[]): Promise<Float32Array[]> =>
  embed(texts, EMBED_MODEL_NAME);

// ─── Session spine (Stage 0 parser, modal vote) ─────────────────────────────

const SPINE = /->->\s*(\d+)\s*,\s*(\d+)/;

/**
 * Partition key per event. Stage 0 validated this at 100% session mapping on
 * the 100K slice (164/164 marker-bearing docs), with one session needing a
 * MODAL vote rather than first-value (92.3% majority), which is why the modal
 * pass exists.
 */
function sessionPartition(events: BenchEvent[]): Map<string, string> {
  const out = new Map<string, string>();
  const byDoc = new Map<string, BenchEvent[]>();
  for (const e of events) {
    const doc = e.shardId;
    if (!byDoc.has(doc)) byDoc.set(doc, []);
    byDoc.get(doc)!.push(e);
  }
  for (const [doc, evs] of byDoc) {
    // Collect the marker value per event, forward-filling gaps (assistant
    // turns carry no marker; ~96% of documents carry any at all).
    const raw: Array<number | null> = evs.map((e) => {
      const m = SPINE.exec(e.content ?? "");
      return m ? Number.parseInt(m[1]!, 10) : null;
    });
    let last: number | null = null;
    const filled = raw.map((v) => {
      if (v !== null) last = v;
      return last;
    });
    // Backfill the head, then modal-vote so a stray marker cannot split a
    // session (Stage 0 found session 20|s2 with 24 markers at S=3 and 2 at S=4).
    const firstSeen = filled.find((v) => v !== null) ?? 1;
    const norm = filled.map((v) => v ?? firstSeen);
    const counts = new Map<number, number>();
    for (const v of norm) counts.set(v, (counts.get(v) ?? 0) + 1);
    for (let i = 0; i < evs.length; i++) {
      out.set(evs[i]!.id, `${doc}::s${String(norm[i]).padStart(4, "0")}`);
    }
  }
  return out;
}

/**
 * Fixed-size chunk partition — the STRESS CONDITION for the router.
 *
 * At 100K a user holds ~8.5 documents and `maxProbeShards` is 8, so the router
 * selects 8 of 8.5 and its ranking cannot matter; the session spine does not
 * help either (measured: 8.5 -> 8.6 shards/user, because 170 documents map to
 * ~90 sessions, so it merges about as often as it splits).
 *
 * Chunking each document's turns into groups of `size` synthesises the regime
 * the upper ladder actually runs in — many shards per user, only 8 probed. At
 * 500K/1M the official telemetry shows probe pinned at exactly 8.0 out of a
 * much larger set; at 10M one document holds 15,083 turns. This is also the
 * rung-4 NULL MODEL for virtual sharding: if session-aware partitioning cannot
 * beat blind chunking, the session-spine story is decoration.
 */
function chunkPartition(events: BenchEvent[], size: number): Map<string, string> {
  const out = new Map<string, string>();
  const byDoc = new Map<string, BenchEvent[]>();
  for (const e of events) {
    if (!byDoc.has(e.shardId)) byDoc.set(e.shardId, []);
    byDoc.get(e.shardId)!.push(e);
  }
  for (const [doc, evs] of byDoc) {
    evs.forEach((e, i) => {
      const c = Math.floor(i / size);
      out.set(e.id, `${doc}::c${String(c).padStart(4, "0")}`);
    });
  }
  return out;
}

// ─── Descriptors: give the lexical leg something to score ───────────────────

const STOP = new Set(
  ("the a an and or of to in on for with at by from as is was were be been that this " +
    "these those it its you your i we they he she assistant user turn would could should " +
    "have has had do does did will can may not but if then so what when where how why")
    .split(" "),
);

/** Top terms by tf-idf across the sibling shards of the same user. */
function topTerms(perShard: Map<string, BenchEvent[]>, n: number): Map<string, string[]> {
  const tf = new Map<string, Map<string, number>>();
  const df = new Map<string, number>();
  for (const [id, evs] of perShard) {
    const counts = new Map<string, number>();
    for (const e of evs) {
      for (const t of String(e.content ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)) {
        if (t.length < 4 || STOP.has(t) || /^\d+$/.test(t)) continue;
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
    tf.set(id, counts);
    for (const t of counts.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = perShard.size || 1;
  const out = new Map<string, string[]>();
  for (const [id, counts] of tf) {
    const scored = [...counts.entries()]
      .map(([t, c]) => [t, c * Math.log(1 + N / (df.get(t) ?? 1))] as const)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([t]) => t);
    out.set(id, scored);
  }
  return out;
}

function firstDate(evs: BenchEvent[]): string | null {
  for (const e of evs) {
    const m = /\[([A-Z][a-z]+-\d{1,2}-\d{4})/.exec(e.content ?? "");
    if (m) return m[1]!;
  }
  return null;
}

/** Rewrite boilerplate descriptors in place with real, query-scorable content. */
function enrichDescriptors(
  entries: MemoryDirectoryEntry[],
  perShard: Map<string, BenchEvent[]>,
): void {
  const terms = topTerms(perShard, 24);
  for (const entry of entries) {
    const evs = perShard.get(entry.id) ?? [];
    const ts = terms.get(entry.id) ?? [];
    const date = firstDate(evs);
    const blurb = `${date ? `${date}. ` : ""}Topics: ${ts.slice(0, 16).join(", ")}.`;
    entry.description = blurb;
    entry.summaryShort = blurb;
    entry.name = `${entry.id} ${ts.slice(0, 6).join(" ")}`;
    // Tags are the highest-weighted lexical signal (x2 in scoreEntryLexical).
    entry.tags = [...new Set([...entry.tags, ...ts.slice(0, 12)])];
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

interface SliceDoc {
  id: string;
  content: string;
  user_id?: string | null;
  timestamp?: string | null;
}

async function main(): Promise<void> {
  const variant = arg("variant", "baseline")!; // baseline|descriptors|hybrid|descriptors+hybrid
  const partition = arg("partition", "doc")!; // doc|session
  const k = Number.parseInt(arg("k", "8")!, 10);
  const limit = Number.parseInt(arg("limit", "0")!, 10);
  const split = arg("split", "100k")!;
  const useDescriptors = variant.includes("descriptors");
  const useHybrid = variant.includes("hybrid");

  const dir = resolve(process.cwd(), "data", "eval", "corpus-beam-slice", split);
  const readMaybeGz = (base: string): unknown => {
    const gz = join(dir, `${base}.json.gz`);
    const plain = join(dir, `${base}.json`);
    if (existsSync(gz)) return JSON.parse(gunzipSync(readFileSync(gz)).toString("utf8"));
    return JSON.parse(readFileSync(plain, "utf8"));
  };
  const docs = readMaybeGz("documents") as SliceDoc[];
  // Query text and user scoping ONLY. `meta.rubric` on these rows is gold and
  // is deliberately not read here — the scorer reads it in a separate process.
  const queries = (
    readMaybeGz("queries") as Array<{ id: string; query: string; user_id?: string }>
  ).filter((q) => q.user_id);

  const runId = `routerbench-${partition}-${variant}`;
  const outDir = resolve(process.cwd(), "data", "eval", "runs", runId);
  mkdirSync(outDir, { recursive: true });

  console.log(
    `bench-router: variant=${variant} partition=${partition} k=${k} ` +
      `queries=${limit > 0 ? Math.min(limit, queries.length) : queries.length}`,
  );

  // Per-user state, built once and reused across that user's queries.
  const cache = new Map<
    string,
    {
      entries: MemoryDirectoryEntry[];
      perShard: Map<string, BenchEvent[]>;
      index: Awaited<ReturnType<typeof buildRouterIndex>> | null;
    }
  >();

  const prepare = async (userId: string) => {
    const hit = cache.get(userId);
    if (hit) return hit;
    const scoped = docs.filter((d) => String(d.user_id ?? "") === userId);
    const corpus = buildCorpus(
      scoped.map((d) => ({
        id: d.id,
        content: d.content,
        user_id: d.user_id ?? null,
        timestamp: d.timestamp ?? null,
      })) as Parameters<typeof buildCorpus>[0],
    );

    let events = [...corpus.byId.values()] as BenchEvent[];
    if (partition === "session" || partition.startsWith("chunk")) {
      const part = partition.startsWith("chunk")
        ? chunkPartition(events, Number.parseInt(partition.slice(5), 10) || 4)
        : sessionPartition(events);
      events = events.map((e) => ({ ...e, shardId: part.get(e.id) ?? e.shardId }));
      const byShard = new Map<string, BenchEvent[]>();
      for (const e of events) {
        if (!byShard.has(e.shardId)) byShard.set(e.shardId, []);
        byShard.get(e.shardId)!.push(e);
      }
      (corpus as { byShard: Map<string, BenchEvent[]> }).byShard = byShard;
      (corpus as { byId: Map<string, BenchEvent> }).byId = new Map(
        events.map((e) => [e.id, e]),
      );
    }

    const { directory } = buildShardsFromCorpus(corpus as Parameters<typeof buildShardsFromCorpus>[0]);
    const perShard = corpus.byShard as Map<string, BenchEvent[]>;
    if (useDescriptors) enrichDescriptors(directory.entries, perShard);

    let index: Awaited<ReturnType<typeof buildRouterIndex>> | null = null;
    if (useHybrid) {
      // One embedding per shard (`embedText`) — the O(shards) option the module
      // documents — rather than a mean over per-event vectors. Cheaper and it
      // is the shape a durable store would hydrate from.
      const terms = useDescriptors ? topTerms(perShard, 24) : null;
      index = await buildRouterIndex({
        shards: directory.entries.map((e) => ({
          shardId: e.id,
          terms: terms?.get(e.id) ?? [],
          embedText: (perShard.get(e.id) ?? [])
            .map((ev) => String(ev.content ?? ""))
            .join(" ")
            .slice(0, 2000),
        })),
        embed: embedFn,
        model: EMBED_MODEL_NAME,
      });
    }
    const state = { entries: directory.entries, perShard, index };
    cache.set(userId, state);
    return state;
  };

  const rows: string[] = [];
  const shardCounts: number[] = [];
  const list = limit > 0 ? queries.slice(0, limit) : queries;
  const t0 = Date.now();

  for (const q of list) {
    const st = await prepare(String(q.user_id));
    shardCounts.push(st.entries.length);
    const chosen = st.index
      ? await selectCandidatesHybrid({
          query: q.query,
          directory: { version: 1, entries: st.entries },
          index: st.index,
          maxCandidates: k,
        })
      : selectCandidates({
          query: q.query,
          directory: { version: 1, entries: st.entries },
          maxCandidates: k,
        });

    const ids: string[] = [];
    for (const c of chosen.slice(0, k)) {
      for (const e of st.perShard.get(c.entry.id) ?? []) ids.push(e.id);
    }
    rows.push(
      JSON.stringify({
        harness: {
          queryId: q.id,
          category: q.id.replace(/^\d+_/, "").replace(/_\d+$/, ""),
          userId: String(q.user_id),
          questionSha256: createHash("sha256").update(q.query).digest("hex"),
          requestedK: k,
          split,
          providerName: "none-offline",
          model: "none",
          wallMs: 0,
          timestampIso: "1970-01-01T00:00:00.000Z",
        },
        documents: ids.map((id) => ({ id, contentChars: 0 })),
        raw_response: {
          returnedEventIds: ids,
          meta: {
            routedShardIds: chosen.slice(0, k).map((c) => c.entry.id),
            shardsAvailable: st.entries.length,
            variant,
            partition,
          },
        },
      }),
    );
  }

  writeFileSync(join(outDir, "payloads.jsonl"), rows.join("\n") + "\n", "utf8");
  writeFileSync(
    join(outDir, "config.json"),
    JSON.stringify(
      {
        harness: "bench-router-v1",
        runId,
        variant,
        partition,
        k,
        split,
        meanShardsPerUser:
          shardCounts.reduce((a, b) => a + b, 0) / (shardCounts.length || 1),
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(
    `  shards/user mean ${(shardCounts.reduce((a, b) => a + b, 0) / (shardCounts.length || 1)).toFixed(1)}` +
      `  wall ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  console.log(`  wrote ${join(outDir, "payloads.jsonl")}`);
  console.log(`  score: npx tsx scripts/score-beam-slice.ts --run ${runId}`);
}

main().catch((err) => {
  console.error(`bench-router failed: ${String((err as Error).message ?? err)}`);
  process.exit(1);
});
