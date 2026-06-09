import { describe, expect, it } from "vitest";

import {
  assembleChronicle,
  classifyQueryIntent,
  compareNaturally,
  computeTemporalRelation,
  countCitedEvents,
  collectTimelineEventIds,
  extractCoverageTerms,
  parseDatePhrase,
  parseEventRef,
  resolveCoverageMaxEntries,
  resolveCoverageMode,
  resolveCoverageRecallTokens,
  resolveCoverageStarvationFloor,
  scoreEventCoverage,
  temporalRelationToClaim,
  timelineFromChronicle,
  DEFAULT_COVERAGE_RECALL_TOKENS,
} from "../src/core/coverage.js";
import { estimateTokens } from "../src/core/tokenBudget.js";
import { SHARD_SYSTEM_PROMPT } from "../src/core/prompts.js";
import type { MemoryEvent, MemoryShardSnapshot } from "../src/core/types.js";

function makeSnapshot(
  shardId: string,
  events: Array<{ id: string; content: string; createdAt?: string; tags?: string[] }>,
): MemoryShardSnapshot {
  return {
    shardId,
    snapshotId: "S001",
    systemPrompt: SHARD_SYSTEM_PROMPT,
    summary: `Synthetic shard ${shardId} (${events.length} events).`,
    events: events.map(
      (e): MemoryEvent => ({
        eventId: e.id,
        role: "user",
        content: e.content,
        createdAt: e.createdAt ?? "2024-01-01T00:00:00.000Z",
        importance: 0.5,
        tags: e.tags ?? [],
      }),
    ),
    indexTerms: [],
    createdAt: "2024-01-01T00:00:00.000Z",
    parentSnapshotId: null,
  };
}

const SUMMARY_INTENT = classifyQueryIntent("Summarize everything we decided about the gateway.");
const POINT_INTENT = classifyQueryIntent("What gateway did we pick?");

describe("coverage chronicle assembler", () => {
  it("returns date-ordered, citation-complete entries", () => {
    const snapA = makeSnapshot("s-alpha", [
      { id: "a3", content: "Gateway latency fix shipped.", createdAt: "2026-03-10T10:00:00Z" },
      { id: "a1", content: "Chose the Kong gateway for routing.", createdAt: "2026-01-05T10:00:00Z" },
      { id: "a2", content: "Gateway rate limits debated at standup.", createdAt: "2026-02-15T10:00:00Z" },
    ]);
    const snapB = makeSnapshot("s-beta", [
      { id: "b1", content: "Incident: gateway returned 502s for an hour.", createdAt: "2026-02-01T10:00:00Z" },
    ]);
    const entries = assembleChronicle({
      query: "Summarize everything that happened with the gateway.",
      intent: SUMMARY_INTENT,
      snapshots: [snapA, snapB],
    });

    expect(entries.length).toBeGreaterThanOrEqual(4);
    // Chronological order.
    const dates = entries.map((e) => e.date ?? "9999-99-99");
    expect([...dates].sort()).toEqual(dates);
    // Citation completeness: every entry resolves back to an input event.
    const known = new Set(["a1", "a2", "a3", "b1"]);
    for (const e of entries) {
      expect(known.has(e.eventId)).toBe(true);
      expect(e.snapshotId).toBe("S001");
      const ref = timelineFromChronicle([e])[0]!.eventRef;
      const parsed = parseEventRef(ref);
      expect(parsed).not.toBeNull();
      expect(parsed!.eventId).toBe(e.eventId);
      expect(parsed!.shardId).toBe(e.shardId);
    }
  });

  it("respects maxEntries and the token budget", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      id: `e${String(i + 1).padStart(3, "0")}`,
      content: `Gateway event number ${i + 1} with plenty of descriptive text about routing and gateways to score on. ${"x".repeat(80)}`,
      createdAt: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T10:00:00Z`,
    }));
    const snap = makeSnapshot("s-big", many);

    const capped = assembleChronicle({
      query: "Summarize the gateway routing history.",
      intent: SUMMARY_INTENT,
      snapshots: [snap],
      maxEntries: 10,
    });
    expect(capped.length).toBeLessThanOrEqual(10);

    const tokenCapped = assembleChronicle({
      query: "Summarize the gateway routing history.",
      intent: SUMMARY_INTENT,
      snapshots: [snap],
      maxEntries: 30,
      maxTimelineTokens: 300,
    });
    const total = tokenCapped.reduce(
      (sum, e) =>
        sum + estimateTokens(`${e.date ?? "undated"} ${e.shardId}@${e.snapshotId}:${e.eventId} ${e.line}`),
      0,
    );
    expect(total).toBeLessThanOrEqual(300);
    expect(tokenCapped.length).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    const snap = makeSnapshot("s-d", [
      { id: "d1", content: "Gateway decision one.", createdAt: "2026-01-01T00:00:00Z" },
      { id: "d2", content: "Gateway decision two.", createdAt: "2026-01-02T00:00:00Z" },
      { id: "d3", content: "Unrelated lunch order.", createdAt: "2026-01-03T00:00:00Z" },
    ]);
    const args = {
      query: "Summarize the gateway decisions.",
      intent: SUMMARY_INTENT,
      snapshots: [snap],
    };
    expect(assembleChronicle(args)).toEqual(assembleChronicle(args));
  });

  it("expands terms from footholds (the q04 class), not from domain tables", () => {
    // Query says "database"; only seed1 contains it. The aurora/postgres
    // events are reachable ONLY through foothold/seed content expansion.
    const snap = makeSnapshot("s-arch", [
      { id: "n1", content: "Sprint planning notes, nothing relevant.", createdAt: "2026-02-01T00:00:00Z" },
      { id: "seed1", content: "Database call: Postgres 17 on Aurora Serverless v2.", createdAt: "2026-02-04T00:00:00Z" },
      { id: "g1", content: "Jordan pushed back on Aurora cost with numbers.", createdAt: "2026-02-05T00:00:00Z" },
      { id: "g2", content: "Postgres JSON_TABLE support sealed the choice.", createdAt: "2026-02-06T00:00:00Z" },
      { id: "n2", content: "Office plants need watering schedule.", createdAt: "2026-02-07T00:00:00Z" },
    ]);
    const entries = assembleChronicle({
      query: "What database did we pick?",
      intent: POINT_INTENT,
      snapshots: [snap],
      forceSpread: false,
    });
    const ids = entries.map((e) => e.eventId);
    expect(ids).toContain("seed1");
    expect(ids).toContain("g1"); // reachable only via expanded terms (aurora)
    expect(ids).toContain("g2"); // reachable only via expanded terms (postgres)
    expect(ids).not.toContain("n1");
    expect(ids).not.toContain("n2");
  });

  it("does not hallucinate domain vocabulary (no hardcoded tables)", () => {
    // The bridge's expandCoverageTerms would expand "security" → "redis",
    // pulling redisEvent in. The core assembler must NOT: redis appears
    // neither in the query nor in any foothold/seed content.
    const snap = makeSnapshot("s-sec", [
      { id: "s1", content: "Security review of the login flow completed.", createdAt: "2026-03-01T00:00:00Z" },
      { id: "redis1", content: "Redis cache eviction tuned for sessions.", createdAt: "2026-03-02T00:00:00Z" },
    ]);
    const entries = assembleChronicle({
      query: "What did the security review find?",
      intent: POINT_INTENT,
      snapshots: [snap],
    });
    const ids = entries.map((e) => e.eventId);
    expect(ids).toContain("s1");
    expect(ids).not.toContain("redis1");
  });

  it("spread phase gives breadth under summary intent even with sparse term hits", () => {
    const events = Array.from({ length: 24 }, (_, i) => ({
      id: `m${String(i + 1).padStart(2, "0")}`,
      content: `Month ${i + 1} status note with routine content only.`,
      createdAt: `2026-${String((i % 12) + 1).padStart(2, "0")}-01T00:00:00Z`,
    }));
    const snap = makeSnapshot("s-span", events);
    const entries = assembleChronicle({
      query: "Give me an overview of the year.",
      intent: classifyQueryIntent("Give me an overview of the year."),
      snapshots: [snap],
      maxEntries: 8,
    });
    expect(entries.length).toBe(8);
    // Breadth: first and last months are both represented.
    const months = new Set(entries.map((e) => e.date?.slice(5, 7)));
    expect(months.size).toBeGreaterThanOrEqual(6);
  });

  it("handles empty inputs", () => {
    expect(
      assembleChronicle({ query: "anything", intent: SUMMARY_INTENT, snapshots: [] }),
    ).toEqual([]);
    const empty = makeSnapshot("s-empty", []);
    expect(
      assembleChronicle({ query: "anything", intent: SUMMARY_INTENT, snapshots: [empty] }),
    ).toEqual([]);
  });
});

describe("coverage temporal arithmetic (deterministic)", () => {
  const snaps = [
    makeSnapshot("s-inc", [
      {
        id: "t1",
        content: "Incident report: the Bun crash happened on Mar 12, 2026 in the sandbox.",
        createdAt: "2026-03-12T10:00:00Z",
      },
      {
        id: "t2",
        content: "Migration complete: cutover to Node finished Mar 14, 2026.",
        createdAt: "2026-03-14T10:00:00Z",
      },
      {
        id: "t3",
        content: "Unrelated note about snacks from 2026-01-01.",
        createdAt: "2026-01-01T10:00:00Z",
      },
    ]),
  ];

  it("computes day differences from content dates with full citations", () => {
    const rel = computeTemporalRelation({
      query: "How many days passed between when the Bun crash happened and when the migration finished?",
      snapshots: snaps,
    });
    expect(rel).not.toBeNull();
    expect(rel!.days).toBe(2);
    expect(rel!.fromRef).toBe("s-inc@S001:t1");
    expect(rel!.toRef).toBe("s-inc@S001:t2");
    expect(rel!.claim).toContain("= 2 days");
    const claim = temporalRelationToClaim(rel!);
    expect(claim.sources).toEqual(["s-inc@S001:t1", "s-inc@S001:t2"]);
    expect(claim.confidence).toBeLessThan(1);
  });

  it("returns null when fewer than two distinct dates exist", () => {
    const single = [
      makeSnapshot("s-one", [
        { id: "o1", content: "Only event, no content date.", createdAt: "2026-05-05T00:00:00Z" },
      ]),
    ];
    expect(computeTemporalRelation({ query: "How many days between things?", snapshots: single })).toBeNull();
  });

  it("parses both ISO and prose month dates", () => {
    expect(parseDatePhrase("2026-03-12")).toBe(Date.UTC(2026, 2, 12));
    expect(parseDatePhrase("Mar 12, 2026")).toBe(Date.UTC(2026, 2, 12));
    expect(parseDatePhrase("March 12 2026")).toBe(Date.UTC(2026, 2, 12));
    expect(Number.isNaN(parseDatePhrase("not a date"))).toBe(true);
  });
});

describe("coverage helpers", () => {
  it("extractCoverageTerms keeps proper nouns, drops stopwords AND intent-shape words", () => {
    const terms = extractCoverageTerms("Why was the early adoption of Bun considered a mistake?");
    expect(terms).toContain("bun"); // short but capitalized in source
    expect(terms).toContain("adoption");
    // "mistake"/"considered" are the intent classifier's own cue vocabulary
    // (query SHAPE, not topic) — they must NOT survive as topic terms, or
    // they steer retrieval toward retro/postmortem meta-content.
    expect(terms).not.toContain("mistake");
    expect(terms).not.toContain("considered");
    expect(terms).not.toContain("the");
    expect(terms).not.toContain("was");
  });

  it("scoreEventCoverage counts whole-word hits, long terms double", () => {
    expect(scoreEventCoverage("the postgres database", ["postgres"])).toBe(2);
    expect(scoreEventCoverage("the postgres database", ["bun"])).toBe(0);
    expect(scoreEventCoverage("bun crashed", ["bun"])).toBe(1);
    // substring is not a whole word
    expect(scoreEventCoverage("bunting flags", ["bun"])).toBe(0);
  });

  it("compareNaturally sorts numeric segments numerically", () => {
    expect(compareNaturally("doc#turn-2", "doc#turn-10")).toBeLessThan(0);
    expect(compareNaturally("e0063", "e0064")).toBeLessThan(0);
    expect(compareNaturally("a", "a")).toBe(0);
  });

  it("parseEventRef handles event IDs containing colons", () => {
    expect(parseEventRef("shard@S001:evt:with:colons")).toEqual({
      shardId: "shard",
      snapshotId: "S001",
      eventId: "evt:with:colons",
    });
    expect(parseEventRef("no-at-sign")).toBeNull();
    expect(parseEventRef("shard@S001:")).toBeNull();
  });

  it("countCitedEvents and collectTimelineEventIds parse packet citations", () => {
    const packet = {
      query: "q",
      summary: "s",
      keyClaims: [
        { claim: "c1", sources: ["s-a@S001:e1", "s-a@S001:e2"], confidence: 0.9 },
        { claim: "c2", sources: ["s-b@S001:e2", "s-b@S001"], confidence: 0.8 },
      ],
      caveats: [],
      conflicts: [],
      recommendedMainContext: "x",
      timeline: [
        { date: "2026-01-01", eventRef: "s-a@S001:e9", line: "l1" },
        { date: null, eventRef: "s-a@S001:e9", line: "dupe" },
        { date: null, eventRef: "bad-ref", line: "ignored" },
      ],
    };
    expect(countCitedEvents(packet)).toBe(2); // e1, e2 (shard-only source ignored)
    expect(collectTimelineEventIds(packet)).toEqual(["e9"]);
  });
});

describe("coverage budgets & flags", () => {
  const coverage = classifyQueryIntent("Summarize the incidents in chronological order.");
  const ordering = classifyQueryIntent("Which came first, the leak or the storm?");
  const point = classifyQueryIntent("What database did we pick?");

  it("coverage mode defaults off and parses truthy values", () => {
    expect(resolveCoverageMode(undefined)).toBe(false);
    expect(resolveCoverageMode("")).toBe(false);
    expect(resolveCoverageMode("0")).toBe(false);
    expect(resolveCoverageMode("1")).toBe(true);
    expect(resolveCoverageMode("true")).toBe(true);
    expect(resolveCoverageMode("yes")).toBe(true);
  });

  it("recall budget is intent-conditional: point stays at base", () => {
    expect(resolveCoverageRecallTokens(point, 1200, undefined)).toBe(1200);
    expect(resolveCoverageRecallTokens(coverage, 1200, undefined)).toBe(
      DEFAULT_COVERAGE_RECALL_TOKENS,
    );
    expect(resolveCoverageRecallTokens(coverage, 1200, "2400")).toBe(2400);
    expect(resolveCoverageRecallTokens(coverage, 1200, "garbage")).toBe(
      DEFAULT_COVERAGE_RECALL_TOKENS,
    );
  });

  it("coverage recall budget leaves headroom inside the 8192 AMB context cap", () => {
    // system prompt + shard header + digest + recall prompt must fit with
    // comfortable headroom. ~700 covers prompt scaffolding measured from
    // prompts.ts; 8192 is CSM_AMB_MODEL_CONTEXT in the BEAM runs.
    const scaffolding = 700;
    expect(DEFAULT_COVERAGE_RECALL_TOKENS + scaffolding).toBeLessThan(8192 / 2);
  });

  it("max entries: 32 for ordering/temporal, 24 otherwise", () => {
    expect(resolveCoverageMaxEntries(ordering, undefined)).toBe(32);
    expect(resolveCoverageMaxEntries(coverage, undefined)).toBe(32); // ordering facet present
    expect(
      resolveCoverageMaxEntries(classifyQueryIntent("Summarize everything."), undefined),
    ).toBe(24);
    expect(resolveCoverageMaxEntries(point, "12")).toBe(12);
  });

  it("starvation floor defaults to 4, 0 disables", () => {
    expect(resolveCoverageStarvationFloor(undefined)).toBe(4);
    expect(resolveCoverageStarvationFloor("0")).toBe(0);
    expect(resolveCoverageStarvationFloor("7")).toBe(7);
    expect(resolveCoverageStarvationFloor("nope")).toBe(4);
  });
});
