import { describe, expect, it } from "vitest";

import { loadAllEvents, sampleFromEvents } from "../src/eval/corpus.js";
import { selectCandidates } from "../src/core/router.js";
import { selectCandidatesHybrid } from "../src/core/routerEmbed.js";
import {
  buildDirectory,
  buildIndexFromCorpus,
  goldShards,
  loadQueries,
} from "../scripts/router-recall-eval.js";

/**
 * Router recall@K regression on the REAL PaySwift corpus (100K sample, seed
 * 42) with the REAL local MiniLM embedder — the T2 acceptance gate:
 *
 *   - spec §22: "Directory routing finds the correct shard in top 3 at least
 *     85% of the time on the initial benchmark" — the hybrid router must meet
 *     it; the Phase-0 lexical router measured 0.714 here.
 *   - hybrid must be ≥ old on primary-recall@3 AND @8 (no-regression bar).
 *   - the documented starved class (q03/q04/q17 — the embedding-floor origin
 *     story in src/eval/baselines/csm.ts) must have its primary gold shard
 *     inside the hybrid top-8 so the shard actually gets probed.
 *
 * Gold (queries.json relevantEventIds → shardIds) is computed eval-side and
 * never enters routing. Embeddings are disk-cached under
 * data/eval/embeddings/; first-ever run downloads the ~80 MB MiniLM once
 * (same cost tests/ambServer.test.ts already pays), hence the long timeout.
 */
describe("router recall@K on PaySwift (hybrid vs Phase-0)", () => {
  it(
    "hybrid meets the spec §22 top-3 bar and never regresses the old router",
    { timeout: 300_000 },
    async () => {
      const allEvents = await loadAllEvents("data/eval/corpus-synthetic");
      const corpus = sampleFromEvents(allEvents, {
        targetTokens: 100_000,
        seed: 42,
      });
      const directory = buildDirectory(corpus);
      const queries = (await loadQueries()).filter(
        (q) => (q.relevantEventIds ?? []).length > 0,
      );
      const { index } = await buildIndexFromCorpus(corpus, 16);

      let oldTop3 = 0;
      let oldTop8 = 0;
      let hybTop3 = 0;
      let hybTop8 = 0;
      const starvedClassRanks: Record<string, number> = {};

      for (const q of queries) {
        const { primary } = goldShards(q, corpus);
        if (!primary) continue;
        const oldRank = selectCandidates({
          query: q.question,
          directory,
          maxCandidates: directory.entries.length,
        })
          .map((c) => c.entry.id)
          .indexOf(primary);
        const hybRank = (
          await selectCandidatesHybrid({
            query: q.question,
            directory,
            index,
            maxCandidates: directory.entries.length,
          })
        )
          .map((c) => c.entry.id)
          .indexOf(primary);

        if (oldRank > -1 && oldRank < 3) oldTop3++;
        if (oldRank > -1 && oldRank < 8) oldTop8++;
        if (hybRank > -1 && hybRank < 3) hybTop3++;
        if (hybRank > -1 && hybRank < 8) hybTop8++;
        if (q.id === "q03" || q.id === "q04" || q.id === "q17") {
          starvedClassRanks[q.id] = hybRank;
        }
      }

      const n = queries.length;
      expect(n).toBe(28); // 28 gold-bearing queries (q28/q29 are goldless)

      // Spec §22 acceptance bar.
      expect(hybTop3 / n).toBeGreaterThanOrEqual(0.85);

      // No-regression vs the Phase-0 router.
      expect(hybTop3).toBeGreaterThanOrEqual(oldTop3);
      expect(hybTop8).toBeGreaterThanOrEqual(oldTop8);

      // Starved-class queries: primary gold shard must enter the top-8 so it
      // gets probed at all (old router: q03 rank 32, q17 rank 11).
      for (const [queryId, rank] of Object.entries(starvedClassRanks)) {
        expect(rank, `${queryId} primary gold must be in hybrid top-8`).toBeGreaterThanOrEqual(0);
        expect(rank, `${queryId} primary gold must be in hybrid top-8`).toBeLessThan(8);
      }
      expect(Object.keys(starvedClassRanks).sort()).toEqual(["q03", "q04", "q17"]);
    },
  );
});
