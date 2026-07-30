# EXP — calibrating a free answer judge against BEAM's official judge

**Status: PASS on holdout, first peek.** Free (Claude subscription sidecar),
replayable from cache. Validated on the official BEAM 100K artifact
(`data/eval/runs/amb-beam-100k-official-v1/.../rag/100k.json`, 400 rows,
answer `gemini-3.1-pro-preview`, judge `gemini-2.5-flash-lite`).

## Why this exists

Every CSM retrieval improvement so far is measured as gold-facet **coverage**,
a proxy. Levers keep dying at "proxy-only, conversion unproven". The fix is an
answer-quality gate we can run for free — but the gate we had was broken.

`scripts/score-answer-gate.ts` built the judge's reference list from
`gold_answers`. **160 of 400 official rows have `gold_answers: []`** — every row
of `contradiction_resolution`, `instruction_following`, `preference_following`
and **`summarization`**. Those rows handed the judge an empty reference and
could only score 0.

That is the whole explanation for the earlier "null result" (mean ~0.03,
summarization 0W/1L/19T). It was **not** low resolution and the scores were
**not** real. BEAM's judge is **rubric-based**: `meta.rubric` is present on
400/400 rows and is byte-identical between the official artifact and the local
slice, so it is available offline at zero cost.

## Two scoring shapes, recovered from the artifact

**1. Rubric fraction (nine categories).** Per-criterion credit in {0, 0.5, 1},
averaged. Official values like 0.875 (3.5/4) and 0.9375 (7.5/8) are only
reachable this way — a 0–10 integer holistic rating cannot express them.

**2. Rank correlation (`event_ordering`).**

```
score = (1 + Kendall tau-b) / 2
```

over the order in which the answer discusses the rubric items. The irrational
scores in the official distribution are the tie-correction term:

| official score | closed form |
|---|---|
| 0.8162277660168380 | 0.5 + 1/√10 |
| 0.8535533905932738 | 0.5 + 1/(2√2) |
| 0.7886751345948129 | 0.5 + 1/(2√3) |
| 0.7672612419124245 | 0.5 + 1/√14 |
| 0.2763932022500211 | 0.5 − 1/√20 |

Worked case `4_event_ordering_0`: item order [1,3,4,5,8,7,6,2,9] → 9 discordant
pairs of 36 → τ = 0.5 → **0.75**, exactly the official value. Pinned in
`tests/beamJudge.test.ts`.

**This is the finding with downstream consequences: the metric literally rewards
correct sequence.** Any retrieval reordering that scrambles chronology is scored
down even when it retrieves strictly more — which is a mechanical prediction
about the coverage reranker, not a hunch.

*Caveat: the τ form is reverse-engineered from the score distribution, not read
from AMB source. It is strong evidence (five independent closed-form matches
plus an exact worked case), not proof.*

## The ceiling — what "good" can even mean

`amb-beam-100k-official-v1` vs `-v2` are the same 400 queries with
**byte-identical retrieval context on 400/400**; only the answer/judge roll
differs. That is the official pipeline measured against itself:

| | value |
|---|---|
| Pearson r | 0.8079 |
| Spearman ρ | 0.8158 |
| MAE / RMSE | 0.0798 / 0.2078 |
| binary agreement | 0.9350 |
| paired Δ | −0.0064, CI95 [−0.0266, 0.0137] |

Answer text differs on 348/400 rows, so most of that noise is the **answer
model**, not the judge.

**Minimum detectable effect (80% power, paired):**

| n | MDE |
|---|---|
| 400 | 0.029 |
| 200 | 0.046 |
| 100 | 0.075 |
| 40 | **0.124** |

This retroactively condemns the earlier gate run twice over: it was not only
using a broken judge, it was run at **n=40 per category looking for effects of
0.02–0.05** — an order of magnitude below what that n can resolve. Even a
perfect instrument would have returned "no effect".

## Result

Free judge = `claude-sonnet-5` via the Agent SDK sidecar, prompt `v2`,
temperature 0, responses content-hash cached. The **official answers** are held
fixed, so this isolates judge error.

| | train (n=208) | holdout (n=192) | official ceiling |
|---|---:|---:|---:|
| Pearson r | 0.8582 | **0.8699** | 0.8079 |
| Spearman ρ | 0.8606 | **0.8644** | 0.8158 |
| MAE | 0.0736 | **0.0770** | 0.0798 |
| bias | +0.0393 | **+0.0319** | — |
| binary agreement | 0.9375 | **0.9323** | 0.9350 |
| unscored rows | 0 | 0 | — |

**Pass bar (ρ ≥ 0.85, MAE ≤ 0.10, |bias| ≤ 0.05): PASS on holdout, first peek.**
Train and holdout agree to within 0.004 on ρ — no overfitting.

Per-category MAE on holdout, worst first:

| category | official | free | MAE |
|---|---:|---:|---:|
| temporal_reasoning | 0.6316 | 0.7632 | **0.1579** |
| event_ordering | 0.7417 | 0.7867 | **0.1468** |
| contradiction_resolution | 0.5972 | 0.6875 | **0.1181** |
| summarization | 0.6734 | 0.6391 | 0.0850 |
| instruction_following | 0.9048 | 0.9405 | 0.0833 |
| information_extraction | 0.7179 | 0.7179 | 0.0769 |
| knowledge_update | 0.6500 | 0.6875 | 0.0625 |
| multi_session_reasoning | 0.5019 | 0.5303 | 0.0436 |
| abstention | 1.0000 | 1.0000 | 0.0000 |
| preference_following | 0.9737 | 0.9737 | 0.0000 |

## How v1 became v2 (one revision, evidence-driven)

v1 instructed "judge substance, not wording" and came out lenient (bias +0.044).
The disagreements were systematic, not random:

- `1_temporal_reasoning_0` — rubric wants *"from January 15, 2024 till March 15,
  2024"*. The answer gives both dates, as two separate event dates. Official
  **0.5**; v1 said 1.0.
- `11_temporal_reasoning_1` — identical shape. Official **0.5**; v1 said 1.0.
- `12_event_ordering_1` — an explicit refusal ("the context lacks the
  information … does not mention a simulated happiness thought experiment or an
  identity paradox") scored **0.233**, not 0. Only reachable if the two *negated*
  topics still counted as discussed, in the wrong order.

So the reference grader credits the **stated form** of a criterion, and counts a
topic as referenced even when the answer denies it. v2 encodes both.

**The gate's job is to predict the official judge, not to out-judge it.** A
fairer grader is a worse instrument.

## Discipline

- **Split**: `sha256(query_id) & 1`, stratified, deterministic, never re-drawn.
- **Holdout budget 2 peeks**; every peek appends to
  `data/eval/judge-calibration/holdout-peeks.jsonl`. Used: **1**.
- Prompt text is part of the cache key (`JUDGE_PROMPT_VERSION`), so an edit
  re-keys and can never silently serve stale verdicts.
- Parse failures **retry once, then EXCLUDE and are counted** — never scored 0.
  Silent zeroing is the bug this replaces.
- `src/eval/beamJudge.ts` is a node-builtin-only leaf, added to
  `tests/beamLeakageFirewall.test.ts` as a second gold module (9 firewall cases,
  up from 6).

## What this does NOT establish

- **Judge-only.** The answer model is held fixed at the official answers. A
  full free gate has Claude *answer* too, which stacks answer-model variance on
  top; expect agreement below these numbers. Untested.
- **Not a Hindsight-comparable number.** Only paired deltas within one stack are
  meaningful. Published numbers still require the official Gemini config.
- **Three categories are weak** (temporal_reasoning, event_ordering,
  contradiction_resolution, MAE 0.12–0.16). Deltas in those need larger n.
- **Sidecar results are not third-party reproducible** (subscription auth).
  Iteration only.
- **The MDE is the binding constraint, not the judge.** At n=40 nothing below
  ~0.12 is measurable by anyone, including the official pipeline. Report deltas
  against the n-matched MDE or not at all.

## Reproduce

```bash
npx tsx scripts/calibrate-judge.ts --mode audit
```

Zero LLM calls: prints the rubric-availability check, the empty-gold census, the
zero-LLM τ reproduction rate, the noise ceiling and the MDE table.

```bash
npx tsx scripts/calibrate-judge.ts --mode judge --split train --jobs 8
```

Replays from the content-hashed cache after the first run.

| Artifact | What |
|---|---|
| `data/eval/judge-calibration/judge-v2-train.json` | train agreement + per-row scores |
| `data/eval/judge-calibration/judge-v2-holdout.json` | holdout agreement (peek 1) |
| `data/eval/judge-calibration/holdout-peeks.jsonl` | the peek ledger |
