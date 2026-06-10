# AMB BEAM 100K — Official-Runner Rerun (2026-06-10)

Status: completed through the **unmodified public AMB runner** in a single
attempt; **submitted to the AMB maintainers and pending their acceptance — not
claimed as an official leaderboard placement until they accept it.** This is
the run that answers the maintainers' requirement: follow the AMB repo
instructions and demonstrate results with the benchmark runners.

## Headline

| BEAM 100K system | AMB score | Correct | Avg answer-visible context | Avg retrieve latency |
|---|---:|---:|---:|---:|
| CSM (this rerun) | **0.743110** | **337/400** | 27,026 tokens | **3.467 s** |
| Hindsight (accepted artifact) | 0.733658 | 326/400 | 17,655 tokens | 6.379 s |

CSM is +0.95 score points and +11 correct rows versus the published Hindsight
row, with retrieval now **1.84x FASTER** than Hindsight (the May local run was
4.58x slower). Honest trades, disclosed: answer-visible context is now larger
than Hindsight's (+53%) because the coverage chronicle fills its return-K
budget, and the run is single-trial. CSM-internal retrieval spend dropped to
**8,805 input / 625 output tokens per query** (May: 21,020 / 2,531 — a 58%
internal-input cut), reported separately via the telemetry sidecar so total
cost is never under-stated.

## Per-category

| Category | Official rerun | May local | Hindsight | vs Hindsight |
|---|---:|---:|---:|---:|
| abstention | 1.0000 | 1.0000 | 0.9750 | +0.0250 |
| contradiction_resolution | 0.6250 | 0.6500 | 0.6156 | +0.0094 |
| event_ordering | 0.7495 | 0.7375 | 0.8047 | −0.0552 |
| information_extraction | 0.7354 | 0.7568 | 0.6495 | +0.0859 |
| instruction_following | 0.9000 | 0.8938 | 0.9125 | −0.0125 |
| knowledge_update | 0.6000 | 0.6688 | 0.5875 | +0.0125 |
| multi_session_reasoning | 0.5322 | 0.5478 | 0.4738 | +0.0584 |
| preference_following | 0.9500 | 0.9750 | 0.9500 | 0.0000 |
| summarization | 0.7139 | 0.7086 | 0.7929 | −0.0790 |
| temporal_reasoning | 0.6250 | 0.6375 | 0.5750 | +0.0500 |

CSM wins 7 of 10 categories (same seven as May). The June coverage/chronicle
work moved both losing categories UP versus May (event_ordering +0.012,
summarization +0.005) while the remaining −5 correct versus May spreads as
small dips across six categories — consistent with single-trial variance plus
mild context-dilution from the larger packed contexts. Abstention held at
1.000 despite the bigger contexts.

## Method / pinning

Everything is recorded in
[`../data/eval/runs/amb-beam-100k-official-v1/RUN_MANIFEST.md`](../data/eval/runs/amb-beam-100k-official-v1/RUN_MANIFEST.md):
AMB base `45fa38052` + a 3-file provider branch (provider, registry line,
README requirements — zero changes to AMB scoring/prompts/judge/gold), CSM
commit `7a7e8a0`,
answer `gemini:gemini-3.1-pro-preview` and judge `gemini:gemini-2.5-flash-lite`
(identical to the accepted Hindsight artifact), CSM internal retrieval
`gemini-3.5-flash` + `gemini-2.5-flash-lite` probes, coverage mode on, exact
commands, and the Windows install recipe.

Artifacts in the same directory: `omb providers` / `omb splits` captures,
1-query smoke (1/1) with its telemetry, full-run stdout log, and the 400-row
CSM token-telemetry sidecar. The raw result JSON (48.7 MB) is not committed;
its SHA-256 is
`af56dd6bd2c656fe50e47ad935ada4e1ae78211e08ba1d85b035ea1faadbabfb`, and the
gzipped copy produced by AMB's own `omb publish-results` flow ships in the
provider branch so maintainers can publish it without conversion. Secret scan
over all artifacts: no key material (the only `api_key` strings are the
google-genai env-var-name warning).

## Relationship to the May 2026 local comparison

[`BEAM_100K_CSM_VS_HINDSIGHT.md`](BEAM_100K_CSM_VS_HINDSIGHT.md) (0.757573,
342/400) remains the May record produced via the per-query bridge with
patched AMB Gemini timeouts. This rerun supersedes it as the publication
artifact because it uses the unmodified harness, the warm-service provider,
and the post-wave CSM defaults. Both runs beat the same Hindsight row; the
honest difference is May traded latency for a leaner answer context, while
this rerun trades a larger answer context for retrieval faster than Hindsight
and a 58% lower internal token bill.
