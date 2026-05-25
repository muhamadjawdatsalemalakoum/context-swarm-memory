import { JsonlStorage } from "../storage/jsonlStorage.js";
import { createProvider, type StageModels } from "../providers/index.js";
import { ask } from "../core/ask.js";
import { FIXTURE_CASES, seedFixtures } from "./fixtures.js";

export interface EvalCaseResult {
  query: string;
  topShards: string[];
  expectTopShards: string[];
  topShardHit: boolean;
  packetSummary: string;
  packetKeywordsHit: string[];
  packetKeywordsMissed: string[];
  cost: { inputTokensEstimate: number; outputTokensEstimate: number; estimatedUsd: number; latencyMs: number };
}

export interface EvalReport {
  cases: EvalCaseResult[];
  routerRecallAt3: number;
  packetKeywordCoverage: number;
  totalCost: { inputTokensEstimate: number; outputTokensEstimate: number; estimatedUsd: number; latencyMs: number };
}

export async function runEval(rootDir?: string, models?: StageModels): Promise<EvalReport> {
  const storage = new JsonlStorage(rootDir);
  await seedFixtures(storage);
  const provider = createProvider();

  const cases: EvalCaseResult[] = [];
  let totalIn = 0, totalOut = 0, totalUsd = 0, totalLat = 0;
  let routerHits = 0, kwHits = 0, kwTotal = 0;

  for (const c of FIXTURE_CASES) {
    const r = await ask({ provider, storage, query: c.query, models });
    const top3 = r.candidates.slice(0, 3).map((c2) => c2.entry.id);
    const hit = c.expectTopShards.some((id) => top3.includes(id));
    if (hit) routerHits++;

    const packetText = [
      r.memoryPacket.summary,
      r.memoryPacket.recommendedMainContext,
      ...r.memoryPacket.keyClaims.map((k) => k.claim),
    ]
      .join(" ")
      .toLowerCase();

    const found: string[] = [];
    const missed: string[] = [];
    for (const kw of c.expectKeywordsInPacket) {
      kwTotal++;
      if (packetText.includes(kw.toLowerCase())) {
        found.push(kw);
        kwHits++;
      } else {
        missed.push(kw);
      }
    }

    totalIn += r.cost.inputTokensEstimate;
    totalOut += r.cost.outputTokensEstimate;
    totalUsd += r.cost.estimatedUsd;
    totalLat += r.cost.latencyMs;

    cases.push({
      query: c.query,
      topShards: top3,
      expectTopShards: c.expectTopShards,
      topShardHit: hit,
      packetSummary: r.memoryPacket.summary,
      packetKeywordsHit: found,
      packetKeywordsMissed: missed,
      cost: r.cost,
    });
  }

  return {
    cases,
    routerRecallAt3: cases.length === 0 ? 0 : routerHits / cases.length,
    packetKeywordCoverage: kwTotal === 0 ? 0 : kwHits / kwTotal,
    totalCost: {
      inputTokensEstimate: totalIn,
      outputTokensEstimate: totalOut,
      estimatedUsd: totalUsd,
      latencyMs: totalLat,
    },
  };
}
