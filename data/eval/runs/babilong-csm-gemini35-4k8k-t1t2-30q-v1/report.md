# BABILong External Benchmark: babilong-csm-gemini35-4k8k-t1t2-30q-v1

Recognized external benchmark: BABILong short-answer reasoning-in-a-haystack. Scoring is exact-match after normalisation; no LLM judge.

| System | Task | Length | N | Accuracy | Citation F1 | Errors | Mean input toks |
|---|---:|---:|---:|---:|---:|---:|---:|
| csm | task1 | 4K | 30 | 100.0% | 0.293 | 0 | 4049 |
| csm | task1 | 8K | 30 | 100.0% | 0.237 | 0 | 4049 |
| csm | task2 | 4K | 30 | 10.0% | 0.025 | 0 | 4084 |
| csm | task2 | 8K | 30 | 0.0% | 0.010 | 0 | 4099 |

Note: BABILong rows from Hugging Face do not expose supporting-fact indices through the dataset-server rows API, so citation metrics use the loader's lexical fallback. Accuracy is the primary comparable BABILong metric.
