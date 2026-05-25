# Benchmark Freshness Gate

This repo must not call any result "2026 SOTA" unless the comparison actually
contains 2026-era frontier models or fresh same-harness runs.

## Current Status

| Evidence | Freshness status | How to describe it |
|---|---|---|
| PaySwift CSM vs LightRAG | 2025 graph-RAG comparator, same harness | Valid head-to-head evidence, not 2026 field-wide SOTA |
| BABILong Space leaderboard v0 | Historical public leaderboard snapshot | External diagnostic only, not current 2026 SOTA |
| BABILong CSM QA1/QA2 4K/8K | Fresh CSM run, partial benchmark coverage | Useful R&D evidence; not the full BABILong avg(QA1-QA5) table |
| Gemini 3.5 Flash PaySwift run | Fresh hosted-model sanity check | Cross-model confirmation, not a SOTA comparison |

## Rule For Any Future SOTA Claim

A public SOTA claim needs all of these:

- Same benchmark and same scoring harness for CSM and comparators, or a clearly
  labeled official leaderboard with current submission dates.
- Model roster includes current frontier families available at run time, not
  only older GPT-4/Llama-3-era rows.
- Exact model IDs, provider, run date, context limit, decoding settings, and
  prompt template are saved.
- Per-query rows are saved for CSM; official leaderboard rows are snapshotted
  with source URL and retrieval date.
- If a benchmark leaderboard has not added current models, call it stale or
  historical and use it only as diagnostic evidence.

## Minimum 2026 Frontier Roster

For a serious 2026 memory/long-context claim, run CSM against either a live
benchmark that already includes current OpenAI, Anthropic, Google, Meta/Qwen/
DeepSeek-class frontier models, or run those model families ourselves through
the same harness.

The exact roster should be refreshed immediately before a release. Do not hard
code old model names into a headline graph and call it current.

## BABILong Decision

BABILong remains valuable because it stresses reasoning in long haystacks and
has public prediction artifacts. But the public Space leaderboard snapshot in
this repo is not tracking 2026 frontier models. Therefore:

- README may show BABILong as an external diagnostic.
- README must not call the BABILong v0 chart "current SOTA".
- Full BABILong QA1-QA5 plus fresh frontier-model rows are required before a
  BABILong SOTA claim is allowed.
