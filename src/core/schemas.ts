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

/** One timeline line in coverage-mode LLM output (T1). Strict per-item shape
 *  used inside the tolerant array below. `event_ref` must be the full
 *  "shard_id@snapshot_id:event_id" citation. */
const timelineEntrySchema = z.object({
  date: z.string().nullable(),
  event_ref: z.string(),
  line: z.string(),
});

type TimelineEntry = z.infer<typeof timelineEntrySchema>;
/** Same per-item tolerance as `tolerantClaimsArray` — see comment there. */
const tolerantTimelineArray = z
  .array(z.unknown())
  .transform((arr): TimelineEntry[] => {
    const good: TimelineEntry[] = [];
    for (const item of arr) {
      const r = timelineEntrySchema.safeParse(item);
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
  // Additive (T1 coverage): the synth prompt does not request a timeline
  // today, so this is absent on every current path and on all cached
  // responses. It exists so a future gated synth/coverage-recall prompt can
  // emit one without a schema change.
  timeline: tolerantTimelineArray.optional(),
});
export type MemoryPacketJson = z.infer<typeof memoryPacketSchema>;

/**
 * Coverage-mode recall output (T1, DESIGN-ONLY — not wired to any runtime
 * path yet). The gated "coverage recall" prompt variant
 * (`coverageRecallPrompt` in prompts.ts) asks the shard for a date-ordered,
 * citation-complete digest of ALL matching events in addition to the normal
 * claims. Kept additive and separate from `recallResultSchema` so the
 * existing recall path stays byte-identical.
 *
 * Merge-window note: when this ships, `CSM_JSON_SCHEMAS` in
 * `src/providers/GeminiProvider.ts` (T4's file) gets a
 * "CoverageRecallResult" entry; until then absence degrades gracefully
 * (providerJson retry + this Zod schema still validate).
 */
export const coverageRecallResultSchema = z.object({
  shard_id: z.string(),
  snapshot_id: z.string(),
  confidence: llmConfidence,
  answer: z.string(),
  claims: tolerantClaimsArray,
  unknowns: z.array(z.string()),
  conflicts: z.array(z.string()),
  timeline: tolerantTimelineArray,
});
export type CoverageRecallResultJson = z.infer<typeof coverageRecallResultSchema>;

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
