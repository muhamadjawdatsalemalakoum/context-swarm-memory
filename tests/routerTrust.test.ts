import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ask } from "../src/core/ask.js";
import type {
  MemoryDirectory,
  MemoryShardSnapshot,
  ProbeResult,
  RecallResult,
} from "../src/core/types.js";
import { SHARD_SYSTEM_PROMPT } from "../src/core/prompts.js";
import type { StorageReader } from "../src/storage/jsonlStorage.js";
import type {
  CompleteJsonInput,
  CompleteTextInput,
  LlmProvider,
  ProviderResponse,
} from "../src/providers/LlmProvider.js";

/**
 * Router-trust safety-net regression test.
 *
 * Real-bench failure (q11 in csm-vs-baselines-10q + csm-audit-fix-10q): the
 * router correctly picked `s-customers` as the #1 candidate for a dental-SaaS
 * LOI question, but the 8B probe model said `knows: false` because the
 * truncated event index didn't surface the ChairSync events. With probe-only
 * gating, the recall queue was empty for the correct shard and the pipeline
 * returned 0 packed events.
 *
 * Fix in `src/core/ask.ts`: always include the router's top-1 candidate in
 * the recall queue, even if the probe rejected it. The 8B probe is a cheap
 * filter; the 31B recall is the source of truth. We let the stronger model
 * decide whether the shard has the answer.
 *
 * This test pins that behaviour: when the router picks shard X as #1 but the
 * probe says X "knows: false", the recall queue must STILL include X.
 *
 * TWO PROBE WIRINGS, BOTH PINNED (2026-08-01). `CSM_PROBE_BATCH` flipped to
 * default-ON for hosted-class providers (`resolveProbeBatch(providerName)`;
 * still off for `ollama` / `llama-server`), so the probe stage now has two
 * shapes and the safety net has to survive both:
 *   - solo    — one `ProbeResult` call per candidate (`CSM_PROBE_BATCH=0`,
 *               and the standing default on local single-GPU servers);
 *   - batched — the router top-1 keeps its own solo call and shards 2..N come
 *               back from ONE `BatchedProbeResult` call, reconciled by shard
 *               id with padded knows:false verdicts for anything missing.
 * The batched wiring is where the net is most load-bearing: reconciliation is
 * what guarantees the top-1 always HAS a probe result for the net to find.
 * Every case below therefore runs twice, once per wiring, and asserts which
 * wiring actually executed — otherwise a regression that quietly reverted the
 * default would leave the batched arm passing as a copy of the solo arm.
 */

/** Wiring matrix. `flag === null` means "leave `CSM_PROBE_BATCH` unset", i.e.
 *  exercise the shipped default for this provider class. */
const PROBE_WIRINGS = [
  {
    label: "CSM_PROBE_BATCH=0 — explicit solo probes (legacy wiring)",
    flag: "0" as string | null,
    batchedWhenEligible: false,
  },
  {
    label: "CSM_PROBE_BATCH unset — batched probes (hosted default since 2026-08-01)",
    flag: null as string | null,
    batchedWhenEligible: true,
  },
] as const;

/** One verdict body per shard, shared by the solo and the batched branch of the
 *  stub. Both wirings must feed the pipeline IDENTICAL probe verdicts, or the
 *  two arms below would be comparing recall behaviour against different inputs
 *  and the batched arm would prove nothing about the safety net. */
function verdictFor(knows: boolean) {
  return {
    knows,
    confidence: knows ? 0.8 : 0.2,
    memory_type: knows ? "direct" : "none",
    estimated_answer_value: knows ? "high" : "none",
    needs_full_recall: knows,
    relevant_event_ids: knows ? ["e_001"] : [],
  };
}

class ScriptedProvider implements LlmProvider {
  /** Deliberately NOT "ollama"/"llama-server": `resolveProbeBatch` splits on
   *  provider class, so this hosted-class name is what puts the unset arm on
   *  the batched path. */
  readonly name = "stub";
  recallCalls: { shardId: string; snapshotId: string }[] = [];
  /** Probe-stage schema names in call order — the evidence that the arm ran
   *  the wiring it claims to be testing. */
  probeSchemas: string[] = [];

  constructor(
    private probeKnowsByShardId: Record<string, boolean>,
  ) {}

  async completeJson<T>(input: CompleteJsonInput): Promise<ProviderResponse<T>> {
    const usage = {
      inputTokensEstimate: 50,
      outputTokensEstimate: 30,
      estimatedUsd: 0,
      latencyMs: 5,
    };
    if (input.schemaName === "ProbeResult") {
      this.probeSchemas.push(input.schemaName);
      const shardId = input.shardId ?? "?";
      const data = verdictFor(this.probeKnowsByShardId[shardId] ?? false);
      return { data: data as unknown as T, usage, rawText: JSON.stringify(data) };
    }
    if (input.schemaName === "BatchedProbeResult") {
      this.probeSchemas.push(input.schemaName);
      // Answer exactly the shards the batched prompt asked about, in the order
      // it asked ("Shard ids, in order: …" — see `batchedProbePrompt`). Reading
      // the request instead of dumping every known shard keeps the stub honest:
      // `probeShardsBatched`'s reconciliation is exercised on a well-formed
      // batch, not rescued by it.
      const line = /^Shard ids, in order: (.+)$/m.exec(input.prompt);
      const shardIds = line ? line[1]!.split(",").map((s) => s.trim()).filter(Boolean) : [];
      const data = {
        verdicts: shardIds.map((shardId) => ({
          shard_id: shardId,
          ...verdictFor(this.probeKnowsByShardId[shardId] ?? false),
        })),
      };
      return { data: data as unknown as T, usage, rawText: JSON.stringify(data) };
    }
    if (input.schemaName === "RecallResult") {
      const shardId = input.shardId ?? "?";
      const snapshotId = input.snapshotId ?? "?";
      this.recallCalls.push({ shardId, snapshotId });
      const data = {
        shard_id: shardId,
        snapshot_id: snapshotId,
        confidence: 0.9,
        answer: `recall on ${shardId}`,
        claims: [{ claim: "x", support: ["e_001"], confidence: 0.9 }],
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

/**
 * Pin the probe wiring that actually ran.
 *
 * `expectBatched: false` with several candidates is a real claim, not a
 * fallback: `ask()` only batches when there are MORE THAN 2 probed candidates
 * (below that the split "top-1 solo + one batch" saves no scaffold), so a
 * 2-candidate query stays on solo probes even with the flag on.
 */
function expectProbeWiring(
  provider: ScriptedProvider,
  opts: { candidates: number; expectBatched: boolean },
): void {
  const solo = provider.probeSchemas.filter((s) => s === "ProbeResult").length;
  const batched = provider.probeSchemas.filter((s) => s === "BatchedProbeResult").length;
  if (opts.expectBatched) {
    expect(solo).toBe(1); // router top-1 keeps its own call (speculative recall)
    expect(batched).toBe(1); // every other candidate in ONE call
  } else {
    expect(solo).toBe(opts.candidates);
    expect(batched).toBe(0);
  }
}

function makeStorageReader(
  shardIds: string[],
  tagsByShard: Record<string, string[]>,
): StorageReader {
  const dir: MemoryDirectory = {
    version: 1,
    entries: shardIds.map((id) => ({
      id,
      name: id,
      description: `Test shard ${id}`,
      tags: tagsByShard[id] ?? [],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      status: "active" as const,
      snapshotId: "S001",
      tokenCountEstimate: 100,
      contextLimitEstimate: 128_000,
      fullnessPct: 0,
      summaryShort: `${id} summary`,
      knownConflicts: [],
      parentId: null,
      children: [] as string[],
      trustLevel: "imported_doc" as const,
      staleness: "current" as const,
    })),
  };
  const snapshots = new Map<string, MemoryShardSnapshot>();
  for (const id of shardIds) {
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
          tags: tagsByShard[id] ?? [],
        },
      ],
      indexTerms: tagsByShard[id] ?? [],
      createdAt: "2024-01-01T00:00:00.000Z",
      parentSnapshotId: null,
    });
  }
  return {
    async loadDirectory() { return dir; },
    async loadSnapshot(shardId, snapshotId) {
      return snapshots.get(`${shardId}@${snapshotId}`) ?? null;
    },
  };
}

for (const wiring of PROBE_WIRINGS) {
  describe(`ask — router-trust safety net [${wiring.label}]`, () => {
    beforeEach(() => {
      if (wiring.flag === null) delete process.env.CSM_PROBE_BATCH;
      else process.env.CSM_PROBE_BATCH = wiring.flag;
    });
    afterEach(() => {
      delete process.env.CSM_PROBE_BATCH;
    });

    it("recalls the router top-1 shard even when the probe rejected it", async () => {
      // Router scores: `customers-shard` matches the query's "customer" token →
      // top-1. Probe says `knows: false` for it (the simulated false negative).
      // Filler shards have no matching tags → score 0 → router rank lower.
      const provider = new ScriptedProvider({
        "customers-shard": false, // <-- probe says NO (the bug case)
        "filler-a": false,
        "filler-b": false,
      });
      const storage = makeStorageReader(
        ["customers-shard", "filler-a", "filler-b"],
        {
          "customers-shard": ["customer", "loi"], // matches the query tokens
          "filler-a": ["unrelated"],
          "filler-b": ["unrelated"],
        },
      );

      const result = await ask({
        provider,
        storage,
        query: "Which customer signed the LOI?",
        parallelProbes: false,
        skipQueryLog: true,
      });

      // 3 candidates > 2, so the batched arm really does batch here. In that
      // arm the top-1's rejection arrives from its SOLO call and the fillers'
      // from the shared batch — the net must fire on the solo verdict either way.
      expectProbeWiring(provider, { candidates: 3, expectBatched: wiring.batchedWhenEligible });

      // Pre-fix: probe rejected customers-shard → 0 recall calls.
      // Post-fix: router-trust safety net forces a recall on customers-shard.
      const recalledShardIds = provider.recallCalls.map((c) => c.shardId);
      expect(recalledShardIds).toContain("customers-shard");

      // …and the same claim against ask()'s OWN output, which is what the net
      // actually decides. Necessary since batch mode implies the parallel path:
      // there the tier-1 speculative recall issues a CALL on the router top-1
      // the moment its probe resolves, whatever the verdict — so in the batched
      // arm `recallCalls` alone cannot tell "the net forced it in" apart from
      // "speculation dialled it and the result was thrown away". A recall only
      // reaches `result.recalls` (and hence the packet) if it was SELECTED.
      expect(result.recalls.map((r) => r.shardId)).toContain("customers-shard");
    });

    it("does NOT add a duplicate recall when the probe accepted the top shard", async () => {
      // Normal path: probe accepts the router's top shard. The safety net must
      // be a no-op (the shard is already in the recall queue, not duplicated).
      const provider = new ScriptedProvider({
        "customers-shard": true,
        "filler-a": false,
      });
      const storage = makeStorageReader(
        ["customers-shard", "filler-a"],
        {
          "customers-shard": ["customer", "loi"],
          "filler-a": ["unrelated"],
        },
      );

      const result = await ask({
        provider,
        storage,
        query: "Which customer signed the LOI?",
        parallelProbes: false,
        skipQueryLog: true,
      });

      // Only 2 candidates: below the `> 2` batching threshold, so BOTH arms run
      // solo probes. Pins that the new default does not change the probe shape
      // of small-candidate queries.
      expectProbeWiring(provider, { candidates: 2, expectBatched: false });

      const recalledIds = provider.recallCalls.map((c) => c.shardId);
      const customerRecalls = recalledIds.filter((id) => id === "customers-shard");
      expect(customerRecalls).toHaveLength(1); // not duplicated
      // Not duplicated in the selection either (the net must not re-add a shard
      // the probe-driven selection already picked).
      expect(result.recalls.filter((r) => r.shardId === "customers-shard")).toHaveLength(1);
    });

    it("respects maxRecallShards budget when prepending the router top", async () => {
      // 5 shards, all probe-accepted EXCEPT the router's top. Recall budget = 4.
      // Pre-fix: 4 probe-accepted shards recalled, top (probe-rejected) is dropped.
      // Post-fix: top is prepended, lowest-scored of the 4 falls off → still 4 total.
      const shardIds = ["s-top", "s-1", "s-2", "s-3", "s-4", "s-5"];
      const provider = new ScriptedProvider({
        "s-top": false, // router top, probe rejects
        "s-1": true,
        "s-2": true,
        "s-3": true,
        "s-4": true,
        "s-5": true,
      });
      const tags: Record<string, string[]> = {
        "s-top": ["customer", "loi", "decision"], // high tag overlap → router #1
        "s-1": ["customer"],
        "s-2": ["customer"],
        "s-3": ["customer"],
        "s-4": ["customer"],
        "s-5": ["customer"],
      };
      const storage = makeStorageReader(shardIds, tags);

      const result = await ask({
        provider,
        storage,
        query: "What customer LOI decision?",
        parallelProbes: false,
        skipQueryLog: true,
      });

      // In the batched arm this is the 5-accepted-shards-in-one-call case, and
      // the budget still has to bind AFTER the prepend: the forced top-1 recall
      // (started speculatively off its solo probe, since batch mode implies the
      // parallel path) must displace a probe-accepted shard, never add a 5th.
      expectProbeWiring(provider, { candidates: 6, expectBatched: wiring.batchedWhenEligible });

      const recalledIds = provider.recallCalls.map((c) => c.shardId);
      expect(recalledIds).toContain("s-top"); // safety net forced this in
      expect(recalledIds.length).toBeLessThanOrEqual(4); // budget respected — spend
      // Same two claims on the SELECTED set (see the note in the first case:
      // in the batched arm the top-1 call itself is speculative, so the budget
      // has to be pinned on what the selection kept, not only on call count).
      const selectedIds = result.recalls.map((r) => r.shardId);
      expect(selectedIds).toContain("s-top");
      expect(selectedIds.length).toBeLessThanOrEqual(4); // budget respected — packet
    });
  });
}
