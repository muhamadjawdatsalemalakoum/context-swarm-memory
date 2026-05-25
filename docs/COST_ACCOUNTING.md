# Cost Accounting Contract

This document records the rules every baseline must follow when reporting `inputTokens`, `outputTokens`, and `latencyMs` in a `BaselineResult`. It exists because of a real bug that nearly published a false claim — captured here so it doesn't happen again.

## The contract (read this first)

For every baseline:

> `BaselineResult.inputTokens` / `outputTokens` / `latencyMs` MUST represent the **TOTAL** cost of producing the answer to one query — including **every** internal LLM call the system made (probes, recalls, synthesis, embedding lookups, anything), not just the final answering call.

There is no exception. If a baseline makes more than one LLM call, the top-level cost fields are sums. The per-stage breakdown lives in `meta.*` so the report can disambiguate, but the top-level number must be the total.

## Why this exists — the bug we caught (and what almost shipped)

During the first CSM pilot we reported:

| Claim (wrong) | Reality |
|---|---|
| CSM uses 2,141 input tokens on q01 | **10,936** |
| CSM latency 121 s on q01 | **1,091 s (18 min)** |

The "2,141 tokens / 121 s" numbers were only the **final MCQ-answering call**. CSM also made 8 probes + 3 recalls + 1 synth on its way to that final call — 12 LLM calls in total — and **their costs were silently dropped from the top-level fields**. They were in `meta.packetCost`, but `bench report` (and the README narrative) read from the top-level fields only.

The bug source was in `src/eval/baselines/csm.ts` at the `return` block:

```typescript
// WRONG — pre-fix:
return {
  inputTokens: llm.inputTokens,        // only the final MCQ call
  outputTokens: llm.outputTokens,      // only the final MCQ call
  latencyMs: llm.latencyMs,            // only the final MCQ call
  meta: { packetCost: askResult.cost } // pipeline cost hidden in meta
};
```

The user caught this and called the retraction. The corrected code sums explicitly:

```typescript
// RIGHT — post-fix:
const pipelineCost = askResult.cost ?? { inputTokensEstimate: 0, ... };
return {
  inputTokens: pipelineCost.inputTokensEstimate + llm.inputTokens,
  outputTokens: pipelineCost.outputTokensEstimate + llm.outputTokens,
  latencyMs: pipelineCost.latencyMs + llm.latencyMs,
  meta: {
    // Per-stage breakdown stays visible for reporting:
    finalCallInputTokens: llm.inputTokens,
    pipelineInputTokens: pipelineCost.inputTokensEstimate,
    finalCallLatencyMs: llm.latencyMs,
    pipelineLatencyMs: pipelineCost.latencyMs,
    // ...etc...
  },
};
```

The corrected number on q01 is **5.1× higher** than the buggy one. Publishing the buggy one would have destroyed the project's credibility.

## Per-baseline status today

| Baseline | LLM calls per query | Accounting | Risk |
|---|---|---|---|
| `longContext` | 1 | `llm.*` directly | trivially correct |
| `vanillaRag` | 1 (+ embedding lookup is local, non-LLM) | `llm.*` directly | trivially correct |
| `hybridRag` | 1 (+ BM25 + embedding lookup, both local) | `llm.*` directly | trivially correct |
| `csm` | **6–14** (router 0, probes N, recalls M, synth 0/1, answer 1) | **`pipelineCost + llm.*` sum** | needed the fix above |

Any new baseline that calls the LLM more than once falls into the CSM bucket and must follow the same sum-then-break-out pattern.

## How to verify the contract on a run

### From results.jsonl

For any cell where `meta.pipelineInputTokens` exists:

```bash
# Should print 0 if the contract holds, or non-zero if there's a drift.
python -c "
import json
for line in open('data/eval/runs/<runId>/results.jsonl'):
    r = json.loads(line)
    m = r.get('meta', {})
    if 'pipelineInputTokens' not in m: continue
    expected = m['pipelineInputTokens'] + m['finalCallInputTokens']
    actual = r['inputTokens']
    if expected != actual:
        print(f'DRIFT in {r[\"system\"]} {r[\"queryId\"]}: top={actual} != pipeline+final={expected}')
"
```

### From the test suite

`tests/cost-accounting.test.ts` constructs a `CsmBaseline` with a stub provider that records every call. Asserts:

- `inputTokens === meta.pipelineInputTokens + meta.finalCallInputTokens`
- `pipelineInputTokens > 0` (because probes/recalls/synth ran)
- Same invariant for output tokens and latency

This test will fail loudly the moment a refactor undoes the fix.

## Retroactive fix for older runs

Runs captured before the fix have buggy top-level numbers but the pipeline cost is preserved in `meta.packetCost`. Run:

```bash
npx tsx scripts/fix-csm-accounting.ts <runId>
```

The script backs up `results.jsonl.pre-fix-accounting` and rewrites top-level fields with `pipelineCost + final`. Idempotent — won't double-apply.

## Rules for adding a new multi-call baseline

1. **Track every LLM call's usage.** If you use `callLlmCached`, the `inputTokens`/`outputTokens`/`latencyMs` it returns is for that single call only.
2. **Sum explicitly in the `return` block.** Don't trust any one call's `.inputTokens` to mean the whole.
3. **Keep per-stage breakdown in `meta`.** Use `*pipelineInputTokens` / `*finalCallInputTokens` field naming or similar so the reporter can render the breakdown.
4. **Add a test.** Pattern after `tests/cost-accounting.test.ts` — assert top-level === sum of per-stage.

## Reporting contract for the README and plots

The README and `bench report` headline tables should use the **top-level** `inputTokens` / `latencyMs` — i.e. the totals. If the breakdown is interesting (it is for CSM), show it as a secondary table or a footnote, not as the headline number.

Never compare systems on a non-comparable metric. If RAG's "inputTokens" is the total cost of producing the answer (it is — RAG is single-call), then CSM's "inputTokens" must also be the total cost. Apples-to-apples or it's misleading.
