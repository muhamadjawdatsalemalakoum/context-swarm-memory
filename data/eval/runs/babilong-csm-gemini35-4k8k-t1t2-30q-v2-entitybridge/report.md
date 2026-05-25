# BABILong External Benchmark: babilong-csm-gemini35-4k8k-t1t2-30q-v2-entitybridge

Recognized external benchmark: BABILong short-answer reasoning-in-a-haystack. Scoring is exact-match after normalisation; no LLM judge.

| System | Task | Length | N | Accuracy | Citation F1 | Errors | Mean input toks |
|---|---:|---:|---:|---:|---:|---:|---:|
| csm | task1 | 4K | 30 | 100.0% | 0.276 | 0 | 4411 |
| csm | task1 | 8K | 30 | 100.0% | 0.220 | 0 | 4406 |
| csm | task2 | 4K | 30 | 60.0% | 0.026 | 0 | 4426 |
| csm | task2 | 8K | 30 | 53.3% | 0.005 | 0 | 4435 |

Note: BABILong rows from Hugging Face do not expose supporting-fact indices through the dataset-server rows API, so citation metrics use the loader's lexical fallback. Accuracy is the primary comparable BABILong metric.
