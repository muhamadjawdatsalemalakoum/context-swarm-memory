# Benchmark report — gemini35-160k-30q-v1

Generated at: 2026-05-25T18:26:08.719Z

## Cells

| System | Corpus | ModelCtx | n | Accuracy | CI95 | Cite F1 | InTokens | LatencyMs | EarlyStop |
|---|---|---|---|---|---|---|---|---|---|
| csm | 100K | 160K | 30 | 93.3% | [83.3, 100.0]% | 0.52 | 14309 | 26534 |  |
| csm | 1M | 160K | 30 | 96.7% | [90.0, 100.0]% | 0.52 | 18999 | 30702 |  |
| csm | 2M | 160K | 30 | 93.3% | [83.3, 100.0]% | 0.51 | 18076 | 30003 |  |
| hybrid | 100K | 160K | 30 | 90.0% | [80.0, 100.0]% | 0.45 | 5860 | 3241 |  |
| hybrid | 1M | 160K | 30 | 90.0% | [80.0, 100.0]% | 0.39 | 5614 | 3474 |  |
| hybrid | 2M | 160K | 30 | 90.0% | [80.0, 100.0]% | 0.39 | 5633 | 3663 |  |
| longctx | 100K | 160K | 30 | 100.0% | [100.0, 100.0]% | 0.56 | 107437 | 4813 |  |
| longctx | 1M | 160K | 30 | 90.0% | [80.0, 100.0]% | 0.16 | 170122 | 10933 |  |
| longctx | 2M | 160K | 30 | 50.0% | [33.3, 66.7]% | 0.09 | 170475 | 11561 |  |
| rag | 100K | 160K | 30 | 93.3% | [83.3, 100.0]% | 0.45 | 5677 | 2898 |  |
| rag | 1M | 160K | 30 | 86.7% | [73.3, 96.7]% | 0.34 | 5489 | 3122 |  |
| rag | 2M | 160K | 30 | 86.7% | [73.3, 96.7]% | 0.33 | 5442 | 3173 |  |

## Plots (Vega-Lite specs)

- `plots/graphA.vl.json`
- `plots/graphB.vl.json`
- `plots/graphC.vl.json`
- `plots/graphD.vl.json`
- `plots/graphE.vl.json`
- `plots/graphG.vl.json`
- `plots/graphH.vl.json`

Render via the online editor at https://vega.github.io/editor/ (paste the JSON), or use the `vega-lite` CLI to convert to SVG/PNG.