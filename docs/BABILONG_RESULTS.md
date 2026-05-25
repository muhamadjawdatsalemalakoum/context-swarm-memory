# BABILong External Benchmark

This is the first committed external-standard benchmark for CSM. It uses
BABILong, a public reasoning-in-a-haystack benchmark from Kuratov et al.
(<https://arxiv.org/abs/2406.10149>), fetched from Hugging Face
`RMT-team/babilong-1k-samples`.

## Run

- Run id: `babilong-csm-gemini35-4k8k-t1t2-30q-v2-entitybridge`
- Model: `gemini-3.5-flash`
- Physical model context: `4K`
- Systems: `csm`
- Tasks: BABILong task 1 and task 2
- Lengths: `4K`, `8K`
- Rows: 30 per task/length cell
- Scoring: exact-match free-form answer after normalisation; no LLM judge

Raw BABILong rows are not committed. Re-fetch the same public subset with:

```bash
npm run bench:babilong:fetch -- --tasks 1,2 --lengths 4K,8K --rows 30
```

Re-run CSM with:

```bash
npm run bench:babilong:csm -- --tasks 1,2 --lengths 4K,8K --limit 30 --model-context 4K --model gemini-3.5-flash --run-id babilong-csm-gemini35-4k8k-t1t2-30q-v2-entitybridge
```

## Results

| System | Task | Length | N | Accuracy | Citation F1 | Errors |
|---|---:|---:|---:|---:|---:|---:|
| CSM | 1 | 4K | 30 | 100.0% | 0.276 | 0 |
| CSM | 1 | 8K | 30 | 100.0% | 0.220 | 0 |
| CSM | 2 | 4K | 30 | 60.0% | 0.026 | 0 |
| CSM | 2 | 8K | 30 | 53.3% | 0.005 | 0 |

## Historical Leaderboard Comparison

The public BABILong Space leaderboard is a historical v0 snapshot, not a current
2026 frontier-model leaderboard. CSM has not run QA3-QA5 yet, so it also cannot
honestly be placed on the full avg(QA1-QA5) table. The committed snapshot is
`data/eval/external/babilong-leaderboard-v0_results.csv`, retrieved from the
Hugging Face Space:
<https://huggingface.co/spaces/RMT-team/babilong>.

On the overlapping QA1/QA2 4K/8K cells:

| Cell | CSM | ARMT fine-tune | Mamba fine-tune | RMT fine-tune | GPT-4 | ChatQA + RAG |
|---|---:|---:|---:|---:|---:|---:|
| QA1 / 4K | 100.0 | 100.0 | 100.0 | 100.0 | 95.0 | 58.0 |
| QA1 / 8K | 100.0 | 100.0 | 100.0 | 100.0 | 93.0 | 58.0 |
| QA2 / 4K | 60.0 | 100.0 | 98.0 | 98.0 | 68.0 | 19.0 |
| QA2 / 8K | 53.3 | 100.0 | 98.0 | 97.0 | 65.0 | 14.0 |

Interpretation: CSM is not BABILong SOTA today, and this snapshot is not a 2026
SOTA source. CSM is perfect on QA1 in this small slice and beats the historical
ChatQA + RAG line on QA2, but it trails the fine-tuned memory models and GPT-4
on QA2. That makes the next research target concrete: full QA1-QA5 coverage,
stronger multi-hop/entity tracking, and fresh 2026 model rows run under the same
scoring harness.

## R&D Finding

The first run, before entity-bridge recall, exposed a real failure:

| Run | Task 1 / 4K | Task 1 / 8K | Task 2 / 4K | Task 2 / 8K |
|---|---:|---:|---:|---:|
| Before entity bridge | 30/30 | 30/30 | 3/30 | 0/30 |
| After entity bridge | 30/30 | 30/30 | 18/30 | 16/30 |

Interpretation: CSM already handled single-hop BABILong task 1, but task 2
requires entity-chain recall, for example retrieving both "Mary got the milk"
and a later "Mary travelled to the hallway" fact. The new entity bridge in
`src/eval/baselines/csm.ts` is a general same-shard expansion from retrieved
foothold events to other events mentioning the same salient entities.

This is not a final SOTA claim. It is a committed external benchmark run that
turns the old SOTA plan into measured evidence and reveals the next research
frontier: multi-hop temporal/entity tracking.

## Citation Caveat

Hugging Face's dataset-server rows endpoint exposes `question`, `target`, and
`input`, but not supporting-fact indices. The BABILong loader therefore uses a
lexical fallback for `relevantEventIds`. Accuracy is the primary comparable
BABILong metric; citation F1 on this run is diagnostic only.
