import type { MemoryDirectory, ShardHealth, SplitRecommendation } from "./types.js";

export const SPLIT_THRESHOLDS = [
  { upTo: 55, recommendation: "continue" as SplitRecommendation, label: "Healthy" },
  { upTo: 65, recommendation: "watch" as SplitRecommendation, label: "Watch zone" },
  { upTo: 75, recommendation: "split_candidate" as SplitRecommendation, label: "Split candidate" },
  { upTo: 85, recommendation: "freeze_recommended" as SplitRecommendation, label: "Freeze zone" },
  { upTo: 101, recommendation: "danger_zone" as SplitRecommendation, label: "Danger zone" },
];

export function recommendForFullness(fullnessPct: number): { recommendation: SplitRecommendation; label: string } {
  for (const t of SPLIT_THRESHOLDS) {
    if (fullnessPct < t.upTo) return { recommendation: t.recommendation, label: t.label };
  }
  return { recommendation: "danger_zone", label: "Danger zone" };
}

export function shardHealthReport(directory: MemoryDirectory): ShardHealth[] {
  return directory.entries.map((e) => {
    const r = recommendForFullness(e.fullnessPct);
    return {
      shardId: e.id,
      fullnessPct: e.fullnessPct,
      recommendation: r.recommendation,
      reason: `${r.label} (fullness=${e.fullnessPct.toFixed(1)}%, status=${e.status})`,
    };
  });
}
