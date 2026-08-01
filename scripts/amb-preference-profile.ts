/**
 * Shared write-time STANDING PREFERENCE PROFILE builder + disk cache.
 *
 * The profile is a WRITE-TIME artifact: it depends only on the unit's content
 * and the extractor (model + prompt version), never on the query, so it is
 * identical across every arm/run that uses the same unit. Rebuilding it per
 * arm cost ~180 large LLM calls and tripped a 429 on the subscription path —
 * hence the disk cache under `data/eval/preference-profiles/`.
 *
 * This module exists so the TWO retrieval entry points that inject the profile
 * derive the cache key the same way and therefore SHARE cache entries when the
 * inputs genuinely match:
 *   - `scripts/run-beam-slice.ts` (slice harness; key inputs: --split, unit id,
 *     write-time model, prompt version)
 *   - `scripts/amb-csm-server.ts`  (warm AMB server; same inputs, with the
 *     split label supplied via `CSM_AMB_SPLIT` because AMB requests carry no
 *     split notion — set it to the BEAM split label, e.g. `1m`, to reuse
 *     profiles a slice run already built)
 *
 * Eval-side cache only: nothing here touches CSM's durable memory (chronicle /
 * snapshots), and the build reads events that are already in RAM.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { CsmBaseline } from "../src/eval/baselines/csm.js";
import { envFlag, envPositiveInt } from "../src/utils/env.js";

/** Bump when the preference-extraction prompt changes so cached profiles
 *  re-derive. Part of the cache key on BOTH entry points. */
export const PREF_PROMPT_VERSION = "v1";

/** `CSM_AMB_PREFERENCE_PROFILE` toggle (default OFF). When ON, the standing
 *  preference profile is built per user scope and passed to
 *  `executeAmbRetrieve` on EVERY query (always-on by design — the queries it
 *  serves never mention the preference they test, so no query-conditioned gate
 *  can exist; see docs/experiments/EXP-preference-write-time.md). */
export function preferenceProfileActive(): boolean {
  // DEFAULT ON since 2026-08-01: the lever that wins knowledge_update at 1M.
  return envFlag(process.env.CSM_AMB_PREFERENCE_PROFILE, {
    name: "CSM_AMB_PREFERENCE_PROFILE",
    fallback: false,
  });
}

/** Cache directory. `CSM_AMB_PREF_CACHE_DIR` overrides (tests point it at a
 *  temp dir); default is the established eval-side location. */
export function preferenceProfileCacheDir(): string {
  const override = process.env.CSM_AMB_PREF_CACHE_DIR?.trim();
  return override && override.length > 0
    ? resolve(override)
    : resolve(process.cwd(), "data", "eval", "preference-profiles");
}

/** The cache path for one (split, unit, model) triple. Key scheme is EXACTLY
 *  the one `run-beam-slice.ts` shipped with — sha256 over
 *  `split|userId|model|promptVersion`, first 16 hex chars — so server and
 *  slice runs hit the same files. Do not change one side without the other. */
export function preferenceProfileCachePath(inputs: {
  split: string;
  userId: string;
  /** Write-time extractor model (`resolveProviderModel(provider.name)`);
   *  undefined = provider default, keyed as the literal "default". */
  model: string | undefined;
}): string {
  const cacheKey = createHash("sha256")
    .update(
      `${inputs.split}|${inputs.userId}|${inputs.model ?? "default"}|${PREF_PROMPT_VERSION}`,
    )
    .digest("hex")
    .slice(0, 16);
  return join(
    preferenceProfileCacheDir(),
    `${inputs.split}-u${inputs.userId}-${cacheKey}.txt`,
  );
}

/**
 * Load the profile from the disk cache, or build it via
 * `organizePreferencesScaled` and cache it. Throws on build failure — callers
 * own the degrade decision (both entry points log and continue without a
 * profile rather than failing the query). A cache WRITE failure is swallowed:
 * it must never fail a run that already has the text in hand.
 */
export async function loadOrBuildPreferenceProfile(args: {
  baseline: CsmBaseline;
  eventContents: string[];
  split: string;
  userId: string;
  model: string | undefined;
  onProgress?: (msg: string) => void;
}): Promise<{ text: string; fromCache: boolean; outputTokens: number; chunks: number }> {
  const cachePath = preferenceProfileCachePath(args);
  if (existsSync(cachePath)) {
    return {
      text: readFileSync(cachePath, "utf8"),
      fromCache: true,
      outputTokens: 0,
      chunks: 0,
    };
  }

  const r = await args.baseline.organizePreferencesScaled({
    eventContents: args.eventContents,
    // `model` may be undefined ("provider default"); organizePreferencesScaled
    // types it `string` but only forwards it to `completeText`, where undefined
    // correctly means "use the provider's own default". Same cast the slice
    // harness shipped with.
    model: args.model as string,
    // The 600K-token defaults are a Gemini-era setting; a 1M-tier unit is
    // ~1.6M tokens, so those produce 600K-token prompts that the sidecar
    // rejects outright. Size the map step to something any provider can
    // actually accept, and let it be tuned per stack.
    chunkTokens: envPositiveInt(process.env.CSM_AMB_PREF_CHUNK_TOKENS, {
      name: "CSM_AMB_PREF_CHUNK_TOKENS",
      fallback: 100_000,
    }),
    singlePassTokens: envPositiveInt(process.env.CSM_AMB_PREF_SINGLE_PASS_TOKENS, {
      name: "CSM_AMB_PREF_SINGLE_PASS_TOKENS",
      fallback: 120_000,
    }),
    chunkOutputTokens: envPositiveInt(process.env.CSM_AMB_PREF_CHUNK_OUTPUT, {
      name: "CSM_AMB_PREF_CHUNK_OUTPUT",
      fallback: 2000,
    }),
    finalOutputTokens: envPositiveInt(process.env.CSM_AMB_PREF_MAX_OUTPUT, {
      name: "CSM_AMB_PREF_MAX_OUTPUT",
      fallback: 2000,
    }),
    mapConcurrency: envPositiveInt(process.env.CSM_AMB_PREF_MAP_CONCURRENCY, {
      name: "CSM_AMB_PREF_MAP_CONCURRENCY",
      fallback: 4,
    }),
    onProgress: args.onProgress,
  });

  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, r.text, "utf8");
  } catch {
    // A cache write failure must never fail the run.
  }
  return { text: r.text, fromCache: false, outputTokens: r.outputTokens, chunks: r.chunks };
}
