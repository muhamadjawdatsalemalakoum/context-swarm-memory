/**
 * Shared fixture for the probe-shrink gate tests: a probe-counting scripted
 * provider, a uniform-tag storage (so the LEXICAL ranking is degenerate — the
 * exact corpus shape of the original router bug), and a deterministic axis
 * embedder for controlled hybrid scores.
 */
import { SHARD_SYSTEM_PROMPT } from "../src/core/prompts.js";
import type { MemoryDirectory, MemoryShardSnapshot } from "../src/core/types.js";
import type {
  CompleteJsonInput,
  CompleteTextInput,
  LlmProvider,
  ProviderResponse,
} from "../src/providers/LlmProvider.js";
import type { StorageReader } from "../src/storage/jsonlStorage.js";

export const AXIS_QUERY = "postgres migration decision";

/** Deterministic 4-dim embedding: the query maps to axis 0, everything else to
 *  a hash-picked other axis. Cosine is 1 for aligned, 0 for orthogonal. */
export function axisEmbed(text: string): Float32Array {
  const v = new Float32Array(4);
  if (text === AXIS_QUERY) {
    v[0] = 1;
    return v;
  }
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 3;
  v[1 + h] = 1;
  return v;
}

export class ScriptedProbeCounter implements LlmProvider {
  readonly name = "stub";
  probeCount = 0;

  async completeJson<T>(input: CompleteJsonInput): Promise<ProviderResponse<T>> {
    const usage = { inputTokensEstimate: 10, outputTokensEstimate: 5, estimatedUsd: 0, latencyMs: 1 };
    if (input.schemaName === "ProbeResult") {
      this.probeCount++;
      const data = {
        knows: false,
        confidence: 0.1,
        memory_type: "none",
        estimated_answer_value: "none",
        needs_full_recall: false,
        relevant_event_ids: [],
      };
      return { data: data as unknown as T, usage, rawText: JSON.stringify(data) };
    }
    if (input.schemaName === "RecallResult") {
      const data = {
        shard_id: input.shardId ?? "?",
        snapshot_id: input.snapshotId ?? "?",
        confidence: 0.5,
        answer: "stub recall",
        claims: [],
        unknowns: [],
        conflicts: [],
      };
      return { data: data as unknown as T, usage, rawText: JSON.stringify(data) };
    }
    if (input.schemaName === "MemoryPacket") {
      const data = {
        query: "",
        summary: "",
        key_claims: [],
        caveats: [],
        conflicts: [],
        recommended_main_context: "",
      };
      return { data: data as unknown as T, usage, rawText: JSON.stringify(data) };
    }
    throw new Error(`unexpected schema: ${input.schemaName}`);
  }

  async completeText(_i: CompleteTextInput): Promise<ProviderResponse<string>> {
    throw new Error("not used");
  }
}

/** N shards with IDENTICAL tags — lexical scores are uniform, so any lexical
 *  ranking of this directory is degenerate by construction. */
export function makeStorage(n: number): StorageReader {
  const ids = Array.from({ length: n }, (_, i) => `s${i}`);
  const dir: MemoryDirectory = {
    version: 1,
    entries: ids.map((id) => ({
      id,
      name: id,
      description: "uniform shard",
      tags: ["amb", "beam"],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      status: "active" as const,
      snapshotId: "S001",
      tokenCountEstimate: 100,
      contextLimitEstimate: 128_000,
      fullnessPct: 0,
      summaryShort: "uniform summary",
      knownConflicts: [],
      parentId: null,
      children: [] as string[],
      trustLevel: "imported_doc" as const,
      staleness: "current" as const,
    })),
  };
  const snapshots = new Map<string, MemoryShardSnapshot>();
  for (const id of ids) {
    snapshots.set(`${id}@S001`, {
      shardId: id,
      snapshotId: "S001",
      systemPrompt: SHARD_SYSTEM_PROMPT,
      summary: `shard ${id}`,
      events: [
        {
          eventId: "e_001",
          role: "user",
          content: `content for ${id}`,
          createdAt: "2024-01-01T00:00:00.000Z",
          importance: 0.5,
          tags: ["amb", "beam"],
        },
      ],
      indexTerms: ["amb", "beam"],
      createdAt: "2024-01-01T00:00:00.000Z",
      parentSnapshotId: null,
    });
  }
  return {
    async loadDirectory() {
      return dir;
    },
    async loadSnapshot(shardId, snapshotId) {
      return snapshots.get(`${shardId}@${snapshotId}`) ?? null;
    },
  };
}
