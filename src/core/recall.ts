import type { LlmProvider, ProviderUsage } from "../providers/LlmProvider.js";
import type { MemoryShardSnapshot, RecallClaim, RecallResult } from "./types.js";
import { recallResultSchema } from "./schemas.js";
import { completeAndValidate } from "./providerJson.js";
import { recallPrompt, SHARD_SYSTEM_PROMPT } from "./prompts.js";
import { tokenize } from "./router.js";
import { selectEventDigest, truncate } from "./digestSelection.js";

export async function recallShard(args: {
  provider: LlmProvider;
  userQuery: string;
  snapshot: MemoryShardSnapshot;
  /** From the probe step. When non-empty, recall context is scoped to just these
   *  events plus a small set of neighbours, dramatically shrinking input tokens. */
  relevantEventIdsHint?: string[];
  /** Hard cap on event-digest input tokens to keep recall calls bounded. */
  maxRecallTokensPerShard?: number;
  model?: string;
  /** Signals lever (CSM_SIGNALS_RANKER). When true, the event digest is built
   *  with query-aware reordering + salient intra-event truncation instead of
   *  blind insertion-order head-truncation. Default false (blind). */
  useSignalsRanker?: boolean;
}): Promise<{ result: RecallResult; usage: ProviderUsage }> {
  const {
    provider,
    userQuery,
    snapshot,
    relevantEventIdsHint,
    maxRecallTokensPerShard = 1200,
    model,
    useSignalsRanker,
  } = args;
  const isMock = provider.name === "mock";

  const eventDigest = scopedEventDigest(snapshot, relevantEventIdsHint, maxRecallTokensPerShard, {
    query: userQuery,
    signalsRanker: useSignalsRanker,
  });

  let promptSuffix = "";
  if (isMock) {
    const baked = mockRecall(userQuery, snapshot, relevantEventIdsHint);
    promptSuffix = `\n\n<<MOCK_RESULT>>${JSON.stringify(baked)}<</MOCK_RESULT>>`;
  }

  // PREFIX-CACHE CONTRACT (Phase α): see comment in src/core/probe.ts. The
  // literal `SHARD_SYSTEM_PROMPT` must be the first bytes of `system`, byte-
  // identical across every recall call in a query. Pinned by
  // tests/prefixCacheContract.test.ts.
  const system = `${SHARD_SYSTEM_PROMPT}

[Shard ${snapshot.shardId}@${snapshot.snapshotId}]
Summary:
${snapshot.summary}

Events:
${eventDigest}`;

  const { data, usage } = await completeAndValidate(
    provider,
    {
      system,
      prompt:
        recallPrompt({ userQuery, shardId: snapshot.shardId, snapshotId: snapshot.snapshotId }) +
        promptSuffix,
      schemaName: "RecallResult",
      // 2048 was sufficient for the pre-audit recall (tight scope: only
      // probe-hinted events, 1-2 claims). Post-audit recall sees MORE events
      // (priority-ordered hint + fill from shard) and is prompted to
      // comprehensively cite (more claims, each with longer support arrays).
      // The 31B model's chain-of-thought routinely consumed all 2048 tokens
      // before emitting valid JSON — observed on q23 in csm-audit-fix-10q
      // ("Could not parse JSON from response:" with empty content). 4096
      // gives the recall LLM headroom for both the bigger digest and the
      // bigger output, matching the final-answer call.
      maxOutputTokens: 4096,
      temperature: 0,
      model,
      shardId: snapshot.shardId,
      snapshotId: snapshot.snapshotId,
    },
    recallResultSchema,
  );

  return {
    result: {
      shardId: data.shard_id,
      snapshotId: data.snapshot_id,
      confidence: data.confidence,
      answer: data.answer,
      // Cast is safe: `tolerantClaimsArray` in schemas.ts validates every item
      // individually via `claimSchema.safeParse`, so anything that reaches here
      // has the shape `RecallClaim`. The cast exists only because Zod 3.x
      // reports `z.array(z.unknown()).transform()` as `unknown[]` through
      // `z.infer`, even though the transform return type is precise.
      claims: data.claims as RecallClaim[],
      unknowns: data.unknowns,
      conflicts: data.conflicts,
    },
    usage,
  };
}

/** Build the per-shard event digest shown to the recall LLM.
 *
 * Pre-fix behaviour (the bug this audit found): when the probe provided a
 * `hint` (its `relevant_event_ids`), recall HARD-FILTERED to ONLY those
 * events. Any event the probe missed — even if relevant — was permanently
 * dropped before the recall LLM ever saw it. With an 8B probe model and a
 * 1200-char compact event index, the probe is often INCOMPLETE; that
 * incompleteness then becomes invisible loss in recall.
 *
 * Post-fix: the hint is treated as a PRIORITY ORDER, not a filter. Hinted
 * events go first (so recall sees the probe's signal); any remaining
 * `maxTokens` budget is filled with the rest of the shard's events. The
 * input-token cost is unchanged — we still respect the budget. Pre-fix,
 * after hint-events fit, leftover budget went to waste; now it goes to
 * additional shard events, giving recall a chance to discover claims the
 * probe missed.
 *
 * No-hint behaviour is unchanged (insertion-order, budget-capped).
 */
function scopedEventDigest(
  snapshot: MemoryShardSnapshot,
  hint: string[] | undefined,
  maxTokens: number,
  opts?: { query?: string; signalsRanker?: boolean },
): string {
  if (opts?.signalsRanker) {
    // Signals mode: query-aware reordering (lever #1) + salient intra-event
    // truncation (lever #2). Pure/deterministic; the [eXXXX]/role/date prefix is
    // rendered outside the scored span, so citation tokens stay byte-verbatim.
    return selectEventDigest(snapshot.events, {
      maxTokens,
      hint,
      reorderBySalience: true,
      salientTruncation: true,
      query: opts.query ?? "",
    }).text;
  }
  // Blind mode (no salience levers): byte-identical to the legacy builder —
  // hint-priority order, 480-char head-truncation, greedy budget pack, and the
  // `(… N more events truncated)` overflow marker.
  return selectEventDigest(snapshot.events, { maxTokens, hint }).text;
}

// ─── Phase 0 mock implementation (only used when provider.name === "mock") ──
function mockRecall(
  userQuery: string,
  snapshot: MemoryShardSnapshot,
  hint?: string[],
) {
  const qTerms = new Set(tokenize(userQuery));
  const scored = snapshot.events
    .map((e) => {
      const evTerms = new Set([
        ...tokenize(e.content),
        ...e.tags.flatMap((t) => tokenize(t)),
      ]);
      let score = 0;
      for (const q of qTerms) if (evTerms.has(q)) score++;
      if (hint?.includes(e.eventId)) score += 1;
      return { e, score };
    })
    .sort((a, b) => b.score - a.score);

  const picks = scored.filter((s) => s.score > 0).slice(0, 3);
  if (picks.length === 0) {
    return {
      shard_id: snapshot.shardId,
      snapshot_id: snapshot.snapshotId,
      confidence: 0.0,
      answer: "This shard does not contain information about the query.",
      claims: [],
      unknowns: [`No events in this shard mention: ${[...qTerms].slice(0, 5).join(", ")}`],
      conflicts: [],
    };
  }

  const claims = picks.map((p) => ({
    claim: truncate(p.e.content, 240),
    support: [p.e.eventId],
    confidence: Math.min(0.95, 0.5 + p.score * 0.1),
  }));

  return {
    shard_id: snapshot.shardId,
    snapshot_id: snapshot.snapshotId,
    confidence: Math.min(0.95, 0.4 + picks.length * 0.15),
    answer: `Based on ${picks.length} relevant event(s) in ${snapshot.shardId}@${snapshot.snapshotId}: ${truncate(picks[0]!.e.content, 320)}`,
    claims,
    unknowns: [],
    conflicts: [],
  };
}
