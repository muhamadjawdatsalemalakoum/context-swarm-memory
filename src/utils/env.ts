/**
 * ENV — the single source of truth for reading configuration out of the
 * environment.
 *
 * ── WHY THIS MODULE EXISTS ──────────────────────────────────────────────────
 *
 * CSM is configured almost entirely through ~110 `CSM_*` environment
 * variables, and every one of them was parsed by hand at its point of use. An
 * audit of the read sites found **six mutually incompatible truthiness rules**
 * for what is nominally the same kind of value — a boolean flag:
 *
 *   src/core/ask.ts:resolveEagerRecalls          1 | true | yes
 *   src/core/probe.ts:resolveProbeFullScan       1 | true | yes
 *   src/core/digestSelection.ts:resolveSignals…  1 | true          (no trim!)
 *   src/eval/rerank.ts:rerankerEnabled           1 | true | yes | on
 *   src/eval/baselines/csm.ts:resolveShardDesc…  1 | true | yes
 *   src/eval/baselines/csm.ts:resolveRouterHyb…  NOT (0 | false | no)
 *
 * The consequences were measured, not hypothesised:
 *
 *   - `CSM_SIGNALS_RANKER=yes` was silently OFF while `CSM_HYBRID_RERANK=yes`
 *     was ON. Same word, same shape of flag, opposite meaning.
 *   - `CSM_SIGNALS_RANKER=" 1"` (a stray space, trivially produced by a shell
 *     or a .env file) was silently OFF — that resolver never trimmed.
 *   - Worst: `resolveRouterHybrid` is a DEFAULT-OFF flag parsed by NEGATION, so
 *     **`CSM_ROUTER_HYBRID=off` turns the hybrid router ON**, as do `disabled`,
 *     `OFF`, and `n`. The hybrid router is CSM's single largest measured
 *     retrieval win (+0.365 at BEAM 1M). An A/B whose baseline arm was written
 *     `CSM_ROUTER_HYBRID=off` would have run the TREATMENT in both arms and
 *     recorded it as the control.
 *
 * No shipped run was actually corrupted — every recorded invocation uses `=1`
 * — but the failure is silent by construction, so "we would have noticed" is
 * not available as a defence.
 *
 * ── THE INVARIANT ───────────────────────────────────────────────────────────
 *
 * **An unrecognised configuration value is an error, never a default.**
 *
 * Silently defaulting is what makes a misconfiguration indistinguishable from
 * an intentional one. `envFlag` accepts a generous, documented vocabulary in
 * BOTH directions and throws — naming the variable and the offending value —
 * on anything else. A typo stops the run instead of quietly producing a
 * mislabelled benchmark row.
 *
 * This is the same invariant `src/core/selection.ts` enforces for ranking
 * ("a component that cannot discriminate must say so") applied to config: a
 * component that cannot interpret its input must say so.
 *
 * Pure and deterministic: no clock, no randomness, no I/O. `process.env` is
 * only ever the DEFAULT argument, so every consumer stays testable.
 */

/** Values accepted as `true`. Lower-cased and trimmed before lookup. */
const TRUE_VALUES = new Set(["1", "true", "yes", "y", "on", "enable", "enabled"]);

/** Values accepted as `false`. Lower-cased and trimmed before lookup. */
const FALSE_VALUES = new Set(["0", "false", "no", "n", "off", "disable", "disabled"]);

export class EnvConfigError extends Error {
  constructor(
    readonly variable: string,
    readonly value: string,
    detail: string,
  ) {
    super(`${variable}=${JSON.stringify(value)} is not valid: ${detail}`);
    this.name = "EnvConfigError";
  }
}

export interface EnvFlagOptions {
  /** Name of the variable, used in error messages. */
  name: string;
  /** Value when the variable is unset or empty. */
  fallback: boolean;
}

/**
 * Read a boolean flag.
 *
 * Unset or empty (including whitespace-only) → `fallback`. Otherwise the value
 * must appear in `TRUE_VALUES` or `FALSE_VALUES`; anything else throws
 * `EnvConfigError`.
 *
 * Note the asymmetry with the old hand-rolled resolvers: those treated
 * "unrecognised" as "the default", which is precisely how `=off` could mean ON.
 */
export function envFlag(raw: string | undefined, opts: EnvFlagOptions): boolean {
  if (raw === undefined || raw.trim().length === 0) return opts.fallback;
  const v = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(v)) return true;
  if (FALSE_VALUES.has(v)) return false;
  throw new EnvConfigError(
    opts.name,
    raw,
    `expected one of ${[...TRUE_VALUES].join(", ")} (true) or ${[...FALSE_VALUES].join(", ")} (false)`,
  );
}

export interface EnvIntOptions {
  /** Name of the variable, used in error messages. */
  name: string;
  /** Value when the variable is unset or empty. */
  fallback: number;
  /** Smallest accepted value. Default 0. */
  min?: number;
  /** Largest accepted value. Default `Number.MAX_SAFE_INTEGER`. */
  max?: number;
}

/**
 * Read an integer.
 *
 * Unset or empty → `fallback`. Non-numeric, fractional, or out-of-range values
 * throw rather than silently falling back — a mistyped budget that quietly
 * reverts to the default is the same silent-misconfiguration failure as a
 * mistyped flag.
 */
export function envInt(raw: string | undefined, opts: EnvIntOptions): number {
  return envIntOptional(raw, opts) ?? opts.fallback;
}

/**
 * `envInt` for callers that distinguish "unset" from "set to a value" — the
 * providers, which chain `env ?? constructorOption ?? builtinDefault`.
 *
 * Returns `undefined` only when the variable is genuinely absent. A present but
 * unparseable value still throws; the hand-rolled versions this replaces
 * returned `undefined`/NaN for garbage, so `CSM_GEMINI_TIMEOUT_MS=6O000` (letter
 * O) silently ran at the default timeout, and the Ollama/llama-server parsers
 * propagated a raw `NaN` into the timeout.
 */
export function envIntOptional(
  raw: string | undefined,
  opts: Omit<EnvIntOptions, "fallback"> & { fallback?: number },
): number | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const text = raw.trim();
  const min = opts.min ?? 0;
  const max = opts.max ?? Number.MAX_SAFE_INTEGER;
  if (!/^[+-]?\d+$/.test(text)) {
    throw new EnvConfigError(opts.name, raw, "expected an integer");
  }
  const parsed = Number.parseInt(text, 10);
  if (!Number.isFinite(parsed)) {
    throw new EnvConfigError(opts.name, raw, "expected an integer");
  }
  if (parsed < min || parsed > max) {
    throw new EnvConfigError(opts.name, raw, `expected an integer in [${min}, ${max}]`);
  }
  return parsed;
}

/**
 * `envInt` with `min: 1` — the common "a count/budget must be positive" case.
 * Note that `0` throws here rather than reverting to the fallback; when 0 is a
 * meaningful "disabled" value, call `envInt` with `min: 0` explicitly.
 */
export function envPositiveInt(
  raw: string | undefined,
  opts: Omit<EnvIntOptions, "min">,
): number {
  return envInt(raw, { ...opts, min: 1 });
}

/** Exposed for tests and for `csm provider info`-style diagnostics. */
export const ENV_TRUE_VALUES: readonly string[] = [...TRUE_VALUES];
export const ENV_FALSE_VALUES: readonly string[] = [...FALSE_VALUES];
