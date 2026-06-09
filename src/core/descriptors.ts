// Content-derived shard descriptors — T2 "Router v1".
//
// Problem (portfolio Discovery A): on bridge-built corpora (AMB/BEAM) the
// directory metadata is degenerate — name/description "Benchmark shard <id>",
// tags ["amb","beam","beam-turn","conversation:<uid>"] — so the Phase-0
// keyword router scores every shard ~0 and the top-8 cut is effectively
// alphabetical. On PaySwift, generic-vocabulary queries (q03/q04/q17 class)
// score <=2 and the right shard never gets probed.
//
// Fix: derive descriptors FROM SHARD CONTENT with zero LLM calls:
//   1. `deriveShardDescriptors` — per-shard top TF-IDF terms (auto-tags).
//      Pure, deterministic, corpus-relative: a term scores high when frequent
//      in this shard and rare in others. This is the lexical leg.
//   2. `centroidOf` — L2-normalized mean of per-event MiniLM embeddings
//      (computed by the caller via `src/eval/embed.ts`, which is disk-cached).
//      This is the embedding leg consumed by `src/core/routerEmbed.ts`.
//
// The README's "zero LLM-indexing cost" claim is preserved: TF-IDF is pure
// arithmetic, and the local MiniLM embedder is explicitly inside that claim.
//
// Where descriptors are computed:
//   - Benchmark/bridge adapters: at corpus build time (one O(events) pass).
//   - Durable stores: at commit time via the Committer's directory update
//     (the spec §16 "directory drift" mitigation) — NEVER on the read path.
//     The read path only consumes whatever the directory already carries.
//
// Storage shape: see `DirectoryDescriptorFields` below — additive OPTIONAL
// fields on `MemoryDirectoryEntry`, so the directory remains the only memory
// object the router reads. (Grafting the fields into `core/types.ts` is a
// merge-window edit owned by the orchestrator; until then the intersection
// type `DirectoryEntryWithDescriptors` carries them structurally.)

import type { MemoryDirectoryEntry } from "./types.js";
import { tokenize } from "./router.js";

// ─── Term derivation (TF-IDF auto-tags) ─────────────────────────────────────

export interface DescriptorSourceEvent {
  content: string;
  tags?: string[];
}

export interface ShardDescriptorSource {
  shardId: string;
  events: DescriptorSourceEvent[];
}

export interface ShardDescriptor {
  shardId: string;
  /** Top discriminative content terms, lowercase, deterministic order
   *  (TF-IDF score desc, then term asc). Acts like auto-generated tags. */
  terms: string[];
  /** Events the descriptor was derived from (for incremental-update math). */
  eventCount: number;
}

export interface DeriveDescriptorsOptions {
  /** Max derived terms per shard. Default 16. */
  maxTerms?: number;
  /** TF multiplier for curated tags vs prose tokens. Default 3 (a tag is a
   *  deliberate signal; one tag occurrence ≈ three prose occurrences). */
  tagTfBoost?: number;
}

const DEFAULT_MAX_TERMS = 16;
const DEFAULT_TAG_TF_BOOST = 3;

/**
 * Derive per-shard descriptor terms with smoothed TF-IDF.
 *
 *   weight(t, s) = (1 + ln tf(t,s)) * ln((N + 1) / (df(t) + 0.5))
 *
 * - tf counts token occurrences in the shard's event content; each curated
 *   tag occurrence counts `tagTfBoost` times.
 * - df = number of shards containing the term at all, so corpus-wide
 *   boilerplate ("user", "assistant", "turn" on BEAM) gets idf ≈ 0 and
 *   falls out of the top-K naturally — no hardcoded domain stoplists.
 * - Deterministic: independent of input ordering; ties broken by term asc.
 *
 * Pure function: no I/O, no LLM, no mutation of inputs.
 */
export function deriveShardDescriptors(
  sources: ShardDescriptorSource[],
  opts: DeriveDescriptorsOptions = {},
): Map<string, ShardDescriptor> {
  const maxTerms = opts.maxTerms ?? DEFAULT_MAX_TERMS;
  const tagTfBoost = opts.tagTfBoost ?? DEFAULT_TAG_TF_BOOST;

  // Pass 1: per-shard term frequencies.
  const tfByShard = new Map<string, Map<string, number>>();
  for (const src of sources) {
    const tf = tfByShard.get(src.shardId) ?? new Map<string, number>();
    for (const ev of src.events) {
      for (const tok of tokenize(ev.content)) {
        tf.set(tok, (tf.get(tok) ?? 0) + 1);
      }
      for (const tag of ev.tags ?? []) {
        for (const tok of tokenize(tag)) {
          tf.set(tok, (tf.get(tok) ?? 0) + tagTfBoost);
        }
      }
    }
    tfByShard.set(src.shardId, tf);
  }

  // Pass 2: document frequencies across shards.
  const df = new Map<string, number>();
  for (const tf of tfByShard.values()) {
    for (const term of tf.keys()) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }
  const n = tfByShard.size;

  // Pass 3: score + select top-K per shard, deterministically.
  const out = new Map<string, ShardDescriptor>();
  // Sort shard ids so output insertion order is input-order independent.
  const shardIds = [...tfByShard.keys()].sort();
  for (const shardId of shardIds) {
    const tf = tfByShard.get(shardId)!;
    const scored: Array<{ term: string; weight: number }> = [];
    for (const [term, count] of tf) {
      const idf = Math.log((n + 1) / ((df.get(term) ?? 0) + 0.5));
      const weight = (1 + Math.log(count)) * idf;
      if (weight > 0) scored.push({ term, weight });
    }
    scored.sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight;
      return a.term < b.term ? -1 : a.term > b.term ? 1 : 0;
    });
    const eventCount =
      sources
        .filter((s) => s.shardId === shardId)
        .reduce((acc, s) => acc + s.events.length, 0) ?? 0;
    out.set(shardId, {
      shardId,
      terms: scored.slice(0, maxTerms).map((s) => s.term),
      eventCount,
    });
  }
  return out;
}

/**
 * Deterministic single-string descriptor for a shard — the "one embed call
 * per shard" scale option (Q6): at thousands of shards, embedding every event
 * for a centroid is the dominant first-pass cost; embedding this string is
 * O(shards). Composes name + derived terms + the first content heads.
 */
export function descriptorText(args: {
  name: string;
  description?: string;
  terms: string[];
  eventHeads?: string[];
  maxHeads?: number;
}): string {
  const heads = (args.eventHeads ?? []).slice(0, args.maxHeads ?? 5);
  return [
    args.name,
    args.description ?? "",
    args.terms.join(", "),
    ...heads.map((h) => h.replace(/\s+/g, " ").slice(0, 120)),
  ]
    .filter((s) => s.length > 0)
    .join("\n");
}

// ─── Embedding centroid helpers ─────────────────────────────────────────────

/**
 * L2-normalized mean of (already L2-normalized) embedding vectors.
 * Returns null for an empty input. Throws on dimension mismatch.
 *
 * Incremental update on commit (design note, Q6): event embeddings are
 * disk-cached per (model, sha256(content)) by `src/eval/embed.ts`, so the
 * recommended commit-time refresh is an exact recompute — embed ONLY the new
 * event (1 call), then re-mean n cached vectors (microseconds at n ≤ 10^4).
 * A true O(1) running-sum update would require persisting the unnormalized
 * sum; not worth the extra directory state at MVP scale.
 */
export function centroidOf(vectors: Float32Array[]): Float32Array | null {
  if (vectors.length === 0) return null;
  const dim = vectors[0]!.length;
  const sum = new Float64Array(dim);
  for (const v of vectors) {
    if (v.length !== dim) {
      throw new Error(`centroidOf: dim mismatch ${v.length} vs ${dim}`);
    }
    for (let i = 0; i < dim; i++) sum[i]! += v[i]!;
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += sum[i]! * sum[i]!;
  norm = Math.sqrt(norm);
  const out = new Float32Array(dim);
  if (norm === 0) return out; // degenerate: all-zero mean
  for (let i = 0; i < dim; i++) out[i] = sum[i]! / norm;
  return out;
}

/** Base64 (little-endian Float32) encoding for storing a centroid in JSON. */
export function encodeCentroid(vec: Float32Array): string {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString(
    "base64",
  );
}

export function decodeCentroid(b64: string): Float32Array {
  const buf = Buffer.from(b64, "base64");
  return new Float32Array(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  );
}

// ─── Directory storage shape (additive, optional) ───────────────────────────

/**
 * Additive optional descriptor fields for `MemoryDirectoryEntry`.
 *
 * Design intent (merge window): these fields are grafted into
 * `MemoryDirectoryEntry` in `core/types.ts` as optional members. Until then,
 * adapters attach them structurally and the hybrid router reads them via the
 * intersection type below. A directory without them routes exactly as today
 * (the hybrid scorer degrades to the Phase-0 lexical path per shard).
 *
 * Versioning: `descriptorVersion` bumps when the derivation algorithm or
 * embedding model changes, so a Committer-side audit job can refresh stale
 * descriptors lazily (spec §16 "directory drift" mitigation).
 */
export interface DirectoryDescriptorFields {
  /** Top TF-IDF content terms (auto-tags), lowercase. */
  derivedTerms?: string[];
  /** Base64 Float32 L2-normalized embedding centroid of the shard's events. */
  embedCentroidB64?: string;
  /** Embedding model the centroid was computed with (e.g. Xenova/all-MiniLM-L6-v2). */
  embedModel?: string;
  /** Derivation algorithm/model version. Bump to trigger refresh. */
  descriptorVersion?: number;
}

export const DESCRIPTOR_VERSION = 1;

export type DirectoryEntryWithDescriptors = MemoryDirectoryEntry &
  DirectoryDescriptorFields;
