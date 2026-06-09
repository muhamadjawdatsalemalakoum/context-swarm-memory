/**
 * BEAM slice loader tests — run entirely on the tiny SYNTHETIC fixture at
 * tests/fixtures/beam/ (never real BEAM rows; the real slice is gitignored).
 *
 * The alignment test at the bottom imports BOTH the retrieval-side
 * `buildCorpus` and the eval-side `buildBeamEventIndex` — tests are exempt
 * from the leakage firewall precisely so they can prove the two sides'
 * event-id schemes agree without the modules sharing code.
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import {
  BEAM_QUERY_REDACTED_FIELDS,
  categoryFromQueryId,
  loadBeamDocuments,
  loadBeamRetrievalQueries,
  selectBeamQueries,
  sha256Hex,
} from "../src/eval/corpus/beam.js";
import { buildCorpus } from "../scripts/amb-csm-retrieve.js";
import { buildBeamEventIndex } from "../src/eval/retrievalScore.js";

const FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "beam",
);

describe("beam corpus loader", () => {
  it("beam_loader_documents_roundtrip", async () => {
    const docs = await loadBeamDocuments("100k", { sliceDir: FIXTURE_DIR });
    expect(docs.length).toBe(5);
    expect(docs.map((d) => d.id)).toEqual([
      "u1_s0_0",
      "u1_s0_1",
      "u1_s1_2",
      "u2_s0_0",
      "u2_s1_0",
    ]);
    // Content must be byte-identical to the raw file (no normalization).
    const raw = JSON.parse(
      await readFile(join(FIXTURE_DIR, "100k", "documents.json"), "utf8"),
    ) as Array<{ content: string }>;
    expect(docs[0]!.content).toBe(raw[0]!.content);
    expect(docs.every((d) => d.user_id === "u1" || d.user_id === "u2")).toBe(true);
  });

  it("beam_loader_queries_redact_all_gold", async () => {
    const queries = await loadBeamRetrievalQueries("100k", {
      sliceDir: FIXTURE_DIR,
    });
    expect(queries.length).toBe(5);

    for (const q of queries) {
      // Exact allowed surface — nothing else may survive the parse.
      expect(Object.keys(q).sort()).toEqual([
        "category",
        "id",
        "question",
        "questionSha256",
        "userId",
      ]);
      const json = JSON.stringify(q).toLowerCase();
      for (const banned of [
        "gold",
        "rubric",
        "ordering_tested",
        "time_points",
        "why_unanswerable",
        "compliance",
        "calculation",
      ]) {
        expect(json.includes(banned), `leak of "${banned}" in ${q.id}`).toBe(false);
      }
    }

    const summarization = queries.find((q) => q.id === "u1_summarization_0")!;
    expect(summarization.category).toBe("summarization");
    expect(summarization.userId).toBe("u1");
    expect(summarization.questionSha256).toBe(sha256Hex(summarization.question));

    // The documented redaction list stays in sync with the raw schema.
    expect([...BEAM_QUERY_REDACTED_FIELDS]).toEqual([
      "gold_answers",
      "gold_ids",
      "meta",
    ]);
  });

  it("beam_loader_reads_gzipped_files", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "beam-gz-"));
    await mkdir(join(tmp, "100k"), { recursive: true });
    for (const base of ["documents", "queries"]) {
      const raw = await readFile(join(FIXTURE_DIR, "100k", `${base}.json`));
      await writeFile(join(tmp, "100k", `${base}.json.gz`), gzipSync(raw));
    }
    const docs = await loadBeamDocuments("100k", { sliceDir: tmp });
    const queries = await loadBeamRetrievalQueries("100k", { sliceDir: tmp });
    expect(docs.length).toBe(5);
    expect(queries.length).toBe(5);
  });

  it("beam_loader_missing_slice_actionable_error", async () => {
    await expect(
      loadBeamDocuments("500k", { sliceDir: FIXTURE_DIR }),
    ).rejects.toThrow(/fetch-beam-slice\.ts --splits 500k/);
  });

  it("beam_category_from_query_id_handles_underscores", () => {
    expect(categoryFromQueryId("12_contradiction_resolution_1")).toBe(
      "contradiction_resolution",
    );
    expect(categoryFromQueryId("u1_summarization_0")).toBe("summarization");
    expect(categoryFromQueryId("nounderscore")).toBeNull();
  });

  it("beam_select_queries_deterministic_and_grouped_by_unit", async () => {
    const queries = await loadBeamRetrievalQueries("100k", {
      sliceDir: FIXTURE_DIR,
    });

    const a = selectBeamQueries(queries, {
      categories: ["summarization", "event_ordering", "temporal_reasoning"],
      seed: 42,
    });
    const b = selectBeamQueries(queries, {
      categories: ["summarization", "event_ordering", "temporal_reasoning"],
      seed: 42,
    });
    expect(a.map((q) => q.id)).toEqual(b.map((q) => q.id));
    expect(a.length).toBe(3);

    // Grouped by unit: all u1 queries precede u2 queries.
    const unitOrder = a.map((q) => q.userId);
    expect(unitOrder).toEqual([...unitOrder].sort());

    const capped = selectBeamQueries(queries, {
      categories: ["summarization", "event_ordering"],
      perCategoryLimit: 1,
      seed: 42,
    });
    expect(capped.length).toBe(2);

    const limited = selectBeamQueries(queries, { queryLimit: 2, seed: 42 });
    expect(limited.length).toBe(2);
  });
});

describe("beam event-id alignment across the firewall", () => {
  it("beam_eval_index_ids_match_bridge_buildCorpus_ids", async () => {
    // The eval side re-implements the bridge's turn splitting without
    // importing it. Prove the id sets AND the per-id text agree exactly.
    const docs = await loadBeamDocuments("100k", { sliceDir: FIXTURE_DIR });
    const corpus = buildCorpus(docs);
    const index = buildBeamEventIndex("100k", { sliceDir: FIXTURE_DIR });

    const bridgeIds = [...corpus.byId.keys()].sort();
    const evalIds = [...index.textById.keys()].sort();
    expect(evalIds).toEqual(bridgeIds);

    for (const id of bridgeIds) {
      expect(index.textById.get(id)).toBe(corpus.byId.get(id)!.content);
    }

    // Multi-turn docs split with #turn-N ids; single-chunk docs keep the
    // bare doc id.
    expect(bridgeIds).toContain("u1_s0_0#turn-0");
    expect(bridgeIds).toContain("u1_s0_0#turn-2");
    expect(bridgeIds).toContain("u2_s0_0");
    expect(bridgeIds).toContain("u2_s1_0#turn-1");

    // Unit partitioning matches the corpus's shard/user scoping.
    const u1 = index.idsByUnit.get("u1") ?? [];
    const u2 = index.idsByUnit.get("u2") ?? [];
    expect(u1.length + u2.length).toBe(bridgeIds.length);
    expect(u1.every((id) => id.startsWith("u1_"))).toBe(true);
    expect(u2.every((id) => id.startsWith("u2_"))).toBe(true);
  });
});
