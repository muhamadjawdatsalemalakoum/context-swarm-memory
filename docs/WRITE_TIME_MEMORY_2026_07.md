# Write-time memory (July 2026): the Observation lever and the fact registry

**TL;DR.** After the BEAM ladder showed *where* CSM loses (summarization,
event_ordering, and multi-session aggregation at scale), we read the failed
answers, found **two distinct failure mechanisms**, and built one write-time
lever for each. The first — an ingestion-time "Observation" — moves BEAM 100K
**summarization from 0.714 → 0.936** on the official-runner config (paired,
same 40 queries) while shrinking answer-visible context 43%. The second — a
metric **fact registry** — is built, gated, and tested, but not yet
score-measured. Every result below, including the ones that *didn't* work, has
a committed artifact.

Status words, chosen carefully: the summarization number is a **measured
category result on the official config**, single-trial, not yet an official
resubmission. The OpenAI-stack results are **mechanism evidence** on a
different answer model, not comparable to the Gemini ladder.

---

## 1. Two failure mechanisms, read from the answers

The BEAM ladder's per-category losses cluster into two diseases with opposite
symptoms (all quotes verbatim from committed run artifacts):

**Disease 1 — "the context lacks the information."** Summarization (10M: 0.49)
and event_ordering (10M: 0.36) queries name 5–15 specific topics scattered
across an entire conversation. Retrieval returns 26–33K tokens of the ~150K–11.7M
haystack; the scattered nuggets aren't all in the slice, and the answer model
says so: *"The retrieved context lacks this information."* This is a **coverage**
failure — no amount of context reorganization fixes it, because the missing
facts were never retrieved. (Six earlier query-time levers — a coverage
reranker, three capsule variants, two query-time synthesis variants — all
failed on exactly this point; see `docs/RD_PORTFOLIO_2026_06.md`.)

**Disease 2 — confidently wrong aggregates.** Multi_session_reasoning (10M:
**0.12**) and knowledge_update (10M: 0.35) answers don't refuse — they compute:
*"You are planning to handle a total of 2.8 million documents."* Gold: 1.8M.
The conversation updated the same metric repeatedly ("1M docs" → later "1.8M
docs"), BEAM events carry no usable timestamps, and the model **aggregates
stale values**. This is a **recency-tracking** failure.

Both diseases are exactly what write-time memory systems (Hindsight's
per-entity Observations, Zep/Graphiti's bi-temporal graph, Honcho's Deriver)
are built for: organize memory **when it's written**, retrieve the organized
form verbatim.

## 2. Lever 1 — the ingestion-time Observation

At ingest (warm-server bridge), CSM now builds one **organized memory** per
conversation: a comprehensive, numbered, chronological account of every topic
the user raised, synthesized over the **full** conversation — not the retrieved
subset. Built once, cached, invalidated on new writes. For conversations larger
than a single model context it runs hierarchically (chunk → map-summarize →
reduce-merge; `organizeMemoryScaled` in `src/eval/baselines/csm.ts`).

Retrospective summary/ordering queries then receive this organized memory as
the primary document plus a reduced set of raw events. Everything else is
byte-identical to baseline. Flag: `CSM_AMB_OBSERVE_MEMORY` (default **off**;
the submitted PR #19 configuration is untouched).

### The gate, and how it was validated

A query-intent gate decides which queries receive the Observation. It was
tuned and validated against **all four BEAM tier query sets — 2,000 queries**:
it fires on 200/200 summarization and 200/200 event_ordering queries and on
**0 of the 1,600 queries in the other eight categories** (the categories CSM
already wins — the gate makes winner regression structurally impossible, not
just unlikely). Two earlier gate drafts *did* leak onto winner categories at
tiers we hadn't yet tested (a multi_session count question at 1M, an abstention
document lookup at 10M, and two 500K queries found in a later audit); each leak
became a permanent must-not-fire regression test (`tests/ambServer.test.ts`).

### Measured: summarization flips (official config, Gemini stack)

Paired on the same 40 BEAM-100K summarization queries as the official-runner
baseline (`csm-official-rerun-100k`, answer `gemini-3.1-pro-preview`, judge
`gemini-2.5-flash-lite`):

| | baseline | + Observation | Δ |
|---|---:|---:|---:|
| summarization (40q, paired) | 0.7139 | **0.9364** | **+0.2224** |
| per-query | — | 29 better / 2 worse / 9 equal | |
| answer-visible context | 26,207 tok | **15,051 tok** | **−42.6%** |

The gains land exactly on the diagnosed coverage failures (e.g. two queries at
0.20/0.30 → both 1.00); the two declines are −0.20 and −0.17. Folding the 40
swapped scores into the 400-query set is **arithmetic, not a fresh run**:
overall 0.7431 → 0.7654 (the Hindsight 100K comparator from the same artifact
set is 0.7337). Single-trial, one category measured; the event_ordering half
of the gate is measured only on the mechanism lab below.

Artifact: `data/eval/runs/obs-wave-2026-07/csm-obs-summ40-100k.json.gz`
(sha256 `ef99e5316896349e…`), run 2026-06-23.

### Measured: event_ordering does NOT flip — published anyway

On a paired A/B (identical stack both legs, OpenAI `gpt-5.4-mini` answer+judge,
30 of 40 queries shared before the account hit its quota):

| | baseline | + Observation | Δ |
|---|---:|---:|---:|
| event_ordering (30q, paired) | 0.6350 | 0.6427 | **+0.008 (wash)** |
| per-query | — | 12 better / 10 worse / 8 equal | |
| answer-visible context | 26,094 tok | **11,065 tok** | **−57.6%** |

Ordering queries ask for *specific named items in exact order*; a narrative
summary rescues some and compresses away others — the same double-edged pattern
every earlier presentation lever showed. Conclusion: for event_ordering the
Observation is a **cost lever (−58% context at score parity), not a score
lever**. It stays gated in for that reason. Score conversion on the Gemini
stack (a stronger answer model) is untested.

Artifacts: `csm-oai-eo40-base-100k.json.gz` (sha256 `acfb31e01f595a4f…`, full
n=40, mean 0.6068), `csm-oai-eo40-obs-100k.json.gz` (sha256
`b0b68b6b4f449141…`, n=30, truncated by provider quota). Mechanism-lab stack —
**not comparable** to the Gemini ladder numbers.

### Measured: the hierarchical build works at 1M scale

The single-pass Observation cannot exist above the model context window (a
BEAM 10M conversation is ~11–18M tokens). The hierarchical build was validated
live on a full 1M-tier conversation (OpenAI stack):

- 1,710 turn-events / ~1.07M tokens → 8 chunks → one **316-entry** numbered
  chronological memory (~11K tokens), faithful from the first turn to the last
  (spot-checked head/mid/tail; concrete values preserved, e.g. latency
  targets, coverage percentages, named tools).
- Cost: 999,641 input / 29,478 output tokens ≈ **$0.35** at `gpt-5.4-mini`
  prices; 466s wall — dominated by the account's 200K tokens-per-minute tier
  cap, not the mechanism.

## 3. Lever 2 — the fact registry (built, gated, not yet measured)

For disease 2, `organizeFactsScaled` extracts every quantitative/stateful fact
at write time and merges them into a registry of **per-metric value histories
with the LATEST value marked** ("Solr docs: 1M → 1.2M; LATEST: 1.2M") — so an
aggregation question combines current values instead of stale ones. Flag:
`CSM_AMB_FACT_MEMORY` (default **off**). Gate: aggregation intent, validated on
the same 2,000 queries — fires **only** on multi_session_reasoning (9/40 at
100K, 19/70 at 500K, 13/70 at 1M, 13/20 at 10M), zero leak elsewhere.
Deliberately *not* gated: knowledge_update's "current value" questions — they
are lexically indistinguishable from information_extraction (a winner
category), so no safe lexical gate exists; that subproblem stays open.

The score measurement (paired multi_session A/B) was staged when the lab
account ran out of quota; it is the first queued experiment.

## 4. Cost accounting — including our own write-time cost

This repo's rule (see `docs/COST_ACCOUNTING.md`): totals must include every
internal LLM call. Two disclosures in that spirit:

1. **The Observation adds a one-time write cost ≈ one pass over the
   conversation** (measured: 1.0M input tokens for a 1.07M-token conversation),
   amortized across every gated query on that conversation. Hindsight pays an
   analogous ingest-time distillation cost and does not disclose it; CSM's is
   stated here and attributed per-run in telemetry.
2. **An early build of this lever did not attribute that cost** — the
   2026-06-23 summarization run predates the fix, so its telemetry
   under-reports the one-time build cost (the *score* comparison is unaffected;
   contexts are stored in the artifact). Found by an adversarial code audit,
   fixed the next day: the build cost now lands on the exact query that paid
   it (`observationBuildCost` in the payload), and cache hits report zero.

## 5. Threats to validity

- **Single-trial everywhere.** Judge/decoder noise ≈ ±0.02–0.03 per category;
  the +0.22 summarization delta is ~10× that, but the small deltas quoted
  (±0.01) are noise-level by construction.
- **One category measured on the official config.** Event_ordering evidence is
  from a different (weaker) answer model; multi_session is unmeasured.
- **The swapped-overall 0.7654 is arithmetic**, not a fresh 400-query run.
- **Gate tuning used the benchmark's query phrasings.** The gates read only
  query text (never gold), the same information available at inference — but
  their recall/leak rates are measured *on BEAM's phrasing distribution* and
  should be re-measured before use on other workloads.
- **The mechanism lab's answer model (`gpt-5.4-mini`) is weaker than
  `gemini-3.1-pro-preview`**; absolute numbers across stacks are not
  comparable, only paired deltas within a stack.

## 6. What's next (in order)

1. **Paired multi_session A/B** for the fact registry (staged, one command).
2. **Known-baselines comparison** people can calibrate against: long-context
   ("paste everything") and vanilla RAG vs CSM, same model, same corpus, same
   questions — the harness has all three behind one interface
   (`scripts/measure-baseline-comparison.ts`, validated offline, awaiting
   credit).
3. Gemini-stack confirmation of the summarization flip + a fresh full BEAM
   ladder with `CSM_AMB_OBSERVE_MEMORY=1`.

## 7. Reproduce / verify

```bash
npm test                      # 368 offline tests (MockProvider, no keys)
npx vitest run tests/ambServer.test.ts   # both gates' regression cases
```

The gate validation over all four tier query sets requires the BEAM data
(`data/beam/<tier>/queries.json.gz` from the AMB repo); the check script
pattern is documented in `tests/ambServer.test.ts` and runs the *production*
exported functions (`observationQueryIntent`, `aggregationQueryIntent`) over
every query.

| Artifact | sha256 (first 16) | What |
|---|---|---|
| `data/eval/runs/obs-wave-2026-07/csm-obs-summ40-100k.json.gz` | `ef99e5316896349e` | BEAM 100K summarization 40q with Observation, official config (0.9364) |
| `data/eval/runs/obs-wave-2026-07/csm-oai-eo40-base-100k.json.gz` | `acfb31e01f595a4f` | event_ordering 40q baseline, mechanism-lab stack (0.6068) |
| `data/eval/runs/obs-wave-2026-07/csm-oai-eo40-obs-100k.json.gz` | `b0b68b6b4f449141` | event_ordering 30q with Observation, mechanism-lab stack (paired Δ +0.008) |
