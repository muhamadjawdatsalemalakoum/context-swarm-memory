/**
 * Audit F9 — does the AMB bridge's hardcoded term-expansion table actually fire?
 *
 * `expandCoverageTerms` in `scripts/amb-csm-retrieve.ts` carries a hand-written
 * synonym table keyed on four triggers (security / database / weather /
 * performance) whose expansions are the vocabulary of a Flask weather app
 * ("flask-wtf", "sqlalchemy", "operationalerror", "openweather", "ga4"). It runs
 * on five retrieval call sites including the coverage capsule — i.e. on the path
 * that produces every BEAM answer.
 *
 * That contradicts the principle stated in `src/core/coverage.ts`: expansion is
 * supposed to be corpus-derived TF-IDF with "zero hardcoded vocabulary".
 *
 * This script answers, with zero LLM calls: on the real BEAM query sets, how
 * often does a trigger fire, and what does it inject when it does?
 *
 *   npx tsx scripts/audit-term-expansion.ts
 */
import { loadBeamRetrievalQueries } from "../src/eval/corpus/beam.js";

const TRIGGERS: Record<string, string[]> = {
  security: [
    "auth", "authentication", "password", "hash", "csrf", "flask-wtf",
    "session", "login", "lockout", "redis", "role", "https",
  ],
  database: [
    "sqlite", "sqlalchemy", "postgres", "transaction", "migration", "table",
    "schema", "constraint", "uuid", "operationalerror",
  ],
  weather: [
    "openweather", "temperature", "humidity", "conditions", "autocomplete",
    "cors", "forecast", "api", "rate", "cache",
  ],
  performance: [
    "lazy", "loading", "load", "latency", "bounce", "analytics", "ga4", "tracking",
  ],
};

/** Same grammar as the bridge's `extractContentTerms`, minus the stop list —
 *  a trigger only ever fires if the raw token survives extraction, and the stop
 *  list does not contain any of the four triggers. */
function terms(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9_.:-]{2,}/g)) {
    out.push(m[0]!.toLowerCase().replace(/'s$/g, ""));
  }
  return out;
}

async function main(): Promise<void> {
  const splits = ["100k", "500k", "1m", "10m"] as const;
  let grandTotal = 0;
  let grandFired = 0;
  const perTrigger = new Map<string, number>();
  const examples: string[] = [];

  for (const split of splits) {
    let queries;
    try {
      queries = await loadBeamRetrievalQueries(split);
    } catch (err) {
      console.log(`  ${split.padEnd(5)} — not on disk (${(err as Error).message.slice(0, 60)})`);
      continue;
    }
    let fired = 0;
    for (const q of queries) {
      const text = q.question ?? "";
      const tset = new Set(terms(text));
      const hits = Object.keys(TRIGGERS).filter((t) => tset.has(t));
      if (hits.length > 0) {
        fired++;
        for (const h of hits) perTrigger.set(h, (perTrigger.get(h) ?? 0) + 1);
        if (examples.length < 8) {
          const injected = hits.flatMap((h) => TRIGGERS[h]!).filter((w) => !tset.has(w));
          examples.push(
            `    [${split}] "${text.slice(0, 90)}${text.length > 90 ? "…" : ""}"\n` +
              `        trigger=${hits.join(",")} injects ${injected.length} terms: ${injected.slice(0, 10).join(", ")}`,
          );
        }
      }
    }
    grandTotal += queries.length;
    grandFired += fired;
    const pct = queries.length ? ((fired / queries.length) * 100).toFixed(1) : "0.0";
    console.log(`  ${split.padEnd(5)} ${String(fired).padStart(4)} / ${String(queries.length).padEnd(4)} queries fire a trigger  (${pct}%)`);
  }

  console.log("");
  console.log(`  TOTAL ${grandFired} / ${grandTotal} (${grandTotal ? ((grandFired / grandTotal) * 100).toFixed(2) : "0"}%)`);
  if (perTrigger.size > 0) {
    console.log("  by trigger: " + [...perTrigger].map(([k, v]) => `${k}=${v}`).join(", "));
    console.log("");
    console.log("  examples:");
    for (const e of examples) console.log(e);
  } else {
    console.log("  NO trigger fires on any BEAM query — the table is dead weight on this benchmark.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
