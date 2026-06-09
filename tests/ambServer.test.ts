import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";

import {
  createAmbServer,
  createAmbServerState,
  getScopedCorpus,
  type AmbServerState,
} from "../scripts/amb-csm-server.js";
import type { AmbDocument } from "../scripts/amb-csm-retrieve.js";
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
});
