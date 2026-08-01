/**
 * T4 — Gemini context-caching measurement harness.
 *
 * Three subcommands:
 *
 *   (no flags)          DRY RUN (default). Prints the live measurement matrix,
 *                       its call/token/cost budget, and exits. Makes ZERO
 *                       network calls. This is the only mode CI ever runs.
 *
 *   --offline-census    Replays the REAL CSM pipeline (router → probe → recall
 *                       → synth) over the PaySwift corpus with a capturing stub
 *                       provider and reports, with zero LLM/network calls:
 *                       per-stage request token sizes, the cross-query stable
 *                       prefix per shard (Discovery B quantified), how many
 *                       requests could EVER clear the implicit-cache floor
 *                       (4,096 tokens on gemini-3.5-flash), and the token cost
 *                       of each prompt-restructuring option from the T4 brief.
 *
 *   --live              Executes the measurement matrix against the real
 *                       Gemini API. Requires GEMINI_API_KEY/GOOGLE_API_KEY,
 *                       caps total calls at CSM_MEASURE_BUDGET_CALLS (default
 *                       100), and writes JSONL + a markdown report under
 *                       data/eval/runs/gemini-caching-measure/<timestamp>/.
 *                       54 calls, ≈$0.47 at gemini-3.5-flash prices (~225K
 *                       fresh input tokens, tiny outputs) — the dry run
 *                       prints the exact plan. The run protocol — what each
 *                       experiment establishes and how to read the results —
 *                       is docs/experiments/EXP-T4-gemini-caching.md.
 *
 * Verified API facts this harness measures against (2026-06-10, see
 * docs/experiments/EXP-T4-gemini-caching.md for the citation table):
 *   - implicit caching is default-on for Gemini 2.5+; minimum prefix for a hit
 *     on gemini-3.5-flash is 4,096 tokens (https://ai.google.dev/gemini-api/docs/caching)
 *   - explicit cachedContents minimum is ALSO 4,096 for gemini-3.5-flash; TTL
 *     defaults to 1 hour (same page + https://ai.google.dev/api/caching)
 *   - cache hits are reported in usageMetadata.cachedContentTokenCount
 *   - gemini-3.5-flash pricing: $1.50/M input, $9.00/M output, $0.15/M cached
 *     input, $1.00/M-token/hour cache storage
 *     (https://ai.google.dev/gemini-api/docs/pricing)
 *
 * Everything interesting is exported so tests/measureGeminiCaching.test.ts can
 * drive the matrix against a scripted fetch — the live path is never exercised
 * by the test suite.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadLocalEnv } from "../src/utils/loadEnv.js";
import { estimateTokens } from "../src/core/tokenBudget.js";
import { SHARD_SYSTEM_PROMPT } from "../src/core/prompts.js";
import { compactEventIndex } from "../src/core/probe.js";
import { loadCorpus, type Corpus } from "../src/eval/corpus.js";
import { CsmBaseline } from "../src/eval/baselines/csm.js";
import type { McqQuery } from "../src/eval/mcq.js";
import type {
  CompleteJsonInput,
  CompleteTextInput,
  LlmProvider,
  ProviderResponse,
} from "../src/providers/LlmProvider.js";
import type { MemoryEvent, MemoryShardSnapshot } from "../src/core/types.js";

// ─── Pricing (verified 2026-06-10) ───────────────────────────────────────────
// Source: https://ai.google.dev/gemini-api/docs/pricing — "Gemini 3.5 Flash":
// input $1.50/M, output $9.00/M, context caching $0.15/M, storage
// "$1.00 / 1,000,000 tokens per hour". The cached rate is exactly 10% of the
// input rate (a 90% discount). The 2.5-era implicit-caching launch post quoted
// "the same 75% token discount" (https://developers.googleblog.com/en/
// gemini-2-5-models-now-support-implicit-caching/); the current pricing table
// supersedes it for explicit caching, but Google does not publish the implicit
// hit discount for 3.5-flash anywhere we could find — the cost model therefore
// carries BOTH a 90% and a 75% sensitivity arm. Flag: partially verified.
export const GEMINI_35_FLASH_PRICES = {
  model: "gemini-3.5-flash",
  inputPerMTok: 1.5,
  outputPerMTok: 9.0,
  cachedInputPerMTok: 0.15,
  cacheStoragePerMTokHour: 1.0,
} as const;

/** Implicit/explicit cache minimum for gemini-3.5-flash (verified 2026-06-10,
 *  https://ai.google.dev/gemini-api/docs/caching: "Gemini 3.5 Flash | 4096"). */
export const GEMINI_35_FLASH_CACHE_MIN_TOKENS = 4096;

/** The ONE model this harness is valid for. Every number it emits is that
 *  model's: `estimatedUsd` and the effective-spend line are computed from
 *  GEMINI_35_FLASH_PRICES unconditionally, and the 4,096-token floor is baked
 *  into each call's `expectation` string plus the A1/A7 pass criteria. Both
 *  are per-model in Google's tables, so pointing the run at another model
 *  would file a report whose costs and pass/fail criteria belong to a
 *  different model. The pin is deliberate — widen it only together with a
 *  per-model price + floor table. */
export type MeasuredModel = typeof GEMINI_35_FLASH_PRICES.model;

/** Narrow an operator-supplied model name (`--model`, or `CSM_GEMINI_MODEL`
 *  picked up from `.env`) to the pinned model, or refuse to measure at all. */
export function assertMeasuredModel(model: string): MeasuredModel {
  if (model !== GEMINI_35_FLASH_PRICES.model) {
    throw new Error(
      `this harness is pinned to ${GEMINI_35_FLASH_PRICES.model}, got "${model}": its pricing ` +
        `table, the ${GEMINI_35_FLASH_CACHE_MIN_TOKENS}-token cache floor and every per-call ` +
        `expectation are ${GEMINI_35_FLASH_PRICES.model}'s, so the run would report that ` +
        `model's costs and pass criteria for a different model. Pass ` +
        `--model ${GEMINI_35_FLASH_PRICES.model} (a CSM_GEMINI_MODEL in .env is the usual ` +
        `source of a mismatch), or add a per-model price/floor table first.`,
    );
  }
  return model;
}

// ─── Deterministic synthetic payloads ────────────────────────────────────────

/** Tiny deterministic LCG so payloads are reproducible across runs/machines. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const WORDS = [
  "ledger", "payment", "gateway", "retry", "policy", "session", "lockout",
  "hashing", "vault", "audit", "invoice", "webhook", "sandbox", "rollout",
  "tenant", "quota", "fallback", "snapshot", "shard", "witness", "chronicle",
  "decision", "migration", "latency", "budget", "packet", "recall", "probe",
];

/** Deterministic prose of ~targetTokens tokens (4 chars ≈ 1 token), shaped like
 *  a CSM shard event digest so the payload is realistic for prefix caching. */
export function buildSyntheticText(targetTokens: number, seed: number, salt = ""): string {
  const rand = lcg(seed);
  const lines: string[] = [];
  if (salt) lines.push(`[variant ${salt}]`);
  let tokens = salt ? estimateTokens(lines[0]!) : 0;
  let eventIx = 1;
  while (tokens < targetTokens) {
    const w = () => WORDS[Math.floor(rand() * WORDS.length)]!;
    const line = `- [e${String(eventIx).padStart(4, "0")}] (user 2026-0${1 + (eventIx % 9)}-1${eventIx % 9}) Team decided the ${w()} ${w()} uses ${w()} with ${w()} ${w()} after reviewing the ${w()} ${w()} constraints.  tags=[${w()},${w()}]`;
    lines.push(line);
    tokens += estimateTokens(line);
    eventIx++;
  }
  return lines.join("\n");
}

// ─── Live measurement matrix ─────────────────────────────────────────────────

export interface MeasureCall {
  id: string;
  experiment: "A1" | "A2" | "A3" | "A4" | "A5" | "A6" | "A7";
  label: string;
  kind: "generate" | "cacheCreate" | "cachePatch" | "cacheDelete";
  /** For generate calls. */
  system?: string;
  prompt?: string;
  jsonMode?: boolean;
  thinkingLevel?: string;
  /** Attach the cachedContents name created by this earlier call id (first
   *  available wins). The cached system replaces systemInstruction. */
  useCacheFromCallId?: string[];
  /** Keep systemInstruction in the request EVEN with cachedContent attached —
   *  the documented-as-invalid combination; used by the A6 conflict probe. */
  keepSystemInstructionWithCache?: boolean;
  /** For cacheCreate calls. */
  cacheSystem?: string;
  ttlSeconds?: number;
  /** For cachePatch/cacheDelete: which create call's resource to target. */
  targetCacheCallId?: string;
  patchTtlSeconds?: number;
  /** The call is EXPECTED to fail with this HTTP status (negative test). */
  expectHttpStatus?: number;
  /** Expected cachedContentTokenCount behavior, recorded into the report. */
  expectation?: string;
}

export interface MeasurePlan {
  /** Pinned: the plan's cost estimate and expectations are this model's only. */
  model: MeasuredModel;
  calls: MeasureCall[];
  /** Estimated FRESH input tokens across all generate/create calls. */
  estimatedInputTokens: number;
  estimatedUsd: number;
}

/** The full A1–A7 matrix from the T4 brief. Deterministic; ~66 calls. */
export function buildMeasurementMatrix(
  model: MeasuredModel = GEMINI_35_FLASH_PRICES.model,
): MeasurePlan {
  const calls: MeasureCall[] = [];
  const QUESTION = (i: number) => `Q${i}: which retry policy did the team pick for the payment gateway? Answer in one short sentence.`;

  // A1 — implicit floor scan: stable prefix, repeated; where do hits start?
  const sizes = [1024, 2048, 3072, 4096, 5120, 6144, 8192];
  for (const size of sizes) {
    const stable = buildSyntheticText(size, 1000 + size);
    for (let rep = 0; rep < 3; rep++) {
      calls.push({
        id: `A1-${size}-r${rep}`,
        experiment: "A1",
        label: `implicit floor: stable ${size}-token system, repeat ${rep}`,
        kind: "generate",
        system: stable,
        prompt: QUESTION(rep), // varying tail (the user turn changes per call)
        expectation:
          size >= GEMINI_35_FLASH_CACHE_MIN_TOKENS
            ? "reps 1-2: cachedContentTokenCount > 0 (≥ floor)"
            : "all reps: cachedContentTokenCount absent/0 (< 4096 floor)",
      });
    }
  }

  // A2 — varying-prefix control (Discovery B simulation): same sizes, prefix
  // mutated every call → expect zero hits at ANY size.
  for (const size of [4096, 6144]) {
    for (let rep = 0; rep < 3; rep++) {
      calls.push({
        id: `A2-${size}-r${rep}`,
        experiment: "A2",
        label: `varying prefix control: ${size}-token system, variant ${rep}`,
        kind: "generate",
        system: buildSyntheticText(size, 2000 + size, `v${rep}`), // salt at the HEAD
        prompt: QUESTION(0),
        expectation: "no rep ever hits (per-call prefix bytes differ — today's probe/recall shape)",
      });
    }
  }

  // A3 — does systemInstruction participate in implicit prefix matching?
  // Docs are silent (flagged unverified). Arm S puts the stable 6K text in
  // systemInstruction; arm C puts the SAME text at the head of the user turn.
  const a3Stable = buildSyntheticText(6144, 3001);
  for (let rep = 0; rep < 3; rep++) {
    calls.push({
      id: `A3-system-r${rep}`,
      experiment: "A3",
      label: `stable 6K in systemInstruction, varying user turn, rep ${rep}`,
      kind: "generate",
      system: a3Stable,
      prompt: QUESTION(rep),
      expectation: "hits on reps 1-2 ⇒ systemInstruction DOES participate",
    });
  }
  for (let rep = 0; rep < 3; rep++) {
    calls.push({
      id: `A3-contents-r${rep}`,
      experiment: "A3",
      label: `stable 6K at head of contents, varying tail, rep ${rep}`,
      kind: "generate",
      system: "You answer questions about the project log below.",
      prompt: `${a3Stable}\n\n${QUESTION(rep)}`,
      expectation: "hits on reps 1-2 ⇒ contents prefix matching works (baseline arm)",
    });
  }

  // A4 — edit-position sensitivity on a 6K stable prefix (prefix semantics).
  const a4Stable = buildSyntheticText(6144, 4001);
  const a4Head = `[edited-head]\n${a4Stable}`;
  const half = Math.floor(a4Stable.length / 2);
  const a4Middle = `${a4Stable.slice(0, half)}[edited-middle]${a4Stable.slice(half)}`;
  const a4Tail = `${a4Stable}\n[edited-tail]`;
  calls.push(
    { id: "A4-prime", experiment: "A4", label: "prime 6K stable prefix", kind: "generate", system: a4Stable, prompt: QUESTION(0), expectation: "first call: no hit" },
    { id: "A4-hit", experiment: "A4", label: "byte-identical repeat", kind: "generate", system: a4Stable, prompt: QUESTION(0), expectation: "full-prefix hit" },
    { id: "A4-head", experiment: "A4", label: "1-line edit at HEAD", kind: "generate", system: a4Head, prompt: QUESTION(0), expectation: "0 cached (prefix broken at byte 0)" },
    { id: "A4-middle", experiment: "A4", label: "1-token edit at MIDDLE", kind: "generate", system: a4Middle, prompt: QUESTION(0), expectation: "≤50% cached (hit up to the edit) or 0" },
    { id: "A4-tail", experiment: "A4", label: "1-line edit at TAIL", kind: "generate", system: a4Tail, prompt: QUESTION(0), expectation: "near-full hit (prefix before edit intact)" },
  );

  // A5 — thinkingConfig interplay: same stable prefix across thinking levels.
  const a5Stable = buildSyntheticText(6144, 5001);
  for (const [ix, level] of (["minimal", "minimal", "low", "medium"] as const).entries()) {
    calls.push({
      id: `A5-${ix}-${level}`,
      experiment: "A5",
      label: `stable 6K prefix at thinkingLevel=${level}`,
      kind: "generate",
      system: a5Stable,
      prompt: QUESTION(0),
      thinkingLevel: level,
      expectation:
        ix === 0
          ? "prime; no hit"
          : "hit ⇒ generationConfig (thinking level) does NOT key the implicit cache",
    });
  }

  // A6 — explicit cachedContents lifecycle + restrictions.
  const a6Cache = buildSyntheticText(6144, 6001);
  calls.push(
    {
      id: "A6-create-sysonly",
      experiment: "A6",
      label: "create cachedContents: systemInstruction-only, 6K",
      kind: "cacheCreate",
      cacheSystem: a6Cache,
      ttlSeconds: 600,
      expectation: "201/200 with a name — or 400 if systemInstruction-only caches are rejected (open question)",
    },
    {
      id: "A6-use-1",
      experiment: "A6",
      label: "generate with cachedContent (text mode)",
      kind: "generate",
      prompt: QUESTION(1),
      useCacheFromCallId: ["A6-create-sysonly"],
      expectation: "cachedContentTokenCount ≈ cache size; billed at cached rate",
    },
    {
      id: "A6-use-2",
      experiment: "A6",
      label: "generate with cachedContent again (TTFT/latency sample)",
      kind: "generate",
      prompt: QUESTION(2),
      useCacheFromCallId: ["A6-create-sysonly"],
      expectation: "same; compare latency vs A2 misses of the same size",
    },
    {
      id: "A6-use-json",
      experiment: "A6",
      label: "generate with cachedContent + responseJsonSchema",
      kind: "generate",
      prompt: `${QUESTION(3)} Return JSON: {"answer": string}`,
      jsonMode: true,
      useCacheFromCallId: ["A6-create-sysonly"],
      expectation: "works ⇒ structured output is compatible with cachedContent (docs silent; wrappers reported issues)",
    },
    {
      id: "A6-conflict",
      experiment: "A6",
      label: "generate with cachedContent AND systemInstruction (documented-invalid combo)",
      kind: "generate",
      system: "This systemInstruction should be rejected.",
      prompt: QUESTION(4),
      useCacheFromCallId: ["A6-create-sysonly"],
      keepSystemInstructionWithCache: true,
      expectHttpStatus: 400,
      expectation: '400 "CachedContent can not be used with ... system_instruction"',
    },
    {
      id: "A6-patch",
      experiment: "A6",
      label: "PATCH ttl to 1200s",
      kind: "cachePatch",
      targetCacheCallId: "A6-create-sysonly",
      patchTtlSeconds: 1200,
      expectation: "200; only expiry is mutable",
    },
    {
      id: "A6-create-belowmin",
      experiment: "A6",
      label: "create cachedContents at 2K tokens (below the 4,096 floor)",
      kind: "cacheCreate",
      cacheSystem: buildSyntheticText(2048, 6002),
      ttlSeconds: 300,
      expectHttpStatus: 400,
      expectation: "400 INVALID_ARGUMENT — confirms the per-model explicit minimum",
    },
    {
      id: "A6-delete",
      experiment: "A6",
      label: "DELETE the cache (cost hygiene)",
      kind: "cacheDelete",
      targetCacheCallId: "A6-create-sysonly",
      expectation: "200; storage billing stops",
    },
  );

  // A7 — production-shaped negative control: probe/recall-sized payloads at
  // TODAY'S sizes (no restructure). Proves the brief's hypothesis: zero hits.
  const probeShaped = `${SHARD_SYSTEM_PROMPT}\n\n[Shard s-meas@S001]\nSummary:\nSynthetic shard s-meas (24 events).\n\nAvailable events (id + tags + first chars):\n${buildSyntheticText(300, 7001)}`;
  const recallShaped = `${SHARD_SYSTEM_PROMPT}\n\n[Shard s-meas@S001]\nSummary:\nSynthetic shard s-meas (24 events).\n\nEvents:\n${buildSyntheticText(1200, 7002)}`;
  for (let rep = 0; rep < 2; rep++) {
    calls.push(
      {
        id: `A7-probe-r${rep}`,
        experiment: "A7",
        label: `probe-shaped (~${estimateTokens(probeShaped)} tok system), rep ${rep}`,
        kind: "generate",
        system: probeShaped,
        prompt: QUESTION(rep),
        expectation: "0 cached at every rep — production probe requests sit far below the 4,096 floor",
      },
      {
        id: `A7-recall-r${rep}`,
        experiment: "A7",
        label: `recall-shaped (~${estimateTokens(recallShaped)} tok system), rep ${rep}`,
        kind: "generate",
        system: recallShaped,
        prompt: QUESTION(rep),
        expectation: "0 cached at every rep — recall requests also sit below the floor",
      },
    );
  }

  let estimatedInputTokens = 0;
  for (const c of calls) {
    if (c.kind === "generate") {
      estimatedInputTokens += estimateTokens(c.system ?? "") + estimateTokens(c.prompt ?? "");
    } else if (c.kind === "cacheCreate") {
      estimatedInputTokens += estimateTokens(c.cacheSystem ?? "");
    }
  }
  const estimatedUsd =
    (estimatedInputTokens / 1_000_000) * GEMINI_35_FLASH_PRICES.inputPerMTok +
    // generous output + thoughts allowance: 64 visible + ~200 thoughts per call
    (calls.length * 264 / 1_000_000) * GEMINI_35_FLASH_PRICES.outputPerMTok;

  return { model, calls, estimatedInputTokens, estimatedUsd };
}

// ─── Live runner (injectable; the test suite drives it with a scripted fetch) ─

export interface MeasureRow {
  id: string;
  experiment: string;
  label: string;
  kind: MeasureCall["kind"];
  ok: boolean;
  httpStatus: number;
  expectedFailure: boolean;
  promptTokens: number;
  cachedContentTokens: number;
  thoughtsTokens: number;
  outputTokens: number;
  latencyMs: number;
  cacheName?: string;
  error?: string;
  expectation?: string;
}

export interface MeasureDeps {
  fetchImpl: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

export interface MeasureConfig {
  apiKey: string;
  baseURL?: string;
  model?: string;
  /** Hard ceiling on executed calls; the plan aborts beyond it. */
  maxCalls?: number;
  /** Pause between calls. Implicit caching wants "requests with similar prefix
   *  in a short amount of time", so keep this small. */
  interCallDelayMs?: number;
}

export async function runMeasurement(
  plan: MeasurePlan,
  cfg: MeasureConfig,
  deps: MeasureDeps,
): Promise<MeasureRow[]> {
  const base = (cfg.baseURL ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
  const model = cfg.model ?? plan.model;
  const maxCalls = cfg.maxCalls ?? 100;
  if (plan.calls.length > maxCalls) {
    throw new Error(
      `measurement plan has ${plan.calls.length} calls > budget ${maxCalls} (CSM_MEASURE_BUDGET_CALLS)`,
    );
  }
  const headers = { "Content-Type": "application/json", "x-goog-api-key": cfg.apiKey };
  const cacheNames = new Map<string, string>(); // create-call id → cachedContents name
  const rows: MeasureRow[] = [];

  for (const call of plan.calls) {
    const row: MeasureRow = {
      id: call.id,
      experiment: call.experiment,
      label: call.label,
      kind: call.kind,
      ok: false,
      httpStatus: 0,
      expectedFailure: call.expectHttpStatus !== undefined,
      promptTokens: 0,
      cachedContentTokens: 0,
      thoughtsTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      expectation: call.expectation,
    };
    const started = deps.now();
    try {
      if (call.kind === "cacheCreate") {
        const res = await deps.fetchImpl(`${base}/cachedContents`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: `models/${model}`,
            systemInstruction: { parts: [{ text: call.cacheSystem ?? "" }] },
            ttl: `${call.ttlSeconds ?? 600}s`,
            displayName: `csm-measure:${call.id}`,
          }),
        });
        row.httpStatus = res.status;
        const json = (await res.json()) as {
          name?: string;
          usageMetadata?: { totalTokenCount?: number };
          error?: { message?: string };
        };
        if (res.ok && json.name) {
          cacheNames.set(call.id, json.name);
          row.cacheName = json.name;
          row.promptTokens = json.usageMetadata?.totalTokenCount ?? 0;
          row.ok = true;
        } else {
          row.error = json.error?.message?.slice(0, 200);
          row.ok = call.expectHttpStatus === res.status; // negative test satisfied
        }
      } else if (call.kind === "cachePatch" || call.kind === "cacheDelete") {
        const name = call.targetCacheCallId ? cacheNames.get(call.targetCacheCallId) : undefined;
        if (!name) {
          row.error = `no cache name from ${call.targetCacheCallId} (create failed?) — skipped`;
        } else {
          const res = await deps.fetchImpl(`${base}/${name}`, {
            method: call.kind === "cachePatch" ? "PATCH" : "DELETE",
            headers,
            ...(call.kind === "cachePatch"
              ? { body: JSON.stringify({ ttl: `${call.patchTtlSeconds ?? 600}s` }) }
              : {}),
          });
          row.httpStatus = res.status;
          row.ok = res.ok;
          if (!res.ok) row.error = (await res.text()).slice(0, 200);
        }
      } else {
        // generate
        const cacheName = call.useCacheFromCallId
          ?.map((id) => cacheNames.get(id))
          .find((n): n is string => Boolean(n));
        if (call.useCacheFromCallId && !cacheName) {
          row.error = `no cache available from ${call.useCacheFromCallId.join(",")} — skipped`;
          rows.push(row);
          deps.log(`${call.id}: SKIP (${row.error})`);
          continue;
        }
        const body: Record<string, unknown> = {
          ...(cacheName && !call.keepSystemInstructionWithCache
            ? {}
            : call.system
              ? { systemInstruction: { parts: [{ text: call.system }] } }
              : {}),
          contents: [{ role: "user", parts: [{ text: call.prompt ?? "" }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 256,
            thinkingConfig: { thinkingLevel: call.thinkingLevel ?? "minimal" },
            ...(call.jsonMode ? { responseMimeType: "application/json" } : {}),
          },
          ...(cacheName ? { cachedContent: cacheName } : {}),
        };
        const res = await deps.fetchImpl(`${base}/models/${model}:generateContent`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        row.httpStatus = res.status;
        const json = (await res.json()) as {
          usageMetadata?: {
            promptTokenCount?: number;
            candidatesTokenCount?: number;
            cachedContentTokenCount?: number;
            thoughtsTokenCount?: number;
          };
          error?: { message?: string };
        };
        if (res.ok) {
          row.ok = true;
          row.promptTokens = json.usageMetadata?.promptTokenCount ?? 0;
          row.cachedContentTokens = json.usageMetadata?.cachedContentTokenCount ?? 0;
          row.thoughtsTokens = json.usageMetadata?.thoughtsTokenCount ?? 0;
          row.outputTokens = json.usageMetadata?.candidatesTokenCount ?? 0;
        } else {
          row.error = json.error?.message?.slice(0, 200);
          row.ok = call.expectHttpStatus === res.status;
        }
      }
    } catch (err) {
      row.error = err instanceof Error ? err.message.slice(0, 200) : String(err);
    }
    row.latencyMs = deps.now() - started;
    rows.push(row);
    deps.log(
      `${call.id}: ${row.ok ? "ok" : "FAIL"} http=${row.httpStatus} prompt=${row.promptTokens} cached=${row.cachedContentTokens} thoughts=${row.thoughtsTokens} lat=${row.latencyMs}ms`,
    );
    await deps.sleep(cfg.interCallDelayMs ?? 500);
  }
  return rows;
}

export interface MeasureSummary {
  totalCalls: number;
  okCalls: number;
  /** Smallest A1 prefix size with a cache hit on repeat calls (null = none hit). */
  implicitFloorObserved: number | null;
  /** A1 hit-rate by size on repeats (rep > 0). */
  a1HitRateBySize: Record<string, number>;
  a2AnyHit: boolean;
  a3SystemArmHits: number;
  a3ContentsArmHits: number;
  a4: Record<string, number>; // call id → cachedContentTokens
  a5CrossLevelHits: number;
  a6ConflictRejected: boolean | null;
  a6BelowMinRejected: boolean | null;
  a6JsonModeWorked: boolean | null;
  a7AnyHit: boolean;
  avgHitLatencyMs: number | null;
  avgMissLatencyMs: number | null;
  freshInputTokens: number;
  cachedTokens: number;
  /** Effective spend at the verified price table (90% discount arm). */
  estimatedUsd: number;
}

export function summarizeRows(rows: MeasureRow[]): MeasureSummary {
  const a1Reps = rows.filter((r) => r.experiment === "A1" && /r[12]$/.test(r.id) && r.ok);
  const bySize = new Map<number, { hits: number; total: number }>();
  for (const r of a1Reps) {
    const size = Number(r.id.split("-")[1]);
    const entry = bySize.get(size) ?? { hits: 0, total: 0 };
    entry.total++;
    if (r.cachedContentTokens > 0) entry.hits++;
    bySize.set(size, entry);
  }
  const hitSizes = [...bySize.entries()].filter(([, v]) => v.hits > 0).map(([k]) => k);
  const a1HitRateBySize: Record<string, number> = {};
  for (const [size, v] of [...bySize.entries()].sort((a, b) => a[0] - b[0])) {
    a1HitRateBySize[String(size)] = v.total ? v.hits / v.total : 0;
  }

  const hitRows = rows.filter((r) => r.ok && r.kind === "generate" && r.cachedContentTokens > 0);
  const missRows = rows.filter(
    (r) => r.ok && r.kind === "generate" && r.cachedContentTokens === 0 && r.promptTokens >= 4096,
  );
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  const conflict = rows.find((r) => r.id === "A6-conflict");
  const belowMin = rows.find((r) => r.id === "A6-create-belowmin");
  const jsonUse = rows.find((r) => r.id === "A6-use-json");

  const freshInputTokens = rows.reduce(
    (acc, r) => acc + Math.max(0, r.promptTokens - r.cachedContentTokens),
    0,
  );
  const cachedTokens = rows.reduce((acc, r) => acc + r.cachedContentTokens, 0);
  const outputTokens = rows.reduce((acc, r) => acc + r.outputTokens + r.thoughtsTokens, 0);
  const p = GEMINI_35_FLASH_PRICES;

  return {
    totalCalls: rows.length,
    okCalls: rows.filter((r) => r.ok).length,
    implicitFloorObserved: hitSizes.length ? Math.min(...hitSizes) : null,
    a1HitRateBySize,
    a2AnyHit: rows.some((r) => r.experiment === "A2" && r.cachedContentTokens > 0),
    a3SystemArmHits: rows.filter((r) => r.id.startsWith("A3-system") && r.cachedContentTokens > 0).length,
    a3ContentsArmHits: rows.filter((r) => r.id.startsWith("A3-contents") && r.cachedContentTokens > 0).length,
    a4: Object.fromEntries(
      rows.filter((r) => r.experiment === "A4").map((r) => [r.id, r.cachedContentTokens]),
    ),
    a5CrossLevelHits: rows.filter(
      (r) => r.experiment === "A5" && !r.id.includes("-0-") && r.cachedContentTokens > 0,
    ).length,
    a6ConflictRejected: conflict ? conflict.httpStatus === 400 : null,
    a6BelowMinRejected: belowMin ? belowMin.httpStatus === 400 : null,
    a6JsonModeWorked: jsonUse ? jsonUse.ok && jsonUse.httpStatus === 200 : null,
    a7AnyHit: rows.some((r) => r.experiment === "A7" && r.cachedContentTokens > 0),
    avgHitLatencyMs: avg(hitRows.map((r) => r.latencyMs)),
    avgMissLatencyMs: avg(missRows.map((r) => r.latencyMs)),
    freshInputTokens,
    cachedTokens,
    estimatedUsd:
      (freshInputTokens / 1e6) * p.inputPerMTok +
      (cachedTokens / 1e6) * p.cachedInputPerMTok +
      (outputTokens / 1e6) * p.outputPerMTok,
  };
}

export function renderMeasureReport(summary: MeasureSummary, model: string): string {
  const lines = [
    `# Gemini caching measurement — ${model}`,
    "",
    `Calls: ${summary.okCalls}/${summary.totalCalls} ok. Effective spend ≈ $${summary.estimatedUsd.toFixed(4)} (fresh ${summary.freshInputTokens} tok, cached ${summary.cachedTokens} tok).`,
    "",
    `| Question | Result |`,
    `|---|---|`,
    `| A1 implicit floor (docs say 4096) | observed ${summary.implicitFloorObserved ?? "no hits at any size"} — hit-rate by size: ${JSON.stringify(summary.a1HitRateBySize)} |`,
    `| A2 varying prefix (status-quo probe/recall shape) | any hit: ${summary.a2AnyHit} (expected false) |`,
    `| A3 systemInstruction participates in implicit matching | system-arm hits ${summary.a3SystemArmHits}/2 vs contents-arm hits ${summary.a3ContentsArmHits}/2 |`,
    `| A4 edit-position sensitivity (cached tokens) | ${JSON.stringify(summary.a4)} |`,
    `| A5 thinkingLevel changes break the cache? | cross-level hits ${summary.a5CrossLevelHits}/2 (2 ⇒ no) |`,
    `| A6 cachedContent + systemInstruction rejected | ${summary.a6ConflictRejected} |`,
    `| A6 below-4096 create rejected | ${summary.a6BelowMinRejected} |`,
    `| A6 responseMimeType JSON works with cachedContent | ${summary.a6JsonModeWorked} |`,
    `| A7 production-shaped requests ever hit | ${summary.a7AnyHit} (expected false — Discovery B) |`,
    `| Cached-prefill latency delta | hit ${summary.avgHitLatencyMs?.toFixed(0) ?? "-"}ms vs miss ${summary.avgMissLatencyMs?.toFixed(0) ?? "-"}ms (≥4K-token requests) |`,
    "",
  ];
  return lines.join("\n");
}

// ─── Offline census (runnable today; zero network) ──────────────────────────

/** Stub provider that runs the REAL pipeline deterministically and records the
 *  exact request bytes each stage would send to Gemini. Returns canned-but-
 *  valid JSON per schema; probe hints/citations are regexed from the system
 *  text so recall digests get realistic hint-ordering. */
export class CapturingStubProvider implements LlmProvider {
  readonly name = "census-stub";
  readonly calls: Array<{
    schemaName: string;
    system: string;
    prompt: string;
    shardId?: string;
    snapshotId?: string;
  }> = [];

  async completeJson<T>(input: CompleteJsonInput): Promise<ProviderResponse<T>> {
    this.calls.push({
      schemaName: input.schemaName,
      system: input.system,
      prompt: input.prompt,
      shardId: input.shardId,
      snapshotId: input.snapshotId,
    });
    const eventIds = [...input.system.matchAll(/\[([A-Za-z]*e\d+)\]/g)].map((m) => m[1]!);
    let data: unknown;
    if (input.schemaName === "ProbeResult") {
      data = {
        knows: true,
        confidence: 0.8,
        memory_type: "direct",
        estimated_answer_value: "high",
        needs_full_recall: true,
        relevant_event_ids: eventIds.slice(0, 6),
      };
    } else if (input.schemaName === "RecallResult") {
      data = {
        shard_id: input.shardId ?? "s-stub",
        snapshot_id: input.snapshotId ?? "S001",
        confidence: 0.9,
        answer: "census stub answer",
        claims: eventIds.slice(0, 3).map((id) => ({
          claim: `claim referencing ${id}`,
          support: [id],
          confidence: 0.9,
        })),
        unknowns: [],
        conflicts: [],
      };
    } else if (input.schemaName === "MemoryPacket") {
      data = {
        query: "census",
        summary: "census stub packet",
        key_claims: eventIds.slice(0, 3).map((id) => ({
          claim: `packet claim ${id}`,
          sources: [id],
          confidence: 0.9,
        })),
        caveats: [],
        conflicts: [],
        recommended_main_context: "census stub context",
      };
    } else {
      data = {};
    }
    return {
      data: data as T,
      usage: {
        inputTokensEstimate: estimateTokens(input.system) + estimateTokens(input.prompt),
        outputTokensEstimate: 50,
        estimatedUsd: 0,
        latencyMs: 0,
      },
      rawText: JSON.stringify(data),
    };
  }

  async completeText(input: CompleteTextInput): Promise<ProviderResponse<string>> {
    return {
      data: "ANSWER: 1",
      usage: {
        inputTokensEstimate: estimateTokens(input.system) + estimateTokens(input.prompt),
        outputTokensEstimate: 4,
        estimatedUsd: 0,
        latencyMs: 0,
      },
      rawText: "ANSWER: 1",
    };
  }
}

export interface StageCensus {
  calls: number;
  avgRequestTokens: number;
  maxRequestTokens: number;
  /** Requests whose TOTAL size reaches the implicit floor — a hard precondition
   *  for any implicit hit, prefix stability aside. */
  atOrAboveImplicitFloor: number;
  /** Across queries probing the SAME shard: tokens of the longest common
   *  byte-prefix of the system prompt (what implicit caching could ever match). */
  avgStablePrefixTokens: number | null;
  maxStablePrefixTokens: number | null;
}

export interface RestructureOption {
  /** Tokens of a per-shard byte-stable probe system (full untruncated event
   *  index, no query ranking) — brief Q3 option (a)/R1. */
  probeStableIndexTokens: number;
  /** Tokens of the full per-shard event digest (recall.ts line format,
   *  untruncated) — what explicit-caching the whole snapshot costs — R3. */
  fullDigestTokens: number;
}

export interface CensusResult {
  corpusTokens: number;
  shardCount: number;
  queries: number;
  implicitFloorTokens: number;
  perStage: Record<string, StageCensus>;
  /** Per-shard restructure-option token costs (sorted by shard id). */
  restructure: Record<string, RestructureOption>;
  restructureTotals: {
    shards: number;
    avgProbeStableIndexTokens: number;
    avgFullDigestTokens: number;
    shardsWhereStableProbeSystemClearsFloor: number;
    shardsWhereFullDigestClearsFloor: number;
  };
}

/** Mirrors buildShardsFromCorpus in src/eval/baselines/csm.ts (private there):
 *  one shard per BenchEvent.shardId, events sorted by id, summary label,
 *  createdAt pinned. Only used to COST restructure options — the pipeline
 *  itself runs through the real adapter inside CsmBaseline. */
function snapshotForShard(shardId: string, corpus: Corpus): MemoryShardSnapshot {
  const events = [...(corpus.byShard.get(shardId) ?? [])].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const createdAt = "2024-01-01T00:00:00.000Z";
  const memoryEvents: MemoryEvent[] = events.map((e) => ({
    eventId: e.id,
    role: "user",
    content: e.content,
    createdAt: e.timestamp ?? createdAt,
    importance: e.isCore ? 0.8 : 0.4,
    tags: e.tags ?? [],
  }));
  return {
    shardId,
    snapshotId: "S001",
    systemPrompt: SHARD_SYSTEM_PROMPT,
    summary: `Synthetic shard ${shardId} (${memoryEvents.length} events).`,
    events: memoryEvents,
    indexTerms: [],
    createdAt,
    parentSnapshotId: null,
  };
}

/** Full event digest in recall.ts's line format, untruncated (restructure R3). */
function fullDigestTokensFor(snapshot: MemoryShardSnapshot): number {
  let total = 0;
  for (const e of snapshot.events) {
    const day = e.createdAt ? e.createdAt.slice(0, 10) : "";
    const line = `- [${e.eventId}] (${e.role}${day ? ` ${day}` : ""}) ${e.content}${
      e.tags.length ? `  tags=[${e.tags.join(",")}]` : ""
    }`;
    total += estimateTokens(line);
  }
  return total;
}

function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

export async function censusFromCorpus(
  corpus: Corpus,
  queries: Array<{ id: string; question: string }>,
  implicitFloorTokens = GEMINI_35_FLASH_CACHE_MIN_TOKENS,
): Promise<CensusResult> {
  // The embedding floor is the only augmentation that loads the local MiniLM
  // model; it runs AFTER ask() and never changes LLM request bytes, so the
  // census disables it for speed/offline determinism.
  const savedFloor = process.env.CSM_EMBED_FLOOR_K;
  process.env.CSM_EMBED_FLOOR_K = "0";
  const stub = new CapturingStubProvider();
  try {
    const baseline = new CsmBaseline({ provider: stub });
    for (const q of queries) {
      const mcq: McqQuery = {
        id: q.id,
        question: q.question,
        options: ["a", "b"],
        correctOption: 1,
        relevantEventIds: [],
      };
      await baseline.retrieveContext(mcq, corpus, {
        maxInputTokens: 8192,
        model: "census",
        maxOutputTokens: 256,
      });
    }
  } finally {
    if (savedFloor === undefined) delete process.env.CSM_EMBED_FLOOR_K;
    else process.env.CSM_EMBED_FLOOR_K = savedFloor;
  }

  const stageName = (schema: string) =>
    schema === "ProbeResult" ? "probe" : schema === "RecallResult" ? "recall" : "synth";
  const perStageCalls = new Map<string, typeof stub.calls>();
  for (const c of stub.calls) {
    const key = stageName(c.schemaName);
    const arr = perStageCalls.get(key) ?? [];
    arr.push(c);
    perStageCalls.set(key, arr);
  }

  const perStage: Record<string, StageCensus> = {};
  for (const [stage, calls] of perStageCalls) {
    const sizes = calls.map((c) => estimateTokens(c.system) + estimateTokens(c.prompt));
    // Stable prefix across queries per shard (probe/recall only).
    const byShard = new Map<string, string[]>();
    for (const c of calls) {
      if (!c.shardId) continue;
      const arr = byShard.get(c.shardId) ?? [];
      arr.push(c.system);
      byShard.set(c.shardId, arr);
    }
    const stablePrefixTokens: number[] = [];
    for (const systems of byShard.values()) {
      if (systems.length < 2) continue;
      let prefix = systems[0]!.length;
      for (let i = 1; i < systems.length; i++) {
        prefix = Math.min(prefix, commonPrefixLength(systems[0]!, systems[i]!));
      }
      stablePrefixTokens.push(estimateTokens(systems[0]!.slice(0, prefix)));
    }
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    perStage[stage] = {
      calls: calls.length,
      avgRequestTokens: Math.round((avg(sizes) ?? 0) * 10) / 10,
      maxRequestTokens: sizes.length ? Math.max(...sizes) : 0,
      atOrAboveImplicitFloor: sizes.filter((s) => s >= implicitFloorTokens).length,
      avgStablePrefixTokens: avg(stablePrefixTokens) !== null ? Math.round(avg(stablePrefixTokens)!) : null,
      maxStablePrefixTokens: stablePrefixTokens.length ? Math.max(...stablePrefixTokens) : null,
    };
  }

  // Restructure-option costs for every shard the pipeline actually touched.
  const touchedShards = [...new Set(stub.calls.map((c) => c.shardId).filter((s): s is string => Boolean(s)))].sort();
  const restructure: Record<string, RestructureOption> = {};
  for (const shardId of touchedShards) {
    const snapshot = snapshotForShard(shardId, corpus);
    const stableIndex = compactEventIndex(snapshot, Number.MAX_SAFE_INTEGER);
    const probeStableSystemTokens =
      estimateTokens(SHARD_SYSTEM_PROMPT) +
      estimateTokens(`\n\n[Shard ${shardId}@S001]\nSummary:\n${snapshot.summary}\n\nAvailable events (id + tags + first chars):\n`) +
      estimateTokens(stableIndex);
    restructure[shardId] = {
      probeStableIndexTokens: probeStableSystemTokens,
      fullDigestTokens: fullDigestTokensFor(snapshot),
    };
  }
  const opts = Object.values(restructure);
  const avgOf = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
  return {
    corpusTokens: corpus.totalTokens,
    shardCount: corpus.byShard.size,
    queries: queries.length,
    implicitFloorTokens,
    perStage,
    restructure,
    restructureTotals: {
      shards: opts.length,
      avgProbeStableIndexTokens: avgOf(opts.map((o) => o.probeStableIndexTokens)),
      avgFullDigestTokens: avgOf(opts.map((o) => o.fullDigestTokens)),
      shardsWhereStableProbeSystemClearsFloor: opts.filter(
        (o) => o.probeStableIndexTokens >= implicitFloorTokens,
      ).length,
      shardsWhereFullDigestClearsFloor: opts.filter((o) => o.fullDigestTokens >= implicitFloorTokens).length,
    },
  };
}

export function renderCensusReport(c: CensusResult): string {
  const lines: string[] = [
    `# Offline caching census — PaySwift ${Math.round(c.corpusTokens / 1000)}K, ${c.queries} queries, ${c.shardCount} shards`,
    "",
    `Implicit-cache floor used: ${c.implicitFloorTokens} tokens (gemini-3.5-flash, verified 2026-06-10).`,
    "",
    `| Stage | Calls | Avg req tokens | Max req tokens | ≥ floor | Avg stable prefix (tok) | Max stable prefix |`,
    `|---|---:|---:|---:|---:|---:|---:|`,
  ];
  for (const [stage, s] of Object.entries(c.perStage)) {
    lines.push(
      `| ${stage} | ${s.calls} | ${s.avgRequestTokens} | ${s.maxRequestTokens} | ${s.atOrAboveImplicitFloor} | ${s.avgStablePrefixTokens ?? "-"} | ${s.maxStablePrefixTokens ?? "-"} |`,
    );
  }
  lines.push(
    "",
    `**Reading:** a request can only ever produce an implicit cache hit if (a) its total size reaches the floor AND (b) its leading bytes repeat across calls. Today neither holds: every probe/recall request sits far below ${c.implicitFloorTokens} tokens, and the cross-query stable prefix is only the ~140-token SHARD_SYSTEM_PROMPT + shard header + summary (Discovery B).`,
    "",
    `## Restructure options (brief Q3), per touched shard`,
    "",
    `| Shard | R1: stable full probe index (system tok) | R3: full event digest (tok) |`,
    `|---|---:|---:|`,
  );
  for (const [shardId, o] of Object.entries(c.restructure)) {
    lines.push(`| ${shardId} | ${o.probeStableIndexTokens} | ${o.fullDigestTokens} |`);
  }
  const t = c.restructureTotals;
  lines.push(
    "",
    `Averages: R1 stable probe system ${t.avgProbeStableIndexTokens} tok (clears the ${c.implicitFloorTokens} floor on ${t.shardsWhereStableProbeSystemClearsFloor}/${t.shards} shards); R3 full digest ${t.avgFullDigestTokens} tok (clears it on ${t.shardsWhereFullDigestClearsFloor}/${t.shards}).`,
    "",
  );
  return lines.join("\n");
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

interface CliArgs {
  live: boolean;
  offlineCensus: boolean;
  /** Raw operator input; validated by assertMeasuredModel on the paths that
   *  actually price/expect a model (the census is model-independent). */
  model: string;
  queries?: string[];
  targetTokens: number;
  outDir?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    live: false,
    offlineCensus: false,
    model: process.env.CSM_GEMINI_MODEL ?? GEMINI_35_FLASH_PRICES.model,
    targetTokens: 100_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--live") args.live = true;
    else if (a === "--offline-census") args.offlineCensus = true;
    else if (a === "--model") args.model = argv[++i] ?? args.model;
    else if (a === "--queries") args.queries = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (a === "--target-tokens") args.targetTokens = Number(argv[++i] ?? args.targetTokens);
    else if (a === "--out") args.outDir = argv[++i];
  }
  return args;
}

async function main(): Promise<void> {
  loadLocalEnv();
  const args = parseArgs(process.argv.slice(2));

  if (args.offlineCensus) {
    const corpusDir = join("data", "eval", "corpus-synthetic");
    const { readFile } = await import("node:fs/promises");
    const queriesRaw = JSON.parse(await readFile(join(corpusDir, "queries.json"), "utf8")) as {
      queries: Array<{ id: string; question: string }>;
    };
    const queries = args.queries
      ? queriesRaw.queries.filter((q) => args.queries!.includes(q.id))
      : queriesRaw.queries;
    const corpus = await loadCorpus(corpusDir, { targetTokens: args.targetTokens, seed: 42 });
    const census = await censusFromCorpus(corpus, queries);
    const report = renderCensusReport(census);
    console.log(report);
    if (args.outDir) {
      mkdirSync(args.outDir, { recursive: true });
      writeFileSync(join(args.outDir, "census.json"), JSON.stringify(census, null, 2));
      writeFileSync(join(args.outDir, "census.md"), report);
      console.log(`written to ${args.outDir}`);
    }
    return;
  }

  // Refuse before printing a plan (let alone spending): the matrix below is
  // priced and expectation-checked for one model only.
  const model = assertMeasuredModel(args.model);

  const plan = buildMeasurementMatrix(model);
  console.log(
    `Measurement plan: ${plan.calls.length} calls, ~${plan.estimatedInputTokens} fresh input tokens, ≈$${plan.estimatedUsd.toFixed(2)} at ${plan.model} prices.`,
  );
  for (const c of plan.calls) {
    console.log(`  ${c.id.padEnd(22)} [${c.kind}] ${c.label}`);
  }

  if (!args.live) {
    console.log(
      "\nDRY RUN (default): no network calls were made. Pass --live to execute " +
        "(requires GEMINI_API_KEY; see docs/experiments/EXP-T4-gemini-caching.md " +
        "for the protocol and budget).",
    );
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";
  if (!apiKey) throw new Error("--live requires GEMINI_API_KEY or GOOGLE_API_KEY (never printed).");
  const maxCalls = Number(process.env.CSM_MEASURE_BUDGET_CALLS ?? 100);
  const rows = await runMeasurement(
    plan,
    { apiKey, model, maxCalls },
    {
      fetchImpl: globalThis.fetch.bind(globalThis),
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log: (line) => console.log(line),
    },
  );
  const summary = summarizeRows(rows);
  const report = renderMeasureReport(summary, model);
  const outDir =
    args.outDir ??
    join("data", "eval", "runs", "gemini-caching-measure", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "rows.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(outDir, "report.md"), report);
  console.log(`\n${report}\nwritten to ${outDir}`);
}

// Only run main() when executed directly (tsx scripts/measure-gemini-caching.ts),
// not when imported by the test suite.
const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("measure-gemini-caching.ts") ?? false;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
