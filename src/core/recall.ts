import type { LlmProvider, ProviderUsage } from "../providers/LlmProvider.js";
import type { MemoryShardSnapshot, RecallClaim, RecallResult } from "./types.js";
import { recallResultSchema } from "./schemas.js";
import { completeAndValidate } from "./providerJson.js";
import { recallPrompt, SHARD_SYSTEM_PROMPT } from "./prompts.js";
import { tokenize } from "./router.js";
import { estimateTokens } from "./tokenBudget.js";

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
}): Promise<{ result: RecallResult; usage: ProviderUsage }> {
  const {
    provider,
    userQuery,
    snapshot,
    relevantEventIdsHint,
    maxRecallTokensPerShard = 1200,
    model,
  } = args;
  const isMock = provider.name === "mock";

  const eventDigest = scopedEventDigest(snapshot, relevantEventIdsHint, maxRecallTokensPerShard);

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
): string {
  const allEvents = snapshot.events;
  let candidates: typeof allEvents;
  if (hint && hint.length) {
    const hintSet = new Set(hint);
    const inHint = allEvents.filter((e) => hintSet.has(e.eventId));
    const outOfHint = allEvents.filter((e) => !hintSet.has(e.eventId));
    candidates = [...inHint, ...outOfHint];
  } else {
    candidates = allEvents;
  }

  const lines: string[] = [];
  let usedTokens = 0;
  for (const e of candidates) {
    const line = `- [${e.eventId}] (${e.role}) ${truncate(e.content, 480)}${
      e.tags.length ? `  tags=[${e.tags.join(",")}]` : ""
    }`;
    const lineTokens = estimateTokens(line);
    if (usedTokens + lineTokens > maxTokens) {
      lines.push(`- (… ${candidates.length - lines.length} more events truncated to fit budget)`);
      break;
    }
    lines.push(line);
    usedTokens += lineTokens;
  }
  return lines.join("\n") || "(no events)";
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

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
