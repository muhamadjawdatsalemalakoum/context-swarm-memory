# Benchmark Methodology

This document is the authoritative reference for the Context Swarm Memory (CSM) benchmark: what it tests, why, the corpora, the statistical methodology, and the explicit limitations of the design.

The benchmark is **fully programmatic** — accuracy is computed by integer or normalised-string comparison, never by an LLM judge — and **reproducible offline** from cached LLM responses (see [REPRODUCING.md](REPRODUCING.md)).

## 1. What the benchmark answers

Three explicit research questions, each about the *effective* context window of a small-context model:

- **Q1.** Does CSM give a small-context model (e.g. Gemma 4 31B with an 8K window) a larger *effective* context than running that same model directly over a long corpus?
- **Q2.** What is the *maximum* effective context window CSM achieves on a small-context model?
- **Q3.** How *little* physical context is enough for CSM to still answer correctly? Can a 4K-context model with CSM match a 128K-context model running vanilla?

Answering these requires running each system at multiple `(corpus_size × model_context)` combinations and observing where accuracy degrades.

## 2. Two corpora, deliberately complementary

The benchmark uses two corpora — each chosen to neutralise a specific reviewer objection to the other.

| Corpus | Tests | Origin | External comparability |
|---|---|---|---|
| **PaySwift** | CSM's actual use case (multi-shard narrative, decision reversals, citation precision) | Hand-authored synthetic project log | Bespoke — no external baselines |
| **BABILong** | Effective-context scaling on a published benchmark | Kuratov et al., HF `RMT-team/babilong-*-samples` | Direct overlay with published baselines |

The dual-corpus design lets the project claim both *use-case validity* (PaySwift) and *external comparability* (BABILong). Neither alone is sufficient: PaySwift on its own is "your corpus, your benchmark"; BABILong alone tests needle-in-haystack but not narrative project memory.

## 3. Eval format

**Programmatic scoring only.** No LLM judge. Two query kinds, dispatched via a discriminated union in `src/eval/mcq.ts`:

- **MCQ** (used by PaySwift): each query has 40 options, exactly one correct. The system outputs an integer 1–40. Scoring: `correct ≡ chosenOption === correctOption`.
- **Free-form** (used by BABILong): each query expects a short string answer. Scoring: exact-match after normalisation (lowercase, strip trailing punctuation, strip leading "the", collapse internal whitespace). `alternativeAnswers` lets a query accept multiple correct surface forms.

**Citation precision/recall** is measured for both kinds. Each system must also output `cited_event_ids`; P/R is computed against ground-truth `relevant_event_ids` per query.

Both formats share the same scorer entry point (`scoreAnswer` in `src/eval/scorer.ts`) which dispatches on `query.kind`. Each baseline calls a common `buildPrompt(query, context)` and `parseAnswer(query, rawOutput)` dispatcher — baselines do not branch on kind themselves.

## 4. Systems compared

Four baselines, all calling **the same Gemma 4 model via Ollama** for fair head-to-head:

- **`csm`** — the full CSM pipeline: router → probe → recall → synthesize → `MemoryPacket` → MCQ/free-form answer step. Tests the architectural thesis.
- **`longctx`** — concatenate all events into one prompt, truncate at the model context limit. The strawman; expected to fail above the model's native window.
- **`rag`** — vanilla embedding-based RAG: embed each event via `all-MiniLM-L6-v2` (local, fully offline), top-K cosine (K=10), generate.
- **`hybrid`** — BM25 + cosine RRF fusion, K=10 final. Often beats vanilla RAG on factual queries because BM25 catches keyword-exact matches embeddings miss.

CSM's probe stage uses the smaller `gemma4:e4b` model for cost; the recall/synth/answer stages use `gemma4:31b`. The other three baselines use `gemma4:31b` for their single LLM call. All four baselines use the same (empty) system prompt so cache keys stay narrow.

## 5. PaySwift corpus

- **Size:** 22,363 events / ~9.0M tokens. Composition: 163 hand-authored core events (~66K tokens), 200 hand-authored tier-1 filler events (~80K tokens), and ~22,000 programmatically-expanded tier-2/3 filler events.
- **Theme:** Fictional B2B payments-infrastructure startup ("PaySwift"), 5-person team, 3-month pre-launch period. Eight shards: architecture, product, people, customers, compliance, incidents, finance, meta.
- **Queries:** 30 MCQ questions, 40 options each. Distribution per the corpus-design spec:
  - 60% single-shard (18 queries) — tests router precision.
  - 30% multi-shard (9 queries) — tests synthesis across shards.
  - 10% adversarial (3 queries) — correct option is "no decision was made"; tests false-positive resistance.
- **Distractor mix per query:** 1 correct + 10 near-truths (one detail changed: wrong vendor, wrong date, wrong threshold) + 15 plausible alternatives (different but realistic decisions that aren't in the corpus) + 14 irrelevant-but-true claims (literal facts lifted from other decisions). Position is randomised via deterministic seed per query.
- **Filler integrity:** `scripts/verify-no-leakage.ts` confirms no filler event mentions banned PaySwift-specific terms (vendor names, person names, etc.).
- **License:** CC0 (original work; no upstream license issues).
- See `specs/corpus-design.md` and `data/eval/corpus-synthetic/decisions.md` for the full ledger of 50 load-bearing facts.

## 6. BABILong corpus

- **Source:** Kuratov et al., released on Hugging Face under `RMT-team/babilong-*-samples`. The fetch script targets the public `resolve` URLs.
- **Tasks:** 1 (single supporting fact), 2 (two supporting facts), 3 (three supporting facts). Picked for the cleanest difficulty gradient and maximum overlap with published baselines.
- **Context lengths:** 0K, 4K, 8K, 32K, 128K, 256K, 1M tokens. Straddles Gemma 4 31B's 128K native window. Past 128K, vanilla `longctx` must truncate.
- **Subsampling:** 30 instances per (task × length) via deterministic Fisher-Yates with seed 42.
- **Format conversion:** each BABILong instance becomes its own shard (`babilong-task<N>-instance<idx>`). Facts become `BenchEvent`s with `isCore: true`. The question + ground-truth string become a `FreeFormQuery`.
- **Fetch:** `npx tsx scripts/fetch-babilong.ts` downloads raw files from HF; falls back to manual-placement instructions when intermediate-length repos 404.
- **Run wrapper:** `npx tsx scripts/run-babilong-bench.ts` loops over (task × length) and calls `runBenchmark` per combo, materialising the in-memory result to `data/eval/corpus-babilong/task<N>-<label>/`.
- **License:** the original BABILong release; raw files are not redistributed in this repo.

## 7. Sweep matrix

The two corpora sweep slightly different axes by design.

**PaySwift sweep:**
- Corpus sizes: 100K, 1M, 10M, 100M, 1B tokens (5 log-spaced points). Filler currently reaches ~9M; tiers 4+ are planned to push past 100M when needed.
- Model contexts: 1K, 4K, 8K, 32K, 128K (5 log-spaced points).
- Trials: ≥3 per (corpus_size × model_context × system × query).
- **Adaptive early-stop:** if a `(system × model_context)` cell's aggregate accuracy at some corpus size drops below 50%, the runner skips all larger corpus sizes for that pair. The system has already failed; further data is uninformative.

**BABILong sweep:**
- Context length is baked into the task variant (each variant ships pre-padded to its target length).
- One corpus size per variant (sized to fit the instance's facts + filler).
- Model contexts: same 5-point sweep as PaySwift.
- Trials: ≥1 per (task × length × system × instance), with 30 instances per cell.
- No adaptive early-stop on BABILong because the haystack length IS the variable.

## 8. Statistical methodology

- **Bootstrap 95% CIs** on accuracy: 10,000 resamples per cell, seeded so the CIs are reproducible across replays.
- **Paired McNemar's exact test** for binary-accuracy comparisons between two systems on the same set of (query × trial) pairs. Reported alongside the raw accuracy delta. p-value is the two-tailed exact binomial probability on discordant pairs.
- **Benjamini-Hochberg FDR correction** when reporting many pairwise comparisons (e.g. CSM vs each of the other 3 baselines at each of 5 corpus sizes = 15 tests per metric — without correction, false-positive risk is real).
- **Citation P/R edge cases:**
  - empty cited + empty relevant → P=R=1 (vacuous agreement)
  - empty cited + non-empty relevant → P=R=0 (the system provided no support)
  - non-empty cited + empty relevant → P=0, R=1 (cited stuff that wasn't needed)
  - F1 is 0 when both P and R are 0 (avoids division-by-zero).

## 9. Output graphs

The plotter (`src/eval/plotter.ts`) emits Vega-Lite JSON specs. Render via [the online editor](https://vega.github.io/editor/) (paste-and-go) or programmatically via the `vega-lite` CLI.

- **Graph A — Effective Context Window:** accuracy vs corpus size, fixed model context (default: 8K). Headline plot for **Q1** and **Q2**. The crossing point with the 80% threshold line gives each system's effective-context ceiling.
- **Graph B — Physical Context Efficiency:** accuracy vs model context, fixed corpus size (default: 1M). Headline plot for **Q3**.
- **Graph C — Effective Context Multiplier:** horizontal bar chart, one bar per system. `multiplier = max_corpus_at_80%_accuracy / model_native_context`. The single-number summary.
- **Graph D — Operating Region Heatmap:** four panels (one per system); colour-coded accuracy across the (corpus size × model context) plane. Shows the *shape* of each system's useful region.
- **Graph E — Cost at Iso-Accuracy:** mean input tokens per LLM call vs corpus size, filtered to cells at ≥80% accuracy. Shows CSM's token-efficiency edge.
- **Graph F — Component Ablation at Scale** (CSM internals only, reserved for v0.3.0): like Graph A but lines are CSM-full, CSM-no-router, CSM-no-probe, CSM-no-synth-skip, CSM-no-scoped-recall.

## 10. Limitations + reproducibility

**Threats to validity, stated explicitly:**

1. **Single LLM family.** All bench numbers use Gemma 4. Generalisation to GPT-class or Claude-class models is not tested in v0.2.0; results may differ on other model families.
2. **Single PaySwift corpus.** Hand-authored, fintech-themed. BABILong neutralises the "your corpus only" objection, but PaySwift-specific numbers don't generalise to every narrative domain.
3. **MCQ format constrains the PaySwift test** to selectable answers. Free-form generation quality on PaySwift is not measured.
4. **BABILong tasks are short-answer.** Reasoning over long-form synthesis (chains-of-claims, conflict resolution) is not what BABILong measures.
5. **Distractor quality is human-curated.** The 10 / 15 / 14 / 1 distractor mix is enforced mechanically, but individual distractor quality varies. Queries with dense compound correct answers (q17 pricing, q19 Bun reversal, q23 burn impact) have weaker near-truth distractors per the authoring notes.
6. **Filler-tier expansion is templated**, not LLM-generated past tier-1. Diversity drops at higher filler tiers — uniform noise may be easier to filter than truly diverse content, which could artificially help retrieval-based systems.
7. **No CSM-internals ablation in v0.2.0.** Graph F is reserved for v0.3.0; for now the comparison is end-to-end CSM vs baselines, not piece-by-piece attribution within CSM.
8. **BABILong filler at intermediate context lengths may not exist on HF.** If the fetch script 404s for some lengths, those points are dropped from the plot rather than synthesised — manual placement is documented.

9. **Hosted Gemini confirmation is cross-model evidence, not the published Gemma headline.** The recommended Gemini run caps the physical model context at 160K tokens (about 15% of Gemini 3.5 Flash's 1,048,576-token input limit) and scales the CSM corpus past 2M tokens. Any Gemini-generated enrichment must be versioned as a separate corpus and cannot be silently mixed into the PaySwift evidence bundle.

**Reproducibility:** see [REPRODUCING.md](REPRODUCING.md) and [EVIDENCE.md](EVIDENCE.md). The cache-first design means `npm run bench:replay <runId>` regenerates summaries in under 5 minutes with zero LLM calls once result rows are present. The synthetic PaySwift corpus + decisions ledger + queries are versioned in-repo under `data/eval/corpus-synthetic/`, and the small canonical v0.2 result rows behind the public claims are committed under `data/eval/runs/`. Larger local response caches, embeddings, and sidecar indexes remain ignored. BABILong raw files are not redistributed (subject to the original dataset license); the fetch script pulls them from HF and caches locally.

Every result row carries: `system`, `corpusSize`, `modelContext`, `trial`, `queryId`, `queryKind`, the chosen answer (option or string), citations, scoring fields, token/latency telemetry, timestamp, and the raw cache hash. Nothing about the methodology requires re-running the LLM; the audit trail is end-to-end.
