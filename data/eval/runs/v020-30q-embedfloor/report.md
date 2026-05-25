# Benchmark report — v020-30q-embedfloor

Generated at: 2026-05-21T01:14:46.425Z

## Cells

| System | Corpus | ModelCtx | n | Accuracy | CI95 | Cite F1 | InTokens | LatencyMs | EarlyStop |
|---|---|---|---|---|---|---|---|---|---|
| csm | 100K | 8K | 30 | 100.0% | [100.0, 100.0]% | 0.47 | 14206 | 337055 |  |
| hybrid | 100K | 8K | 30 | 93.3% | [83.3, 100.0]% | 0.22 | 5669 | 89044 |  |
| longctx | 100K | 8K | 30 | 80.0% | [63.3, 93.3]% | 0.11 | 8664 | 234476 |  |
| rag | 100K | 8K | 30 | 96.7% | [90.0, 100.0]% | 0.31 | 5501 | 96389 |  |

## Plots (Vega-Lite specs)

- `plots/graphA.vl.json`
- `plots/graphB.vl.json`
- `plots/graphC.vl.json`
- `plots/graphD.vl.json`
- `plots/graphE.vl.json`
- `plots/graphG.vl.json`
- `plots/graphH.vl.json`

Render via the online editor at https://vega.github.io/editor/ (paste the JSON), or use the `vega-lite` CLI to convert to SVG/PNG.