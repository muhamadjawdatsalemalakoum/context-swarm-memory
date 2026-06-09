# EXP-T4 — Gemini context caching for shard content (live protocol; WRITTEN, NOT YET RUN)

Status: **written 2026-06-10 by R&D agent T4; no live calls have been made.**
Owner of the live runs: orchestrator (or any agent with `.env` access).
Branch: `rd/t4-gemini-caching`. Harness: `scripts/measure-gemini-caching.ts`
(unit-tested against scripted fixtures in `tests/measureGeminiCaching.test.ts`;
the default invocation is a dry run that makes zero network calls).

This document contains: the verified-API-facts table (with quotes and the
things we could NOT verify), the offline census results (already run — no
network needed), the cost model with break-even math and a go/no-go, and the
three live experiments in execution order.

---

## 1. Verified API facts (web-checked 2026-06-10)

| # | Fact | Value | Source (fetched 2026-06-10) | Status |
|---|---|---|---|---|
| F1 | Implicit caching default | "Implicit caching is enabled by default for all Gemini 2.5 and newer models. We automatically pass on cost savings if your request hits caches." | <https://ai.google.dev/gemini-api/docs/caching> (same text on <https://ai.google.dev/gemini-api/docs/interactions/caching>, page updated 2026-06-02) | Verified |
| F2 | Implicit minimum prefix, **gemini-3.5-flash** | **4,096 tokens** ("Gemini 3.5 Flash: 4096"; "Gemini 3.1 Pro Preview: 4096"; "Gemini 2.5 Flash: 2048"; "Gemini 2.5 Pro: 2048") | both caching pages above | Verified |
| F3 | Explicit `cachedContents` minimum, gemini-3.5-flash | **4,096 tokens** (same per-model table governs explicit caching) | <https://ai.google.dev/gemini-api/docs/caching> | Verified |
| F4 | Hit reporting | "You can see the number of tokens which were cache hits in the response object's `usage_metadata` field." — field `cached_content_token_count` / `cachedContentTokenCount` | caching page + <https://developers.googleblog.com/en/gemini-2-5-models-now-support-implicit-caching/> ("you will start to see `cached_content_token_count` in the usage metadata") | Verified |
| F5 | gemini-3.5-flash pricing | input **$1.50/M**, output **$9.00/M**, context caching **$0.15/M**, storage **"$1.00 / 1,000,000 tokens per hour"** | <https://ai.google.dev/gemini-api/docs/pricing> | Verified |
| F6 | Implicit-hit discount % | Not published for 3.5-flash. The 2.5-era launch post says implicit caching provides "the same 75% token discount"; the current pricing table's cached rate is 10% of input (a 90% discount). | blog above + pricing page | **Partially verified — cost model carries both a 90% and a 75% arm; Experiment A confirms empirically** |
| F7 | Explicit cache TTL | "If not set, the TTL defaults to 1 hour." Only expiry (`ttl`/`expireTime`) is mutable via PATCH; `model`, `contents`, `systemInstruction`, `tools`, `toolConfig`, `displayName` are immutable. | <https://ai.google.dev/gemini-api/docs/caching> + <https://ai.google.dev/api/caching> | Verified |
| F8 | `cachedContent` + `system_instruction` in one request | Rejected: HTTP 400 "CachedContent can not be used with GenerateContent request setting system_instruction, tools or tool_config." | Enforced live-API error, consistently reproduced across SDKs (e.g. langchain-google issue #978, Google AI forum threads). Not stated as prose in first-party docs. | **Verified by field reports; A6 re-confirms** |
| F9 | Does `systemInstruction` text participate in **implicit** prefix matching? | Docs are silent. Guidance only says "Try putting large and common contents at the beginning of your prompt." | caching page | **UNVERIFIED — Experiment A3 resolves it** |
| F10 | thinkingConfig × caching | Docs silent on interaction. Related fact: "When thinking is turned on, response pricing is the sum of output tokens and thinking tokens" — thoughts bill as OUTPUT and are reported in `thoughtsTokenCount`, NOT included in `candidatesTokenCount`. | <https://ai.google.dev/gemini-api/docs/thinking> | Billing: verified. Cache interaction: **UNVERIFIED — Experiment A5** |
| F11 | `responseJsonSchema`/structured output × `cachedContent` | Docs silent; third-party wrappers historically hit failures (vercel/ai #3333; Google AI forum "Structured output support with cached content"). `generationConfig` is not in the F8 restricted list, so it should be allowed. | forum/GitHub | **UNVERIFIED — Experiment A6 (`A6-use-json`)** |
| F12 | gemini-3.5-flash thinking levels | supports `minimal`/`low`/`medium`/`high`; **default is `medium`** when thinkingConfig is absent ("e.g., `high` for Gemini 3.1 Pro, and `medium` for Gemini 3.5 Flash") | <https://ai.google.dev/gemini-api/docs/thinking> | Verified |
| F13 | Explicit caching model coverage | "Explicit caching (can be manually enabled on most models, cost saving guarantee)". 3.5-flash support inferred from its pricing-table caching rows. | caching + pricing pages | Verified (support for 3.5-flash is an inference from F5; A6 confirms) |

Two notable deltas against the portfolio doc's assumptions (corrections):

1. **Discovery B understates the problem.** It says per-query prompt bytes
   defeat caching "beyond the ~140-token `SHARD_SYSTEM_PROMPT`". With F2, even
   that 140-token stable prefix is worthless: no request below 4,096 tokens can
   ever produce an implicit hit on gemini-3.5-flash. Today's pipeline gets
   **exactly zero** implicit caching, not "a little".
2. **The portfolio's "est. 40-60% internal input-cost cut" for T4 does not
   survive the verified numbers** (§3): the best restructuring arm is ~10-17%
   of input cost, with accuracy risk; explicit caching of full snapshots
   *raises* absolute cost at today's truncation budgets (it is a
   quality-headroom enabler, not a cost cut).

## 2. Offline census (RUN, no network — reproduce anytime)

```
npx tsx scripts/measure-gemini-caching.ts --offline-census \
  --out data/eval/runs/gemini-caching-measure/offline-census-payswift-100k
```

Real pipeline (router → probe → recall → synth) over PaySwift 100K, all 30
queries, capturing the exact request bytes each stage would send to Gemini
(committed at `data/eval/runs/gemini-caching-measure/offline-census-payswift-100k/`):

| Stage | Calls | Avg req tokens | Max req tokens | ≥ 4,096 floor | Avg stable prefix (tok) | Max stable prefix |
|---|---:|---:|---:|---:|---:|---:|
| probe | 240 | 557.3 | 701 | **0** | 178 | 211 |
| recall | 120 | 1,383.5 | 1,676 | **0** | 571 | 1,289 |
| synth | 30 | 635.5 | 861 | **0** | — | — |

Restructure-option costs (brief Q3) on the same corpus: a fully-stable
untruncated probe index (option R1) averages **445 tokens** of system prompt —
it clears the 4,096 floor on **0/29 shards**; the full per-shard event digest
(option R3, what an explicit cache would hold) averages **3,381 tokens** and
clears the floor on only **8/29 shards** (the core `s-*` shards, 3.3K-19.4K
tokens). On BEAM, session-shards are ~15K tokens (≈100K-token unit ÷ ~6.5
sessions), so R3 clears the floor there comfortably while R1-style index-only
stabilization does not exist (the bridge digests are the session text itself).

**Brief design-question 1 answered (the "prove it" part):** today's pipeline
can receive zero implicit cache hits — every request is below the floor (a),
and the cross-query byte-stable prefix is only 178/571 tokens (b). Hypothesis
confirmed, stronger than hypothesized.

## 3. Cost model — status quo vs implicit-restructure vs explicit-cache

Basis: committed BEAM-100K telemetry
(`data/eval/runs/sota-combined/amb-beam-100k-csm-vs-hindsight.json`): 400
queries = 20 units × 20; per query avg 7.25 probes, 3.55 recalls, 13,884.6
pipeline input tokens (5.55M total), 2,512.8 output. Per-unit stage split
(probe ≈ 600 tok/call, recall ≈ 1,600, synth = residual):

| Per unit (20 queries) | Calls | Input tokens | $ at $1.50/M |
|---|---:|---:|---:|
| probes | 145 | 87,000 | $0.1305 |
| recalls | 71 | 113,600 | $0.1704 |
| synth | ~18 | 77,100 | $0.1157 |
| **status quo total** | ~234 | **277,700** | **$0.4166** ($8.33/run input; output adds 1.005M × $9/M = $9.05/run) |

Reuse structure: ~6.5 session-shards/unit; each probed ~22× and recalled ~14×
per unit — the "~20× reuse" from the portfolio is real; what is NOT real is
the ability to cache it at today's request sizes.

**Option B — implicit-restructure (pad each per-shard stable prefix to the
4,096 floor; query/hints move to the user turn).** Wave-2-gated, T1-colliding.
Per unit, 90%-discount arm (cached @$0.15/M) / 75% arm (@$0.375/M):

- probes: primes 6.5 × 4,300 fresh + repeats 138.5 × (4,200 cached + 150
  fresh) → fresh 48,725 ($0.0731) + cached 581,700 ($0.0873 / $0.2181) =
  **$0.160 / $0.291** vs $0.1305 status quo → **+23% / +123% — worse in both
  arms.** Padding probe prompts ~7× to reach the floor costs more than the
  discount returns.
- recalls: primes 5 × 4,400 fresh + repeats 66 × (4,300 cached + 250 fresh) →
  fresh 38,500 ($0.0578) + cached 283,800 ($0.0426 / $0.1064) = **$0.100 /
  $0.164** vs $0.1704 → **−41% / −4%.**
- unit totals: **$0.376 (−9.7%) / $0.571 (+37%)**. Recall-only restructuring:
  $0.347/unit (**−17% input ≈ −8% of total run cost**) in the favorable arm.
- Hidden costs: no hit-rate SLA (implicit hits are best-effort), stable
  truncation re-introduces the exact failure query-aware ranking fixed
  (probe.ts comment), and it rewrites probe/recall prompts — T1's territory.

**Option C — explicit-cache the full snapshot per `shardId@snapshotId`**
(BEAM session ≈ 15.4K tokens; TTL 600s; cache holds
SHARD_SYSTEM_PROMPT+header+summary+full digest; query in the user turn):

- creates: 6.5 × 15,400 = 100,100 fresh = $0.1502 + storage 100,100 ×
  (600s/3600s) × $1.00/M·hr = $0.0167
- probes: 145 × (15,400 cached + 150 fresh) = cached $0.3350 + fresh $0.0326
- recalls: 71 × (15,400 cached + 250 fresh) = cached $0.1640 + fresh $0.0266
- synth unchanged $0.1157 → **unit $0.841 = 2.02× status quo. NOT a cost cut.**
- BUT compare against the same full-context strategy paid at full rate
  (probes $3.382 + recalls $1.667 + synth = **$5.165/unit, 12.4×**): explicit
  caching makes full-snapshot context **6.1× cheaper** than uncached
  full-snapshot context. Break-even vs full rate is at **N ≥ 1.11 uses per
  shard** (save/use = 15,400×($1.50−$0.15)/M = $0.0208 vs create $0.0231 —
  storage negligible at unit-length TTLs), i.e. from the second same-shard
  call. There is **no N at which it beats the truncated status quo on cost**:
  a cached 15.4K-token call ($0.00254) is itself pricier than today's
  truncated full-rate call ($0.0009-0.0024).

**Projection to 500K / 1M.** Stage budgets are capped (≤8 probes, ≤4 recalls,
1,200-char index, 1,200-token digest), so status-quo per-unit input cost stays
≈$0.42 regardless of split size; total run cost scales with unit count only.
What changes is probed-shard DIVERSITY per unit: at 500K (~32 sessions/unit)
with T2's informed router, expect ~13+ distinct shards probed per unit instead
of 6.5 — halving per-shard reuse. That moves Option B probes to ≈+51% vs
status quo and Option C creates to $0.30-0.69/unit (2.4-3.2× total). **Both
caching options degrade with scale and router quality; neither is a
scale-survival lever.** (The floor F2 is also per-request, so bigger corpora
do not help implicit hits at all.)

**Thinking-spend correction (observability win, free).** Probes run at
`minimal` (0 thoughts), recall/synth at `low` ≈125 thoughts/call (measured in
`docs/PERF_BREAKDOWN.md`): ≈(3.55+0.9)×125×400 ≈ 222K thought tokens/run ≈
**$2.00/run billed today but invisible** in CSM accounting
(`outputTokensEstimate` = `candidatesTokenCount` only). The new
`ProviderUsage.thoughtsTokens` makes it visible; nothing changes in existing
sums (additive field).

**Go/no-go recommendation:**

- **GO (shipped, wave-1):** observability — `cachedInputTokens` +
  `thoughtsTokens` parsing, `CSM_GEMINI_CACHE=implicit-observe` logging, stats
  getter. Zero risk; default byte-identical.
- **GO (cheap, next .env session):** Experiment A below (~$0.60) to nail F6,
  F9, F10, F11 and the cached-prefill latency delta.
- **NO-GO (wave-1) on restructuring for cost:** the best arm is −17% input
  (−8% run cost) with accuracy risk and a T1 collision; the portfolio's 40-60%
  estimate is corrected down.
- **CONDITIONAL GO (wave-2, coupled to T1):** explicit full-snapshot caching
  (`explicit` mode + `cacheKey`) **iff** T1's coverage work decides recall
  should see more shard content: caching is what makes that affordable (2× vs
  12.4×), with TTFT upside to be measured. Gate: Experiment C.

---

## 4. Experiment A — measurement matrix (54 calls, ≈$0.47)

**Goal.** Empirically pin F6 (implicit discount %), F9 (systemInstruction
participation), F10 (thinking × cache), F11 (JSON schema × cachedContent), the
4,096 floor (F2/F3), prefix-edit semantics, cached-prefill latency, and the
A7 zero-hit confirmation for production-shaped payloads.

**Command** (requires `.env` with `GEMINI_API_KEY`; never run by T4):

```bash
# 1. Inspect the plan first (no network):
npx tsx scripts/measure-gemini-caching.ts

# 2. Execute:
CSM_MEASURE_BUDGET_CALLS=100 npx tsx scripts/measure-gemini-caching.ts --live \
  --model gemini-3.5-flash
# artifacts → data/eval/runs/gemini-caching-measure/<timestamp>/{rows.jsonl,summary.json,report.md}
```

Budget (from the dry-run plan, which prints these numbers before any call):
54 calls, ~225K fresh input tokens ≈ $0.34 + outputs/thoughts allowance ≈
$0.13 → **≈$0.47 total**; hard call cap 100 (`CSM_MEASURE_BUDGET_CALLS`);
inter-call delay 500ms (implicit caching wants temporally-close repeats).
Expected wall time ≈ 2-4 min.

| Exp | Calls | Establishes | Success criterion |
|---|---:|---|---|
| A1 floor scan (1K→8K × 3 reps) | 21 | implicit floor + discount + hit latency | hits appear at exactly ≥4,096; `cachedContentTokenCount` ≈ prefix size on reps 1-2 |
| A2 varying-prefix control | 6 | Discovery-B simulation | zero hits at every size |
| A3 system-vs-contents arms | 6 | F9 | if system-arm reps hit, systemInstruction participates |
| A4 edit-position (head/middle/tail) | 5 | prefix semantics for restructure design | tail-edit retains most cached tokens; head-edit retains none |
| A5 thinking levels on stable prefix | 4 | F10 | cross-level hits ⇒ thinkingConfig doesn't key the cache |
| A6 explicit lifecycle (create/use/use-json/conflict/patch/below-min/delete) | 8 | F3, F7, F8, F11; cached-use latency; whether systemInstruction-only caches are allowed (open) | create 200 with name; conflict & below-min both 400; use-json 200 |
| A7 production-shaped probe/recall payloads ×2 | 4 | the brief's "prove it" live leg | zero hits (matches the offline census) |

A7 includes probe- and recall-shaped calls. If `A6-create-sysonly` is
rejected (systemInstruction-only caches disallowed), the script records the
failure, dependent `A6-use-*` calls self-skip, and the fallback design is to
move the cached text into `contents[0]` at cache-creation time — re-run with
that variant before concluding.

**Reading F6 from A1:** billed cost cannot be read from the API response; the
discount is verified by comparing AI-Studio/billing-console spend for the run
against `summary.freshInputTokens`/`cachedTokens` at the two candidate rates
($0.15/M vs $0.375/M for cached tokens). Record the verdict in this file.

## 5. Experiment B — observability soak (3 PaySwift queries, ≈$0.05)

**Goal.** Confirm end-to-end plumbing on the REAL pipeline: per-stage usage
rows flow from `GeminiProvider` → JSONL with cached/thoughts fields populated;
confirm zero implicit hits in production shape (A7's in-vivo twin); measure
per-stage thoughts spend against the PERF_BREAKDOWN numbers.

```bash
CSM_GEMINI_CACHE=implicit-observe \
CSM_GEMINI_USAGE_LOG=data/local/t4-usage-soak.jsonl \
npm run csm -- bench run --systems csm --trials 1 --corpus-sizes 100K \
  --model-contexts 8K --queries q01,q11,q28 --model gemini-3.5-flash \
  --run-id t4-observe-soak-v1
```

(Or the equivalent 3-query `bench run` invocation current at run time; any
PaySwift csm-only 3-query run works. `CSM_GEMINI_USAGE_LOG` must point OUTSIDE
`data/` memory stores — `data/local/` is gitignored scratch.)

Checks:
1. The usage log has one row per LLM call (8 probes + N recalls + synth +
   final per query), each with `schemaName`, `promptTokens`,
   `cachedInputTokens`, `thoughtsTokens`.
2. `cachedInputTokens` = 0 on every row (production shape can't hit — census).
3. probe rows: `thoughtsTokens` = 0 (minimal); recall/synth rows ≈ 100-200
   (low) — reconciles the $2.00/run invisible-thinking estimate.
4. Accuracy unaffected: 3/3 on q01/q11/q28 (same as `rd-probelite-30q-v1`
   baseline behavior for these queries with default models), token counts
   within noise of the rd-digest-30q-v1 baselines — the flag is response-side
   only, so any drift is a bug.

## 6. Experiment C — wave-2 restructuring A/B (GATED; do not run in wave 1)

**Gate:** runs only after (a) Experiment A confirms the floor/discount/F9, and
(b) T1's coverage mechanism has merged, settling what recall context looks
like. Restructuring changes LLM inputs → full accuracy gates apply (standing
rule).

Design under test (pick per A3's F9 verdict):

- **C-implicit:** per-shard byte-stable system =
  `SHARD_SYSTEM_PROMPT + [Shard X@Y] + summary + STABLE full event index/digest`
  (padded to ≥4,096 only if within 25% of the floor; shards that can't reach
  it stay unrestructured); query + probe-hint ranking moved to the user turn.
- **C-explicit:** unchanged prompts EXCEPT recall context becomes the full
  snapshot digest served via `cachedContent` (`CSM_GEMINI_CACHE=explicit`,
  call sites pass `cacheKey: "<shardId>@<snapshotId>:<stage-version>"`).
  Immutable snapshots make `shardId@snapshotId` a perfect cache key — cache
  invalidation is structurally free (a new snapshot is a new key; TTL handles
  the rest).

Protocol:
1. PaySwift 30q × {baseline, variant} at 100K/8K, 1 trial, gemini-3.5-flash
   answers; success bar: no score regression (≥29/30 given current 29/30), and
   for C-explicit a q04/q27 coverage check (packedEventIds ⊇ current).
2. T3 BEAM-slice retrieval recall@k on summarization + event_ordering — no
   regression on either; this is the gate the portfolio assigns to LLM-input
   changes.
3. Token accounting: `bench report` totals + the usage log; verify
   cachedInputTokens ≈ model prediction from §3 and recompute the cost table
   with measured numbers.
4. 3-trial repeat on any query that flips either way.
5. Latency: per-stage latencyMs distribution vs baseline (TTFT effect of
   cached prefill at 15K tokens).
Budget: 30q × 2 arms × ~14K input ≈ 0.9M tokens ≈ $1.40 + T3 slice (~1.1M
retrieval-only ≈ $1.70) + trials.

## 7. Flag surface shipped in wave 1 (all default-off)

| Env | Default | Effect |
|---|---|---|
| `CSM_GEMINI_CACHE` | `off` | `off` = byte-identical legacy requests; `implicit-observe` = legacy bytes + per-call observation logging; `explicit` = cachedContents lifecycle for calls that pass `cacheKey` (none do yet) |
| `CSM_GEMINI_USAGE_LOG` | unset | JSONL sink for observation rows (modes ≠ off). Keep outside `data/` stores |
| `CSM_GEMINI_CACHE_TTL_S` | 3600 | explicit-cache TTL (per-unit runs should use 300-900) |
| `CSM_GEMINI_CACHE_MIN_TOKENS` | 4096 | estimate-guard for doomed cache creations (update if Google changes F2/F3) |

Provider internals: per-instance registry `${model}::${cacheKey}` → cache
name + SHA-256 of cached bytes (reuse refused on hash mismatch — contract
violations are counted, warned once, and degrade to uncached); negative-cache
(10 min) for failed creations; cache-flavored generateContent failures
invalidate + retry uncached without consuming transient-retry budget;
`clearExplicitCaches()` for end-of-unit hygiene; `getCacheStats()` for
harnesses. See `tests/geminiCaching.test.ts` for the pinned behaviors,
including default-off byte-identity.
