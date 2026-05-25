# SOTA Scaling Report

Question: does CSM get better and more precise as corpus size grows, and do SOTA memory systems show the same behavior?

Runs loaded: `scaling-rq1`, `scaling-1m`, `lightrag-30q`, `gemini35-160k-30q-v1`

Interpretation: accuracy and citation precision can improve while citation recall/F1 falls. Treat that as a mixed result, not a clean win.

## gemini-3.5-flash / ctx=160K

| System | Type | Corpus sizes | Accuracy first -> last | dAcc | Citation P first -> last | dP | Citation R first -> last | dR | Citation F1 first -> last | dF1 | Verdict |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| CSM | CSM | 100K -> 1M -> 2M | 93.3% -> 93.3% | 0.0pp | 77.8% -> 78.9% | +1.1pp | 45.2% -> 44.6% | -0.6pp | 0.517 -> 0.515 | -0.002 | roughly stable |
| hybrid RAG | control | 100K -> 1M -> 2M | 90.0% -> 90.0% | 0.0pp | 74.2% -> 67.7% | -6.6pp | 42.3% -> 36.4% | -5.9pp | 0.447 -> 0.386 | -0.061 | degrades on at least one grounding metric |
| long-context | control | 100K -> 1M -> 2M | 100.0% -> 50.0% | -50.0pp | 82.7% -> 21.1% | -61.6pp | 53.2% -> 12.2% | -41.0pp | 0.559 -> 0.086 | -0.473 | degrades on at least one grounding metric |
| vanilla RAG | control | 100K -> 1M -> 2M | 93.3% -> 86.7% | -6.7pp | 73.3% -> 60.0% | -13.3pp | 41.7% -> 31.5% | -10.3pp | 0.447 -> 0.334 | -0.113 | degrades on at least one grounding metric |

## gemma4:31b / ctx=8K

| System | Type | Corpus sizes | Accuracy first -> last | dAcc | Citation P first -> last | dP | Citation R first -> last | dR | Citation F1 first -> last | dF1 | Verdict |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| CSM | CSM | 100K -> 1M | 90.0% -> 93.3% | +3.3pp | 75.3% -> 77.4% | +2.2pp | 53.2% -> 42.7% | -10.5pp | 0.524 -> 0.460 | -0.064 | accuracy+precision up; recall/F1 check |
| LightRAG | SOTA | 100K | 80.0% -> 80.0% | 0.0pp | 45.1% -> 45.1% | 0.0pp | 27.5% -> 27.5% | 0.0pp | 0.265 -> 0.265 | 0.000 | needs multi-size run |
| long-context | control | 100K -> 1M | 36.7% -> 30.0% | -6.7pp | 6.7% -> 3.3% | -3.3pp | 6.7% -> 6.7% | 0.0pp | 0.067 -> 0.033 | -0.033 | degrades on at least one grounding metric |
| vanilla RAG | control | 100K -> 1M | 96.7% -> 83.3% | -13.3pp | 73.1% -> 61.9% | -11.1pp | 41.2% -> 32.0% | -9.2pp | 0.446 -> 0.336 | -0.110 | degrades on at least one grounding metric |

SOTA gap: LightRAG needs at least two corpus sizes in this track before we can compare scaling slope.

## Required Next Evidence

- Run each SOTA comparator at the same corpus sizes as CSM, starting with 100K and 1M.
- Report slopes for accuracy, citation precision, citation recall, and citation F1 separately.
- Include indexing wall time, index tokens, and disk size so graph/agentic systems cannot hide setup cost.
- Do not claim CSM gets better than SOTA with scale until at least one runnable SOTA comparator has multi-size rows.
