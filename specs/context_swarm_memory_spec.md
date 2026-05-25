# Context Swarm Memory Spec

**Project codename:** Context Swarm Memory, or CSM
**Status:** R&D spec for Codex / Claude Code implementation
**Date:** 2026-04-26
**Goal:** Test whether multiple bounded LLM-context “memory shards” can act as external, forkable memory for a main LLM, as an alternative or complement to classic RAG.

---

## 1. One-line thesis

Build a memory system where stored context windows are treated as specialized, read-only memory witnesses. A manager routes questions to the right shards, asks cheap scout/probe questions first, asks only useful shards for full recall, synthesizes the answers, and writes new memory only through an explicit commit protocol.

This is not “one infinite LLM.” It is a memory operating system made from small, bounded, disposable LLM calls.

---

## 2. Problem

Classic RAG often retrieves chunks by lexical or embedding similarity. That works for many factual lookups but can fail when the needed memory is narrative, evolving, personal, contradictory, or spread across a long project history.

Long-context stuffing also has problems:

- The main context gets polluted by logs, questions, tangents, partial attempts, and dead-end explorations.
- Important details can become buried.
- The model may degrade as the context fills with less relevant material.
- Asking a memory question can itself mutate the conversational state if the memory is stored as an ongoing thread.

The user hypothesis:

> Instead of replacing memory with RAG, use many LLM-backed memory shards. Each shard holds a bounded context. A memory manager asks shards whether they know something, then gathers full answers only from relevant shards. Querying a shard should not pollute it, because the system forks or reverts the shard state after each question.

---

## 3. Core constraints and reality check

### 3.1 LLMs are not persistent memory by themselves

An API model is usually stateless unless the product exposes stateful threads or sessions. For implementation, a “memory LLM” should be represented as:

```text
MemoryShard = saved system prompt + saved transcript/events + metadata + snapshot ID
```

When queried, the runtime loads that shard snapshot into an LLM call. The LLM call is disposable.

### 3.2 Revert/fork is a design rule, not a required provider feature

Some tools expose “revert to previous message” or stateful sessions. Do not depend on that as the only mechanism. The general implementation should store immutable shard snapshots. A query creates a temporary branch:

```text
snapshot S42 -> branch query_run_abc -> answer -> branch discarded
```

No user question, probe, or recall prompt is appended to the durable shard unless an explicit commit step approves it.

### 3.3 The final context bottleneck remains

Total durable memory can grow almost indefinitely, but the main answer still receives only a compressed subset. The system’s value comes from selecting and distilling the right subset, not from eliminating context limits.

### 3.4 This may be expensive

Each shard query is another model call. The architecture must be ruthless about routing, pruning, caching, token budgets, and evals.

---

## 4. Definitions

| Term | Meaning |
|---|---|
| Main Agent | The assistant or product agent answering the user. |
| Memory Manager | Router that decides which memory shards to ask. |
| Memory Directory | Small manifest listing shard names, descriptions, tags, date ranges, fullness, summaries, and trust/staleness. |
| Memory Shard | Bounded saved context window plus metadata. It behaves like a memory witness when loaded into an LLM call. |
| Snapshot | Immutable version of a shard. Queries read snapshots. Writes create new snapshots. |
| Branch | Ephemeral query run based on a snapshot. Discarded after answer. |
| Probe / Scout | Cheap first-pass query asking a shard whether it has relevant memory. |
| Recall | Full answer from a shard, grounded in its own context. |
| Synthesizer | Combines recalls, resolves conflicts, and prepares clean context for the Main Agent. |
| Committer | Decides what new memory should be written after a task. |
| Splitter | Freezes or divides shards when they get too full or topic-drifted. |
| Chronicle | Append-only event log of memory writes, splits, merges, and deletions. |

---

## 5. Non-goals

- Do not build a general autonomous agent swarm at first.
- Do not allow memory shards to edit code, browse, or use tools in MVP.
- Do not make every shard answer every query.
- Do not store every assistant response as memory.
- Do not assume embeddings are forbidden. The goal is to test LLM-context memory against and alongside RAG, not to perform ritual combat in the embedding colosseum.
- Do not rely on vendor-specific “thread fork” features until the snapshot version works.

---

## 6. Target behavior

Given a user query:

```text
What did we decide about using OpenClaw as the shell for Thalm?
```

The system should:

1. Show the Memory Manager a compact directory, not all memory content.
2. Select likely shards:
   - `thalm-architecture-001`
   - `openclaw-shell-002`
   - `voice-canvas-noet-001`
3. Run probe mode on those shards.
4. Ask full recall only from high-value shards.
5. Synthesize a short, grounded memory packet:

```text
Relevant memory packet:
- Decision: OpenClaw was considered as a shell/control plane for Thalm, not necessarily the renderer itself.
- Reason: The user wanted an OS-like environment for orchestrating voice, canvas, model routing, and memory.
- Caveat: This was exploratory, not locked as final architecture.
- Sources: thalm-architecture-001@S12, openclaw-shell-002@S07
```

6. Send only this packet to the Main Agent.
7. Do not mutate any shard unless the Committer later writes a new decision.

---

## 7. Architecture

```text
                   User Query
                       |
                       v
                 Main Agent
                       |
                       v
              Memory Manager / Router
                       |
             reads compact directory
                       |
          +------------+------------+
          |                         |
          v                         v
   Candidate Shards            No Memory Needed
          |
          v
    Probe / Scout Mode
          |
          v
  Select recall candidates
          |
          v
      Full Recall Mode
          |
          v
      Synthesizer
          |
          v
  Clean Memory Packet to Main Agent
          |
          v
    Optional Committer
          |
          v
  New Snapshot / Split / No-op
```

---

## 8. Component specs

### 8.1 Memory Directory

The directory is the only memory object loaded into the Main Agent or Manager by default. It must stay small.

Recommended max size for MVP: **2,000 to 8,000 tokens**.

Each directory entry:

```json
{
  "id": "thalm-architecture-001",
  "name": "Thalm architecture memory 001",
  "description": "Early architecture discussions for Thalm: voice, canvas, OpenClaw, NOET shell, model routing.",
  "tags": ["thalm", "voice", "canvas", "openclaw", "noet", "architecture"],
  "created_at": "2026-04-26T00:00:00Z",
  "updated_at": "2026-04-26T00:00:00Z",
  "time_range": {
    "from": "2026-04-01",
    "to": "2026-04-26"
  },
  "status": "active",
  "snapshot_id": "S12",
  "token_count_estimate": 52000,
  "context_limit_estimate": 128000,
  "fullness_pct": 40.6,
  "summary_short": "Thalm is an AI-native working environment centered on voice, canvas, model routing, and long-lived project memory.",
  "known_conflicts": [],
  "parent_id": null,
  "children": [],
  "trust_level": "user_memory",
  "staleness": "current"
}
```

### 8.2 Memory Manager

Responsibilities:

- Given a user query, select candidate shards from the directory.
- Choose probe strategy.
- Decide which shards deserve full recall.
- Enforce budgets.
- Return a memory packet to the Main Agent.

MVP routing can be simple:

```text
score = tag_overlap + semantic_description_match + recency_boost - staleness_penalty - fullness_penalty
```

Later routing can include embeddings, learned rankers, or LLM-based directory review.

### 8.3 Memory Shard

A shard contains durable memory content. It may be represented as:

```json
{
  "id": "openclaw-shell-002",
  "snapshot_id": "S07",
  "system_prompt": "You are a read-only memory shard...",
  "events": [
    {
      "event_id": "e001",
      "role": "user",
      "content": "...",
      "created_at": "...",
      "importance": 0.83,
      "tags": ["openclaw", "shell"]
    }
  ],
  "summary": "...",
  "index_terms": ["OpenClaw", "Thalm", "shell", "control plane"],
  "metadata": {}
}
```

The shard should answer only from its own snapshot. It must be explicit when it does not know.

### 8.4 Probe / Scout

The user suggested a 1-token `0` or `1` mode. Keep it as an optional optimization, but do not make it the default.

Default probe output should be JSON:

```json
{
  "knows": true,
  "confidence": 0.77,
  "memory_type": "direct",
  "estimated_answer_value": "high",
  "needs_full_recall": true,
  "likely_conflicts": false,
  "reason": "This shard contains early OpenClaw and Thalm shell architecture decisions.",
  "relevant_event_ids": ["e041", "e052", "e066"]
}
```

Allowed `memory_type` values:

```text
direct | adjacent | conflicting | vague | none
```

The ultra-cheap `0/1` probe can be tested as a later experiment:

```text
Return exactly `1` if your snapshot contains direct or adjacent information relevant to this question. Otherwise return exactly `0`.
```

Use JSON scout for R&D because it gives calibration data.

### 8.5 Recall

Recall output should be structured and evidence-bearing:

```json
{
  "shard_id": "openclaw-shell-002",
  "snapshot_id": "S07",
  "confidence": 0.82,
  "answer": "OpenClaw was discussed as a shell or control-plane layer for Thalm, not as the whole product.",
  "claims": [
    {
      "claim": "OpenClaw was considered as orchestration shell/control plane.",
      "support": ["e041", "e052"],
      "confidence": 0.86
    },
    {
      "claim": "The decision was exploratory rather than final.",
      "support": ["e066"],
      "confidence": 0.71
    }
  ],
  "unknowns": [
    "No final locked architecture decision exists in this shard."
  ],
  "conflicts": []
}
```

### 8.6 Synthesizer

Responsibilities:

- Merge answers from multiple shards.
- Deduplicate repeated claims.
- Identify conflicts and old-vs-new memory.
- Create a compact memory packet for the Main Agent.
- Include shard IDs and snapshot IDs.

Memory packet shape:

```json
{
  "query": "What did we decide about using OpenClaw as the shell for Thalm?",
  "summary": "OpenClaw was considered as a shell/control plane for Thalm. It was not locked as final architecture.",
  "key_claims": [
    {
      "claim": "OpenClaw was considered for orchestration/shell responsibilities.",
      "sources": ["openclaw-shell-002@S07", "thalm-architecture-001@S12"],
      "confidence": 0.84
    }
  ],
  "caveats": ["Exploratory, not final."],
  "recommended_main_context": "..."
}
```

### 8.7 Committer

The Committer is the only component allowed to mutate durable memory.

Commit rules:

- Store user-stated durable preferences, facts, project decisions, and corrections.
- Store assistant-derived conclusions only if they are clearly validated by user acceptance or tagged as inferred.
- Do not store random assistant speculation as fact.
- Do not store sensitive data unless the system has permission and a deletion path.
- Every commit creates a new snapshot.

Commit decision output:

```json
{
  "action": "write",
  "target_shard_id": "thalm-architecture-001",
  "memory_type": "project_decision",
  "content": "User clarified that OpenClaw should be treated as a possible shell/control plane, not the renderer.",
  "confidence": 0.91,
  "requires_user_confirmation": false,
  "tags": ["thalm", "openclaw", "architecture"],
  "source": "current_conversation"
}
```

Allowed actions:

```text
write | update | split | merge | freeze | no_op | ask_confirmation
```

### 8.8 Splitter / Compactor

The Splitter watches shard fullness and topic drift.

Starting thresholds:

| Shard state | Fullness | Action |
|---|---:|---|
| Healthy active shard | 0 to 55% | Continue writing. |
| Watch zone | 55 to 65% | Prefer local summaries and tighter commits. |
| Split candidate | 65 to 75% | Create continuation shard or topic split. |
| Freeze zone | 75 to 85% | Freeze shard, write summary, spawn child. |
| Danger zone | 85%+ | Do not write more. Recall only after compaction. |

These are R&D defaults, not claims about universal model behavior. The eval suite should tune them.

Split strategies:

1. **Chronological continuation**
   - `thalm-001` freezes.
   - `thalm-002` continues.

2. **Topic split**
   - `thalm-architecture-001`
   - `thalm-voice-001`
   - `thalm-canvas-001`

3. **Conflict split**
   - Keep old decisions in frozen shard.
   - Create new shard with updated decision state.

Every split must update the directory.

---

## 9. Context budget policy

### 9.1 Main Agent

The Main Agent should not receive raw shard transcripts. It should receive synthesized memory packets.

Initial budget targets:

| Context slice | Target |
|---|---:|
| System and tool instructions | 10 to 20% |
| Current user task and immediate conversation | 35 to 55% |
| Retrieved memory packet | 10 to 25% |
| Working scratch / output room | 20 to 35% |

### 9.2 Memory shards

Active shards should remain below roughly 65% to 70% fullness until experiments prove a higher threshold works.

### 9.3 Recall budget

Default recall limits:

```json
{
  "max_candidate_shards": 8,
  "max_probe_shards": 8,
  "max_recall_shards": 4,
  "max_recall_tokens_per_shard": 1200,
  "max_memory_packet_tokens": 2500
}
```

---

## 10. Prompt templates

### 10.1 Memory Shard system prompt

```text
You are a read-only memory shard.

Your job is to answer questions using only the memory snapshot provided in your context.

Rules:
- Do not claim knowledge that is not present in this snapshot.
- Do not update, rewrite, or append memory.
- Treat the user question as an external query, not as new memory.
- If the snapshot is silent, say so.
- Prefer exact project decisions, user preferences, dates, and caveats.
- Distinguish direct memory from adjacent or inferred memory.
- Return the requested JSON schema exactly when asked for JSON.
```

### 10.2 Probe prompt

```text
Question:
{{user_query}}

You are being asked only whether this memory shard is relevant.
Return JSON only:
{
  "knows": boolean,
  "confidence": number between 0 and 1,
  "memory_type": "direct" | "adjacent" | "conflicting" | "vague" | "none",
  "estimated_answer_value": "none" | "low" | "medium" | "high",
  "needs_full_recall": boolean,
  "likely_conflicts": boolean,
  "reason": string,
  "relevant_event_ids": string[]
}

Do not answer the user question yet.
```

### 10.3 Ultra-cheap binary probe prompt

```text
Question:
{{user_query}}

Return exactly one token:
1 = this shard contains direct or adjacent relevant memory
0 = this shard does not contain relevant memory
```

Use this only in experiments or after calibration.

### 10.4 Recall prompt

```text
Question:
{{user_query}}

Answer using only this shard snapshot. Return JSON only:
{
  "shard_id": "{{shard_id}}",
  "snapshot_id": "{{snapshot_id}}",
  "confidence": number between 0 and 1,
  "answer": string,
  "claims": [
    {
      "claim": string,
      "support": string[],
      "confidence": number between 0 and 1
    }
  ],
  "unknowns": string[],
  "conflicts": string[]
}

If this shard does not know, return an empty claims list and explain the unknown.
```

### 10.5 Synthesizer prompt

```text
You are the memory synthesizer.

User question:
{{user_query}}

Shard recalls:
{{recall_json_array}}

Create a compact memory packet for the Main Agent.
Rules:
- Merge duplicate claims.
- Preserve caveats and uncertainty.
- Flag conflicts between shards.
- Prefer newer snapshots when the conflict is clearly chronological.
- Do not invent facts.
- Include shard_id@snapshot_id for each key claim.
Return JSON only.
```

### 10.6 Committer prompt

```text
You are the memory committer.

Current user/assistant exchange:
{{conversation_excerpt}}

Existing relevant memory packet:
{{memory_packet}}

Decide whether durable memory should change.
Return JSON only:
{
  "action": "write" | "update" | "split" | "merge" | "freeze" | "no_op" | "ask_confirmation",
  "target_shard_id": string | null,
  "memory_type": "user_preference" | "project_decision" | "fact" | "correction" | "inference" | "none",
  "content": string,
  "confidence": number between 0 and 1,
  "requires_user_confirmation": boolean,
  "tags": string[],
  "source": "current_conversation" | "user_confirmation" | "system_inference"
}

Rules:
- Do not store ordinary assistant prose.
- Do not store uncertain inference as fact.
- If the user corrected memory, prefer update or write a correction.
```

---

## 11. Data model

### 11.1 TypeScript interfaces

```ts
export type ShardStatus = "active" | "frozen" | "archived" | "deleted";
export type MemoryType = "direct" | "adjacent" | "conflicting" | "vague" | "none";
export type CommitAction = "write" | "update" | "split" | "merge" | "freeze" | "no_op" | "ask_confirmation";

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
  trustLevel: "user_memory" | "project_memory" | "imported_doc" | "inferred";
  staleness: "current" | "possibly_stale" | "stale";
}

export interface MemoryEvent {
  eventId: string;
  role: "user" | "assistant" | "system" | "commit_note";
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

export interface ProbeResult {
  shardId: string;
  snapshotId: string;
  knows: boolean;
  confidence: number;
  memoryType: MemoryType;
  estimatedAnswerValue: "none" | "low" | "medium" | "high";
  needsFullRecall: boolean;
  likelyConflicts: boolean;
  reason: string;
  relevantEventIds: string[];
}

export interface RecallResult {
  shardId: string;
  snapshotId: string;
  confidence: number;
  answer: string;
  claims: Array<{
    claim: string;
    support: string[];
    confidence: number;
  }>;
  unknowns: string[];
  conflicts: string[];
}

export interface MemoryPacket {
  query: string;
  summary: string;
  keyClaims: Array<{
    claim: string;
    sources: string[];
    confidence: number;
  }>;
  caveats: string[];
  conflicts: string[];
  recommendedMainContext: string;
}
```

### 11.2 Storage

MVP storage options:

1. SQLite for local R&D.
2. JSONL files for quick iteration.
3. Postgres later for concurrent multi-user use.

Recommended MVP:

```text
data/
  directory.json
  shards/
    thalm-architecture-001/
      snapshots/
        S001.json
        S002.json
      manifest.json
  chronicle.jsonl
  query-runs.jsonl
```

Chronicle event example:

```json
{
  "chronicle_id": "c_000123",
  "type": "commit_write",
  "created_at": "2026-04-26T12:00:00Z",
  "target_shard_id": "thalm-architecture-001",
  "old_snapshot_id": "S12",
  "new_snapshot_id": "S13",
  "reason": "User clarified OpenClaw role in Thalm architecture.",
  "actor": "committer"
}
```

---

## 12. Orchestration pseudocode

```ts
async function answerWithMemory(userQuery: string): Promise<string> {
  const directory = await storage.loadDirectory();

  const candidates = await router.selectCandidates({
    query: userQuery,
    directory,
    maxCandidates: 8,
  });

  const probes = await Promise.all(
    candidates.map((entry) => probeShard(userQuery, entry))
  );

  const recallTargets = probes
    .filter((p) => p.needsFullRecall && p.confidence >= 0.45)
    .sort((a, b) => scoreProbe(b) - scoreProbe(a))
    .slice(0, 4);

  const recalls = await Promise.all(
    recallTargets.map((p) => recallShard(userQuery, p.shardId, p.snapshotId))
  );

  const memoryPacket = await synthesizeMemoryPacket(userQuery, recalls);

  const answer = await mainAgent.answer({
    userQuery,
    memoryPacket,
  });

  const commitDecision = await committer.decide({
    conversationExcerpt: { userQuery, answer },
    memoryPacket,
  });

  await applyCommitDecision(commitDecision);

  return answer;
}
```

Important: `probeShard` and `recallShard` must never append the query to the shard snapshot.

---

## 13. MVP CLI

Commands:

```bash
csm init
csm shard create --name "Thalm architecture" --tags thalm,architecture,openclaw
csm remember --shard thalm-architecture-001 --text "User said OpenClaw may act as Thalm's shell/control plane."
csm ask "What did we decide about OpenClaw and Thalm?"
csm inspect directory
csm inspect shard thalm-architecture-001
csm eval run
csm split check
```

`csm ask` should print:

```text
Memory candidates:
- thalm-architecture-001, probe confidence 0.84
- openclaw-shell-001, probe confidence 0.71

Memory packet:
...

Answer:
...
```

Use a `--quiet` flag for normal product mode.

---

## 14. MVP implementation plan

### Phase 0: Mock runtime

Goal: Build the architecture without real model calls.

Tasks:

- Create storage layer.
- Create directory and shard data model.
- Create fake probe/recall functions using keyword matching.
- Create CLI.
- Create basic eval fixture.

Acceptance:

- Can create shards, write events, ask a question, see selected shards.
- No query mutates shard snapshots.

### Phase 1: Real probe and recall

Goal: Use real LLM calls for probe and recall.

Tasks:

- Implement provider interface.
- Add JSON schema validation.
- Add retry on malformed JSON.
- Add token estimation.
- Add concurrency limits.

Acceptance:

- Probe returns valid JSON 95%+ on eval fixture.
- Recall returns claims with event IDs.
- Cost and latency are logged.

### Phase 2: Commit protocol

Goal: Memory can safely evolve.

Tasks:

- Implement Committer.
- Add snapshot creation.
- Add chronicle logging.
- Add dry-run mode.
- Add user-confirmation flag.

Acceptance:

- Asking questions does not change memory.
- New durable decisions create new snapshots.
- All writes are visible in chronicle.

### Phase 3: Splitting and compaction

Goal: Prevent context rot inside shards.

Tasks:

- Add fullness tracking.
- Add freeze/continuation shard.
- Add topic split proposal.
- Add summary generation.

Acceptance:

- Shards above threshold are frozen or split.
- Directory updates correctly.
- Frozen shards remain queryable.

### Phase 4: Evals and sweet-spot experiments

Goal: Find the actual useful fullness thresholds and routing strategy.

Tasks:

- Build synthetic memory benchmark.
- Compare context fullness levels.
- Compare binary probe vs JSON probe.
- Compare no-RAG CSM vs RAG vs hybrid.

Acceptance:

- Produce a report with cost, latency, recall, answer accuracy, and shard fullness performance curves.

### Phase 5: Tool integration

Goal: Make it usable from coding agents and apps.

Tasks:

- Expose MCP server or local HTTP API.
- Add Codex/Claude Code setup files.
- Add read-only memory subagents.
- Add hooks for logging and write validation.

Acceptance:

- Codex/Claude Code can call `csm ask` or MCP tools.
- Writes require explicit Committer protocol.

---

## 15. Evaluation design

### 15.1 Baselines

Compare at least four modes:

1. **No memory**
2. **Classic RAG**
3. **Single huge context**
4. **Context Swarm Memory**
5. **Hybrid CSM + RAG**

### 15.2 Metrics

| Metric | Meaning |
|---|---|
| Router Recall@K | Correct shard appears in top K candidates. |
| Probe Precision | A probed shard marked useful actually helps. |
| Probe Recall | A useful shard is not missed. |
| Answer Accuracy | Final answer matches ground truth. |
| Groundedness | Claims cite relevant shard/event IDs. |
| Conflict Handling | Old and new decisions are distinguished. |
| Mutation Safety | Query-only runs do not change snapshots. |
| Cost per Query | Total tokens and money. |
| Latency | End-to-end wall time. |
| Context Fullness Sensitivity | Accuracy by shard fullness bucket. |

### 15.3 Sweet-spot experiment

Create shards with identical facts placed at different positions and fullness levels.

Fullness buckets:

```text
20%, 40%, 55%, 65%, 75%, 85%, 95%
```

For each bucket:

- Ask direct fact questions.
- Ask indirect narrative questions.
- Ask conflict-resolution questions.
- Ask questions where relevant fact is near beginning, middle, and end.

Track:

- Probe correctness.
- Recall correctness.
- Hallucination rate.
- Latency and tokens.

Expected outcome:

- Find practical split/freeze thresholds per model and prompt style.
- Do not assume the 70% heuristic is correct until measured.

### 15.4 Binary probe experiment

Compare:

1. `0/1` one-token probe.
2. JSON scout probe.
3. Directory-only routing.
4. Embedding/vector shortlist plus JSON scout.

Measure missed-memory rate. The binary probe is only acceptable if false negatives are low enough for the product’s tolerance.

---

## 16. Failure modes and mitigations

| Failure mode | Symptom | Mitigation |
|---|---|---|
| False-negative probe | Useful shard says it knows nothing. | Lower threshold, use JSON scout, add embedding shortlist, ask more shards. |
| False-positive probe | Wasted recall calls. | Track precision, penalize shard in router, improve descriptions. |
| Context pollution | Shard accumulates query prompts and noise. | Immutable snapshots, branch-and-discard, Committer-only writes. |
| Context rot | Full shards answer worse. | Split/freeze thresholds, summaries, eval fullness curve. |
| Memory contradiction | Old and new decisions both appear. | Time-aware synthesis, conflict split, explicit status fields. |
| Cost explosion | Too many shards queried. | Candidate cap, probe cap, recall cap, caching, cheap models. |
| Directory drift | Directory summary no longer matches shard. | Update directory on every commit, audit job. |
| Over-summarization | Nuance lost in compaction. | Keep frozen originals, cite event IDs, summaries as index not truth. |
| Privacy leak | Sensitive memory stored accidentally. | Commit filters, redaction, encryption, deletion path. |
| Shard fragmentation | Too many tiny shards. | Merge low-traffic related shards, hierarchical directory. |

---

## 17. Security and privacy

Minimum requirements:

- All writes go through Committer.
- User can inspect memory directory.
- User can delete shard or event.
- Sensitive categories can be blocked or require confirmation.
- Store raw memory encrypted at rest if using real user data.
- Keep audit log of memory writes.
- Separate read-only query path from write path.

Do not allow a memory shard to execute tools in MVP. Treat it as read-only language recall.

---

## 18. Provider abstraction

Create a provider interface:

```ts
export interface LlmProvider {
  completeJson<T>(input: {
    system: string;
    prompt: string;
    schemaName: string;
    maxOutputTokens: number;
    temperature?: number;
    model?: string;
  }): Promise<T>;

  completeText(input: {
    system: string;
    prompt: string;
    maxOutputTokens: number;
    temperature?: number;
    model?: string;
  }): Promise<string>;
}
```

Implementation should support:

- OpenAI-compatible provider.
- Anthropic-compatible provider.
- Mock provider for evals.

Do not bake in a provider-specific session model. Use snapshots first. Prompt caching and stateful sessions can be optimization layers.

---

## 19. Codex / Claude Code handoff

### 19.1 Codex setup

Create an `AGENTS.md` in the repo root:

```md
# AGENTS.md

## Project mission
Build and test Context Swarm Memory: a memory system using bounded, read-only LLM context shards, manager routing, probe/recall, synthesis, and explicit commit-only writes.

## Non-negotiables
- Querying memory must not mutate durable memory.
- All memory writes must go through the Committer.
- Shard snapshots are immutable.
- Keep provider APIs behind an interface.
- Add evals before optimizing.

## First implementation target
Build the Phase 0 and Phase 1 MVP:
- TypeScript CLI
- JSONL or SQLite storage
- Directory, shards, snapshots, chronicle
- Mock provider
- Real provider interface
- Probe, recall, synthesize pipeline
- Basic eval suite

## Commands
- `npm test`
- `npm run lint`
- `npm run eval`

## Style
- Prefer small files with clear interfaces.
- Validate all LLM JSON outputs.
- Log cost, latency, token estimates, shard IDs, snapshot IDs.
```

Useful Codex prompt:

```text
Read specs/context_swarm_memory_spec.md and AGENTS.md. Implement Phase 0 and Phase 1 only. Do not build autonomous write behavior. Start with TypeScript, local JSONL storage, and a mock provider. After the mock pipeline works, add a provider interface for real LLM calls. Add tests for mutation safety.
```

For parallel review in Codex:

```text
Review this repository with parallel subagents. Spawn one agent for architecture correctness, one for mutation safety, one for eval design, and one for TypeScript code quality. Wait for all agents, then summarize concrete changes with file references.
```

### 19.2 Claude Code setup

Create a `CLAUDE.md` in the repo root:

```md
# CLAUDE.md

## Project
This repo implements Context Swarm Memory, an R&D system where LLM-backed memory shards are queried as read-only witnesses.

## Architecture invariants
- Memory query runs are branch-and-discard.
- Durable memory changes only through Committer decisions.
- Shard snapshots are immutable and versioned.
- Summaries are indexes, not sources of truth.
- Recall must cite shard ID and event IDs.

## Development workflow
- Start in plan mode for architectural changes.
- Add tests for every mutation path.
- Run evals after changing router, probe, recall, synthesis, or split thresholds.
- Prefer explicit JSON schemas for all LLM outputs.

## MVP stack
- TypeScript first unless the user requests Python.
- JSONL or SQLite storage.
- Provider interface with mock implementation.
```

Example Claude subagent file:

```md
---
name: memory-safety-reviewer
description: Reviews Context Swarm Memory code for accidental mutation, unsafe writes, or missing snapshot boundaries.
tools: [Read, Grep, Glob, Bash]
model: sonnet
permissionMode: plan
maxTurns: 6
memory: project
---

You are a memory safety reviewer for Context Swarm Memory.

Focus only on:
- Query paths mutating durable memory.
- Missing snapshot IDs.
- Writes that bypass Committer.
- Shard recalls that fail to cite event IDs.
- Tests missing for mutation safety.

Return concrete file-level findings and suggested fixes. Do not edit files unless explicitly asked.
```

Example Claude prompt:

```text
Use the memory-safety-reviewer subagent to inspect the current implementation. Then propose the smallest patch set to enforce branch-and-discard semantics for probe and recall.
```

---

## 20. Optional MCP/API interface

Expose CSM as a local service so coding agents can call it.

HTTP endpoints:

```text
GET  /directory
POST /ask
POST /probe
POST /recall
POST /commit/dry-run
POST /commit/apply
GET  /shards/:id
GET  /shards/:id/snapshots/:snapshotId
POST /eval/run
```

`POST /ask` request:

```json
{
  "query": "What did we decide about OpenClaw and Thalm?",
  "mode": "memory_packet",
  "maxRecallShards": 4
}
```

Response:

```json
{
  "memoryPacket": {},
  "probes": [],
  "recalls": [],
  "cost": {
    "inputTokens": 12345,
    "outputTokens": 1200,
    "estimatedUsd": 0.0
  },
  "mutated": false
}
```

---

## 21. Open research questions

1. What is the best shard fullness threshold by model and task?
2. Can binary `0/1` probes be calibrated well enough to reduce cost without missing memories?
3. Is the Memory Directory enough, or does it need embeddings for candidate selection?
4. How often should directory summaries be regenerated?
5. What is the best split strategy: chronological, topic-based, or hybrid?
6. How should contradictory memories be represented without overwriting useful history?
7. Can prompt caching make large shard snapshots economical?
8. When is classic RAG strictly better?
9. When is CSM strictly better?
10. Can a small local model handle probe mode while larger models handle recall and synthesis?

---

## 22. R&D acceptance criteria

The first serious prototype is successful if:

- Querying memory never mutates snapshots.
- Directory routing finds the correct shard in top 3 at least 85% of the time on the initial benchmark.
- JSON scout probe has fewer false negatives than binary probe on the benchmark.
- Final answers cite shard IDs and snapshot IDs.
- CSM beats no-memory and single huge context on at least one narrative/project-history benchmark.
- RAG beats CSM on at least one simple factual benchmark, proving the eval is not rigged.
- Hybrid CSM + RAG has a clear measured role, or is rejected with data.
- Cost and latency are logged for every run.

---

## 23. Suggested first coding tasks

Give this to Codex or Claude Code:

```text
Implement the Context Swarm Memory MVP from specs/context_swarm_memory_spec.md.

Start with Phase 0:
1. Create TypeScript project structure.
2. Implement MemoryDirectoryEntry, MemoryShardSnapshot, MemoryEvent, ProbeResult, RecallResult, MemoryPacket types.
3. Implement JSONL storage under data/.
4. Implement csm init, shard create, remember, inspect, ask.
5. Implement mock router/probe/recall/synthesizer using keyword matching.
6. Add tests proving csm ask does not modify shard snapshots or chronicle.

Then prepare Phase 1 but do not require API keys:
7. Add LlmProvider interface.
8. Add MockProvider implementation.
9. Add placeholder OpenAI/Anthropic provider classes behind environment flags.
10. Add JSON schema validation for probe and recall outputs.

Stop after tests pass and print a concise TODO list for Phase 1 real provider wiring.
```

---

## 24. Tooling notes verified on 2026-04-26

These are compatibility notes for handoff. Check current docs again before production hardening.

- Codex supports project guidance through `AGENTS.md`, global guidance, and nested overrides.
- Codex has an SDK for controlling local Codex agents programmatically.
- Codex supports explicit subagent workflows where specialized agents can run in parallel and return consolidated results.
- Claude Code supports `CLAUDE.md` and auto memory. These are loaded as context, so concise project instructions matter.
- Claude Code subagents are Markdown files with YAML frontmatter and can be configured with tool access, model, permissions, memory scope, hooks, and isolation.
- Claude Agent SDK exposes built-in tools, hooks, subagents, MCP, permissions, and sessions.

Reference URLs:

- OpenAI Codex AGENTS.md: https://developers.openai.com/codex/guides/agents-md
- OpenAI Codex SDK: https://developers.openai.com/codex/sdk
- OpenAI Codex subagents: https://developers.openai.com/codex/subagents
- OpenAI Codex subagent concepts: https://developers.openai.com/codex/concepts/subagents
- Claude Code memory: https://code.claude.com/docs/en/memory
- Claude Code subagents: https://code.claude.com/docs/en/sub-agents
- Claude Code hooks: https://code.claude.com/docs/en/hooks
- Claude Agent SDK overview: https://code.claude.com/docs/en/agent-sdk/overview
- MemGPT paper: https://arxiv.org/abs/2310.08560

---

## 25. Tiny mental model

Think of memory as a courtroom, not a haystack.

- The Directory is the witness list.
- The Manager decides who to call.
- Probe asks, “Do you know anything useful?”
- Recall asks, “State what you remember and cite your notes.”
- The Synthesizer cross-examines.
- The Committer updates the record.
- Every witness goes home unchanged unless the court clerk files a new record.

That is the whole system in one little robe-wearing nutshell.

---

## 26. Related work and architectural differentiation

The 2024-2026 long-context memory literature splits into three camps. CSM sits in a fourth, narrowly-defined one. This section names the camps, names the closest cousin, and pins exactly where CSM diverges.

### 26.1 The three camps

**Graph / hierarchical RAG.** Microsoft GraphRAG (Edge et al., arXiv:2404.16130), LazyGraphRAG, LightRAG (Guo et al., arXiv:2410.05779, EMNLP 2025), HippoRAG (Gutiérrez et al., arXiv:2405.14831, NeurIPS 2024) and HippoRAG 2 (arXiv:2502.14802, ICML 2025), RAPTOR (Sarthi et al., arXiv:2401.18059, ICLR 2024). These systems build an LLM-extracted structure over the corpus at index time — entity-relation graphs, community summaries, recursive cluster trees — then traverse that structure at query time. Strong on multi-hop QA: HippoRAG 2 sets the contemporary mark on MuSiQue F1=48.6, 2Wiki F1=71.0, HotpotQA F1=75.5. Indexing is LLM-driven and proportionate to corpus size: HippoRAG ≈ 2× corpus tokens, LightRAG ≈ 4×, full GraphRAG 10×+. On a single 4090 with Gemma 4 31B, this caps practical corpus size at ≈ 1M tokens.

**Agentic memory layers.** Mem0 (Chhikara et al., arXiv:2504.19413), MemoryOS (Kang et al., EMNLP 2025 Oral), Letta / MemGPT (Packer et al., arXiv:2310.08560), Zep / Graphiti (Rasmussen et al., arXiv:2501.13956), A-MEM (Xu et al., arXiv:2502.12110, NeurIPS 2025). These systems take conversational input streams and distill them into persistent fact stores at ingest time, then retrieve facts on query. Mem0 reports ~90 % token reduction vs full-context on LoCoMo (numbers disputed by Zep and Letta). Production-deployed; pip-installable. Indexing cost is sub-linear in corpus tokens (fact extraction is cheap per turn).

**Per-shard partitioned memory.** ShardMemo (Zhao et al., arXiv:2601.21545, 2026-01-29). Three-tier memory service for agentic LLMs: per-agent working state, sharded evidence with shard-local ANN indexes, versioned skill library. Probing cast as **masked mixture-of-experts routing**: metadata/eligibility constraints *mask* ineligible shards before MoE routing kicks in. Probes up to a budgeted Top-B_probe or adaptive Top-P shard set with cost-aware gating. Reports +5.11 to +6.82 F1 over GAM on LoCoMo; HotpotQA F1 in the 57.95–63.41 range at 56K-448K tokens. Ran on 4×RTX 4090D. **This is the published architectural cousin closest to CSM.**

### 26.2 CSM's positioning vs ShardMemo

ShardMemo and CSM agree on the fundamental sharding decision: memory is partitioned, each partition has a local representation, and a query consults a budget-limited subset of partitions. They diverge on three load-bearing axes:

| Axis | ShardMemo | CSM |
|---|---|---|
| **What a shard *is*** | Evidence + a shard-local ANN/vector index | An **LLM witness** that has read its event slice. There is no vector index inside the shard; "probing" the shard means asking an LLM to read the slice and report relevance. |
| **Routing mechanism** | Masked MoE — learned gating over shard families with cost-aware Top-B_probe / adaptive Top-P | Keyword/tag scorer (Phase 0); LLM probe stage filters candidates. The router is a deterministic CPU pass; the probe is a small LLM call. |
| **Mutation discipline** | Shards mutable; writes validated against scope metadata; ANN index updated in-place | **Branch-and-discard read path with SHA-256 hash enforcement** (`tests/mutationSafety.test.ts`). Durable writes only through the explicit Committer protocol with immutable versioned snapshots (S001, S002, …) and an audit trail. |
| **Citation requirements** | Implicit via the evidence the ANN happens to surface | **Mandatory**: every claim must cite `shard_id@snapshot_id:event_id`. The synthesiser's `MemoryPacket.keyClaims[].sources` carries the trail through to the answering call. |
| **Recall mechanism** | ANN nearest-neighbour lookup within selected shards | LLM-generated claims with explicit event-ID `support` arrays. Recall is generative reasoning over an event slice, not similarity search. |

**CSM's genuine novelty within this neighbourhood:**

1. **Shards are LLM witnesses, not vector indexes.** This is the single most consequential architectural choice and it is what makes CSM's read path generative rather than retrieval-shaped. The trade-off is real: CSM probe + recall costs per-shard are O(LLM call), where ShardMemo's are O(ANN lookup). The benefit is that the shard can reason about relevance, paraphrase, and partial matches — and that "what did this shard remember" is a generative question with a citation-bearing answer, not a returned chunk.
2. **Cryptographically-enforced read-only invariant.** ShardMemo's spec permits in-place shard mutation; CSM forbids it outside the Committer. The mutation-safety test (`tests/mutationSafety.test.ts`) hashes every file the read path could touch *before* and *after* a query and fails the build if any byte changes. This appears genuinely novel — no cited paper in the survey enforces storage immutability through a hash-checked query path.
3. **Mandatory event-ID citations bake provenance into the answer.** ShardMemo's provenance is only what the ANN happens to surface; CSM's is mechanically required by the prompt + schema and downstream consumers can refuse claims without `support`. Citation precision/recall becomes a first-class quality axis, not a derived one.

### 26.3 What CSM is *not*

- CSM is not a graph-RAG system. We have no LLM-extracted entity or triple graph at index time; we have a keyword/tag scorer plus per-shard LLM witnesses. If you measure us on multi-hop graph traversal (MuSiQue, 2WikiMultihopQA, HotpotQA), HippoRAG 2 will typically beat us at scales where its graph can be indexed cheaply. We don't make a graph-RAG claim.
- CSM is not an agentic-memory layer in the Mem0 sense. We don't distill conversation turns into a separate fact store at ingest; the durable memory IS the event log, and the LLM witnesses read the raw log. The Committer is the only path that adds new events.
- CSM is not a long-context replacement. The main agent still has a bounded context; the value comes from selecting and synthesising the right subset, not from eliminating context limits.

### 26.4 Where CSM is expected to win

- **High corpus mutation rate**: when the corpus changes faster than ~200-20,000 queries per re-index, graph/hierarchical RAG systems pay an LLM-extraction tax on every re-build that CSM does not.
- **Corpus scale above the indexing ceiling**: at ≥ 10M tokens on consumer hardware, HippoRAG/LightRAG/GraphRAG cannot be indexed in any practical wall-clock. CSM's indexing is keyword-level (no LLMs) and is essentially free.
- **Citation-sensitive applications**: where every claim must trace to specific events, CSM's mandatory `shard@snapshot:event_id` discipline gives stronger guarantees than ANN-surfaced provenance.
- **Trust-graded memory**: CSM's `trustLevel` field (`user_memory` | `project_memory` | `imported_doc` | `inferred`) flows through to packet caveats; the answering model knows which sources are user-confirmed vs system-inferred. None of the surveyed systems treat trust as a first-class scalar.

### 26.5 Where CSM is expected to lose or break even

- **Static knowledge bases queried at high volume.** When you can index once and amortise across millions of queries, HippoRAG 2's graph beats CSM's per-query LLM pipeline on both accuracy and per-query cost.
- **Pure single-hop factual retrieval** on small corpora that fit a single shard. CSM's pipeline adds latency the task doesn't need; a plain bi-encoder + LLM beats us on cost.
- **Conversational memory where dialogue is the primary input.** Mem0's fact-distillation pipeline is purpose-built for this shape; CSM treats events generically and doesn't extract turn-level facts.

These are not weaknesses to hide — they're the boundary of the design. The benchmark roadmap (PaySwift MCQ + BABILong free-form, both at 100K → 1M → 10M → 100M → 1B corpus sizes) is structured to measure exactly where CSM crosses and falls back below the SOTA on each axis.
