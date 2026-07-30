# EXP — CSM vs Hindsight on one reader, no API keys

**Status: tie at 100K, reproducing the official verdict on an independent
stack.** Free (Claude subscription), n=120 stratified, replayable from cache.

## Why this exists

Dropping Gemini removed our only comparator: all-Claude numbers measured CSM
against itself. This restores the comparison without a key.

The published BEAM comparison varies the memory system **and** is read by a model
we no longer use. This holds the reader completely constant — same answer model,
same judge, same prompts, same queries — and varies **only the retrieved
context**. That is the memory-system question stated precisely, and it removes
the answer-model confound the published comparison carries.

Neither system is re-implemented or re-tuned by us. Both arms are official
artifacts:

| arm | source | published accuracy |
|---|---|---|
| CSM | `data/eval/runs/amb-beam-100k-official-v1/.../rag/100k.json` | 0.7431 |
| Hindsight | vectorize-io public blob, `outputs/beam/hindsight/single-query/100k.json.gz` | **0.7337** |

The Hindsight artifact was downloaded from the benchmark's own public storage
and **sha256-verified against `blob-manifest.json`**
(`ee26d546c98b828a…`). Its `accuracy` (0.73366) and `avg_context_tokens`
(17,654) match the published Hindsight 100K comparator exactly, so this is the
same artifact the leaderboard number comes from.

Every row of both files carries `context`, `meta.rubric` and the same
`query_id`, so the pairing is exact.

## Method

`scripts/headtohead-arms.ts`. For each query, Claude answers from arm A's context
and from arm B's context, then the judge calibrated in
[EXP-judge-calibration](EXP-judge-calibration.md) (holdout ρ 0.864, MAE 0.077 vs
the official Gemini judge) grades both against BEAM's rubric. Stratified 12 per
category so a truncated run stays balanced.

Firewall: the script reads gold (rubric) but never imports the retrieval bridge
or `src/core` — it consumes finished contexts from artifacts. Registered as a
judge consumer in `tests/beamLeakageFirewall.test.ts` (10 cases).

## Result

| category | n | CSM | Hindsight | Δ | MDE | HS/CSM/tie | leader |
|---|---:|---:|---:|---:|---:|---|---|
| abstention | 12 | 0.708 | 0.708 | +0.000 | 0.299 | 1/2/9 | tie |
| contradiction_resolution | 12 | 0.760 | 0.760 | +0.000 | 0.299 | 3/4/5 | tie |
| event_ordering | 12 | 0.649 | 0.723 | +0.074 | 0.227 | 6/4/2 | tie |
| information_extraction | 12 | 0.743 | 0.634 | −0.109 | 0.341 | 2/4/6 | tie |
| instruction_following | 12 | 0.604 | 0.625 | +0.021 | 0.135 | 1/1/10 | tie |
| knowledge_update | 12 | 0.333 | 0.417 | +0.083 | 0.338 | 4/1/7 | tie |
| multi_session_reasoning | 12 | 0.662 | 0.452 | −0.210 | 0.303 | 1/7/4 | tie |
| preference_following | 12 | 0.750 | 0.917 | +0.167 | 0.277 | 4/1/7 | tie |
| summarization | 12 | 0.422 | 0.503 | +0.081 | 0.149 | 5/2/5 | tie |
| temporal_reasoning | 12 | 0.813 | 0.583 | −0.229 | 0.316 | 1/5/6 | tie |
| **ALL** | **120** | **0.6444** | **0.6322** | **−0.0122** | **0.0902** | 28/31/61 | **tie** |

*(Δ positive = Hindsight ahead. Every per-category row is below its n=12 MDE and
the script refuses to call any of them — they are printed for shape only, not as
results.)*

## What it establishes

**At 100K the two systems are statistically tied on an independent reader.** The
official Gemini comparison put CSM at 0.7367 and Hindsight at 0.7337 — a tie of
+0.003. This stack, with a different answer model, a different judge and a
different scoring implementation, lands on −0.012 with an MDE of 0.090: the same
verdict.

That is genuine cross-stack corroboration. The 100K tie is not an artifact of
Gemini, of BEAM's judge prompt, or of our own scoring code.

It also validates the harness itself: a completely independent path reproduces a
published head-to-head, which is the strongest available evidence that the free
gate measures the thing it claims to.

## What it does NOT establish

- **Only 100K.** CSM loses at 500K (−0.052), 1M (−0.169) and 10M (−0.079). Those
  Hindsight artifacts are published at the same public URLs and sha-listed in
  `blob-manifest.json`; running the upper tiers is the obvious extension and the
  only one that touches where CSM actually loses.
- **n=120, so MDE is 0.090.** Nothing smaller than that is resolvable. The full
  400 is one flag away and cached-incremental, which takes MDE to ≈0.049.
- **Per-category numbers are noise at n=12** and are labelled as such. The
  suggestive-looking rows (`multi_session_reasoning` −0.210,
  `temporal_reasoning` −0.229 in CSM's favour; `preference_following` +0.167 in
  Hindsight's) all sit inside their own MDE.
- **Absolute values are lower than the official run** (0.64 vs 0.74) because the
  reader is `claude-sonnet-5`, not `gemini-3.1-pro-preview`. Only the paired
  delta within this stack is meaningful.
- **Hindsight's arm is `single-query` mode**, CSM's is `rag` mode. Both supply a
  retrieved `context` and both are the published 100K artifacts, but the modes
  are not identical harness paths.
- **Not third-party reproducible** (subscription auth), so this is engineering
  evidence, not a publishable claim.

## Reproduce

```bash
npx tsx scripts/headtohead-arms.ts --hindsight <path>/hs-100k.json.gz --per-category 12 --jobs 6
```

Drop `--per-category` for the full 400. Replays from the content-hashed cache.
Artifact: `data/eval/judge-calibration/headtohead-csm-vs-hindsight.json`.
