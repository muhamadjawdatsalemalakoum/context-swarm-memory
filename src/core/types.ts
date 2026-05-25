// Core data types for Context Swarm Memory.
// These mirror specs/context_swarm_memory_spec.md §11.1 and §8.

export type ShardStatus = "active" | "frozen" | "archived" | "deleted";
export type MemoryType = "direct" | "adjacent" | "conflicting" | "vague" | "none";
export type EstimatedAnswerValue = "none" | "low" | "medium" | "high";
export type TrustLevel = "user_memory" | "project_memory" | "imported_doc" | "inferred";
export type Staleness = "current" | "possibly_stale" | "stale";
export type CommitAction =
  | "write"
  | "update"
  | "split"
  | "merge"
  | "freeze"
  | "no_op"
  | "ask_confirmation";
export type CommitMemoryType =
  | "user_preference"
  | "project_decision"
  | "fact"
  | "correction"
  | "inference"
  | "none";
export type CommitSource = "current_conversation" | "user_confirmation" | "system_inference";

export interface MemoryDirectoryEntry {
  id: string;
  name: string;
  description: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  timeRange?: { from?: string; to?: string };
  status: ShardStatus;
  snapshotId: string;
  tokenCountEstimate: number;
  contextLimitEstimate: number;
  fullnessPct: number;
  summaryShort: string;
  knownConflicts: string[];
  parentId?: string | null;
  children: string[];
  trustLevel: TrustLevel;
  staleness: Staleness;
}

export interface MemoryDirectory {
  version: number;
  entries: MemoryDirectoryEntry[];
}

export type EventRole = "user" | "assistant" | "system" | "commit_note";

export interface MemoryEvent {
  eventId: string;
  role: EventRole;
  content: string;
  createdAt: string;
  importance: number;
  tags: string[];
  sourceConversationId?: string;
  sourceMessageId?: string;
}

export interface MemoryShardSnapshot {
  shardId: string;
  snapshotId: string;
  systemPrompt: string;
  summary: string;
  events: MemoryEvent[];
  indexTerms: string[];
  createdAt: string;
  parentSnapshotId?: string | null;
}

export interface ShardManifest {
  id: string;
  name: string;
  description: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  status: ShardStatus;
  latestSnapshotId: string;
  snapshotIds: string[];
  contextLimitEstimate: number;
  trustLevel: TrustLevel;
  parentId?: string | null;
  children: string[];
}

export interface ProbeResult {
  shardId: string;
  snapshotId: string;
  knows: boolean;
  confidence: number;
  memoryType: MemoryType;
  estimatedAnswerValue: EstimatedAnswerValue;
  needsFullRecall: boolean;
  // `likelyConflicts` and `reason` removed in Phase α — see schemas.ts comment.
  relevantEventIds: string[];
}

export interface RecallClaim {
  claim: string;
  support: string[];
  confidence: number;
}

export interface RecallResult {
  shardId: string;
  snapshotId: string;
  confidence: number;
  answer: string;
  claims: RecallClaim[];
  unknowns: string[];
  conflicts: string[];
}

export interface MemoryPacketClaim {
  claim: string;
  sources: string[];
  confidence: number;
}

export interface MemoryPacket {
  query: string;
  summary: string;
  keyClaims: MemoryPacketClaim[];
  caveats: string[];
  conflicts: string[];
  recommendedMainContext: string;
}

export interface CandidateScore {
  entry: MemoryDirectoryEntry;
  score: number;
  reasons: string[];
}

export interface AskRunCost {
  inputTokensEstimate: number;
  outputTokensEstimate: number;
  estimatedUsd: number;
  latencyMs: number;
}

export interface AskRunResult {
  query: string;
  candidates: CandidateScore[];
  probes: ProbeResult[];
  recalls: RecallResult[];
  memoryPacket: MemoryPacket;
  cost: AskRunCost;
  mutated: false;
  runId: string;
  startedAt: string;
  finishedAt: string;
}

// Commit protocol — Phase 2.
export interface CommitDecision {
  action: CommitAction;
  targetShardId: string | null;
  memoryType: CommitMemoryType;
  content: string;
  confidence: number;
  requiresUserConfirmation: boolean;
  tags: string[];
  source: CommitSource;
}

export interface ChronicleEvent {
  chronicleId: string;
  type:
    | "init"
    | "shard_created"
    | "commit_write"
    | "commit_update"
    | "commit_correction"
    | "shard_frozen"
    | "shard_split"
    | "shard_merged"
    | "shard_archived";
  createdAt: string;
  targetShardId?: string;
  oldSnapshotId?: string | null;
  newSnapshotId?: string | null;
  reason: string;
  actor: "user" | "committer" | "system";
  meta?: Record<string, unknown>;
}

export interface QueryRunRecord {
  runId: string;
  query: string;
  startedAt: string;
  finishedAt: string;
  candidateIds: string[];
  probedIds: string[];
  recalledIds: string[];
  packetSummary: string;
  cost: AskRunCost;
  mutated: false;
  providerName: string;
}

// Split/compact recommendations — Phase 3.
export type SplitRecommendation =
  | "continue"
  | "watch"
  | "split_candidate"
  | "freeze_recommended"
  | "danger_zone";

export interface ShardHealth {
  shardId: string;
  fullnessPct: number;
  recommendation: SplitRecommendation;
  reason: string;
}
