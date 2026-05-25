import type { JsonlStorage } from "../storage/jsonlStorage.js";
import { createShard, appendEventAndSnapshot } from "../core/commit.js";
import { SHARD_SYSTEM_PROMPT } from "../core/prompts.js";

export interface EvalCase {
  query: string;
  expectTopShards: string[];
  expectKeywordsInPacket: string[];
}

export const FIXTURE_SHARDS: Array<{
  id: string;
  name: string;
  description: string;
  tags: string[];
  summary: string;
  events: { content: string; tags?: string[] }[];
}> = [
  {
    id: "thalm-architecture-001",
    name: "Thalm architecture memory 001",
    description:
      "Early architecture discussions for Thalm: voice, canvas, OpenClaw, NOET shell, model routing.",
    tags: ["thalm", "voice", "canvas", "openclaw", "noet", "architecture"],
    summary:
      "Thalm is an AI-native working environment centered on voice, canvas, model routing, and long-lived project memory.",
    events: [
      {
        content:
          "User said OpenClaw may act as Thalm's shell/control plane, not as the renderer itself.",
        tags: ["thalm", "openclaw", "shell"],
      },
      {
        content:
          "Decision: NOET is the voice/canvas surface; OpenClaw is the orchestration layer underneath.",
        tags: ["noet", "openclaw", "architecture"],
      },
      {
        content:
          "Caveat: This was exploratory, not locked as final architecture. Re-evaluate after voice prototype.",
        tags: ["caveat", "architecture"],
      },
    ],
  },
  {
    id: "music-headphones-001",
    name: "Music + headphones",
    description: "User preferences about music gear and listening setups.",
    tags: ["music", "headphones", "audio", "preferences"],
    summary: "User prefers planar magnetic headphones and listens mostly to ambient and post-rock.",
    events: [
      {
        content: "User prefers HiFiMan Sundara for evening listening; finds them comfortable.",
        tags: ["headphones", "preferences"],
      },
      {
        content: "Genre rotation: ambient (Stars of the Lid), post-rock (Mogwai), some jazz.",
        tags: ["music", "preferences"],
      },
    ],
  },
  {
    id: "personal-admin-001",
    name: "Personal admin tasks",
    description: "Renewals, appointments, household admin.",
    tags: ["admin", "tasks", "household"],
    summary: "Tracks recurring renewals, appointments, and household chores.",
    events: [
      {
        content: "Passport renewal window opens 2026-09-01; allow 6 weeks for processing.",
        tags: ["passport", "admin"],
      },
      {
        content: "Boiler service due annually in October; last serviced 2025-10-12.",
        tags: ["household", "maintenance"],
      },
    ],
  },
];

export const FIXTURE_CASES: EvalCase[] = [
  {
    query: "What did we decide about OpenClaw and Thalm?",
    expectTopShards: ["thalm-architecture-001"],
    expectKeywordsInPacket: ["openclaw", "thalm", "shell"],
  },
  {
    query: "Which headphones do I prefer?",
    expectTopShards: ["music-headphones-001"],
    expectKeywordsInPacket: ["sundara"],
  },
  {
    query: "When is the passport renewal window?",
    expectTopShards: ["personal-admin-001"],
    expectKeywordsInPacket: ["passport", "2026"],
  },
];

/** Seed the given storage with the eval fixtures. Idempotent: skips already-existing shards. */
export async function seedFixtures(storage: JsonlStorage): Promise<void> {
  await storage.ensureLayout();
  for (const f of FIXTURE_SHARDS) {
    const existing = await storage.loadManifest(f.id);
    if (existing) continue;
    await createShard({
      storage,
      id: f.id,
      name: f.name,
      description: f.description,
      tags: f.tags,
      systemPrompt: SHARD_SYSTEM_PROMPT,
      summary: f.summary,
    });
    for (const ev of f.events) {
      await appendEventAndSnapshot({
        storage,
        shardId: f.id,
        event: { role: "user", content: ev.content, tags: ev.tags ?? [] },
        reason: `Seed fixture event for ${f.id}`,
        actor: "user",
      });
    }
  }
}
