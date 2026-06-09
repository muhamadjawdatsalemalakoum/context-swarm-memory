import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import {
  assembleChronicle,
  classifyQueryIntent,
  timelineFromChronicle,
} from "../src/core/coverage.js";
import { SHARD_SYSTEM_PROMPT } from "../src/core/prompts.js";
import type { MemoryEvent, MemoryShardSnapshot } from "../src/core/types.js";

/**
 * T1 coverage — the brief's must-pass offline gate, on the REAL PaySwift
 * corpus (core events; the corpus ships in-repo under CC0):
 *
 *   - q27 ("In hindsight, why was the early adoption of Bun considered a
 *     mistake by the team?") — 13 gold events across THREE shards
 *     (s-architecture, s-incidents, s-customers). The live pipeline packed
 *     2/13. The assembler must surface ≥ 10/13.
 *   - q04 ("What database technology backs the core service?") — 6 gold
 *     events; the live pipeline packed 0/6. Point-shaped (starvation class):
 *     the assembler runs as the starvation net with probe footholds and must
 *     surface ≥ 5/6.
 *
 * Snapshots are built exactly the way the benchmark baseline builds them
 * (one shard per shardId, events sorted by id, summary/tags synthesized) so
 * the result transfers to the wired pipeline.
 */

const Q27 = "In hindsight, why was the early adoption of Bun considered a mistake by the team?";
const Q27_GOLD = [
  "e0006", "e0007", "e0009", "e0063", "e0064", "e0065", "e0066",
  "e0067", "e0068", "e0069", "e0070", "e0071", "e0072",
];

const Q04 = "What database technology backs the core service?";
const Q04_GOLD = ["e0011", "e0012", "e0013", "e0014", "e0024", "e0027"];

interface RawEvent {
  id: string;
  shardId: string;
  content: string;
  isCore: boolean;
  timestamp?: string;
  tags?: string[];
}

let snapshots: MemoryShardSnapshot[] = [];

beforeAll(() => {
  const path = join(process.cwd(), "data", "eval", "corpus-synthetic", "events.jsonl");
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const byShard = new Map<string, RawEvent[]>();
  for (const line of lines) {
    if (!line || !line.includes('"isCore":true')) continue;
    const raw = JSON.parse(line) as RawEvent;
    if (!raw.isCore) continue;
    const arr = byShard.get(raw.shardId);
    if (arr) arr.push(raw);
    else byShard.set(raw.shardId, [raw]);
  }
  expect(byShard.size).toBe(8); // the 8 core PaySwift shards

  snapshots = [...byShard.keys()].sort().map((shardId) => {
    const events = (byShard.get(shardId) ?? []).sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    const memoryEvents: MemoryEvent[] = events.map((e) => ({
      eventId: e.id,
      role: "user",
      content: e.content,
      createdAt: e.timestamp ?? "2024-01-01T00:00:00.000Z",
      importance: 0.8,
      tags: e.tags ?? [],
    }));
    return {
      shardId,
      snapshotId: "S001",
      systemPrompt: SHARD_SYSTEM_PROMPT,
      summary: `Synthetic shard ${shardId} (${memoryEvents.length} events).`,
      events: memoryEvents,
      indexTerms: [],
      createdAt: "2024-01-01T00:00:00.000Z",
      parentSnapshotId: null,
    };
  });
});

describe("coverage assembler on the real PaySwift corpus", () => {
  it("q27: surfaces >= 10/13 gold events across three shards, date-ordered", () => {
    const intent = classifyQueryIntent(Q27);
    expect(intent.kind).toBe("coverage");

    const entries = assembleChronicle({
      query: Q27,
      intent,
      snapshots,
      // No footholds: the query's own terms (bun, runtime, …) must carry it.
    });

    const surfaced = new Set(entries.map((e) => e.eventId));
    const goldHit = Q27_GOLD.filter((id) => surfaced.has(id));
    expect(goldHit.length).toBeGreaterThanOrEqual(10);

    // Multi-shard: evidence must span at least two of the three gold shards.
    const goldShards = new Set(
      entries.filter((e) => Q27_GOLD.includes(e.eventId)).map((e) => e.shardId),
    );
    expect(goldShards.size).toBeGreaterThanOrEqual(2);

    // Date-ordered output.
    const dates = entries.map((e) => e.date ?? "9999-99-99");
    expect([...dates].sort()).toEqual(dates);

    // Citation discipline: every timeline ref is full shard@snapshot:event.
    for (const t of timelineFromChronicle(entries)) {
      expect(t.eventRef).toMatch(/^[^@]+@S001:e\d+$/);
    }
  });

  it("q04: starvation net with a probe foothold surfaces >= 5/6 gold events", () => {
    const intent = classifyQueryIntent(Q04);
    expect(intent.kind).toBe("point"); // starvation class, not intent class

    const entries = assembleChronicle({
      query: Q04,
      intent,
      snapshots,
      // Starvation trigger semantics: probes ran (the router found
      // s-architecture), the probe surfaced at least one foothold, recall
      // cited almost nothing. e0013 is the one gold event whose text
      // contains the query's own word "database".
      footholdEventIds: ["e0013"],
      forceSpread: true,
    });

    const surfaced = new Set(entries.map((e) => e.eventId));
    const goldHit = Q04_GOLD.filter((id) => surfaced.has(id));
    expect(goldHit.length).toBeGreaterThanOrEqual(5);
  });

  it("q04: even without footholds, self-discovered seeds recover >= 4/6", () => {
    // Two-pass self-foothold: the query term "database" finds e0013 as a
    // seed; its content (postgres/aurora/serverless) expands the term set.
    const intent = classifyQueryIntent(Q04);
    const entries = assembleChronicle({
      query: Q04,
      intent,
      snapshots,
      forceSpread: true,
    });
    const surfaced = new Set(entries.map((e) => e.eventId));
    const goldHit = Q04_GOLD.filter((id) => surfaced.has(id));
    expect(goldHit.length).toBeGreaterThanOrEqual(4);
  });
});
