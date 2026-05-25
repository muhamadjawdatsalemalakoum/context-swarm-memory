import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { getPaths } from "../storage/paths.js";
import { stableStringify } from "../utils/json.js";
import { nowIso } from "../utils/time.js";

/**
 * Inputs that uniquely determine an LLM call. Two calls with identical
 * `CacheKeyInput` are guaranteed (with `temperature: 0`) to produce the same
 * response from the same model snapshot — so we can cache the response and
 * reuse it across replays.
 *
 * `model` should pin the exact tag/digest (e.g. `"gemma4:31b@sha256:abc..."`)
 * to avoid silent drift when the user re-pulls and the underlying weights
 * change.
 */
export interface CacheKeyInput {
  model: string;
  prompt: string;
  /** System message; included separately so OpenAI/Ollama-style two-message inputs hash distinctly from concatenated single prompts. */
  system?: string;
  /** Sampling temperature. 0 for the benchmark. */
  temperature: number;
  /** Optional explicit seed. We hash whatever value is passed (or `null` if absent). */
  seed?: number;
  /** Token budget the call requested. */
  maxOutputTokens: number;
  /** When true, the call was made with `disableThinking: true` (suppressing the
   *  reasoning channel). Included in the hash ONLY when truthy so existing
   *  cache entries — keyed without this field — still match for replay paths
   *  that don't disable thinking. New runs with `disableThinking: true` get a
   *  distinct key to avoid silently serving old reasoning-laden responses. */
  disableThinking?: boolean;
}

export interface CacheEntry {
  key: string;
  request: CacheKeyInput;
  response: string;
  latencyMs: number;
  timestampIso: string;
}

/**
 * Compute the cache key (sha256 hex digest) for an input. Stable across runs
 * thanks to `stableStringify` (sorted keys at every level).
 */
export function computeCacheKey(input: CacheKeyInput): string {
  // Normalise: ensure undefined optional fields hash distinctly from zero/empty.
  const normalised: Record<string, unknown> = {
    model: input.model,
    prompt: input.prompt,
    system: input.system ?? null,
    temperature: input.temperature,
    seed: input.seed ?? null,
    maxOutputTokens: input.maxOutputTokens,
  };
  // Only add `disableThinking` to the normalised hash when truthy. Preserves
  // back-compat with cache entries written before this field existed: callers
  // that don't set `disableThinking` (or pass `false`) hash to the same key
  // as the legacy form. New `disableThinking: true` calls hash distinctly so
  // they don't silently serve old reasoning-laden responses.
  if (input.disableThinking) {
    normalised.disableThinking = true;
  }
  return createHash("sha256")
    .update(stableStringify(normalised, 0))
    .digest("hex");
}

export function cacheRoot(rootDir?: string): string {
  return join(getPaths(rootDir).data, "eval", "cache");
}

/**
 * Path for one cache entry. Sharded by the first 2 hex chars of the key so we
 * never put 1000s of files in a single directory (slow on Windows + bad for git).
 */
function cacheFilePath(key: string, rootDir?: string): string {
  return join(cacheRoot(rootDir), key.slice(0, 2), `${key}.json`);
}

/**
 * Look up a cached response. Returns `null` on miss or any read error
 * (corrupted entries are treated as misses; the runner will repopulate).
 */
export async function cacheGet(
  input: CacheKeyInput,
  rootDir?: string,
): Promise<CacheEntry | null> {
  const key = computeCacheKey(input);
  const path = cacheFilePath(key, rootDir);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as CacheEntry;
  } catch {
    return null;
  }
}

/**
 * Atomically write a cache entry. Uses tmp + rename so a crash mid-write
 * never produces a half-written file (which would later be treated as
 * corrupted and re-fetched).
 *
 * Refuses to write empty / near-empty responses (the timeout/CPU-offload
 * failure mode). An empty cached response would otherwise poison every
 * future replay of the same prompt — the caller would get an instant
 * cache-hit with no answer text and silently propagate a null answer
 * through the scorer. Better to let the next run actually call the LLM.
 *
 * Threshold: <5 characters trimmed. Any legitimate MCQ answer is at least
 * "ANSWER: 1" (9 chars); any legitimate free-form answer is a word.
 */
export class CacheRefusedEmptyError extends Error {
  constructor(public readonly key: string) {
    super(`cache.cacheSet: refusing to write empty response for key ${key}`);
    this.name = "CacheRefusedEmptyError";
  }
}

export async function cacheSet(
  input: CacheKeyInput,
  value: { response: string; latencyMs: number },
  rootDir?: string,
): Promise<CacheEntry> {
  const key = computeCacheKey(input);
  if (typeof value.response !== "string" || value.response.trim().length < 5) {
    // Don't poison the cache. The runner will retry on the next invocation.
    throw new CacheRefusedEmptyError(key);
  }
  const path = cacheFilePath(key, rootDir);
  const entry: CacheEntry = {
    key,
    request: input,
    response: value.response,
    latencyMs: value.latencyMs,
    timestampIso: nowIso(),
  };
  await mkdir(dirname(path), { recursive: true });
  // Tmp file in the OS temp dir → cross-device rename can fail on some
  // setups, so put the tmp inside the same shard dir to guarantee same-fs.
  const tmp = join(
    dirname(path),
    `.${key}.${process.pid}.${Date.now()}.tmp`,
  );
  await writeFile(tmp, stableStringify(entry), "utf8");
  await rename(tmp, path);
  return entry;
}

export interface CacheStats {
  count: number;
  sizeBytes: number;
}

/** Cheap walk for `csm bench report` and the cache-hosting decision in Phase D. */
export async function cacheStats(rootDir?: string): Promise<CacheStats> {
  const dir = cacheRoot(rootDir);
  if (!existsSync(dir)) return { count: 0, sizeBytes: 0 };
  let count = 0;
  let sizeBytes = 0;
  const shardDirs = await readdir(dir);
  for (const shard of shardDirs) {
    const shardPath = join(dir, shard);
    const sStat = await stat(shardPath);
    if (!sStat.isDirectory()) continue;
    const files = await readdir(shardPath);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      count++;
      const fStat = await stat(join(shardPath, f));
      sizeBytes += fStat.size;
    }
  }
  return { count, sizeBytes };
}

// Re-export the temp module type only so consumers don't need to import os themselves.
// (Used only as a documentation hook — we no longer use os.tmpdir() above.)
export const _internal = { tmpdir };
