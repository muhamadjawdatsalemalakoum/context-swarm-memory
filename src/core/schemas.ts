import { z } from "zod";

/**
 * LLM-tolerant confidence field.
 *
 * Even with `response_format: { type: "json_object" }`, local Gemma 4 31B
 * occasionally emits `"confidence": "0.8"` (string) instead of `0.8` (number)
 * — usually on the Nth claim of a multi-claim recall, after several previous
 * claims serialised correctly. Strict `z.number()` then fails the entire
 * recall response and the pipeline drops every claim it produced. Observed
 * in real bench runs after the recall prompt was updated to encourage
 * comprehensive citation (which raised the per-call claim count).
 *
 * `z.coerce.number()` does `Number(v)` first, so `"0.8"` → `0.8`. Out-of-
 * range values are still rejected by min/max — we don't silently clamp
 * because that would mask other model errors.
 */
const llmConfidence = z.coerce.number().min(0).max(1);

export const probeResultSchema = z.object({
  knows: z.boolean(),
  confidence: llmConfidence,
  memory_type: z.enum(["direct", "adjacent", "conflicting", "vague", "none"]),
  estimated_answer_value: z.enum(["none", "low", "medium", "high"]),
  needs_full_recall: z.boolean(),
  // `likely_conflicts` and `reason` were removed in Phase α (2026-05) — they
  // were never read downstream (`reason` was CLI-debug-only) and the model
  // spent ~30-80 output tokens per probe generating them. Zod's default
  // strict mode passes through unknown keys, so cached responses written
  // before this change continue to parse cleanly.
  relevant_event_ids: z.array(z.string()),
});
export type ProbeResultJson = z.infer<typeof probeResultSchema>;

/** Strict per-claim shape — used inside the tolerant array below. */
const claimSchema = z.object({
  claim: z.string(),
  support: z.array(z.string()),
  confidence: llmConfidence,
});

type Claim = z.infer<typeof claimSchema>;
/**
 * Tolerant array-of-claims. When the LLM emits N claims and one is malformed
 * (e.g., wrong type on `confidence`, missing `support`), strict validation
 * drops ALL N claims — wasting the entire recall call. Real-bench data showed
 * this happens at ~4+ claims (a single bad item kills the whole array).
 *
 * Post-fix: each item is `safeParse`'d individually; bad items are dropped,
 * good items survive. Net effect: more claims reach the synthesizer, more
 * events reach the answering context.
 */
const tolerantClaimsArray = z
  .array(z.unknown())
  .transform((arr): Claim[] => {
    const good: Claim[] = [];
    for (const item of arr) {
      const r = claimSchema.safeParse(item);
      if (r.success) good.push(r.data);
    }
    return good;
  });

export const recallResultSchema = z.object({
  shard_id: z.string(),
  snapshot_id: z.string(),
  confidence: llmConfidence,
  answer: z.string(),
  claims: tolerantClaimsArray,
  unknowns: z.array(z.string()),
  conflicts: z.array(z.string()),
});
export type RecallResultJson = z.infer<typeof recallResultSchema>;

const keyClaimSchema = z.object({
  claim: z.string(),
  sources: z.array(z.string()),
  confidence: llmConfidence,
});

type KeyClaim = z.infer<typeof keyClaimSchema>;
/** Same per-item tolerance as `tolerantClaimsArray` — see comment there. */
const tolerantKeyClaimsArray = z
  .array(z.unknown())
  .transform((arr): KeyClaim[] => {
    const good: KeyClaim[] = [];
    for (const item of arr) {
      const r = keyClaimSchema.safeParse(item);
      if (r.success) good.push(r.data);
    }
    return good;
  });

export const memoryPacketSchema = z.object({
  query: z.string(),
  summary: z.string(),
  key_claims: tolerantKeyClaimsArray,
  caveats: z.array(z.string()),
  conflicts: z.array(z.string()),
  recommended_main_context: z.string(),
});
export type MemoryPacketJson = z.infer<typeof memoryPacketSchema>;

export const commitDecisionSchema = z.object({
  action: z.enum(["write", "update", "split", "merge", "freeze", "no_op", "ask_confirmation"]),
  target_shard_id: z.string().nullable(),
  memory_type: z.enum([
    "user_preference",
    "project_decision",
    "fact",
    "correction",
    "inference",
    "none",
  ]),
  content: z.string(),
  confidence: z.number().min(0).max(1),
  requires_user_confirmation: z.boolean(),
  tags: z.array(z.string()),
  source: z.enum(["current_conversation", "user_confirmation", "system_inference"]),
});
export type CommitDecisionJson = z.infer<typeof commitDecisionSchema>;
