/**
 * REGRESSION GUARD — the router must not silently select query-INDEPENDENTLY.
 *
 * THE DEFECT THIS PINS. `selectCandidates` ends with:
 *
 *     .filter((c) => c.score > 0 || c.entry.status === "active")
 *     .sort((a, b) => b.score - a.score)
 *     .slice(0, maxCandidates)
 *
 * When every entry scores ~0 — which is the case on BEAM, where each shard
 * carries the same four tags and a boilerplate name/description/summary — the
 * filter passes ALL active entries, the sort is a no-op between equal scores
 * (stable, so directory order survives), and the slice takes the first N in
 * DIRECTORY ORDER. `buildShardsFromCorpus` builds that order from
 * `shardIds.sort()`, so the router returns the alphabetically-first N shards
 * for every query.
 *
 * MEASURED CONSEQUENCE (2026-07-31, BEAM 1M, 45 queries):
 *   - 14 of 15 users received the IDENTICAL 8 shards for every one of their
 *     queries — e.g. `13_s0_0, 13_s0_1 … 13_s0_5, 13_s1_10, 13_s1_11`
 *     (note `s1_10` sorting before `s1_2`: pure lexicographic).
 *   - With ~50 documents per user, CSM therefore read a fixed 16% of memory
 *     regardless of the question. Any answer living outside those 8 documents
 *     was unreachable, which is exactly the shutout pattern observed against
 *     Hindsight (0 wins of 10 on knowledge_update).
 *
 * WHY IT WAS NEVER CAUGHT. At BEAM 100K a user holds ~8.5 documents against a
 * probe budget of 8, so "alphabetically first 8" is ~94% of the corpus and the
 * defect is invisible. It only bites as documents-per-user grows, which is
 * precisely the ladder's shape: tie at 100K, −0.052 at 500K, −0.169 at 1M.
 *
 * These tests characterise both halves so the behaviour can never regress
 * silently again, and so any future fix has to update this file deliberately.
 */
import { describe, expect, it } from "vitest";

import { selectCandidates } from "../src/core/router.js";
import type { MemoryDirectory, MemoryDirectoryEntry } from "../src/core/types.js";

/** A BEAM-shaped directory: uniform tags, boilerplate text, nothing to score. */
function boilerplateDirectory(n: number): MemoryDirectory {
  const entries: MemoryDirectoryEntry[] = [];
  for (let i = 0; i < n; i++) {
    const id = `u1_s${Math.floor(i / 10)}_${i}`;
    entries.push({
      id,
      name: id,
      description: `Benchmark shard ${id}`,
      tags: ["amb", "beam", "beam-turn", "conversation:1"],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      status: "active",
      snapshotId: "S001",
      tokenCountEstimate: 1000,
      contextLimitEstimate: 128_000,
      fullnessPct: 1,
      summaryShort: `Synthetic shard ${id} (40 events).`,
      knownConflicts: [],
      parentId: null,
      children: [],
      trustLevel: "imported_doc",
      staleness: "current",
    });
  }
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { version: 1, entries };
}

/** The same directory after `CSM_SHARD_DESCRIPTORS` writes real terms in. */
function enrichedDirectory(n: number, termsFor: (i: number) => string[]): MemoryDirectory {
  const dir = boilerplateDirectory(n);
  dir.entries.forEach((e, i) => {
    const terms = termsFor(i);
    e.tags = [...e.tags, ...terms];
    e.description = `Topics: ${terms.join(", ")}.`;
    e.summaryShort = e.description;
  });
  return dir;
}

const pick = (dir: MemoryDirectory, query: string): string[] =>
  selectCandidates({ query, directory: dir, maxCandidates: 8 }).map((c) => c.entry.id);

describe("router query-independence defect", () => {
  it("documents_the_defect_boilerplate_directory_ignores_the_query", () => {
    const dir = boilerplateDirectory(50);
    const a = pick(dir, "what kubernetes autoscaler settings did I choose for payments");
    const b = pick(dir, "what sourdough hydration ratio do I prefer when baking");

    // Two totally unrelated queries return the SAME shards. This is the bug.
    expect(a).toEqual(b);

    // And that selection is the alphabetically-first 8, not anything semantic.
    expect(a).toEqual(dir.entries.slice(0, 8).map((e) => e.id));

    // 42 of the user's 50 shards are unreachable for EVERY query, purely
    // because their ids sort late. Nothing about relevance is consulted.
    expect(a.length).toBe(8);
    expect(a).not.toContain("u1_s2_20");
    expect(a).not.toContain("u1_s4_49");
  });

  it("defect_is_invisible_when_the_directory_fits_in_the_probe_budget", () => {
    // BEAM 100K: ~8.5 documents per user, budget 8. "First 8" is ~everything,
    // so the same broken selection is harmless — which is why 100K measured a
    // tie while 1M collapsed.
    const dir = boilerplateDirectory(9);
    const picked = pick(dir, "anything at all");
    expect(picked.length).toBe(8);
    expect(picked.length / dir.entries.length).toBeGreaterThan(0.85);
  });

  it("real_descriptors_restore_query_dependence", () => {
    // CSM_SHARD_DESCRIPTORS writes discriminative terms into exactly the fields
    // `scoreEntryLexical` reads, so the same 50-shard directory now ranks.
    const topics = [
      ["kubernetes", "autoscaler", "payments", "cluster"],
      ["sourdough", "hydration", "baking", "starter"],
    ];
    const dir = enrichedDirectory(50, (i) =>
      i === 7 ? topics[0]! : i === 33 ? topics[1]! : ["invoice", "ledger", "reconciliation"],
    );

    const a = pick(dir, "kubernetes autoscaler settings for the payments cluster");
    const b = pick(dir, "sourdough hydration ratio for my starter when baking");

    expect(a).not.toEqual(b);
    // The shard that actually holds the topic is now ranked first.
    expect(a[0]).toBe("u1_s0_7");
    expect(b[0]).toBe("u1_s3_33");
  });

  it("scale_dose_response_more_shards_means_less_of_memory_reachable", () => {
    // The fraction of a user's memory the router can reach shrinks as the
    // directory grows, which is the ladder's shape: 100K ~94%, 1M ~16%.
    const reach = (n: number): number => pick(boilerplateDirectory(n), "q").length / n;
    expect(reach(9)).toBeGreaterThan(0.85);
    expect(reach(27)).toBeLessThan(0.35);
    expect(reach(50)).toBeLessThan(0.2);
  });
});
