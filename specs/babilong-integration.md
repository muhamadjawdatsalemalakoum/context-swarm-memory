# BABILong Integration — Second Corpus for External Comparability

**Status.** Draft, pending sign-off. Once accepted, this becomes the authoritative spec for the BABILong integration work in Phase C.

**Purpose.** Add a second, public, externally-published long-context benchmark alongside the bespoke PaySwift corpus so the headline numbers can be overlaid against published BABILong baselines. PaySwift continues to ship as the use-case-validity corpus (multi-shard narrative, decision reversals, citation precision); BABILong provides the "your corpus, your benchmark" reviewer rebuttal.

**Non-goal.** Replace PaySwift. Both corpora run in Phase C. PaySwift is canonical for CSM's claimed strengths (narrative project memory). BABILong is canonical for reviewer comparability against the published long-context literature.

**Estimated effort.** 1–2 working days, slotted into Phase C ahead of the primary run. The `BaselineRunner` interface and discriminated `Query` union already support the free-form path at the type level — this work finishes the wiring.

---

## Why BABILong (and not RULER / LongBench v2)

| Benchmark | Tests | Why we want it | Why we're not adding it now |
|---|---|---|---|
| **BABILong** (Kuratov et al.) | Scaled-context multi-hop QA over noisy haystacks (1K → 1M tokens) | Directly probes "effective context window of small-context models" — exactly CSM's pitch. Published Gemma/Llama/Mistral baselines at each context length give us a direct overlay axis. Free-form short-answer scoring is programmatic (exact-match after normalisation), no judge. | — |
| **RULER** (NVIDIA, 13 tasks, 128K+) | NIAH variants + tracking + aggregation | Strong external comparability; more task diversity than bAbI's 20 tasks. | Heavier integration: 13 tasks, more bespoke output formats. Better as a v0.3 follow-up. |
| **LongBench v2** (Tsinghua) | 503 multiple-choice, real-world long-context tasks (8K → 2M) | MCQ format aligns with PaySwift; closer to real-world tasks. | Heavy: full corpus is several GB; tasks are domain-mixed, not designed for scaling-axis evaluation. Wrong fit for the "effective context" claim. |

Verdict: BABILong first. RULER/LongBench v2 are noted as future work in the benchmark methodology doc but not in scope for v0.2.0.

---

## What BABILong is, minimal version

- Source: HuggingFace `RMT-team/babilong`, paper "BABILong: Testing the Limits of LLMs with Long Context Reasoning-in-a-Haystack" (Kuratov et al., 2024).
- Construction: each item is one of the 20 original bAbI tasks (Weston et al., 2015) where the supporting facts have been embedded into a "haystack" of unrelated text (PG-19 books) padded to a target context length.
- Format per item:
  - `input` — the haystack with bAbI facts inserted at random positions
  - `target` — short answer string (single word or short phrase, e.g. "kitchen", "yes", "no", "8")
  - `question` — the bAbI question text
  - `supporting_facts` — line indices in `input` where the answer-bearing facts live
  - `task` — task ID (`qa1`…`qa20`)
- Available context lengths: 0K (raw bAbI, no haystack), 1K, 2K, 4K, 8K, 16K, 32K, 64K, 128K, 256K, 512K, 1M tokens.

The published BABILong tables report accuracy of a model at each (task × context length). That is the table we want to overlay our four systems against.

---

## Task selection — recommendation: 4 tasks

The full 20 tasks × 5 context lengths × 4 systems × N trials would be expensive and overkill for a v0.2.0 release. Recommend running:

| Task | What it tests | Why included |
|---|---|---|
| **qa1** — single supporting fact | Find one fact in noise. | NIAH-equivalent baseline. If a system can't pass qa1 at a given length, it has no effective context there — this is our floor. |
| **qa2** — two supporting facts | Two-hop synthesis. | First real multi-hop probe. Directly maps to CSM's "synthesise across events" pitch. |
| **qa3** — three supporting facts | Three-hop synthesis. | Stress test of multi-hop. Published numbers show this is where small-context models break first. |
| **qa5** — three-argument relations | Relational reasoning ("X gave Y to Z"). | Different reasoning shape from qa1–3 (relational, not factoid retrieval). Catches systems that overfit to needle-finding. |

Skipped on purpose:
- qa4 (two-argument relations) — substantially overlaps qa5.
- qa6–qa20 — defer to a future expansion. Listed in the methodology doc as out-of-scope for v0.2.0.

**Open decision for user:** sign off on this 4-task set, or push for 3 (drop qa5 — keep qa1/qa2/qa3 only) or 5 (add qa10 "indefinite knowledge" — interesting because it maps to PaySwift's adversarial "no decision was made" category).

---

## Context-length selection — align with MODEL_CONTEXT_SWEEP

The Phase C `MODEL_CONTEXT_SWEEP` is `[1_024, 4_096, 8_192, 32_768, 131_072]` (`src/eval/corpus.ts:231`). BABILong publishes at `{1K, 2K, 4K, 8K, 16K, 32K, 64K, 128K, …}`. The natural overlap:

| MODEL_CONTEXT_SWEEP | BABILong split |
|---|---|
| 1,024 | 1K |
| 4,096 | 4K |
| 8,192 | 8K |
| 32,768 | 32K |
| 131,072 | 128K |

Exact match on all five points. No interpolation needed. Headline plot is `accuracy × context length` overlaid against published BABILong baselines at the same lengths.

---

## Integration with the existing pipeline

The codebase is partly pre-plumbed for this. Below is the current state and what each piece needs.

### Already done (type-level only)

- `src/eval/mcq.ts` — `FreeFormQuery` interface, `FreeFormAnswer` interface, `QueryZ` discriminated union, `FreeFormQueriesFileZ` on-disk schema, `formatFreeFormPrompt()` prompt builder, `validateQuery()` dispatching on `kind`, `isFreeFormQuery()` / `isMcqQuery()` type guards.
- `src/eval/baselines/types.ts` — `BaselineRunner` interface is already corpus-agnostic. No interface changes needed.

### To build

1. **Loader: `src/eval/corpus/babilong.ts`**
   - Reads a downloaded BABILong split (HuggingFace parquet or jsonl).
   - For each item, emits:
     - A `Corpus` worth of `BenchEvent[]` — the haystack chunked into pseudo-events. Chunk strategy: split haystack on sentence boundaries (period + space + capital), one event per sentence. `tokenCount` computed via the existing whitespace approximation. `isCore: true` iff the sentence is in `supporting_facts`; else `isCore: false`, `tier: 1` (treat as filler).
     - One `FreeFormQuery` referencing the supporting-fact event IDs as `relevantEventIds`. `correctAnswer = item.target`. `alternativeAnswers` populated from a small canonical-form map (e.g. "yes"/"Yes"/"YES" handled by normalisation; "kitchen"/"the kitchen" handled by alternatives).
     - Per-task, per-context-length output: `data/eval/corpus-babilong/<task>/<ctxLen>/events.jsonl` + `queries.json`.
   - Shard structure for BABILong is artificial — bAbI haystacks are flat. Pragma: group every 20 consecutive events into a synthesised shard `s-chunk-NNN`. This lets the router-based systems (CSM, hybrid RAG) work without special-casing. Document this as a known integration awkwardness in the methodology doc — BABILong's flat structure is a mismatch with CSM's shard-native model, but it's the cleanest mapping.

2. **Free-form scorer: extend `src/eval/scorer.ts`**
   - Add `scoreFreeFormAnswer(query: FreeFormQuery, answer: FreeFormAnswer): FreeFormScore`.
   - Exact-match after normalisation: strip whitespace + lowercase on both sides. Accept if `normalisedAnswer === normalised(correctAnswer)` OR `normalisedAnswer ∈ normalised(alternativeAnswers)`.
   - Citation P/R: same convention as MCQ (`tp / cited.size`, `tp / relevant.size`, vacuous-empty handled identically). No changes to the formula.
   - `FreeFormScore` shape mirrors `McqScore`: `{ correct, citationPrecision, citationRecall, citationF1 }`. Aggregation across query × trial is corpus-mode-agnostic so the existing aggregator works once the per-pair scoring branches by kind.

3. **Runner dispatch: extend `src/eval/runner.ts` (and the runner's wrapper for each baseline)**
   - On each query, dispatch on `query.kind`:
     - `mcq` → existing path (formatMcqPrompt → parseMcqOutput → scoreAnswer).
     - `free-form` → new path (formatFreeFormPrompt → parseFreeFormOutput → scoreFreeFormAnswer).
   - Baselines do NOT need per-kind logic in their retrieval code — they hand off prompt-building and parsing to the runner. Retrieval is identical in both modes (the corpus is `BenchEvent[]` either way).
   - **Free-form output parser** needs to be written (parallel to `parseMcqOutput`): regex for `^ANSWER:\s*(.+)$`, capture the rest of the line (trimmed), fall back to whole-output-if-no-prefix. Trim trailing punctuation. Cap at 64 chars to defend against runaway outputs.

4. **Long-context baseline — verify behaviour on free-form**
   - The long-context baseline (`src/eval/baselines/longContext.ts`) packs events as raw text into the prompt. For BABILong this should reconstruct the original haystack (up to `maxInputTokens`). Sanity check after wiring: at `ctxLen=1024` against `MODEL_CONTEXT_SWEEP[0]=1024`, long-context's accuracy should be in the ballpark of BABILong's published Gemma numbers at 1K. If off by >10pp absolute, investigate (likely chunking or token-counting drift between us and HuggingFace's tokenizer; document the gap).

5. **CLI surface — extend `csm bench run`**
   - Add `--corpus-set payswift,babilong` flag (default `payswift` for back-compat).
   - For BABILong runs, the `(task × context-length)` cross-product is the matrix axis instead of `(corpus-size × context-length)`. Document this divergence in `--help` text.
   - `csm bench replay` and `csm bench report` need no change — they consume `summary.json` which is corpus-agnostic.

6. **Smoke test — `tests/eval/babilong.smoke.test.ts`**
   - Load qa1 at 1K context, run 5 queries × 1 system (long-context) × 1 trial against MockProvider with canned responses. Assert events parse, queries validate, scorer returns a number.
   - Vitest, <5s, no real LLM.

7. **Documentation updates**
   - `docs/BENCHMARK_METHODOLOGY.md` — add a "BABILong" subsection: task list, context-length list, scoring (exact-match after normalisation), citation P/R definition, the shard-mapping pragma, threats to validity ("BABILong's haystack is generic PG-19 text; not domain-realistic — that's PaySwift's job").
   - `specs/benchmark-results.md` — when authored, headline table shows PaySwift and BABILong side-by-side at each context length, with published BABILong numbers as a reference column (cite paper + version).
   - `NOTICE` — add BABILong attribution (BSD-3 or Apache-2.0, verify before adding; see Open decisions).

---

## Data sourcing and license

- Pull: `huggingface-cli download RMT-team/babilong --include "data/<task>/<ctxLen>/*"` for the 4 tasks × 5 lengths above. ~50 MB total at 128K; ~5 MB at 1K.
- License: BABILong is published under Apache 2.0 per the repo's README at time of writing (2026-05 — verify at download time; if it's changed, escalate before shipping).
- Underlying bAbI is from Facebook AI Research under a BSD-3 license; we cite both.
- Cache + checked-in artefacts: download script lives in `scripts/fetch-babilong.ts` and is idempotent. Downloaded splits live under `data/eval/corpus-babilong/raw/` (gitignored). Our loader-produced `events.jsonl` + `queries.json` are checked in per task/length (small, deterministic).

**Open decision for user:** confirm we ship the downloaded BABILong splits as gitignored + the script to re-fetch them, vs. checking the splits into the repo directly (would add a few hundred MB; clean for reproducibility, heavy for clone size).

---

## What stays unchanged

- PaySwift corpus, MCQ format, distractor strategy, ground-truth labels — unaffected. PaySwift remains the primary use-case-validity benchmark.
- McNemar's test + bootstrap CIs + Benjamini-Hochberg — applied identically to BABILong's per-query correctness.
- `npm run bench:replay` — must replay BABILong runs from cache the same way it replays PaySwift runs. Cache keys are model+prompt+temperature+seed+num_predict, which doesn't care about the source corpus.

---

## Acceptance criteria

The BABILong integration is "done" when:

1. `scripts/fetch-babilong.ts` pulls the 4 chosen tasks × 5 context lengths and verifies checksums.
2. `src/eval/corpus/babilong.ts` converts each downloaded split into `data/eval/corpus-babilong/<task>/<ctxLen>/{events.jsonl,queries.json}` that loads via `loadCorpus(...)` without changes to the loader.
3. `src/eval/scorer.ts` exports `scoreFreeFormAnswer(query, answer)` with the same return shape (modulo `correct`) as `scoreAnswer`.
4. `src/eval/runner.ts` dispatches on `query.kind`. Existing PaySwift runs are byte-identical after the change (run a `bench:replay` against an existing tagged runId to verify).
5. `tests/eval/babilong.smoke.test.ts` passes against MockProvider, <5s.
6. `npm run bench:run -- --corpus-set babilong --task qa1 --ctx 1024` completes end-to-end against local Ollama on the 4090, ~5 min wall.
7. Long-context baseline at qa1/1K is within 10pp absolute of published BABILong-paper Gemma numbers at the same length (or a documented reason if not).
8. `docs/BENCHMARK_METHODOLOGY.md` documents the BABILong subsection.
9. `NOTICE` has BABILong + bAbI attribution.

---

## Open decisions (require maintainer sign-off before implementation starts)

1. **Task set.** Default: qa1, qa2, qa3, qa5 (4 tasks). Alternatives: 3 tasks (drop qa5) or 5 tasks (add qa10).
2. **Context-length set.** Default: align with `MODEL_CONTEXT_SWEEP` = {1K, 4K, 8K, 32K, 128K}. Alternative: cap at 32K if 128K runs balloon wall-clock past the 50-min budget for the full primary run.
3. **N trials for BABILong.** Default: 3, mirroring PaySwift. Alternative: 1 trial at 128K (the longest split) to save wall-clock; BABILong's published numbers are typically single-trial anyway.
4. **Cache-in-repo vs gitignored.** Default: raw splits gitignored, loader-produced events/queries checked in. Alternative: check in raw splits for max reproducibility (heavier clone).
5. **Citation P/R on BABILong.** Default: compute it (use `supporting_facts` → `relevantEventIds`). Alternative: omit it on BABILong because published BABILong baselines don't report citation P/R, so the overlay axis only goes through accuracy — citation is PaySwift-only.
6. **Plot strategy.** Default: one headline plot per corpus (PaySwift + BABILong), each `accuracy × context length`, with the BABILong plot showing published-paper baselines as a reference line. Alternative: one combined plot, four CSM lines (PaySwift, BABILong-qa1, BABILong-qa2, BABILong-qa3), risking a busy chart.

---

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| BABILong's published numbers were collected with a different tokenizer than Ollama's, so "1K context" isn't apples-to-apples | Document the tokenizer drift in methodology doc; verify the long-context baseline's input-token count at each split lands within 5% of the named context length; flag any larger drift in results |
| 4 tasks × 5 lengths × 4 systems × 3 trials ≈ 240 cells; 128K cells dominate wall-clock | Resumable runner via cache; allow `--ctx-max 32768` to cap the longest split if needed; pilot at 1K + 8K + 128K only and project the full sweep before committing |
| BABILong haystack chunking strategy biases retrieval (RAG chunk size != BABILong sentence) | Sweep RAG chunk size on a 5-query subset, same as PaySwift; document |
| Published BABILong baselines exclude RAG-style systems, so our "RAG on BABILong" numbers have no direct overlay | This is fine: long-context baseline IS the direct overlay; RAG/hybrid/CSM are the comparative axis we contribute |
| Loader produces a `Corpus` that fails `loadCorpus`'s "core ≤ target" invariant for tiny haystacks | At small context lengths (1K), supporting_facts may be ~80% of the haystack; treat all haystack sentences as `tier: 1` filler and only the supporting_facts as `isCore: true`; tokenCount is already correct |
| License drift on BABILong between now and ship date | Re-verify license at download time in the fetch script; if it's changed, fail loudly with a pointer to this spec |

---

## What this spec does NOT cover

- RULER, LongBench v2 — listed in methodology doc as "future work."
- BABILong qa6–qa20 — same.
- 0K split (raw bAbI without haystack) — not in scope; the point of this integration is the noisy-haystack scaling axis.
- BABILong's 256K/512K/1M splits — beyond `MODEL_CONTEXT_SWEEP`'s top end. Can be added later as a stretch sweep when we want to push past Gemma 4's 128K ceiling.
- Re-running the PaySwift Phase C results after this change. The runner change must preserve byte-identical PaySwift replay; that's a passing requirement in `npm run bench:replay`, not new work.
