import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getPaths } from "../storage/paths.js";

/**
 * Default sentence embedding model used by `vanillaRag` and `hybridRag`.
 * 384-dim, ~80 MB to download once via `@huggingface/transformers`. Runs entirely
 * locally — no API key, no GPU required.
 */
export const EMBED_MODEL_NAME = "Xenova/all-MiniLM-L6-v2";
export const EMBED_DIM = 384;

// `@huggingface/transformers` is dynamically imported so users who don't run the
// RAG baselines never pay the load cost or require the dep at type-check
// time. The pipeline is lazy-initialized once per process and reused.
type FeaturePipeline = (
  text: string,
  opts: { pooling: "mean"; normalize: true },
) => Promise<{ data: Float32Array | number[] }>;

let pipelinePromise: Promise<FeaturePipeline> | null = null;

async function getPipeline(modelName: string): Promise<FeaturePipeline> {
  if (!pipelinePromise) {
    const tx = await import("@huggingface/transformers");
    pipelinePromise = tx.pipeline("feature-extraction", modelName) as Promise<FeaturePipeline>;
  }
  return pipelinePromise;
}

function modelSlug(modelName: string): string {
  return modelName.replace(/[^A-Za-z0-9_-]/g, "_");
}

function embeddingsRoot(modelName: string, rootDir?: string): string {
  return join(getPaths(rootDir).data, "eval", "embeddings", modelSlug(modelName));
}

function contentHashHex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function embeddingPath(modelName: string, hash: string, rootDir?: string): string {
  return join(embeddingsRoot(modelName, rootDir), hash.slice(0, 2), `${hash}.f32`);
}

/**
 * Embed an array of texts. Disk-cached per (model, sha256(text)) so repeat
 * runs over the same corpus are free (only embed once per unique text ever).
 *
 * Vectors are mean-pooled and L2-normalised, so cosine similarity reduces to
 * a dot product (`cosine` below).
 */
export async function embed(
  texts: string[],
  modelName: string = EMBED_MODEL_NAME,
  rootDir?: string,
): Promise<Float32Array[]> {
  const out: Float32Array[] = new Array(texts.length);
  const toCompute: Array<{ index: number; text: string; path: string }> = [];

  // Pass 1: cache hits.
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i]!;
    const hash = contentHashHex(text);
    const path = embeddingPath(modelName, hash, rootDir);
    if (existsSync(path)) {
      const buf = await readFile(path);
      // Construct a Float32Array view backed by the file bytes.
      out[i] = new Float32Array(
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      );
    } else {
      toCompute.push({ index: i, text, path });
    }
  }

  // Pass 2: compute misses.
  if (toCompute.length > 0) {
    const pipe = await getPipeline(modelName);
    for (const item of toCompute) {
      const result = await pipe(item.text, { pooling: "mean", normalize: true });
      const vec =
        result.data instanceof Float32Array
          ? result.data
          : new Float32Array(result.data);
      out[item.index] = vec;
      await mkdir(dirname(item.path), { recursive: true });
      await writeFile(item.path, Buffer.from(vec.buffer));
    }
  }

  return out;
}

/**
 * Cosine similarity between two L2-normalised vectors. For the model above,
 * vectors are normalised at embed time, so this is just a dot product.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosine: dim mismatch ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

/**
 * Top-K by cosine similarity. Returns indexes into `vectors` sorted by
 * descending similarity, plus the score for each.
 */
export function topKCosine(
  query: Float32Array,
  vectors: Float32Array[],
  k: number,
): Array<{ index: number; score: number }> {
  const scored = vectors.map((v, index) => ({ index, score: cosine(query, v) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}
