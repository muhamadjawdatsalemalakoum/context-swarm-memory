import type {
  ChronicleEvent,
  CommitDecision,
  EventRole,
  MemoryDirectoryEntry,
  MemoryEvent,
  MemoryShardSnapshot,
  ShardManifest,
  TrustLevel,
} from "./types.js";
import { JsonlStorage } from "../storage/jsonlStorage.js";
import { newChronicleId, newEventId, newSnapshotId, nextSnapshotId } from "../utils/ids.js";
import { nowIso } from "../utils/time.js";
import { estimateEventsTokens, fullnessPct } from "./tokenBudget.js";

/** Single, well-known durable-write entry point.
 *  All other modules must call this to mutate memory; the query path never does. */
export async function appendEventAndSnapshot(args: {
  storage: JsonlStorage;
  shardId: string;
  event: {
    role: EventRole;
    content: string;
    importance?: number;
    tags?: string[];
    sourceConversationId?: string;
    sourceMessageId?: string;
  };
  reason: string;
  actor?: ChronicleEvent["actor"];
  chronicleType?: ChronicleEvent["type"];
}): Promise<{ snapshot: MemoryShardSnapshot; entry: MemoryDirectoryEntry; chronicle: ChronicleEvent }> {
  const { storage, shardId, event, reason, actor = "user", chronicleType = "commit_write" } = args;

  const manifest = await storage.loadManifest(shardId);
  if (!manifest) throw new Error(`Shard not found: ${shardId}`);
  if (manifest.status !== "active") {
    throw new Error(`Cannot write to shard ${shardId}: status=${manifest.status}`);
  }

  const prevSnapshot = await storage.loadSnapshot(shardId, manifest.latestSnapshotId);
  if (!prevSnapshot) {
    throw new Error(`Latest snapshot ${manifest.latestSnapshotId} missing for shard ${shardId}`);
  }

  const newEvent: MemoryEvent = {
    eventId: newEventId(prevSnapshot.events.length + 1),
    role: event.role,
    content: event.content,
    createdAt: nowIso(),
    importance: event.importance ?? 0.5,
    tags: event.tags ?? [],
    ...(event.sourceConversationId ? { sourceConversationId: event.sourceConversationId } : {}),
    ...(event.sourceMessageId ? { sourceMessageId: event.sourceMessageId } : {}),
  };

  const newSnapId = nextSnapshotId(manifest.latestSnapshotId);
  const newSnapshot: MemoryShardSnapshot = {
    shardId,
    snapshotId: newSnapId,
    systemPrompt: prevSnapshot.systemPrompt,
    summary: prevSnapshot.summary,
    events: [...prevSnapshot.events, newEvent],
    indexTerms: dedupe([...prevSnapshot.indexTerms, ...newEvent.tags]),
    createdAt: nowIso(),
    parentSnapshotId: prevSnapshot.snapshotId,
  };

  await storage.writeSnapshot(newSnapshot);

  const updatedManifest: ShardManifest = {
    ...manifest,
    latestSnapshotId: newSnapId,
    snapshotIds: [...manifest.snapshotIds, newSnapId],
    updatedAt: nowIso(),
  };
  await storage.saveManifest(updatedManifest);

  const dir = await storage.loadDirectory();
  const existing = dir.entries.find((e) => e.id === shardId);
  const tokens = estimateEventsTokens(newSnapshot.events);
  const contextLimit = existing?.contextLimitEstimate ?? manifest.contextLimitEstimate ?? 128_000;
  const updatedEntry: MemoryDirectoryEntry = {
    id: shardId,
    name: manifest.name,
    description: manifest.description,
    tags: dedupe([...(existing?.tags ?? manifest.tags), ...newEvent.tags]),
    createdAt: existing?.createdAt ?? manifest.createdAt,
    updatedAt: nowIso(),
    timeRange: existing?.timeRange,
    status: manifest.status,
    snapshotId: newSnapId,
    tokenCountEstimate: tokens,
    contextLimitEstimate: contextLimit,
    fullnessPct: round2(fullnessPct(tokens, contextLimit)),
    summaryShort: existing?.summaryShort ?? prevSnapshot.summary,
    knownConflicts: existing?.knownConflicts ?? [],
    parentId: manifest.parentId ?? null,
    children: manifest.children,
    trustLevel: existing?.trustLevel ?? manifest.trustLevel,
    staleness: existing?.staleness ?? "current",
  };
  await storage.upsertDirectoryEntry(updatedEntry);

  const chronicle: ChronicleEvent = {
    chronicleId: newChronicleId(),
    type: chronicleType,
    createdAt: nowIso(),
    targetShardId: shardId,
    oldSnapshotId: prevSnapshot.snapshotId,
    newSnapshotId: newSnapId,
    reason,
    actor,
  };
  await storage.appendChronicle(chronicle);

  return { snapshot: newSnapshot, entry: updatedEntry, chronicle };
}

/** Create a new shard with an initial S001 snapshot. Logs to chronicle. */
export async function createShard(args: {
  storage: JsonlStorage;
  id: string;
  name: string;
  description: string;
  tags: string[];
  systemPrompt: string;
  summary: string;
  contextLimitEstimate?: number;
  trustLevel?: TrustLevel;
}): Promise<{ snapshot: MemoryShardSnapshot; entry: MemoryDirectoryEntry; chronicle: ChronicleEvent }> {
  const {
    storage,
    id,
    name,
    description,
    tags,
    systemPrompt,
    summary,
    contextLimitEstimate = 128_000,
    trustLevel = "user_memory",
  } = args;

  const existing = await storage.loadManifest(id);
  if (existing) throw new Error(`Shard already exists: ${id}`);

  const snapshotId = newSnapshotId(1);
  const snapshot: MemoryShardSnapshot = {
    shardId: id,
    snapshotId,
    systemPrompt,
    summary,
    events: [],
    indexTerms: dedupe(tags),
    createdAt: nowIso(),
    parentSnapshotId: null,
  };
  await storage.writeSnapshot(snapshot);

  const manifest: ShardManifest = {
    id,
    name,
    description,
    tags,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: "active",
    latestSnapshotId: snapshotId,
    snapshotIds: [snapshotId],
    contextLimitEstimate,
    trustLevel,
    parentId: null,
    children: [],
  };
  await storage.saveManifest(manifest);

  const entry: MemoryDirectoryEntry = {
    id,
    name,
    description,
    tags,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    status: "active",
    snapshotId,
    tokenCountEstimate: 0,
    contextLimitEstimate,
    fullnessPct: 0,
    summaryShort: summary,
    knownConflicts: [],
    parentId: null,
    children: [],
    trustLevel,
    staleness: "current",
  };
  await storage.upsertDirectoryEntry(entry);

  const chronicle: ChronicleEvent = {
    chronicleId: newChronicleId(),
    type: "shard_created",
    createdAt: nowIso(),
    targetShardId: id,
    oldSnapshotId: null,
    newSnapshotId: snapshotId,
    reason: `Created shard ${id} (${name})`,
    actor: "user",
  };
  await storage.appendChronicle(chronicle);

  return { snapshot, entry, chronicle };
}

/** Phase 2: dry-run — describe what a CommitDecision *would* do. No mutation. */
export async function dryRunCommit(args: {
  storage: JsonlStorage;
  decision: CommitDecision;
}): Promise<{ wouldMutate: boolean; description: string; chronicleType: ChronicleEvent["type"] | "none" }> {
  const { storage, decision } = args;
  if (decision.action === "no_op" || decision.action === "ask_confirmation") {
    return { wouldMutate: false, description: `No durable change for action=${decision.action}.`, chronicleType: "none" };
  }
  if (!decision.targetShardId) {
    return {
      wouldMutate: false,
      description: `Action ${decision.action} requires target_shard_id.`,
      chronicleType: "none",
    };
  }
  const manifest = await storage.loadManifest(decision.targetShardId);
  if (!manifest) {
    return {
      wouldMutate: false,
      description: `Target shard ${decision.targetShardId} not found; would be a no-op.`,
      chronicleType: "none",
    };
  }
  if (decision.action === "write" || decision.action === "update") {
    const role: EventRole = decision.action === "update" ? "commit_note" : "commit_note";
    const chronicleType: ChronicleEvent["type"] =
      decision.action === "write" ? "commit_write" : "commit_update";
    return {
      wouldMutate: true,
      description: `Would append ${role} event to ${decision.targetShardId}, creating new snapshot. content="${truncate(decision.content, 80)}"`,
      chronicleType,
    };
  }
  if (decision.action === "freeze") {
    return {
      wouldMutate: true,
      description: `Would freeze shard ${decision.targetShardId} (status:active→frozen).`,
      chronicleType: "shard_frozen",
    };
  }
  return {
    wouldMutate: true,
    description: `Action ${decision.action} not implemented in MVP. Would be a no-op.`,
    chronicleType: "none",
  };
}

/** Phase 2: apply — performs the mutation specified by the decision via the same write path. */
export async function applyCommitDecision(args: {
  storage: JsonlStorage;
  decision: CommitDecision;
}): Promise<{ applied: boolean; description: string }> {
  const { storage, decision } = args;
  const dry = await dryRunCommit({ storage, decision });
  if (!dry.wouldMutate) return { applied: false, description: dry.description };

  if (!decision.targetShardId) {
    return { applied: false, description: "Missing targetShardId." };
  }

  if (decision.action === "write" || decision.action === "update") {
    await appendEventAndSnapshot({
      storage,
      shardId: decision.targetShardId,
      event: {
        role: "commit_note",
        content: decision.content,
        importance: decision.confidence,
        tags: decision.tags,
      },
      reason: `Committer:${decision.action} memory_type=${decision.memoryType} source=${decision.source}`,
      actor: "committer",
      chronicleType: decision.action === "write" ? "commit_write" : "commit_update",
    });
    return { applied: true, description: dry.description };
  }

  if (decision.action === "freeze") {
    const manifest = await storage.loadManifest(decision.targetShardId);
    if (!manifest) return { applied: false, description: "Manifest missing." };
    const updated: ShardManifest = { ...manifest, status: "frozen", updatedAt: nowIso() };
    await storage.saveManifest(updated);
    const dir = await storage.loadDirectory();
    const entry = dir.entries.find((e) => e.id === decision.targetShardId);
    if (entry) {
      entry.status = "frozen";
      entry.updatedAt = nowIso();
      await storage.saveDirectory(dir);
    }
    await storage.appendChronicle({
      chronicleId: newChronicleId(),
      type: "shard_frozen",
      createdAt: nowIso(),
      targetShardId: decision.targetShardId,
      reason: `Committer:freeze`,
      actor: "committer",
    });
    return { applied: true, description: dry.description };
  }

  return { applied: false, description: dry.description };
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr.map((s) => s.toLowerCase()))];
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
