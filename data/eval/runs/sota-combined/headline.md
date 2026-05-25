# SOTA head-to-head — combined headline

| System | Accuracy | 95% CI | Citation F1 | Citation P | Citation R | Latency | Input tokens |
|---|---|---|---|---|---|---|---|
| **CSM (pipeline + embedding floor)** | **30/30 (100%)** | [100, 100]% | **0.505** | 0.789 | 0.472 | 337 s | 14206 |
| vanilla RAG | 29/30 (97%) | [90, 100]% | 0.446 | 0.731 | 0.412 | 96 s | 5501 |
| hybrid RAG | 28/30 (93%) | [83, 100]% | 0.455 | 0.728 | 0.438 | 89 s | 5669 |
| LightRAG (SOTA — dual-level graph) | 24/30 (80%) | [63, 93]% | 0.265 | 0.451 | 0.275 | 224 s | 5451 |
| long-context | 11/30 (37%) | [20, 53]% | 0.067 | 0.067 | 0.067 | 94 s | 8786 |

## Significance — CSM vs each system (paired McNemar, exact)

| Comparison | CSM-only wins | other-only wins | p-value | verdict |
|---|---|---|---|---|
| CSM vs vanilla RAG | 1 | 0 | 1.000 | tie (n.s.) |
| CSM vs hybrid RAG | 2 | 0 | 0.500 | tie (n.s.) |
| CSM vs LightRAG (SOTA — dual-level graph) | 6 | 0 | 0.031 | CSM wins (sig.) |
| CSM vs long-context | 19 | 0 | 0.000 | CSM wins (sig.) |

**Citation F1**: CSM 0.505 vs next-best hybrid RAG 0.455 (1.1×).
