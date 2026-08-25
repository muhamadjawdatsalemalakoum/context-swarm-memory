/** Warm CSM bridge server for the Agent Memory Benchmark.
 *
 * The one-shot bridge (`amb-csm-retrieve.ts`) pays a Node spawn + corpus
 * rebuild + embedding-model load on EVERY query (~0.8 s/query process
 * residual on the May BEAM run, plus npm wrapper overhead). This server is
 * the ingest-once / query-many replacement: the AMB provider starts it once
 * in `initialize()`, POSTs documents during `ingest()`, and calls
 * `/retrieve` per query. Retrieval goes through the exact same
 * `executeAmbRetrieve` core as the one-shot script, so AMB-visible behavior
 * is identical for identical inputs.
 *
 * Memory-safety invariant: this process holds AMB documents in RAM and
 * NEVER touches CSM's durable storage. The read-only `ask()` path inside
 * `CsmBaseline` is unchanged.
 *
 * Routes (localhost only):
 *   GET  /healthz   → { ok, llm_provider, llm_model, documents, corpora }
 *   POST /ingest    { documents: AmbDocument[] }  — also fire-and-forget
 *                   pre-warms the write-time builds for the flags that are ON
 *                   (hybrid router index, Observation, fact registry,
 *                   preference profile), so the first query of a unit doesn't
 *                   pay an arbitrary ~60-LLM-call build on its own wall clock.
 *   POST /reset     {}                            — clears documents + cache
 *   POST /retrieve  { query, k?, user_id?, query_timestamp? }
 *   POST /shutdown  {}
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CsmBaseline } from "../src/eval/baselines/csm.js";
import type { Corpus } from "../src/eval/corpus.js";
import { resolveProviderModel, type LlmProvider } from "../src/providers/LlmProvider.js";
import { envFlag, envPositiveInt } from "../src/utils/env.js";
import { loadLocalEnv } from "../src/utils/loadEnv.js";
import {
  loadOrBuildPreferenceProfile,
  preferenceProfileActive,
} from "./amb-preference-profile.js";
import {
  factFoldActive,
  loadOrBuildFactRegistry,
} from "./amb-fact-registry.js";
import {
  type AmbBridgeOptions,
  type AmbDocument,
  type AmbRetrievePayload,
  type AmbRetrieveRequest,
  aggregationQueryIntent,
  buildCorpus,
  createBridgeProvider,
  DEFAULT_BRIDGE_MAX_OUTPUT_TOKENS,
  DEFAULT_BRIDGE_MODEL_CONTEXT,
  publishBridgeModel,
  resolveBridgeModel,
  emptyAmbPayload,
  executeAmbRetrieve,
  factMemoryActive,
  observationQueryIntent,
  observeMemoryActive,
  scopeDocuments,
} from "./amb-csm-retrieve.js";

/** Max user-scoped corpora kept warm. BEAM walks units sequentially, so one
 *  would mostly hit; a little slack covers interleaved access without letting
 *  a big split pin every unit's corpus in memory at once. */
const CORPUS_CACHE_MAX = 4;

/** Request bodies are JSON; ingest batches are the largest (a BEAM 100K unit
 *  is ~400 KB of text). 256 MB leaves room for 10M-split batches while still
 *  bounding a runaway client. */
const MAX_BODY_BYTES = 256 * 1024 * 1024;

export interface ObservationBuildCost {
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  chunks: number;
}

export interface ScopedObservation {
  text: string;
  /** Non-null ONLY on the request that actually paid the build — the honest-
   *  accounting hook (see csm.ts answer(): top-level tokens must reflect the
   *  whole pipeline). Cache hits return null so the cost is attributed exactly
   *  once, to the first firing query. */
  buildCost: ObservationBuildCost | null;
}

export interface AmbServerState {
  documents: AmbDocument[];
  /** Global counter, bumped on every ingest/reset. Reported in /healthz.
   *  Cache freshness is tracked per SCOPE (see `scopeVersions`), not on this
   *  counter — otherwise ingesting unit N would invalidate unit N−1's warm
   *  builds even though N−1's scoped documents are untouched, and the /ingest
   *  pre-warm would double-build every unit under BEAM's per-unit ingest. */
  version: number;
  /** Per-scope document versions (key = user id, or `__all__` for the null
   *  scope). Bumped only when an ingest adds documents for that scope;
   *  `__all__` bumps on every non-empty ingest. Monotonic and NEVER cleared —
   *  not even on /reset — so a build that raced a reset can never be stored
   *  as fresh (its captured pre-reset version can't recur). */
  scopeVersions: Map<string, number>;
  corpusCache: Map<string, { version: number; corpus: Corpus }>;
  /** Ingestion-time organized-memory ("Observation") per user scope, built once
   *  over the full conversation and reused across that user's summary queries.
   *  Versioned like corpusCache so an ingest invalidates it. */
  observationCache: Map<string, { version: number; text: string }>;
  /** Single-flight guard for observation builds, keyed `${scope}@${version}`:
   *  a concurrent (or timeout-retried) request for the same scope joins the
   *  in-flight build instead of paying a second full multi-LLM pass — the same
   *  promise-cache pattern as csm.ts routerIndexCache. Failed builds delete
   *  their entry so the next request rebuilds (loud failure preserved). */
  observationInflight: Map<
    string,
    Promise<{ text: string; inputTokens: number; outputTokens: number; latencyMs: number; chunks: number }>
  >;
  /** Write-time FACT REGISTRY per user scope (metric value histories with
   *  LATEST markers) — same cache + single-flight contract as the Observation. */
  factCache: Map<string, { version: number; text: string }>;
  factInflight: Map<
    string,
    Promise<{ text: string; inputTokens: number; outputTokens: number; latencyMs: number; chunks: number }>
  >;
  /** Write-time STANDING PREFERENCE PROFILE per user scope
   *  (CSM_AMB_PREFERENCE_PROFILE) — same versioned-cache + single-flight
   *  contract as the Observation, but ALWAYS-ON per query (no intent gate; see
   *  executeAmbRetrieve's `preferenceProfile` doc) and additionally backed by
   *  the shared disk cache in scripts/amb-preference-profile.ts, so server and
   *  slice-harness runs reuse each other's builds. */
  preferenceCache: Map<string, { version: number; text: string }>;
  preferenceInflight: Map<string, Promise<string>>;
  /** Fold-mode fact registries (CSM_AMB_FACT_FOLD) — distinct from the legacy
   *  aggregation-intent factCache so the two modes can never serve each other. */
  factFoldCache: Map<string, { version: number; text: string }>;
  factFoldInflight: Map<string, Promise<string>>;
  baseline: CsmBaseline;
  providerName: string;
  defaults: AmbBridgeOptions;
}

export function createAmbServerState(provider?: LlmProvider): AmbServerState {
  const resolved = provider ?? createBridgeProvider();
  return {
    documents: [],
    version: 0,
    scopeVersions: new Map(),
    corpusCache: new Map(),
    observationCache: new Map(),
    observationInflight: new Map(),
    factCache: new Map(),
    factInflight: new Map(),
    preferenceCache: new Map(),
    preferenceInflight: new Map(),
    factFoldCache: new Map(),
    factFoldInflight: new Map(),
    baseline: new CsmBaseline({ provider: resolved }),
    providerName: resolved.name,
    defaults: defaultBridgeOptions(),
  };
}

/** Current document version of one user scope (0 = never ingested into). */
export function scopeVersion(state: AmbServerState, key: string): number {
  return state.scopeVersions.get(key) ?? 0;
}

/** Bump the scope versions an ingest batch touches: each distinct user_id in
 *  the batch, plus `__all__` (every document joins the null-scope corpus).
 *  An empty batch touches nothing — no invalidation. */
function bumpScopeVersions(state: AmbServerState, ingested: AmbDocument[]): void {
  if (ingested.length === 0) return;
  const scopes = new Set<string>(["__all__"]);
  for (const doc of ingested) if (doc.user_id) scopes.add(doc.user_id);
  for (const key of scopes) {
    state.scopeVersions.set(key, (state.scopeVersions.get(key) ?? 0) + 1);
  }
}

export function defaultBridgeOptions(): AmbBridgeOptions {
  return {
    model: resolveBridgeModel(),
    modelContext: envPositiveInt(process.env.CSM_AMB_MODEL_CONTEXT, {
      name: "CSM_AMB_MODEL_CONTEXT",
      fallback: DEFAULT_BRIDGE_MODEL_CONTEXT,
    }),
    maxOutputTokens: envPositiveInt(process.env.CSM_AMB_MAX_OUTPUT_TOKENS, {
      name: "CSM_AMB_MAX_OUTPUT_TOKENS",
      fallback: DEFAULT_BRIDGE_MAX_OUTPUT_TOKENS,
    }),
    withInternalAnswer: envFlag(process.env.CSM_AMB_WITH_INTERNAL_ANSWER, {
      name: "CSM_AMB_WITH_INTERNAL_ANSWER",
      fallback: false,
    }),
  };
}

/** Build (or reuse) the corpus for a user scope at the scope's doc version.
 *  Versioning is per scope so an ingest for user B does not evict user A's
 *  corpus object — which also keeps the baseline's WeakMap-keyed router index
 *  (pre-warmed at ingest) alive for A. */
export function getScopedCorpus(
  state: AmbServerState,
  userId: string | null | undefined,
): Corpus | null {
  const key = userId ?? "__all__";
  const version = scopeVersion(state, key);
  const hit = state.corpusCache.get(key);
  if (hit && hit.version === version) return hit.corpus;

  const scoped = scopeDocuments(state.documents, userId);
  if (scoped.length === 0) return null;
  const corpus = buildCorpus(scoped);

  state.corpusCache.set(key, { version, corpus });
  // Evict stale versions first, then oldest insertion until under the cap.
  for (const [k, v] of state.corpusCache) {
    if (state.corpusCache.size <= CORPUS_CACHE_MAX) break;
    if (k !== key && v.version !== scopeVersion(state, k)) state.corpusCache.delete(k);
  }
  for (const k of state.corpusCache.keys()) {
    if (state.corpusCache.size <= CORPUS_CACHE_MAX) break;
    if (k !== key) state.corpusCache.delete(k);
  }
  return corpus;
}

/** Max user-scoped Observations kept warm (one LLM-built summary each). */
const OBSERVATION_CACHE_MAX = 8;
const OBSERVATION_FOCUS =
  "the full conversation — every topic the user raised and how things developed over time";

/** Build (or reuse) the ingestion-time Observation for a user scope: one
 *  organized-memory synthesis over the FULL conversation (chronological),
 *  cached and reused across that user's summary queries. This is the Hindsight/
 *  RAPTOR/Honcho write-time pattern — synthesize once, retrieve verbatim.
 *
 *  Returns the text plus, on the request that actually paid the build, its full
 *  LLM cost (honest accounting: at the 10M tier a build is ~60 map calls over
 *  ~18M input tokens — invisible cost would corrupt the token-cost A/B vs
 *  Hindsight, whose write-time organization cost is the very thing compared). */
export async function getScopedObservation(
  state: AmbServerState,
  userId: string | null | undefined,
  corpus: Corpus,
): Promise<ScopedObservation | undefined> {
  const key = userId ?? "__all__";
  // Capture the SCOPE version BEFORE the long await: an /ingest landing
  // mid-build for THIS scope must leave the observation tagged stale, not
  // fresh (TOCTOU hardening). Ingests for other scopes don't invalidate it.
  const version = scopeVersion(state, key);
  const hit = state.observationCache.get(key);
  if (hit && hit.version === version) return { text: hit.text, buildCost: null };

  // corpus.events is in document/turn (chronological) order. The default cap is
  // high enough to cover a full conversation at any BEAM tier (10M units run to
  // tens of thousands of turns); the hierarchical map-reduce inside
  // organizeMemoryScaled — not this cap — is what bounds cost at scale.
  const maxEvents = envPositiveInt(process.env.CSM_AMB_OBSERVE_MAX_EVENTS, { name: "CSM_AMB_OBSERVE_MAX_EVENTS", fallback: 200_000 });
  const contents = corpus.events.slice(0, maxEvents).map((e) => e.content);
  if (contents.length === 0) return undefined;

  // Single-flight: a concurrent or timeout-retried request joins the in-flight
  // build rather than starting a duplicate full multi-LLM pass.
  const inflightKey = `${key}@${version}`;
  let inflight = state.observationInflight.get(inflightKey);
  const paysBuild = !inflight;
  if (!inflight) {
    // Scale-aware: single-pass for 100K-tier conversations (byte-equivalent to
    // the proven win), hierarchical chunk→map→reduce once a conversation
    // exceeds the model context window (500K/1M/10M tiers).
    const approxTokens = contents.reduce((s, c) => s + Math.ceil(c.length / 4), 0);
    process.stderr.write(
      `[observation] building user=${key} events=${contents.length} ~tokens=${approxTokens} ...\n`,
    );
    inflight = state.baseline.organizeMemoryScaled({
      query: OBSERVATION_FOCUS,
      eventContents: contents,
      // May be undefined ("provider default"); the param is typed `string` but
      // only forwards to completeText, where undefined correctly means "use
      // the provider's own default". Same cast the slice harness uses.
      model: state.defaults.model as string,
      chunkTokens: envPositiveInt(process.env.CSM_AMB_OBSERVE_CHUNK_TOKENS, { name: "CSM_AMB_OBSERVE_CHUNK_TOKENS", fallback: 600_000 }),
      singlePassTokens: envPositiveInt(process.env.CSM_AMB_OBSERVE_SINGLE_PASS_TOKENS, { name: "CSM_AMB_OBSERVE_SINGLE_PASS_TOKENS", fallback: 700_000 }),
      chunkOutputTokens: envPositiveInt(process.env.CSM_AMB_OBSERVE_CHUNK_OUTPUT, { name: "CSM_AMB_OBSERVE_CHUNK_OUTPUT", fallback: 3000 }),
      // Default matches organizeMemoryScaled's own default AND the proven
      // 0.9364 run (measured observations were 4.0K–10.5K tokens; the old 2048
      // default silently truncated ~95% of them — 2026-06-24 audit finding).
      finalOutputTokens: envPositiveInt(process.env.CSM_AMB_OBSERVE_MAX_OUTPUT, { name: "CSM_AMB_OBSERVE_MAX_OUTPUT", fallback: 12_000 }),
      mapConcurrency: envPositiveInt(process.env.CSM_AMB_OBSERVE_MAP_CONCURRENCY, { name: "CSM_AMB_OBSERVE_MAP_CONCURRENCY", fallback: 4 }),
      onProgress: (msg) => process.stderr.write(`[observation] user=${key} ${msg}\n`),
    });
    state.observationInflight.set(inflightKey, inflight);
    // Failed builds clear the slot so the next request rebuilds (loud failure
    // preserved — a silent baseline fallback would corrupt the A/B).
    inflight.catch(() => state.observationInflight.delete(inflightKey));
  }
  const organized = await inflight;
  state.observationInflight.delete(inflightKey);
  process.stderr.write(
    `[observation] done user=${key} chunks=${organized.chunks} ` +
      `inTokens=${organized.inputTokens} outTokens=${organized.outputTokens} ` +
      `ms=${Math.round(organized.latencyMs)}\n`,
  );

  state.observationCache.set(key, { version, text: organized.text });
  for (const [k, v] of state.observationCache) {
    if (state.observationCache.size <= OBSERVATION_CACHE_MAX) break;
    if (k !== key && v.version !== scopeVersion(state, k)) state.observationCache.delete(k);
  }
  for (const k of state.observationCache.keys()) {
    if (state.observationCache.size <= OBSERVATION_CACHE_MAX) break;
    if (k !== key) state.observationCache.delete(k);
  }
  return {
    text: organized.text,
    buildCost: paysBuild
      ? {
          inputTokens: organized.inputTokens,
          outputTokens: organized.outputTokens,
          latencyMs: organized.latencyMs,
          chunks: organized.chunks,
        }
      : null,
  };
}

/** Fold-mode fact registry (CSM_AMB_FACT_FOLD, default ON): same contract as
 *  getScopedPreferenceProfile — versioned in-RAM cache + single-flight with
 *  the SHARED disk cache (scripts/amb-fact-registry.ts) underneath, so server
 *  and slice runs reuse each other's builds when split+model+prompt match
 *  (set CSM_AMB_SPLIT on official runs). No intent gate: the queries the
 *  registry serves are lexically indistinguishable from extraction ones.
 *  Failure degrades the QUERY to no-registry, never fails it. Distinct from
 *  the legacy aggregation-intent path below, which is unchanged. */
export async function getScopedFactRegistryFolded(
  state: AmbServerState,
  userId: string | null | undefined,
  corpus: Corpus,
): Promise<string | undefined> {
  const key = userId ?? "__all__";
  const version = scopeVersion(state, key);
  const hit = state.factFoldCache.get(key);
  if (hit && hit.version === version) return hit.text;

  const inflightKey = `${key}@${version}`;
  let inflight = state.factFoldInflight.get(inflightKey);
  if (!inflight) {
    inflight = loadOrBuildFactRegistry({
      baseline: state.baseline,
      eventContents: corpus.events.map((e) => e.content),
      split: resolvePreferenceSplit(),
      userId: key,
      model: resolveProviderModel(state.providerName),
      onProgress: (msg) => process.stderr.write(`[fact-fold] user=${key} ${msg}
`),
    }).then((r) => {
      process.stderr.write(
        r.fromCache
          ? `[fact-fold] user=${key} registry from disk cache
`
          : `[fact-fold] user=${key} registry ready (${r.outputTokens} out-tok, ${r.chunks} chunk(s))
`,
      );
      return r.text;
    });
    state.factFoldInflight.set(inflightKey, inflight);
    inflight.catch(() => state.factFoldInflight.delete(inflightKey));
  }

  let text: string;
  try {
    text = await inflight;
  } catch (err) {
    process.stderr.write(`[fact-fold] user=${key} FAILED: ${String(err).slice(0, 200)}
`);
    return undefined;
  }
  state.factFoldInflight.delete(inflightKey);

  state.factFoldCache.set(key, { version, text });
  for (const [k, v] of state.factFoldCache) {
    if (state.factFoldCache.size <= PREFERENCE_CACHE_MAX) break;
    if (k !== key && v.version !== scopeVersion(state, k)) state.factFoldCache.delete(k);
  }
  return text;
}

/** Build (or reuse) the write-time FACT REGISTRY for a user scope — mirror of
 *  getScopedObservation (versioned cache, single-flight, exactly-once cost). */
export async function getScopedFactRegistry(
  state: AmbServerState,
  userId: string | null | undefined,
  corpus: Corpus,
): Promise<ScopedObservation | undefined> {
  const key = userId ?? "__all__";
  const version = scopeVersion(state, key);
  const hit = state.factCache.get(key);
  if (hit && hit.version === version) return { text: hit.text, buildCost: null };

  const maxEvents = envPositiveInt(process.env.CSM_AMB_OBSERVE_MAX_EVENTS, { name: "CSM_AMB_OBSERVE_MAX_EVENTS", fallback: 200_000 });
  const contents = corpus.events.slice(0, maxEvents).map((e) => e.content);
  if (contents.length === 0) return undefined;

  const inflightKey = `${key}@${version}`;
  let inflight = state.factInflight.get(inflightKey);
  const paysBuild = !inflight;
  if (!inflight) {
    const approxTokens = contents.reduce((s, c) => s + Math.ceil(c.length / 4), 0);
    process.stderr.write(
      `[facts] building user=${key} events=${contents.length} ~tokens=${approxTokens} ...\n`,
    );
    inflight = state.baseline.organizeFactsScaled({
      eventContents: contents,
      // Same undefined-means-provider-default contract as the observation
      // build above.
      model: state.defaults.model as string,
      chunkTokens: envPositiveInt(process.env.CSM_AMB_OBSERVE_CHUNK_TOKENS, { name: "CSM_AMB_OBSERVE_CHUNK_TOKENS", fallback: 600_000 }),
      singlePassTokens: envPositiveInt(process.env.CSM_AMB_OBSERVE_SINGLE_PASS_TOKENS, { name: "CSM_AMB_OBSERVE_SINGLE_PASS_TOKENS", fallback: 700_000 }),
      chunkOutputTokens: envPositiveInt(process.env.CSM_AMB_FACT_CHUNK_OUTPUT, { name: "CSM_AMB_FACT_CHUNK_OUTPUT", fallback: 4000 }),
      finalOutputTokens: envPositiveInt(process.env.CSM_AMB_FACT_MAX_OUTPUT, { name: "CSM_AMB_FACT_MAX_OUTPUT", fallback: 12_000 }),
      mapConcurrency: envPositiveInt(process.env.CSM_AMB_OBSERVE_MAP_CONCURRENCY, { name: "CSM_AMB_OBSERVE_MAP_CONCURRENCY", fallback: 4 }),
      onProgress: (msg) => process.stderr.write(`[facts] user=${key} ${msg}\n`),
    });
    state.factInflight.set(inflightKey, inflight);
    inflight.catch(() => state.factInflight.delete(inflightKey));
  }
  const organized = await inflight;
  state.factInflight.delete(inflightKey);
  process.stderr.write(
    `[facts] done user=${key} chunks=${organized.chunks} ` +
      `inTokens=${organized.inputTokens} outTokens=${organized.outputTokens} ` +
      `ms=${Math.round(organized.latencyMs)}\n`,
  );

  state.factCache.set(key, { version, text: organized.text });
  for (const [k, v] of state.factCache) {
    if (state.factCache.size <= OBSERVATION_CACHE_MAX) break;
    if (k !== key && v.version !== scopeVersion(state, k)) state.factCache.delete(k);
  }
  for (const k of state.factCache.keys()) {
    if (state.factCache.size <= OBSERVATION_CACHE_MAX) break;
    if (k !== key) state.factCache.delete(k);
  }
  return {
    text: organized.text,
    buildCost: paysBuild
      ? {
          inputTokens: organized.inputTokens,
          outputTokens: organized.outputTokens,
          latencyMs: organized.latencyMs,
          chunks: organized.chunks,
        }
      : null,
  };
}

/** Max preference profiles kept warm. Deliberately roomier than the
 *  Observation cap: a profile is ~2.5K tokens of text (cheap to hold) but is
 *  needed on EVERY query of its unit (always-on), so evicting one costs a
 *  full multi-LLM rebuild — or a disk-cache read at best — on the very next
 *  query for that unit. */
const PREFERENCE_CACHE_MAX = 64;

/** `CSM_AMB_SPLIT` — the BEAM split label (`100k`/`500k`/`1m`/`10m`) for the
 *  preference-profile DISK-cache key. AMB requests carry no split notion, so
 *  the label rides in on the environment; set it to the split being run to
 *  share cache entries with `run-beam-slice.ts` runs of the same
 *  split/unit/model. Default "amb" = a private namespace (never a false hit,
 *  because the label is hashed into the key alongside unit/model/prompt). */
function resolvePreferenceSplit(): string {
  const raw = process.env.CSM_AMB_SPLIT?.trim();
  return raw && raw.length > 0 ? raw : "amb";
}

/** Build (or reuse) the write-time STANDING PREFERENCE PROFILE for a user
 *  scope — versioned cache + single-flight like getScopedObservation, plus
 *  the shared disk cache (scripts/amb-preference-profile.ts) underneath.
 *
 *  Failure contract mirrors the slice harness: a failed build logs loudly and
 *  returns undefined so the QUERY degrades to no-profile instead of failing;
 *  the in-flight slot is cleared so the next request retries. No token-cost
 *  attribution on purpose — the slice path attributes none either (the
 *  profile is a disk-cached cross-run artifact), and the two paths must stay
 *  byte-identical for identical inputs. */
export async function getScopedPreferenceProfile(
  state: AmbServerState,
  userId: string | null | undefined,
  corpus: Corpus,
): Promise<string | undefined> {
  const key = userId ?? "__all__";
  const version = scopeVersion(state, key);
  const hit = state.preferenceCache.get(key);
  if (hit && hit.version === version) return hit.text;

  const inflightKey = `${key}@${version}`;
  let inflight = state.preferenceInflight.get(inflightKey);
  if (!inflight) {
    inflight = loadOrBuildPreferenceProfile({
      baseline: state.baseline,
      eventContents: corpus.events.map((e) => e.content),
      split: resolvePreferenceSplit(),
      userId: key,
      // Same resolution as run-beam-slice's writeTimeModel: the ACTIVE
      // provider's own configured model (undefined = provider default), never
      // CSM_AMB_MODEL, which is a retrieval-stage id.
      model: resolveProviderModel(state.providerName),
      onProgress: (msg) => process.stderr.write(`[pref] user=${key} ${msg}\n`),
    }).then((r) => {
      process.stderr.write(
        r.fromCache
          ? `[pref] user=${key} profile from disk cache\n`
          : `[pref] user=${key} profile ready (${r.outputTokens} out-tok, ${r.chunks} chunk(s))\n`,
      );
      return r.text;
    });
    state.preferenceInflight.set(inflightKey, inflight);
    inflight.catch(() => state.preferenceInflight.delete(inflightKey));
  }

  let text: string;
  try {
    text = await inflight;
  } catch (err) {
    process.stderr.write(
      `[pref] user=${key} FAILED: ${String(err).slice(0, 200)}\n`,
    );
    return undefined;
  }
  state.preferenceInflight.delete(inflightKey);

  state.preferenceCache.set(key, { version, text });
  for (const [k, v] of state.preferenceCache) {
    if (state.preferenceCache.size <= PREFERENCE_CACHE_MAX) break;
    if (k !== key && v.version !== scopeVersion(state, k)) state.preferenceCache.delete(k);
  }
  for (const k of state.preferenceCache.keys()) {
    if (state.preferenceCache.size <= PREFERENCE_CACHE_MAX) break;
    if (k !== key) state.preferenceCache.delete(k);
  }
  return text;
}

export async function handleRetrieve(
  state: AmbServerState,
  request: AmbRetrieveRequest,
): Promise<AmbRetrievePayload> {
  const corpus = getScopedCorpus(state, request.user_id);
  if (!corpus) return emptyAmbPayload("no_documents_in_scope");
  // Write-time levers, each behind its own flag + validated zero-leak gate so
  // every non-firing query stays byte-identical to baseline:
  // - observation: retrospective summary / order-recap intent
  // - fact registry: aggregation intent (multi_session "total/combined" questions)
  // Observation intent is checked FIRST: summarization/event_ordering queries can
  // embed incidental aggregation phrases ("mention 8 items in total" — measured
  // at 500k), while multi_session aggregation queries match the observation gate
  // 0/2000 times across all tiers — so this order is strictly protective.
  let fact: ScopedObservation | undefined;
  let observation: ScopedObservation | undefined;
  if (observeMemoryActive() && observationQueryIntent(request.query)) {
    observation = await getScopedObservation(state, request.user_id, corpus);
  } else if (factMemoryActive() && aggregationQueryIntent(request.query)) {
    fact = await getScopedFactRegistry(state, request.user_id, corpus);
  }
  // ALWAYS-ON standing preference profile (CSM_AMB_PREFERENCE_PROFILE=1): no
  // intent gate, because the preference/instruction queries it serves never
  // mention the preference they test. Normally pre-warmed at /ingest; a query
  // arriving before the build finishes joins the in-flight build here.
  const preferenceProfile = preferenceProfileActive()
    ? await getScopedPreferenceProfile(state, request.user_id, corpus)
    : undefined;
  // Fold-mode registry (CSM_AMB_FACT_FOLD, default ON) — always-on like the
  // profile. Without this the certified knowledge_update lever existed ONLY on
  // the slice harness: the official AMB path would have silently run without
  // it, the same class of gap the preference profile once had.
  const foldedFactRegistry = factFoldActive()
    ? await getScopedFactRegistryFolded(state, request.user_id, corpus)
    : undefined;
  return executeAmbRetrieve({
    baseline: state.baseline,
    providerName: state.providerName,
    corpus,
    request,
    opts: state.defaults,
    observation: observation?.text,
    observationBuildCost: observation?.buildCost ?? null,
    factRegistry: foldedFactRegistry ?? fact?.text,
    factBuildCost: fact?.buildCost ?? null,
    preferenceProfile,
  });
}

/** Ingest-time pre-warm (fire-and-forget) for every user scope in the batch,
 *  covering each write-time build whose flag is ON:
 *    - hybrid router index      (CSM_ROUTER_HYBRID; zero LLM, MiniLM embed)
 *    - Observation              (CSM_AMB_OBSERVE_MEMORY)
 *    - fact registry            (CSM_AMB_FACT_MEMORY)
 *    - preference profile       (CSM_AMB_PREFERENCE_PROFILE)
 *  Each build goes through the SAME single-flight getter the query path uses,
 *  so an early query joins the in-flight build — never a double build. Errors
 *  are logged per build and never propagate (ingest already responded; the
 *  query path re-attempts with its own failure semantics). The null `__all__`
 *  scope is deliberately NOT pre-warmed: BEAM queries are always user-scoped,
 *  and an all-documents build at the 10M tier would be enormous and unused. */
export function prewarmIngestedScopes(
  state: AmbServerState,
  ingested: AmbDocument[],
): void {
  const users = new Set<string>();
  for (const doc of ingested) if (doc.user_id) users.add(doc.user_id);
  const queue = [...users];
  // THROTTLE (2026-08-25 pre-flight audit): an AMB 1M ingest delivers ~35
  // units in one batch, and firing every scope at once meant up to 35 units
  // x 2 write-time artifacts x mapConcurrency 4 = ~280 concurrent
  // ~100K-token calls (~28M tokens in flight) -- past any Gemini TPM tier;
  // sustained 429s exhaust CSM_GEMINI_MAX_RETRIES and push builds onto the
  // query path, where a 10M-scale build blows the AMB provider 600s
  // retrieve timeout with no retry. Bounded workers over a queue instead;
  // early queries still JOIN in-flight builds via the single-flight maps.
  const width = Math.min(
    envPositiveInt(process.env.CSM_AMB_PREWARM_SCOPES, {
      name: "CSM_AMB_PREWARM_SCOPES",
      fallback: 2,
    }),
    Math.max(1, queue.length),
  );
  const worker = async (): Promise<void> => {
    for (;;) {
      const userId = queue.shift();
      if (userId === undefined) return;
      try {
        await prewarmScope(state, userId);
      } catch (err) {
        // Belt-and-braces: prewarmScope already catches per-build.
        process.stderr.write(
          `[prewarm] user=${userId} failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  };
  for (let i = 0; i < width; i++) void worker();
}

async function prewarmScope(state: AmbServerState, userId: string): Promise<void> {
  const corpus = getScopedCorpus(state, userId);
  if (!corpus) return;
  const logFailure = (build: string) => (err: unknown) => {
    process.stderr.write(
      `[prewarm] user=${userId} ${build} build failed (query path will retry): ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
    return undefined;
  };
  const jobs: Array<Promise<unknown>> = [];
  const router = state.baseline.warmRouterIndex(corpus);
  if (router) jobs.push(router.catch(logFailure("router-index")));
  if (observeMemoryActive()) {
    jobs.push(
      getScopedObservation(state, userId, corpus).catch(logFailure("observation")),
    );
  }
  if (factMemoryActive()) {
    jobs.push(
      getScopedFactRegistry(state, userId, corpus).catch(logFailure("fact-registry")),
    );
  }
  if (factFoldActive()) {
    // getScopedFactRegistryFolded already degrades + logs on failure.
    jobs.push(getScopedFactRegistryFolded(state, userId, corpus));
  }
  if (preferenceProfileActive()) {
    // getScopedPreferenceProfile already degrades + logs on failure.
    jobs.push(getScopedPreferenceProfile(state, userId, corpus));
  }
  await Promise.all(jobs);
}

export function createAmbServer(state: AmbServerState): Server {
  return createServer((req, res) => {
    routeRequest(state, req, res).catch((err) => {
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
}

async function routeRequest(
  state: AmbServerState,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = req.url ?? "/";

  if (req.method === "GET" && (url === "/healthz" || url === "/")) {
    sendJson(res, 200, {
      ok: true,
      service: "csm-amb-bridge",
      llm_provider: state.providerName,
      llm_model: state.defaults.model,
      documents: state.documents.length,
      corpora: state.corpusCache.size,
      version: state.version,
    });
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: `method ${req.method} not allowed` });
    return;
  }

  if (url === "/shutdown") {
    sendJson(res, 200, { ok: true, shutting_down: true });
    res.once("close", () => {
      // Give the response a beat to flush, then exit. The AMB provider also
      // terminates the child process in cleanup(), so this is belt-and-braces.
      setTimeout(() => process.exit(0), 50).unref();
    });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  switch (url) {
    case "/ingest": {
      const docs = (body as { documents?: unknown }).documents;
      if (!Array.isArray(docs)) {
        sendJson(res, 400, { error: 'body must be {"documents": [...]}' });
        return;
      }
      for (const doc of docs) state.documents.push(doc as AmbDocument);
      state.version++;
      bumpScopeVersions(state, docs as AmbDocument[]);
      sendJson(res, 200, { ok: true, ingested: docs.length, total: state.documents.length });
      // Ingest-time pre-warm (fire-and-forget, AFTER the response): the lazy
      // first-query builds — router index, Observation, fact registry,
      // preference profile — otherwise charge one arbitrary query's wall
      // clock (~60 LLM calls at the 10M tier for the registry). Single-flight
      // inside each getter means a query arriving early just joins the
      // in-flight build; a pre-warm failure is logged, never fatal — the
      // query path keeps its own (loud or degrading) failure semantics.
      prewarmIngestedScopes(state, docs as AmbDocument[]);
      return;
    }
    case "/reset": {
      state.documents = [];
      state.corpusCache.clear();
      state.observationCache.clear();
      state.observationInflight.clear();
      state.factCache.clear();
      state.factInflight.clear();
      state.preferenceCache.clear();
      state.factFoldCache.clear();
      state.preferenceInflight.clear();
      // scopeVersions deliberately NOT cleared: versions stay monotonic so an
      // in-flight build that raced this reset can never be re-read as fresh.
      state.version++;
      sendJson(res, 200, { ok: true });
      return;
    }
    case "/retrieve": {
      const request = body as AmbRetrieveRequest;
      if (!request || typeof request.query !== "string" || request.query.length === 0) {
        sendJson(res, 400, { error: 'body must include string field "query"' });
        return;
      }
      const payload = await handleRetrieve(state, request);
      sendJson(res, 200, payload);
      return;
    }
    default:
      sendJson(res, 404, { error: `unknown route ${url}` });
  }
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(text));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const text = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function main(): Promise<void> {
  // Same env contract as the CLI and the one-shot bridge: pick up the CSM
  // repo's .env; vars exported by the parent (AMB) process win.
  loadLocalEnv();

  const portArgIx = process.argv.indexOf("--port");
  const requestedPort =
    portArgIx !== -1 ? Number.parseInt(process.argv[portArgIx + 1] ?? "0", 10) : 0;

  const state = createAmbServerState();
  publishBridgeModel(state.defaults.model);
  const server = createAmbServer(state);

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(
      { host: "127.0.0.1", port: Number.isFinite(requestedPort) ? requestedPort : 0 },
      () => resolveListen(),
    );
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : requestedPort;
  // The AMB provider parses this exact line to learn the ephemeral port.
  process.stdout.write(`AMB_CSM_SERVER_READY port=${port}\n`);
  process.stderr.write(
    `csm-amb-bridge listening on 127.0.0.1:${port} (provider=${state.providerName}, model=${state.defaults.model})\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(
      `amb-csm-server failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exitCode = 1;
  });
}
