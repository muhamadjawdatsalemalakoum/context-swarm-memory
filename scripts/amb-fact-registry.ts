/**
 * Shared write-time FACT REGISTRY builder + disk cache — the R2 mechanism arm.
 *
 * WHY (1M knowledge_update diagnosis, 2026-08-24, n=70): 16 of 19 losses are
 * ABSENCES caused by "drive-by" updates — the current value is stated once, in
 * a session whose dominant topic is unrelated (the 78-wpm typing update lives
 * inside a Cappadocia trip conversation), so topical retrieval structurally
 * cannot find it: 7 of 16 update sessions were never retrieved, and in the
 * other 9 the right session was retrieved but the RETURN_K turn-slice dropped
 * the one update turn. Only ingest-time extraction over EVERY chunk reaches
 * those. `organizeFactsScaled` already produces exactly the needed artifact —
 * per-metric value histories in conversation order with the LATEST value
 * marked — but it was only wired on the warm server, gated to
 * aggregation-intent queries, and RENDERED AS A CAPSULE REPLACEMENT.
 *
 * This module gives it the preference-profile treatment: a write-time artifact
 * with a shared disk cache, buildable from both retrieval entry points, and a
 * FOLD flag (`CSM_AMB_FACT_FOLD`) so the registry rides INSIDE the capsule —
 * document count unchanged; displacement has been measured as the killer four
 * separate times.
 *
 * Same key discipline as `amb-preference-profile.ts`: the artifact depends
 * only on (split, unit content, extractor model, prompt version), never the
 * query. Eval-side cache only; durable memory untouched.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { CsmBaseline } from "../src/eval/baselines/csm.js";
import { envFlag, envPositiveInt } from "../src/utils/env.js";

/** Bump when the fact-extraction prompt changes so cached registries
 *  re-derive. Part of the cache key on every entry point. */
export const FACT_PROMPT_VERSION = "v1";

/** `CSM_AMB_FACT_FOLD` toggle (default ON since 2026-08-25). When ON, the write-time fact
 *  registry is built per user scope and folded INTO the evidence capsule on
 *  every query — always-on by design, like the preference profile: the
 *  knowledge-update queries it serves are lexically indistinguishable from
 *  information-extraction ones, so no query-conditioned gate can exist (the
 *  P2 intent-regex audit measured exactly that). Distinct from the older
 *  `CSM_AMB_FACT_MEMORY`, which replaces the capsule for aggregation-intent
 *  queries on the warm-server path and remains unchanged. */
export function factFoldActive(
  raw: string | undefined = process.env.CSM_AMB_FACT_FOLD,
): boolean {
  // DEFAULT ON since 2026-08-25. The complete evidence file, every measured
  // cell positive or neutral: 500K knowledge_update CERTIFIED on two readers
  // (+0.382 / +0.326, where the official ladder had a LOSS); 1M paired +0.114
  // with the CI excluding zero; abstention guard a wash (-0.018, 58 ties);
  // 500K contradiction_resolution +0.118 and preference_following +0.038 in
  // the composition guard (ALL +0.078, CI [0.001,0.158]); answer-context
  // tokens neutral. The cost is a one-time per-unit ingest build, disk-cached.
  return envFlag(raw, {
    name: "CSM_AMB_FACT_FOLD",
    fallback: true,
  });
}

/** Cache directory. `CSM_AMB_FACT_CACHE_DIR` overrides (tests point it at a
 *  temp dir); default is an eval-side location beside the profiles. */
export function factRegistryCacheDir(): string {
  const override = process.env.CSM_AMB_FACT_CACHE_DIR?.trim();
  return override && override.length > 0
    ? resolve(override)
    : resolve(process.cwd(), "data", "eval", "fact-registries");
}

/** Cache path for one (split, unit, model) triple — sha256 over
 *  `split|userId|model|promptVersion`, first 16 hex chars, mirroring the
 *  preference-profile scheme so the two artifacts stay operationally alike. */
export function factRegistryCachePath(inputs: {
  split: string;
  userId: string;
  /** Write-time extractor model; undefined = provider default, keyed as the
   *  literal "default". */
  model: string | undefined;
}): string {
  const cacheKey = createHash("sha256")
    .update(
      `${inputs.split}|${inputs.userId}|${inputs.model ?? "default"}|${FACT_PROMPT_VERSION}`,
    )
    .digest("hex")
    .slice(0, 16);
  return join(
    factRegistryCacheDir(),
    `${inputs.split}-u${inputs.userId}-${cacheKey}.txt`,
  );
}

/**
 * Load the registry from the disk cache, or build it via
 * `organizeFactsScaled` and cache it. Throws on build failure — callers own
 * the degrade decision (log and continue without a registry rather than fail
 * the query). A cache WRITE failure is swallowed: it must never fail a run
 * that already has the text in hand.
 */
export async function loadOrBuildFactRegistry(args: {
  baseline: CsmBaseline;
  eventContents: string[];
  split: string;
  userId: string;
  model: string | undefined;
  onProgress?: (msg: string) => void;
}): Promise<{ text: string; fromCache: boolean; outputTokens: number; chunks: number }> {
  const cachePath = factRegistryCachePath(args);
  if (existsSync(cachePath)) {
    // A 0-byte or whitespace-only file is NOT a hit. Before 2026-09-05 an empty
    // build result was written to disk and then read back as a valid artifact
    // on every later run, so the lever was permanently and silently OFF for
    // that split|user|model key -- four such files were found in the real cache.
    const cached = readFileSync(cachePath, "utf8");
    if (cached.trim().length > 0) {
      return { text: cached, fromCache: true, outputTokens: 0, chunks: 0 };
    }
    process.stderr.write(`[fact-fold] ignoring empty cache file ${cachePath} -- rebuilding\n`);
  }

  const r = await args.baseline.organizeFactsScaled({
    eventContents: args.eventContents,
    // `model` may be undefined ("provider default") — same cast the profile
    // helper ships with; it is only forwarded to `completeText`.
    model: args.model as string,
    // Same sizing rationale as the profile helper: the 600K-token defaults
    // are Gemini-era; size the map step to something any provider accepts.
    chunkTokens: envPositiveInt(process.env.CSM_AMB_FACT_CHUNK_TOKENS, {
      name: "CSM_AMB_FACT_CHUNK_TOKENS",
      fallback: 100_000,
    }),
    singlePassTokens: envPositiveInt(process.env.CSM_AMB_FACT_SINGLE_PASS_TOKENS, {
      name: "CSM_AMB_FACT_SINGLE_PASS_TOKENS",
      fallback: 120_000,
    }),
    chunkOutputTokens: envPositiveInt(process.env.CSM_AMB_FACT_CHUNK_OUTPUT, {
      name: "CSM_AMB_FACT_CHUNK_OUTPUT",
      fallback: 2000,
    }),
    finalOutputTokens: envPositiveInt(process.env.CSM_AMB_FACT_MAX_OUTPUT, {
      name: "CSM_AMB_FACT_MAX_OUTPUT",
      fallback: 2000,
    }),
    mapConcurrency: envPositiveInt(process.env.CSM_AMB_FACT_MAP_CONCURRENCY, {
      name: "CSM_AMB_FACT_MAP_CONCURRENCY",
      fallback: 4,
    }),
    onProgress: args.onProgress,
  });

  if (r.text.trim().length > 0) {
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, r.text, "utf8");
    } catch {
      // A cache write failure must never fail the run.
    }
  } else {
    // Never persist an empty build: the next run must try again, not inherit
    // a silent OFF.
    process.stderr.write(`[fact-fold] build returned empty text for ${cachePath}; not caching\n`);
  }
  return { text: r.text, fromCache: false, outputTokens: r.outputTokens, chunks: r.chunks };
}

/**
 * The capsule fold block. Header wording is a measured requirement, not
 * decoration: 2 of the 19 diagnosed losses had the current value IN context
 * and still lost because the reader hedged between old and new values, and a
 * third stated the right value but led with the history and was scored 0.5.
 * The judge pays 1.0 for crisp commitment — so the block must LICENSE the
 * reader to commit to the latest value, and must bind qualifiers (two losses
 * turned on "during recorded sessions"-style qualifier mismatches).
 */
export function renderFactFoldBlock(registry: string): string {
  return (
    "CURRENT VALUES — every metric/topic this user stated, with its value " +
    "history in conversation order and the LATEST value marked (gathered at " +
    "write time over the whole conversation; source-derived, no gold answers " +
    "or rubric used). Where a value was updated, the LATEST value IS the " +
    "current one: state it plainly as the answer, noting it supersedes the " +
    "earlier value — do not hedge between old and new. Match any qualifier " +
    "exactly (e.g. a value measured “during recorded sessions” is not the " +
    "value “during presentations”). Use an earlier value only when the " +
    "question explicitly asks about an earlier period.\n\n" +
    registry
  );
}
