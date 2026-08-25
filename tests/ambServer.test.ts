import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAmbServer,
  createAmbServerState,
  getScopedCorpus,
  type AmbServerState,
} from "../scripts/amb-csm-server.js";
import {
  aggregationQueryIntent,
  type AmbDocument,
  observationQueryIntent,
} from "../scripts/amb-csm-retrieve.js";
import { preferenceProfileCachePath } from "../scripts/amb-preference-profile.js";
import { factRegistryCachePath } from "../scripts/amb-fact-registry.js";
import { resolveProviderModel } from "../src/providers/LlmProvider.js";
import { MockProvider } from "../src/providers/MockProvider.js";

const DOCS: AmbDocument[] = [
  {
    id: "conv-01",
    content:
      "[Mar-03-2026 | Turn 1] User: We chose PBKDF2 with SHA256 for password hashing.\n[Mar-03-2026 | Turn 2] Assistant: Iterations set to 600k.",
    user_id: "u1",
    timestamp: "2026-03-03T10:00:00Z",
    context: "security",
  },
  {
    id: "conv-02",
    content:
      "[Mar-10-2026 | Turn 1] User: Database is SQLite for MVP, Postgres later.\n[Mar-10-2026 | Turn 2] Assistant: Noted.",
    user_id: "u2",
    timestamp: "2026-03-10T09:00:00Z",
    context: "database",
  },
];

describe("amb-csm-server", () => {
  let state: AmbServerState;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    state = createAmbServerState(new MockProvider());
    server = createAmbServer(state);
    await new Promise<void>((resolve) =>
      server.listen({ host: "127.0.0.1", port: 0 }, () => resolve()),
    );
    const address = server.address();
    if (typeof address !== "object" || !address) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("amb_server_health", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.llm_provider).toBe("mock");
    expect(body.documents).toBe(0);
  });

  it("amb_server_ingest_retrieve_scoped", async () => {
    const ingest = await fetch(`${base}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documents: DOCS }),
    });
    expect(ingest.status).toBe(200);
    expect(((await ingest.json()) as { total: number }).total).toBe(2);

    const res = await fetch(`${base}/retrieve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "What password hashing algorithm did we choose?",
        k: 5,
        user_id: "u1",
      }),
    });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      documents: Array<{ id: string }>;
      raw_response: Record<string, unknown>;
    };
    expect(payload.raw_response.mode).toBe("retrieve-only");
    expect(payload.raw_response.llm_provider).toBe("mock");
    // u1 scope: only conv-01 events are visible.
    expect(payload.documents.length).toBeGreaterThan(0);
    for (const doc of payload.documents) {
      if (doc.id === "csm-evidence-capsule") continue;
      expect(doc.id.startsWith("conv-01")).toBe(true);
    }
  });

  it("amb_server_corpus_cache_reuse_and_invalidation", async () => {
    const before = getScopedCorpus(state, "u1");
    const again = getScopedCorpus(state, "u1");
    expect(again).toBe(before); // same version → same object

    const ingest = await fetch(`${base}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        documents: [
          {
            id: "conv-03",
            content: "[Apr-01-2026 | Turn 1] User: Lockout is 15 minutes after 5 failures.",
            user_id: "u1",
          },
        ],
      }),
    });
    expect(ingest.status).toBe(200);

    const after = getScopedCorpus(state, "u1");
    expect(after).not.toBe(before); // version bump → rebuilt
    expect(after?.byId.has("conv-03")).toBe(true);
  });

  it("amb_server_retrieve_unknown_user_returns_empty", async () => {
    const res = await fetch(`${base}/retrieve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "anything", user_id: "nope" }),
    });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      documents: unknown[];
      raw_response: { reason?: string };
    };
    expect(payload.documents.length).toBe(0);
    expect(payload.raw_response.reason).toBe("no_documents_in_scope");
  });

  it("amb_server_reset_clears_state", async () => {
    const res = await fetch(`${base}/reset`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(state.documents.length).toBe(0);
    expect(state.corpusCache.size).toBe(0);

    const retrieve = await fetch(`${base}/retrieve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "anything", user_id: "u1" }),
    });
    const payload = (await retrieve.json()) as { raw_response: { reason?: string } };
    expect(payload.raw_response.reason).toBe("no_documents_in_scope");
  });

  // The two gate tests below pin the BENCHMARK-VALIDATED (fitted) contract,
  // which since the P2 split lives behind CSM_AMB_LEGACY_INTENT=1: the
  // ordering/timeline phrase list and the two measured-leak guards were grown
  // against individual BEAM queries. They stay exactly as measured because
  // that knowledge is expensive and any legacy-ON arm still depends on it;
  // the DEFAULT (plain-language) path is pinned separately in
  // tests/ambIntent.test.ts.
  it("observation_gate_fires_on_both_coverage_loss_categories", () => {
    process.env.CSM_AMB_LEGACY_INTENT = "1";
    // Summarization category (retrospective-summary requests) fire.
    for (const q of [
      "Can you give me a summary of how my work with Robert developed over time?",
      "Summarize my major progress between April and May 2024.",
      "Can you summarize how I approached the issues with my web project?",
      "Give me a recap of our conversations.",
      "Provide an overview of how my plans have progressed.",
    ]) {
      expect(observationQueryIntent(q)).toBe(true);
    }
    // Event_ordering category fires — including the 500k/1m phrasings the
    // original phrase list missed ("progress in order", "reconstruct the
    // timeline"; 2026-06-24 all-tier audit).
    for (const q of [
      "Can you walk me through the order in which I brought up different ways my family supported me?",
      "Can you list the order in which I brought up different aspects of improving my resume?",
      "Can you list in order how I brought up different aspects of my research projects?",
      "Can you walk me through my progress in order? Mention ONLY and ONLY six items.",
      "Can you help me reconstruct the timeline of my project decisions?",
    ]) {
      expect(observationQueryIntent(q)).toBe(true);
    }
    // Must NOT fire — every measured leak across all four tiers:
    // - the 100k broadSummary leaks (multi_session COUNT + preference advice),
    // - the 1m leak (summary as a NOUN MODIFIER: "summary generation time",
    //   "summary quality" — a how-to question about a summarization model),
    // - the 10m leak (overview as a document name: "design overview document"
    //   — an abstention query, the worst category to leak into),
    // - the "in order to" purpose idiom and a plain temporal question.
    for (const q of [
      "How many different book series or genres have I mentioned wanting to explore across my conversations?",
      "How many specific assets have I mentioned across my conversations that are part of my estate planning?",
      "I'm preparing materials to support my patent application. What types of content should I include to make it clear and comprehensive?",
      "Considering my different implementations and tests with Pegasus-large, how can I best reduce summary generation time while maintaining or improving summary quality, based on my code and performance details?",
      "Could you provide the detailed content or key sections of the design overview document I shared with my team about modularity benefits?",
      "What should I do in order to improve my resume before the deadline?",
      "When did I first mention the lockout policy?",
    ]) {
      expect(observationQueryIntent(q)).toBe(false);
    }
    delete process.env.CSM_AMB_LEGACY_INTENT;
  });

  it("aggregation_gate_fires_on_multi_session_totals_only", () => {
    process.env.CSM_AMB_LEGACY_INTENT = "1";
    // Measured multi_session aggregation phrasings (the fact-registry target).
    for (const q of [
      "How many documents am I planning to handle in total when combining my Elasticsearch and Solr projects?",
      "How many queries per second am I aiming to support across sharding, load balancing, and partitioning efforts combined?",
      "How much total delay have I noted across the agent updates, pedestrian updates, and camera data sync issues?",
    ]) {
      expect(aggregationQueryIntent(q)).toBe(true);
    }
    // ACCEPTED MISS: widening the gate to catch this phrasing ("how many
    // different [>40 chars] mention across my sessions") was measured to leak
    // onto event_ordering + temporal_reasoning at 500k — winner categories.
    // Zero-leak precision beats +1 recall; the gate stays narrow.
    expect(
      aggregationQueryIntent(
        "How many different error types related to sensor data debugging did I mention across my sessions?",
      ),
    ).toBe(false);
    // Winner-category shapes must NOT fire: info_extraction point lookups,
    // knowledge_update current-value questions (deliberately not gated — no
    // safe lexical gate exists), summarization, plain temporal questions, and
    // the two leaks MEASURED at 500k (an event_ordering query embedding
    // "mention 8 items in total" as an output-format instruction, and a
    // temporal_reasoning duration-arithmetic "how much total time did I spend").
    for (const q of [
      "What event processing capacity does my log tool support per minute without downtime?",
      "How many tasks have I logged in Jira for the sprint on 2024-11-05, and what is my sprint completion target percentage?",
      "Can you give me a summary of how my work with Robert developed over time?",
      "What database did I choose for the MVP?",
      "When did I first mention the lockout policy?",
      "Can you list the order in which I brought up different aspects of improving and securing my Flask API throughout our conversations in order (mention 8 items in total)?",
      "How much total time did I spend practicing derivatives across the sessions where I worked through both equations, considering I initially spent 3 hours over 2 days on the basics?",
    ]) {
      expect(aggregationQueryIntent(q)).toBe(false);
    }
    delete process.env.CSM_AMB_LEGACY_INTENT;
  });

  it("amb_server_rejects_bad_requests", async () => {
    const badJson = await fetch(`${base}/retrieve`, {
      method: "POST",
      body: "{not json",
    });
    expect(badJson.status).toBe(400);

    const noQuery = await fetch(`${base}/retrieve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: "u1" }),
    });
    expect(noQuery.status).toBe(400);

    const unknownRoute = await fetch(`${base}/nope`, { method: "POST", body: "{}" });
    expect(unknownRoute.status).toBe(404);
  });

  it("amb_server_passes_preference_profile_when_flag_on_and_omits_when_off", async () => {
    const prevFlag = process.env.CSM_AMB_PREFERENCE_PROFILE;
    const prevCacheDir = process.env.CSM_AMB_PREF_CACHE_DIR;
    const cacheDir = mkdtempSync(join(tmpdir(), "csm-pref-test-"));
    const profileText = "PREF | language | Use TypeScript for all examples | turn-1";
    const spy = vi
      .spyOn(state.baseline, "organizePreferencesScaled")
      .mockResolvedValue({
        text: profileText,
        inputTokens: 10,
        outputTokens: 5,
        latencyMs: 1,
        chunks: 1,
      });
    try {
      process.env.CSM_AMB_PREFERENCE_PROFILE = "1";
      process.env.CSM_AMB_PREF_CACHE_DIR = cacheDir;

      // Ingest ONE unit (u1 only): /ingest fire-and-forget pre-warms the
      // profile build for exactly the ingested scopes, and the retrieve right
      // behind it must JOIN that in-flight build (single-flight), not start a
      // second one.
      const ingest = await fetch(`${base}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documents: [DOCS[0]] }),
      });
      expect(ingest.status).toBe(200);

      const retrieveOnce = () =>
        fetch(`${base}/retrieve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: "What password hashing algorithm did we choose?",
            k: 5,
            user_id: "u1",
          }),
        });

      const on = await retrieveOnce();
      expect(on.status).toBe(200);
      const onPayload = (await on.json()) as {
        documents: Array<{ id: string; content: string }>;
      };
      // The profile rides in exactly ONE returned document (folded into the
      // capsule when one exists, its own document otherwise), under the
      // standing-preferences header.
      const carriers = onPayload.documents.filter((d) =>
        d.content.includes(profileText),
      );
      expect(carriers.length).toBe(1);
      expect(carriers[0]!.content).toContain(
        "STANDING PREFERENCES AND INSTRUCTIONS FROM THIS USER",
      );
      // Pre-warm build + joined query = exactly one build.
      expect(spy).toHaveBeenCalledTimes(1);

      // Second retrieve: in-RAM memoized per (user, scope version) — no rebuild.
      const again = await retrieveOnce();
      expect(again.status).toBe(200);
      const againPayload = (await again.json()) as {
        documents: Array<{ id: string; content: string }>;
      };
      expect(
        againPayload.documents.filter((d) => d.content.includes(profileText)).length,
      ).toBe(1);
      expect(spy).toHaveBeenCalledTimes(1);

      // The disk-cache entry uses the slice-compatible key scheme: the file the
      // server wrote is the exact path the shared helper derives from the same
      // (split, unit, write-time model) inputs the slice harness would use.
      const files = readdirSync(cacheDir);
      expect(files.length).toBe(1);
      const expectedPath = preferenceProfileCachePath({
        split: "amb", // CSM_AMB_SPLIT unset → server default namespace
        userId: "u1",
        model: resolveProviderModel("mock"),
      });
      expect(join(cacheDir, files[0]!)).toBe(expectedPath);

      // Flag OFF: byte-identical to baseline — no profile text, no header,
      // and no further build.
      delete process.env.CSM_AMB_PREFERENCE_PROFILE;
      const off = await retrieveOnce();
      expect(off.status).toBe(200);
      const offPayload = (await off.json()) as {
        documents: Array<{ id: string; content: string }>;
      };
      expect(offPayload.documents.length).toBeGreaterThan(0);
      for (const doc of offPayload.documents) {
        expect(doc.content.includes(profileText)).toBe(false);
        expect(doc.content.includes("STANDING PREFERENCES")).toBe(false);
      }
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
      if (prevFlag === undefined) delete process.env.CSM_AMB_PREFERENCE_PROFILE;
      else process.env.CSM_AMB_PREFERENCE_PROFILE = prevFlag;
      if (prevCacheDir === undefined) delete process.env.CSM_AMB_PREF_CACHE_DIR;
      else process.env.CSM_AMB_PREF_CACHE_DIR = prevCacheDir;
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("amb_server_folds_fact_registry_when_flag_on_and_omits_when_explicitly_off", async () => {
    // THE test whose absence let this gap exist: the fold (default ON,
    // certified knowledge_update lever) was wired on the slice harness while
    // the official AMB server path only passed the registry under the legacy
    // aggregation-intent gate — the same silently-missing-lever class the
    // preference profile once had. Mirrors the profile test above.
    const prevFlag = process.env.CSM_AMB_FACT_FOLD;
    const prevCacheDir = process.env.CSM_AMB_FACT_CACHE_DIR;
    const cacheDir = mkdtempSync(join(tmpdir(), "csm-fact-test-"));
    const registryText = "typing speed | 75 wpm -> 78 wpm; LATEST: 78 wpm";
    const spy = vi
      .spyOn(state.baseline, "organizeFactsScaled")
      .mockResolvedValue({
        text: registryText,
        inputTokens: 10,
        outputTokens: 5,
        latencyMs: 1,
        chunks: 1,
      });
    try {
      process.env.CSM_AMB_FACT_FOLD = "1";
      process.env.CSM_AMB_FACT_CACHE_DIR = cacheDir;

      const ingest = await fetch(`${base}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documents: [DOCS[0]] }),
      });
      expect(ingest.status).toBe(200);

      const retrieveOnce = () =>
        fetch(`${base}/retrieve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: "What password hashing algorithm did we choose?",
            k: 5,
            user_id: "u1",
          }),
        });

      const on = await retrieveOnce();
      expect(on.status).toBe(200);
      const onPayload = (await on.json()) as {
        documents: Array<{ id: string; content: string }>;
      };
      // The registry rides in exactly ONE returned document under the
      // commitment-licensing header.
      const carriers = onPayload.documents.filter((d) =>
        d.content.includes(registryText),
      );
      expect(carriers.length).toBe(1);
      expect(carriers[0]!.content).toContain("CURRENT VALUES");
      // Pre-warm build + joined query = exactly one build.
      expect(spy).toHaveBeenCalledTimes(1);

      // Memoized per (user, scope version): no rebuild on a second retrieve.
      const again = await retrieveOnce();
      expect(again.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);

      // Disk cache uses the slice-compatible key scheme.
      const files = readdirSync(cacheDir);
      expect(files.length).toBe(1);
      const expectedPath = factRegistryCachePath({
        split: "amb",
        userId: "u1",
        model: resolveProviderModel("mock"),
      });
      expect(join(cacheDir, files[0]!)).toBe(expectedPath);

      // EXPLICIT off (the default is ON): no registry text, no header.
      process.env.CSM_AMB_FACT_FOLD = "0";
      const off = await retrieveOnce();
      expect(off.status).toBe(200);
      const offPayload = (await off.json()) as {
        documents: Array<{ id: string; content: string }>;
      };
      expect(offPayload.documents.length).toBeGreaterThan(0);
      for (const doc of offPayload.documents) {
        expect(doc.content.includes(registryText)).toBe(false);
        expect(doc.content.includes("CURRENT VALUES")).toBe(false);
      }
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
      if (prevFlag === undefined) delete process.env.CSM_AMB_FACT_FOLD;
      else process.env.CSM_AMB_FACT_FOLD = prevFlag;
      if (prevCacheDir === undefined) delete process.env.CSM_AMB_FACT_CACHE_DIR;
      else process.env.CSM_AMB_FACT_CACHE_DIR = prevCacheDir;
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
