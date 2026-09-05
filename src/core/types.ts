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

/** One date-ordered evidence line in a MemoryPacket timeline (T1 coverage).
 *  Produced by the deterministic chronicle assembler in `src/core/coverage.ts`;
 *  never LLM-invented. Citation discipline matches `MemoryPacketClaim.sources`:
 *  `eventRef` is always "shard_id@snapshot_id:event_id". */
export interface MemoryPacketTimelineEntry {
  /** ISO calendar date (YYYY-MM-DD) derived from the event's createdAt, or
   *  null when the event carries no parseable date. */
  date: string | null;
  /** Full citation: "shard_id@snapshot_id:event_id". */
  eventRef: string;
  /** Short, term-centered excerpt of the event content. */
  line: string;
}

export interface MemoryPacket {
  query: string;
  summary: string;
  keyClaims: MemoryPacketClaim[];
  caveats: string[];
  conflicts: string[];
  recommendedMainContext: string;
  /** Optional date-ordered evidence chronicle for coverage-shaped queries
   *  (summaries, event ordering, temporal arithmetic, aggregation). Additive:
   *  absent on point lookups and whenever coverage mode is off. */
  timeline?: MemoryPacketTimelineEntry[];
}

// Query-intent classification (T1 coverage) — deterministic and lexical.
// Shared by the core read path and the AMB bridge so the two can never
// disagree about what "coverage-shaped" means.
export interface QueryIntentFacets {
  /** Narrative/summary breadth: "summarize", "overview", "in hindsight",
   *  "impact of X on Y", … */
  summary: boolean;
  /** Sequence questions: "in what order", "which came first", … */
  ordering: boolean;
  /** Date arithmetic: "how many days between", "how long", … Triggers the
   *  deterministic date-anchor computation — never LLM date math. */
  temporalArithmetic: boolean;
  /** Counting/enumeration across events: "how many distinct …", … */
  aggregation: boolean;
}

export interface QueryIntent {
  /** "coverage" iff any facet matched; otherwise "point". */
  kind: "point" | "coverage";
  facets: QueryIntentFacets;
  /** Matched cue labels for CLI/debug explanations (mirrors
   *  `CandidateScore.reasons`). */
  cues: string[];
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

/**
 * What a `select()` cut reported about itself (src/core/selection.ts). Carried
 * on every ask() result and query-run record so "the ranking was arbitrary" is
 * a fact the operator can see, not one the code computed and threw away
 * (invariant 4: a component that cannot discriminate must SAY so).
 */
export interface SelectionSummary {
  discriminated: boolean;
  degenerateReason?: "no-candidates" | "no-signal" | "ties-at-cut";
  signalRatio: number;
  totalCandidates: number;
  /** Router only: which path produced the cut. */
  path?: "lexical" | "hybrid" | "hybrid-fallback-no-index" | "hybrid-fallback-embed-failed";
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
  /** Eager (CSM_EAGER_RECALLS) recall calls that completed but were not in
   *  the score-ordered selection; their tokens are included in `cost`. */
  discardedRecalls?: number;
  /** The per-shard recall digest budget this run actually used. Bimodal by
   *  design — the coverage intent classifier escalates 1,200 → 3,200 tokens on
   *  summary/ordering/temporal/aggregation-shaped queries — which is a 2.7×
   *  swing on the most expensive per-call stage. Recorded because the 2026-08
   *  token audit found the swing was invisible in telemetry: cost analyses were
   *  averaging over two populations without knowing it. */
  recallTokensPerShard: number;
  /** True when the coverage intent classifier escalated the recall budget. */
  coverageEscalated: boolean;
  /** Degeneracy reports of the two production cuts (router, recall). */
  selection: { router: SelectionSummary; recall: SelectionSummary };
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
  /** Whether the router's and recall's score->cut actually discriminated. */
  routerDiscriminated: boolean;
  recallDiscriminated: boolean;
  /** Human-readable list of which cuts were degenerate and why; empty when none. */
  degenerate: string[];
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
