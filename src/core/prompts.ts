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
