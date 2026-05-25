import { describe, expect, it } from "vitest";

import { compactEventIndex } from "../src/core/probe.js";
import type { MemoryEvent, MemoryShardSnapshot } from "../src/core/types.js";
import { SHARD_SYSTEM_PROMPT } from "../src/core/prompts.js";

/**
 * Query-aware ranking regression test.
 *
 * The failure mode from iter1c on q05 ("What did the team decide about the
 * authentication system?"): the s-architecture shard has 45 events; the
 * compact event index has a 1200-char budget. The auth events (e0017+) are
 * deep in the list. With the old id-sorted ranking the index only showed
 * e0001-e0008 (monolith / postgres decisions) and the probe correctly said
 * "no, this shard isn't about auth" — even though e0017 IS about auth.
 *
 * The fix ranks events by query relevance (tag-match weighted 2×, content
 * head 1×, with prefix-tolerance for "auth" ↔ "authentication") before
 * truncating, so the most relevant events fit in the index.
 */

function ev(eventId: string, tags: string[], content: string): MemoryEvent {
  return {
    eventId,
    role: "user",
    content,
    createdAt: "2024-01-01T00:00:00.000Z",
    importance: 0.5,
    tags,
  };
}

function snapshot(events: MemoryEvent[]): MemoryShardSnapshot {
  return {
    shardId: "s-architecture",
    snapshotId: "S001",
    systemPrompt: SHARD_SYSTEM_PROMPT,
    summary: "Synthetic shard for the probe-index ranking regression test.",
    events,
    indexTerms: [],
    createdAt: "2024-01-01T00:00:00.000Z",
    parentSnapshotId: null,
  };
}

describe("compactEventIndex — query-aware ranking", () => {
  it("orders auth-tagged events first when the query is about authentication", () => {
    // 12 events, only ones at index 8+ have the auth tag. With id-sorted
    // ordering and a 600-char budget, the first ~5 events fill the budget
    // and the auth ones never appear. With query-aware ranking the auth-
    // tagged events jump to the top.
    const events: MemoryEvent[] = [
      ev("e001", ["architecture", "monolith"], "ADR-001: monolith decision approved"),
      ev("e002", ["architecture", "postgres"], "Choose Postgres as the primary DB"),
      ev("e003", ["architecture", "monorepo"], "pnpm workspaces structure"),
      ev("e004", ["payments"], "Payment intent shape v1"),
      ev("e005", ["payments"], "Idempotency keys for refunds"),
      ev("e006", ["webhook"], "Webhook signature scheme"),
      ev("e007", ["infra"], "Terraform module for RDS"),
      ev("e008", ["infra"], "Sentry + Grafana wiring"),
      ev("e009", ["auth", "lucia"], "Auth: pick Lucia (build) over Devise (buy)"),
      ev("e010", ["auth", "lucia", "review"], "Auth design-doc review comments"),
      ev("e011", ["auth", "decision"], "ADR-003: Auth — Lucia DECIDED"),
      ev("e012", ["meta"], "Phase-1 retro notes"),
    ];
    const snap = snapshot(events);

    const idxAuth = compactEventIndex(snap, 600, "authentication system");
    // The auth events must appear in the truncated index.
    expect(idxAuth).toMatch(/\be009\b/);
    expect(idxAuth).toMatch(/\be010\b/);
    expect(idxAuth).toMatch(/\be011\b/);
    // Non-auth events that share no token with "authentication system" should
    // be the first to be truncated.
    // (We can't assert e001 is ABSENT in all cases — but the auth events
    // appearing IS the key invariant.)
  });

  it("prefix-tolerant: query 'authentication' matches tag 'auth'", () => {
    const events: MemoryEvent[] = [
      ev("e001", ["random"], "unrelated content"),
      ev("e002", ["auth"], "auth-related event with the auth tag"),
    ];
    const snap = snapshot(events);
    // Both events fit comfortably in 600 chars — the test is about ORDER.
    // The auth-tagged event must appear before the random one.
    const idx = compactEventIndex(snap, 600, "authentication");
    const posAuth = idx.indexOf("e002");
    const posRandom = idx.indexOf("e001");
    expect(posAuth).toBeGreaterThanOrEqual(0);
    expect(posRandom).toBeGreaterThanOrEqual(0);
    expect(posAuth).toBeLessThan(posRandom);
  });

  it("preserves id-sorted ordering when no query is given (backwards-compat)", () => {
    const events: MemoryEvent[] = [
      ev("e003", ["c"], "third"),
      ev("e001", ["a"], "first"),
      ev("e002", ["b"], "second"),
    ];
    const snap = snapshot(events);
    const idx = compactEventIndex(snap, 600); // no query
    // Order matches `snapshot.events` order (no re-sort).
    expect(idx.indexOf("e003")).toBeLessThan(idx.indexOf("e001"));
    expect(idx.indexOf("e001")).toBeLessThan(idx.indexOf("e002"));
  });

  it("query-aware ranking stable by id within the same score tier", () => {
    // Two events with identical score (both tagged 'auth') — alphabetical
    // event-id ordering must determine which appears first.
    const events: MemoryEvent[] = [
      ev("e002", ["auth"], "second-id auth event"),
      ev("e001", ["auth"], "first-id auth event"),
    ];
    const snap = snapshot(events);
    const idx = compactEventIndex(snap, 600, "authentication");
    expect(idx.indexOf("e001")).toBeLessThan(idx.indexOf("e002"));
  });
});
