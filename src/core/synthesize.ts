import type { LlmProvider, ProviderUsage } from "../providers/LlmProvider.js";
import type { MemoryPacket, MemoryPacketClaim, RecallResult } from "./types.js";
import { memoryPacketSchema } from "./schemas.js";
import { completeAndValidate } from "./providerJson.js";
import { synthesizerPrompt } from "./prompts.js";

export async function synthesizeMemoryPacket(args: {
  provider: LlmProvider;
  userQuery: string;
  recalls: RecallResult[];
  model?: string;
}): Promise<{ packet: MemoryPacket; usage: ProviderUsage }> {
  const { provider, userQuery, recalls, model } = args;
  const isMock = provider.name === "mock";

  let promptSuffix = "";
  if (isMock) {
    const baked = mockSynthesize(userQuery, recalls);
    promptSuffix = `\n\n<<MOCK_RESULT>>${JSON.stringify(baked)}<</MOCK_RESULT>>`;
  }

  const recallJson = JSON.stringify(
    recalls.map((r) => ({
      shard_id: r.shardId,
      snapshot_id: r.snapshotId,
      confidence: r.confidence,
      answer: r.answer,
      claims: r.claims,
      unknowns: r.unknowns,
      conflicts: r.conflicts,
    })),
    null,
    2,
  );

  const { data, usage } = await completeAndValidate(
    provider,
    {
      system: "You are the memory synthesizer. Produce only JSON matching the requested schema.",
      prompt: `${synthesizerPrompt(userQuery, recallJson)}\n\n${promptSuffix}`,
      schemaName: "MemoryPacket",
      // Synth merges multiple recalls into one packet. With the post-audit
      // recall prompt encouraging comprehensive citation, each recall now
      // produces more claims; merging N recalls × ~4 claims each can push
      // synth output past 2048. Mirror the recall budget bump.
      maxOutputTokens: 4096,
      temperature: 0,
      model,
    },
    memoryPacketSchema,
  );

  return {
    packet: {
      query: data.query,
      summary: data.summary,
      // Cast is safe: `tolerantKeyClaimsArray` in schemas.ts validates every
      // item individually. See parallel comment in `recall.ts`.
      keyClaims: data.key_claims as MemoryPacketClaim[],
      caveats: data.caveats,
      conflicts: data.conflicts,
      recommendedMainContext: data.recommended_main_context,
    },
    usage,
  };
}

/** Build a MemoryPacket from a single recall without an LLM call.
 *  Efficiency win: synth is the most expensive stage; skipping it when there's
 *  only one shard to merge gives back roughly 1/3 of the per-query cost. */
export function packetFromSingleRecall(userQuery: string, r: RecallResult): MemoryPacket {
  const sourceTag = `${r.shardId}@${r.snapshotId}`;
  return {
    query: userQuery,
    summary: r.answer,
    keyClaims: r.claims.map((c) => ({
      claim: c.claim,
      sources: c.support.map((s) => `${sourceTag}:${s}`),
      confidence: c.confidence,
    })),
    caveats: r.unknowns,
    conflicts: r.conflicts,
    recommendedMainContext: `${sourceTag}: ${r.answer}`,
  };
}

export function emptyPacket(userQuery: string): MemoryPacket {
  return {
    query: userQuery,
    summary: "No relevant memory found in any consulted shard.",
    keyClaims: [],
    caveats: ["Searched shards yielded no recall."],
    conflicts: [],
    recommendedMainContext: "No memory packet available; answer from general knowledge.",
  };
}

// ─── Phase 0 mock implementation (only used when provider.name === "mock" and N>=2) ──
function mockSynthesize(userQuery: string, recalls: RecallResult[]) {
  if (recalls.length === 0) {
    return {
      query: userQuery,
      summary: "No relevant memory found in any consulted shard.",
      key_claims: [],
      caveats: ["Searched shards yielded no recall."],
      conflicts: [],
      recommended_main_context: "No memory packet available; answer from general knowledge.",
    };
  }

  type Bucket = { claim: string; sources: Set<string>; confidence: number };
  const buckets: Bucket[] = [];

  for (const r of recalls) {
    const tag = `${r.shardId}@${r.snapshotId}`;
    for (const c of r.claims) {
      const norm = c.claim.trim().toLowerCase();
      const existing = buckets.find(
        (b) => b.claim.toLowerCase().includes(norm) || norm.includes(b.claim.toLowerCase()),
      );
      const sourceTags = c.support.map((s) => `${tag}:${s}`);
      if (existing) {
        for (const s of sourceTags) existing.sources.add(s);
        existing.confidence = Math.max(existing.confidence, c.confidence);
      } else {
        buckets.push({
          claim: c.claim.trim(),
          sources: new Set(sourceTags),
          confidence: c.confidence,
        });
      }
    }
  }

  const keyClaims = buckets
    .sort((a, b) => b.confidence - a.confidence)
    .map((b) => ({
      claim: b.claim,
      sources: [...b.sources],
      confidence: round2(b.confidence),
    }));

  const caveats = recalls.flatMap((r) => r.unknowns);
  const conflicts = recalls.flatMap((r) => r.conflicts);

  const top = recalls
    .slice()
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 2)
    .map((r) => `${r.shardId}@${r.snapshotId}: ${r.answer}`)
    .join("\n\n");

  return {
    query: userQuery,
    summary:
      keyClaims.length > 0
        ? keyClaims
            .slice(0, 3)
            .map((k) => `- ${k.claim}`)
            .join("\n")
        : "Recalls returned no concrete claims.",
    key_claims: keyClaims,
    caveats,
    conflicts,
    recommended_main_context: top,
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
