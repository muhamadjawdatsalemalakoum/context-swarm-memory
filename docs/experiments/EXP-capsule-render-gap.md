# EXP — the free answer gate never showed the model CSM's evidence capsule

**Status:** defect found, fixed, and the affected conclusions listed. Re-measurement
pending (P1).

## What happened

`scripts/answer-arms.ts` replays two frozen arms and asks a model to answer from
each arm's retrieved documents. It rendered a document by resolving its id to text:

```ts
row.documents.map((d, i) => `[excerpt ${i+1}]\n${text.get(d.id) ?? `(id ${d.id} unavailable)`}`)
```

`text` is built from the corpus (`answer-arms.ts:loadDocText`) — event ids and raw
document ids. CSM also emits **synthesised** documents whose ids belong to no
corpus:

- `csm-evidence-capsule` — the deterministic chronicle, CSM's densest single document
- `csm-organized-memory` — the LLM-organized memory (synthesis / Observation levers)
- `csm-preference-profile` — the write-time preference profile

Those ids resolve to nothing. Worse, the text was never recoverable, because
`payloads.jsonl` persisted documents as ids and a length only:

```json
{"id": "csm-evidence-capsule", "contentChars": 7583}
```

So the gate emitted the literal string `(id csm-evidence-capsule unavailable)` in
place of CSM's best document, produced an answer from the remainder, and reported
a score. The hole was invisible precisely because the fallback looked deliberate.

## Blast radius, measured

Every arm on disk, counting synthesised documents and the characters they carried:

| arm | queries | `csm-*` docs | lost chars/query | total chars/query | % lost |
|---|---:|---:|---:|---:|---:|
| r1mA-base-v1 | 45 | 30 | 3,484 | 70,766 | 4.9% |
| r1mB-desc-v1 | 45 | 24 | 2,723 | 68,065 | 4.0% |
| r1mC-deschybrid-v1 | 45 | 21 | 2,326 | 61,495 | 3.8% |
| r1mD-allthree-v1 | 45 | 22 | 2,420 | 71,891 | 3.4% |
| r1mE-probefix-v1 | 45 | 24 | 2,769 | 78,424 | 3.5% |
| r1mF-units-v1 | 45 | 24 | 2,714 | 65,381 | 4.2% |
| r1mG-prefprofile-v1 | 40 | 54 | 4,073 | 68,230 | 6.0% |
| r1mH-preffold-v1 | 45 | 45 | 4,537 | 63,383 | 7.2% |
| r1mHR-audit-repro-v1 | 45 | 45 | 4,483 | 49,090 | 9.1% |
| r1mI-cleanvocab-v1 | 45 | 45 | 3,973 | 60,622 | 6.6% |
| gateA-off-v1 | 40 | 40 | 4,578 | 48,374 | 9.5% |
| gateB-on-v1 | 40 | 40 | 4,648 | 57,553 | 8.1% |

**414 synthesised documents** were rendered as the placeholder.

## It manufactured a published result

Arm G put the preference profile in its own document; arm H folded it into the
capsule. Neither was rendered — but they cost a different number of return slots:

| arm | `csm-evidence-capsule` | `csm-preference-profile` | unrenderable slots/query |
|---|---:|---:|---:|
| r1mG-prefprofile-v1 (40q) | 0.42 | 0.93 | **1.35** |
| r1mH-preffold-v1 (45q) | 0.49 | 0.51 | **1.00** |

`RETURN_K` is fixed, so arm H carried **~0.35 more real evidence documents per
query** than arm G for no reason other than the harness's inability to render one
of arm G's documents. That is the whole of the reported +0.068, and it was
published as *"folding a signal into the capsule beats appending it as a
document"* — a claimed property of BEAM's slot limit.

Note arm H lost **more** characters than arm G (4,537 vs 4,073) and still scored
higher. Under a working gate that combination should be surprising; under this one
it is exactly what a slot-count effect looks like.

## Conclusions this invalidates

- **"Fold, never append" / the displacement mechanism.** Retracted pending
  re-measurement. It may still be true — `RETURN_K` really is a hard cap — but
  this experiment did not show it.
- **Every capsule-resident lever.** `CSM_AMB_ORDERED_CAPSULE`,
  `CSM_AMB_OBSERVE_MEMORY`, `CSM_AMB_FACT_MEMORY`, `CSM_AMB_SYNTH_MEMORY`,
  `CSM_AMB_PREFERENCE_PROFILE` were measured as content no-ops. Only their slot
  cost was ever visible.
- **Arm scores A–I, including 0.8037 and "CSM numerically ahead of Hindsight at
  1M".** Measured on CSM-minus-capsule. Direction may survive; the numbers do not
  stand as reported.

## What is NOT affected

The **official** ladder. The real bridge hands AMB documents with real `content`,
and the official runs delivered 25.8 memories/query (median 25 — the full
`RETURN_K`). The published 0.7367 / 0.6589 / 0.5693 / 0.5616 carry no such loss.
This is a defect of the free iteration harness only.

## Fix

1. `scripts/run-beam-slice.ts` writes `<run>/synthesized-docs.jsonl` — one row per
   synthesised document, `{queryId, id, content}`. The principle: **persist exactly
   what cannot be reconstructed.** Real event text stays out of the run record
   because the corpus can supply it by id; synthesised text cannot come from
   anywhere else.
2. `scripts/answer-arms.ts` resolves ids through that file first, then the corpus,
   and **throws** on an unresolvable id naming the run, the query and the count.
   A rendering hole now aborts the arm instead of shrinking the context.
3. `renderExcerpts` extracted as a pure exported function; `tests/answerRender.test.ts`
   pins that a `csm-*` id with no supplied text raises rather than renders.
4. Entry-point guard added to `answer-arms.ts` — importing it used to run the whole
   answer stage and exit the process, which is why it had never been unit-tested.

## The lesson worth keeping

The instrument produced a number for every run, so nothing looked wrong. Both this
and audit F11 (a missing flag mistaken for noise) share a root: **a measurement
pipeline that degrades silently is more dangerous than one that fails**, because
its output is indistinguishable from a real result. The general fix is the same in
both cases — make the degraded path loud, and record enough provenance that a run
can be reconstructed from its own artifacts.
