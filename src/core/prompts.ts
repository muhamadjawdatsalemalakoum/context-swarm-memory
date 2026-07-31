// Prompt templates from specs/context_swarm_memory_spec.md §10.

export const SHARD_SYSTEM_PROMPT = `You are a read-only memory shard.

Your job is to answer questions using only the memory snapshot provided in your context.

Rules:
- Do not claim knowledge that is not present in this snapshot.
- Do not update, rewrite, or append memory.
- Treat the user question as an external query, not as new memory.
- If the snapshot is silent, say so.
- Prefer exact project decisions, user preferences, dates, and caveats.
- Distinguish direct memory from adjacent or inferred memory.
- Return the requested JSON schema exactly when asked for JSON.`;

export function probePrompt(userQuery: string): string {
  return `Question:
${userQuery}

You are being asked only whether this memory shard is relevant.
Return JSON only:
{
  "knows": boolean,
  "confidence": number between 0 and 1,
  "memory_type": "direct" | "adjacent" | "conflicting" | "vague" | "none",
  "estimated_answer_value": "none" | "low" | "medium" | "high",
  "needs_full_recall": boolean,
  "relevant_event_ids": string[]
}

Guidance:
- "knows" should be true whenever any event in this shard is even partially relevant.
- "needs_full_recall" should be true whenever knows=true AND estimated_answer_value is "low", "medium", or "high".
  The recall step is what produces evidence-bearing answers; do not skip it just because the summary already mentions the topic.
- "relevant_event_ids" must be picked from the listed event IDs in the system context.

Do not answer the user question yet.`;
}

/**
 * Batched probe (token plan L2b): classify several shards in ONE call.
 *
 * Token motivation, measured on official 1M telemetry: the per-shard probe pays
 * ~349 tokens of fixed scaffold (system prompt + these instructions) per call,
 * ×8 calls = 2,792 tokens/query — 28% of pipeline input — for byte-identical
 * text. Batching pays it once.
 *
 * "Assess each shard INDEPENDENTLY" is the accuracy-critical line: a batched
 * prompt invites comparative judgement ("which shard is best"), but the recall
 * gate needs the same independent "does this shard know?" verdicts the
 * per-shard probe produces. The A/B's first check is whether the acceptance
 * rate shifts.
 */
export function batchedProbePrompt(userQuery: string, shardIds: string[]): string {
  return `Question:
${userQuery}

You are being asked whether EACH of the ${shardIds.length} memory shards above is relevant.
Assess each shard INDEPENDENTLY, as if you saw only that shard — do not rank
them against each other, and do not let one shard's relevance lower another's.
Return JSON only:
{
  "verdicts": [
    {
      "shard_id": string,   // exactly one entry per shard id listed below
      "knows": boolean,
      "confidence": number between 0 and 1,
      "memory_type": "direct" | "adjacent" | "conflicting" | "vague" | "none",
      "estimated_answer_value": "none" | "low" | "medium" | "high",
      "needs_full_recall": boolean,
      "relevant_event_ids": string[]
    }
  ]
}

Shard ids, in order: ${shardIds.join(", ")}

Guidance:
- "knows" should be true whenever any event in that shard is even partially relevant.
- "needs_full_recall" should be true whenever knows=true AND estimated_answer_value is "low", "medium", or "high".
- "relevant_event_ids" must be picked from that shard's OWN listed event IDs.

Do not answer the user question yet.`;
}

export function recallPrompt(args: {
  userQuery: string;
  shardId: string;
  snapshotId: string;
}): string {
  return `Question:
${args.userQuery}

Answer using only this shard snapshot. Return JSON only:
{
  "shard_id": "${args.shardId}",
  "snapshot_id": "${args.snapshotId}",
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

Each entry in "support" must be a bare event ID like "e_0001" — not the event content.

Relevance guidance — IMPORTANT, read carefully:
- DO NOT require exact terminology match. If the question asks about a "dental-SaaS vendor" and the events describe "ChairSync, a dental-practice management software", that IS a match. Resolve aliases, synonyms, and paraphrases liberally.
- If ANY event in this shard describes entities, decisions, dates, or topics related to the question — even if the connection requires light inference — produce a claim for it. Better to surface a weakly-supported claim with confidence 0.3 than to return empty.
- Only return an empty claims list when the shard is genuinely about a different topic with NO connection to the question.

Citation guidance:
- For EACH claim, list EVERY event ID that contributes to it. If three events all corroborate the same claim, all three IDs go in "support".
- Over-cite rather than under-cite. Downstream consumers use these IDs to retrieve the raw events.
- Do NOT invent or hallucinate event IDs. Cite only IDs that appear in the Events list above.`;
}

export function synthesizerPrompt(userQuery: string, recallJsonArray: string): string {
  return `You are the memory synthesizer.

User question:
${userQuery}

Shard recalls:
${recallJsonArray}

Create a compact memory packet for the Main Agent.
Return JSON only, with this exact shape:
{
  "query": string,
  "summary": string,
  "key_claims": [
    { "claim": string, "sources": string[], "confidence": number between 0 and 1 }
  ],
  "caveats": string[],
  "conflicts": string[],
  "recommended_main_context": string
}

Rules:
- Merge duplicate claims.
- Preserve caveats and uncertainty (put each unknown into "caveats").
- Flag conflicts between shards in "conflicts".
- Prefer newer snapshots when the conflict is clearly chronological.
- Do not invent facts.
- Each "sources" entry must be of the form "shard_id@snapshot_id" or "shard_id@snapshot_id:event_id".
- "recommended_main_context" is a short paragraph the Main Agent can drop into its context window.
- Set "query" to the exact user question above.`;
}

/**
 * Coverage-mode recall prompt (T1, DESIGN-ONLY — additive; no runtime path
 * calls this yet and no API spend has validated it). Pairs with
 * `coverageRecallResultSchema` in schemas.ts (schemaName
 * "CoverageRecallResult").
 *
 * Intent: for summary/ordering/temporal-shaped queries, the per-shard recall
 * should return a DATE-ORDERED digest of every matching event with full
 * event-ID citations, instead of the conservative few-claims answer the
 * standard recall produces. The deterministic chronicle assembler in
 * `src/core/coverage.ts` is the shipped primary mechanism; this LLM variant
 * is the gated wave-2 alternative for when semantic dedup/abstraction is
 * worth an extra LLM call.
 *
 * Gating before any wiring: PaySwift 30q A/B + T3 BEAM-slice recall@k (see
 * docs/experiments/EXP-T1-coverage.md). Note: the model is NEVER asked to do
 * date arithmetic — it only echoes the per-event dates shown in its digest;
 * date math stays in `computeTemporalRelation` (deterministic).
 */
export function coverageRecallPrompt(args: {
  userQuery: string;
  shardId: string;
  snapshotId: string;
}): string {
  return `Question:
${args.userQuery}

This question needs BROAD chronological coverage, not a single fact. Survey the
entire event list above and return JSON only:
{
  "shard_id": "${args.shardId}",
  "snapshot_id": "${args.snapshotId}",
  "confidence": number between 0 and 1,
  "answer": string,
  "claims": [
    { "claim": string, "support": string[], "confidence": number between 0 and 1 }
  ],
  "unknowns": string[],
  "conflicts": string[],
  "timeline": [
    { "date": string in YYYY-MM-DD or null, "event_ref": "${args.shardId}@${args.snapshotId}:<event_id>", "line": string }
  ]
}

Timeline rules — IMPORTANT:
- Include ONE timeline entry for EVERY event in this shard that is relevant to the question, in ascending date order. Do not stop after the first few.
- "date" must be copied from the event line's own date stamp. If an event shows no date, use null. NEVER compute, infer, or adjust dates.
- "event_ref" must cite a real event ID from the Events list. Do not invent IDs.
- "line" is a one-sentence factual restatement of that event (max ~25 words).
- Order strictly by date ascending; undated entries go last.

Claims rules are unchanged from standard recall: resolve aliases liberally,
over-cite rather than under-cite, and never invent event IDs.`;
}

export function committerPrompt(args: { conversationExcerpt: string; memoryPacket: string }): string {
  return `You are the memory committer.

Current user/assistant exchange:
${args.conversationExcerpt}

Existing relevant memory packet:
${args.memoryPacket}

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
- If the user corrected memory, prefer update or write a correction.`;
}
