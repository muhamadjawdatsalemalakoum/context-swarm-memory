# EXP — does the coverage-ordering lever convert? No. It looks harmful.

**Status: DO NOT SHIP. `CSM_AMB_COVERAGE_RERANK` stays default-off.**
Free (Claude sidecar), paired, replayable from cache.

## The question

The coverage reranker (`greedyCoverageOrder`, applied on every return path in
`c419a5e`) raises gold-facet retrieval **coverage** substantially:

| proxy, cov@24 | OFF | ON | Δ |
|---|---:|---:|---:|
| event_ordering | 0.558 | 0.674 | **+11.6** |
| summarization | 0.498 | 0.602 | **+10.4** |

`retrieved` is unchanged (0.742→0.744, 0.807→0.824), so this is a pure ordering
effect. Every prior attempt to ship a lever died at exactly this point —
"proxy-only, conversion unproven". This is the conversion test.

## Method

Two frozen arms, identical in everything but the flag: `gateA-off-v1` (OFF) vs
`gateB-on-v1` (ON), 40 paired queries (20 summarization, 20 event_ordering) at
BEAM 100K, `CSM_AMB_ID_REPAIR=1` on both.

Two processes, so no module holds both the corpus and gold:
`scripts/answer-arms.ts` answers from each arm's frozen retrieved documents;
`scripts/judge-arms.ts` grades both against BEAM's rubric with the judge
calibrated in [EXP-judge-calibration](EXP-judge-calibration.md)
(holdout ρ 0.864, MAE 0.077 vs the official Gemini judge).

## Result

| category | n | mean OFF | mean ON | Δ | CI95 | MDE | W/L/T | sign test |
|---|---:|---:|---:|---:|---|---:|---|---:|
| event_ordering | 20 | 0.670 | 0.612 | **−0.058** | [−0.123, +0.009] | 0.097 | **4/13/3** | **p = 0.049** |
| summarization | 20 | 0.393 | 0.388 | −0.005 | [−0.120, +0.100] | 0.163 | 9/8/3 | p = 1.00 |
| ALL | 40 | 0.531 | 0.500 | −0.032 | [−0.097, +0.034] | 0.094 | 13/21/6 | p = 0.23 |

**The lever does not convert. On `event_ordering` it looks actively harmful:
13 losses against 4 wins.**

## Why this is the predicted direction, not a surprise

BEAM scores `event_ordering` as `(1 + Kendall τ-b)/2` over the order in which
the answer discusses the rubric items — reverse-engineered from the official
score distribution and pinned in `tests/beamJudge.test.ts`. **The metric rewards
correct sequence.**

The coverage reranker orders candidates by greedy *vocabulary novelty*. That is
close to orthogonal to chronology, so it hands the answer model a
scrambled timeline. Concretely, for `14_event_ordering_0` — *"walk me through
the order in which I brought these up"* — the top excerpt under the ON arm is
dated May-15, mid-timeline.

The two categories dissociate exactly as the mechanism predicts: the
order-scored one degrades (p = 0.049), the non-order-scored one is pure noise
(9W/8L, p = 1.00).

## The lesson that generalises

The proxy said **+11.6**. The metric says **−0.058 with 4W/13L**. For
order-scored categories, gold-facet coverage is not a weak proxy — it is
**anti-correlated** with the objective, because improving it means reordering,
and reordering is what the metric penalises.

Any future lever that changes *order* must be gated on the answer metric.
Coverage may still be a reasonable proxy for levers that change *which* events
are retrieved; it is not one for levers that change the sequence.

## Threats to validity — stated plainly

- **p = 0.049 is borderline, and two categories were tested.** Under a
  Bonferroni correction that is p ≈ 0.098, i.e. **not** significant at 0.05.
  The honest claim is *directional evidence of harm*, not a proven effect.
- **The magnitude is below the MDE.** At n = 20 the minimum detectable effect is
  0.097 and the delta is 0.058, so the *size* is not established — only the
  win/loss asymmetry carries information here.
- **Single trial.** No repeated seeds.
- **Answer model is `claude-sonnet-5` via the subscription sidecar**, not BEAM's
  `gemini-3.1-pro-preview`. Absolute means (0.53 / 0.50) are therefore not
  comparable to the official 0.71–0.75; only the paired delta within this stack
  is meaningful. Not third-party reproducible — iteration only.
- **The arms come from the slice harness**, which shows a 4× recall-count
  discrepancy against the official runner (see
  [EXP-recall-breadth-census](EXP-recall-breadth-census.md)). If that turns out
  to be a harness infidelity, these arms describe a system that is not the one
  on the leaderboard.

## Decision

`CSM_AMB_COVERAGE_RERANK` **stays default-off**, now on evidence rather than
caution. The follow-up worth running is the chronology variant: select by
coverage, then **emit in chronological order**, which keeps the breadth gain
while restoring the sequence the metric rewards. That is a distinct hypothesis
and gets its own pre-registered falsification criteria.

## Reproduce

```bash
npx tsx scripts/answer-arms.ts --a gateA-off-v1 --b gateB-on-v1 --split 100k --jobs 6
npx tsx scripts/judge-arms.ts --run gateB-on-v1 --split 100k --jobs 8
```

Both replay from the content-hashed cache after the first run.
Artifacts: `data/eval/runs/gateB-on-v1/answers.jsonl`,
`data/eval/runs/gateB-on-v1/answer-gate-v2.json`.
