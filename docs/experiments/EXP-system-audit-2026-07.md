# EXP — whole-system audit of CSM (2026-07-31)

**Method.** Not scenario-driven. Every prior defect this campaign found was found
by running into it: the router query-independence bug surfaced because BEAM 1M
lost, the Gemini-id-to-Claude-sidecar bug surfaced because a profile build
returned empty. This pass instead took the three defect *classes* already proven
to exist in this repo and searched the whole tree for further instances,
statically:

| class | canonical instance | how it was found before |
|---|---|---|
| **silent degeneration** — a selector returns an arbitrary-but-confident result when its signal is uniform | `selectCandidates` returned the alphabetically-first 8 shards for every query | a lost benchmark tier |
| **cross-namespace leak** — a model id valid for one provider reaches another | `gemini-3.5-flash` sent to the Claude sidecar | an empty output and a truncated error string |
| **divergent duplicate** — the same concept implemented twice, free to drift | `prefixMatch` copied into `probe.ts` | reading the file for another reason |

Nothing here is a hypothesis. Each finding below was reproduced by executing the
real code before it was changed.

---

## F1 — `CSM_ROUTER_HYBRID=off` turned the hybrid router **ON**  ⚠ highest severity

`resolveRouterHybrid` was a **default-off** flag parsed by **negation**:

```ts
if (raw === undefined || raw.trim().length === 0) return false;
return !(v === "0" || v === "false" || v === "no");
```

Every other default-off flag in the repo used positive parsing (`v === "1" || …`).
Measured against the real resolvers before the fix:

```
value       EAGER_RECALLS  PROBE_FULL_SCAN  SIGNALS_RANKER  SHARD_DESCRIPTORS  ROUTER_HYBRID
"off"       off            off              off             off                ON
"disabled"  off            off              off             off                ON
"OFF"       off            off              off             off                ON
"n"         off            off              off             off                ON
```

**Why it matters more than a usability wart.** The hybrid router is CSM's single
largest measured retrieval win (+0.365 answer score at BEAM 1M, 26W/5L). An A/B
whose control arm was written `CSM_ROUTER_HYBRID=off` would have run the
*treatment* in both arms and recorded one of them as the baseline — a
null result manufactured by configuration.

**Was anything actually corrupted?** No. Every recorded invocation in the repo
(`docs/experiments/*`, run manifests, scripts) uses `=1`, and `EXP-T2-router.md`
uses `=0`, which parsed correctly. The defect was latent. It is worth stating
plainly that "we would have noticed" was never available as a defence: the
failure mode is silent by construction.

## F2 — six mutually incompatible truthiness rules

The same shape of value — a boolean flag — was parsed six different ways:

| resolver | accepts as true | notes |
|---|---|---|
| `resolveEagerRecalls` | `1 true yes` | |
| `resolveProbeFullScan` | `1 true yes` | |
| `resolveSignalsRanker` | `1 true` | **never trimmed** → `" 1"` was false |
| `rerankerEnabled` | `1 true yes on` | only one accepting `on` |
| `resolveShardDescriptors` | `1 true yes` | |
| `resolveRouterHybrid` | *everything except* `0 false no` | F1 |

So `CSM_SIGNALS_RANKER=yes` was silently off while `CSM_HYBRID_RERANK=yes` was on,
and a single leading space — trivially produced by a `.env` file — silently
disabled the signals ranker.

Integer parsing had the mirror problem across five hand-rolled copies:
`CSM_GEMINI_TIMEOUT_MS=6O000` (letter O) silently ran at the default, and the
Ollama / llama-server parsers propagated a raw `NaN` into the timeout.

## F3 — the model-namespace fix was only half a fix

`resolveProviderModel` was made a primitive last week to stop a provider from
inheriting another provider's model id. It guards the **read** side. Both AMB
bridge entry points still wrote on the other side:

```ts
// scripts/amb-csm-retrieve.ts:80, and the same line in amb-csm-server.ts
if (!process.env.CSM_MODEL) process.env.CSM_MODEL = args.model;  // default "gemini-3.5-flash"
```

`CSM_MODEL` is the **generic** slot that `resolveProviderModel` falls back to for
*every* provider. Reproduced against the real function:

```
before bridge start : resolveProviderModel('agent-sdk') = undefined
after  bridge start : resolveProviderModel('agent-sdk') = gemini-3.5-flash
```

Four further sites hardcoded `"gemini-3.5-flash"` as the fallback for a
provider-agnostic option (`amb-csm-retrieve`, `amb-csm-server`, `run-beam-slice`,
plus `probe-flash-latency`, which is a deliberately Gemini-specific diagnostic and
was left alone).

**Root cause, stated precisely:** the rule was expressed as a *reader*. A rule that
only one side of a channel obeys is not an invariant.

## F4 — recall-shard selection was the router bug, one level down

`src/core/ask.ts` selected which shards to recall with

```ts
.sort((a, b) => scoreProbe(b) - scoreProbe(a)).slice(0, maxRecallShards)
```

— no tiebreak, no degeneracy signal: the identical shape to the router defect.
It is if anything *more* tie-prone, because `scoreProbe` maps two small enums
(confidence × `estimatedAnswerValue`) onto a handful of discrete values, so
several probes routinely share a score and the cut lands inside a tie run.

Note the fix is **not** the module default. `probes` arrives in router-candidate
order, so insertion order here *carries signal*; sorting ties by `shardId` would
have replaced a meaningful order with an alphabetical one — the very failure being
guarded against. `tieBreak: "stable"` is correct here, and is now stated and
tested rather than inherited from sort stability.

## F5 — the hybrid router degraded to the losing configuration in silence

```ts
try { const [v] = await index.embed([query]); queryVec = v ?? null; }
catch { queryVec = null; }
if (!queryVec) return selectCandidates({ ... });   // no signal to anyone
```

"Degrades gracefully to lexical" reads as a virtue until you notice what lexical
selection *does* on a BEAM-shaped corpus: every entry scores ~0, so it returns the
alphabetically-first N for every query (F1's sibling). The embedding leg is the
entire measured win — the descriptor leg alone was flat. So a transient
`@xenova/transformers` failure does not lose a little signal; it silently swaps
the winning configuration for the losing one, mid-run, per query, while the run
manifest still says the hybrid router was enabled.

## F6 — one duplicate pair had already diverged  *(resolved by F9's fix)*

`extractBetweenSegmentTerms` exists twice and the two disagree:

| | term extraction for each side of "between X and Y" |
|---|---|
| `src/core/coverage.ts` | `extractCoverageTerms(side, 16)` — one pass, capped at 16 |
| `scripts/amb-csm-retrieve.ts` | `expandCoverageTerms(extractContentTerms(side))` — extract, then **expand** |

The same temporal query therefore yields different term sets depending on which
path runs. This bears on `temporal_reasoning`, where CSM has an unexplained
−0.135 result at n=8.

Initially left alone — choosing either implementation silently changes retrieval,
so it looked like it needed an A/B rather than a refactor. Chasing *why* the
bridge's version expanded led straight to F9, which made the decision for us: the
expansion step was benchmark-tuned vocabulary and had to go regardless. Both
paths now share `extractCoverageTerms`, and the A/B that matters is F9's.

## F9 — hardcoded, corpus-specific vocabulary compiled into the retriever  ⚠ publication-blocking

Chasing F6 into the bridge's term pipeline surfaced something larger.
`expandCoverageTerms` is a **hand-written synonym table**:

```ts
addWhen("security",    ["auth","authentication","password","hash","csrf","flask-wtf","session","login","lockout","redis","role","https"]);
addWhen("database",    ["sqlite","sqlalchemy","postgres","transaction","migration","table","schema","constraint","uuid","operationalerror"]);
addWhen("weather",     ["openweather","temperature","humidity","conditions","autocomplete","cors","forecast","api","rate","cache"]);
addWhen("performance", ["lazy","loading","load","latency","bounce","analytics","ga4","tracking"]);
```

Those expansions are the vocabulary of the benchmark's own documents — BEAM
conversations are dev-assistant chats about building a Flask auth app, a weather
app, a budget tracker. It ran on **five** retrieval call sites including
`selectCapsuleCoverageEvents`, i.e. on the path that produces every BEAM answer.

**Provenance.** `git log -S 'flask-wtf'` → commit `31cbef9`, 2026-05-26, titled
*"Improve CSM AMB retrieval evidence shaping"*, body: *"Add BEAM-oriented AMB
retrieval improvements for the CSM provider without using gold answers, rubrics,
or query IDs in the retrieval path."* `src/eval/corpus/beam.ts` did not exist yet;
the table went in with the BEAM bridge work.

**Was it inert?** No — measured with `scripts/audit-term-expansion.ts`, zero LLM
calls, over the real query sets:

| split | queries firing a trigger | |
|---|---:|---:|
| 100K | 13 / 400 | 3.3% |
| 500K | 10 / 700 | 1.4% |
| 1M | 22 / 700 | 3.1% |
| 10M | 10 / 200 | 5.0% |
| **total** | **55 / 2000** | **2.75%** |

by trigger: `performance`=29, `security`=11, `database`=11, `weather`=6. Each
firing injects 9–22 terms into the coverage scorer. Example: *"Can you give me a
comprehensive summary of how I handled the security and database challenges…"*
fires two triggers and injects 22 terms including `flask-wtf` and
`operationalerror`.

**Assessment, stated without softening.** This is not gold leakage: no rubric,
answer, or query id is touched, and `tests/beamLeakageFirewall.test.ts` was never
violated in its own terms. It is still benchmark-derived vocabulary compiled into
the retriever, and it is exactly what a reviewer would find first. A retrieval
result carrying `openweather` as a hardcoded expansion is not defensible whatever
the effect size turns out to be. It contradicts the principle `src/core/coverage.ts`
states for its own expansion path — corpus-derived TF-IDF, *"zero hardcoded
vocabulary"*.

**Fix.** Deleted. The bridge's private `extractContentTerms` and its stop list
went with it; all five call sites now route through one `queryTerms()` that
delegates to `src/core/coverage.ts:extractCoverageTerms` — which also resolves F6,
since that was the same divergence one layer down. `CSM_AMB_LEGACY_VOCAB=1`
restores the whole legacy pipeline (extractor *and* table — restoring half would
make the A/B measure a blend and answer neither question) purely so the removal
is measurable. It is not a supported configuration and is deleted once measured.

## F10 — a second hardcoded vocabulary table, steering what the reader sees

Sweeping for F9's siblings found `HIGH_SIGNAL_TERMS` — same file, same
2026-05-26 commit (`git log -S 'pbkdf2'` → `31cbef9`):

```ts
const HIGH_SIGNAL_TERMS = new Set([
  "api", "api key", "csrf", "flask-wtf", "ga4", "lockout", "operationalerror",
  "pbkdf2", "redis", "sha256", "unique", "constraint", "uuid", "wireframe",
]);
```

`highSignalWeight` returned **100** for a member against a generic ceiling of
**40**, and that weight drives two things in `formatEvidenceSnippet`:

1. which terms are printed as `anchors=…` in each snippet header, and
2. **where the 360-char excerpt is centred** (`relevantExcerpt` picks the
   highest-weighted match as the centre).

This is a more direct steer than F9. F9 changed which events were *scored*; F10
changes which words the answer model actually *reads* inside the event it got.

**Fix.** The intent — identifiers and dates anchor an excerpt better than prose
words do — is kept but expressed **structurally**, so it generalises to any
corpus and names none:

```ts
if (/\d/.test(t) || /[-_.]/.test(t)) return 60;   // clears the >= 50 anchor bar
```

`sha256`, `flask-wtf`, `postgres-17`, `ga4` still score high — by shape, not by
membership. `lockout`, `redis`, `wireframe` now compete on length like any other
prose word. Both tables sit behind one flag, `CSM_AMB_LEGACY_VOCAB=1`, because
they are one defect from one commit and the question worth answering is a single
one: what did removing benchmark-tuned vocabulary cost?

## F11 — retrieval is not a pure function, and every A/B in this campaign assumed it was

Trying to regression-test the audit the *right* way — compare retrieved evidence
rather than a score that has to survive an answer model and a judge first —
produced a result that looked alarming and turned out to be more important than
the audit.

`r1mHR-audit-repro-v1` re-runs arm H's exact configuration
(`CSM_AMB_LEGACY_VOCAB=1`, so the removed vocabulary is restored) on the
post-audit code. **43 of 45 queries returned different documents.**

Splitting the pipeline into its deterministic and LLM-mediated halves settles
what happened:

| stage | mechanism | H vs HR |
|---|---|---|
| `candidateShardIds` | offline router (lexical + MiniLM) | **39/39 identical** |
| `routerTopScore` | offline | **39/39 identical** |
| `probedShardIds` | offline slice of the above | **43/43 identical** |
| `probeAcceptCount` | **LLM verdict** | **differs on 10/43** |
| `recalledShardIds` | ranked by LLM probe verdicts | differs on 20/39 |
| returned documents | downstream of recall | differs on 43/45 |

The probe stage receives a byte-identical shard list and a byte-identical event
index and accepts a different number of shards on 10 of 43 queries. No code path
touched by this audit can do that while holding the inputs fixed. It is the
model.

Two conclusions, and the second is the uncomfortable one.

**1. The audit refactors are clean.** Everything deterministic is byte-identical:
same candidates, same scores, same probe targets. That is the regression check,
and it passes exactly where a code change could have shown up.

**2. Every arm-to-arm comparison in this campaign has an unmeasured noise floor.**
The published MDE of 0.1436 at n=45 was derived from the official pipeline's
*judge* self-agreement (r = 0.808). It does not include retrieval
nondeterminism, because until now nobody had run the same configuration twice.
Arm A → arm H differences were attributed entirely to the lever. Some fraction of
every one of those deltas is this.

This does not overturn the large results — arm A → arm C is +0.365, far above any
plausible noise floor — but it does mean **any delta near the MDE was never
resolvable**, and results already reported as "below MDE" (notably
`preference_following`, +0.142) are on even weaker ground than stated.

The correct fix is procedural, and cheap now that it is visible: **a same-config
repeat arm is the control**, and its delta is the noise floor a lever must clear.
`r1mHR` is the first one this campaign has ever had.

## F7 — run manifests did not record the flags that define the arm

`ECHOED_ENV_VARS` in `scripts/run-beam-slice.ts` omitted `CSM_ROUTER_HYBRID`,
`CSM_SHARD_DESCRIPTORS`, `CSM_SIGNALS_RANKER`, `CSM_COVERAGE`,
`CSM_RETRIEVAL_UNITS`, `CSM_VIRTUAL_SHARDS`, `CSM_AMB_PREFERENCE_PROFILE` and the
rest of the arm-defining levers. This is why reading an official manifest earlier
in the campaign could not distinguish *"the flag was off"* from *"the flag was
never recorded"* — a question that consumed real time.

## F8 — the same knob had two different defaults at two entry points

`maxOutputTokens` defaulted to **8** in the one-shot bridge and **512** in the warm
server: a 64× difference in the same option, enough to truncate any answer
produced through the one-shot path with `--with-internal-answer`.

---

## What changed

**New primitive — `src/utils/env.ts`.** One vocabulary for flags
(`1/true/yes/y/on/enable/enabled` ↔ `0/false/no/n/off/disable/disabled`), one for
integers, and the invariant that makes the class impossible:

> **An unrecognised configuration value is an error, never a default.**

Silently defaulting is what makes a misconfiguration indistinguishable from an
intentional one. `envFlag`/`envInt` throw, naming the variable and the offending
value. This mirrors what `src/core/selection.ts` did for ranking ("a component
that cannot discriminate must say so") applied to configuration.

All 8 boolean resolvers and all 17 integer read sites now route through it; five
hand-rolled parser copies deleted.

**`providerModelEnvVar()`** — the write side of the table `resolveProviderModel`
reads, so both directions share one source of truth. The bridge's
`publishBridgeModel()` writes into the *active provider's* slot and never into
`CSM_MODEL`; `resolveBridgeModel()` returns `undefined` rather than a hardcoded id
when nothing is configured, letting each provider apply its own default.

**`hybridRouterStats()`** — every fallback to lexical is counted, with the embed
error recorded. Counting rather than throwing is deliberate: aborting a long
benchmark on one flaky embed call is worse than finishing it with an honest,
inspectable degradation record. Anything reporting a hybrid-router measurement
must read it.

**Shared helpers** — `dedupeInOrder` 4 copies → 1, `escapeRegExp` 4 → 2,
`truncate` 2 → 1, `extractDatePhrases`/`parseDatePhrase` 2 → 1. The two surviving
`escapeRegExp`/`packToBudget` copies are **mandated** by
`tests/beamLeakageFirewall.test.ts` (gold-side modules must import node builtins
only) and are now commented as such so a future pass does not "fix" them into a
firewall failure.

**Manifest echo** — all arm-defining levers now recorded.

## Verification

- `npm run lint` (tsc) clean; **468 tests pass** (was 442).
- 26 new tests: `tests/env.test.ts` (14), the write-side namespace guards in
  `tests/providerModelNamespace.test.ts` (+8), hybrid degradation accounting in
  `tests/routerEmbed.test.ts` (+4).
- `tests/beamLeakageFirewall.test.ts`, `tests/mutationSafety.test.ts`,
  `tests/coverageReadOnly.test.ts` and `tests/recallScope.test.ts` unchanged and
  passing — no invariant was weakened to make this fit.

## What this does NOT claim

No benchmark number moves as a result of this pass. F1 and F3 were latent, F5 has
no recorded occurrence, and F4 changes tie ordering only in cases that were
previously undefined. The value delivered is that four ways to silently
mislabel an experiment are now impossible, plus one measurable follow-up (F6).
