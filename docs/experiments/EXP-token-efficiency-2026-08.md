# EXP — token efficiency campaign (2026-08)

**Goal.** CSM is the most token-expensive system on the BEAM ladder: ~36K all-in
tokens/query (README) vs Hindsight 18–27K, and M-1 — the current BEAM #1 —
~20% below the next best. This campaign attacks cost and speed **without
surrendering score**, with every lever A/B-gated. Identity constraint (user):
the swarm architecture — shards, router→probe→recall→synthesize, read-only
witnesses, Committer, deterministic capsule — is not up for change; what each
stage *costs* is.

## Baseline anatomy (official 1M telemetry, 700 rows; verified this campaign)

| bucket | tokens/query | note |
|---|---:|---|
| internal input | 9,934 | 97.9% of bridge wall time |
| — probe stage | ~7,300 (72%) | 8 probes × ~880–930 tok |
| — fixed scaffold ×8 | 2,792 (28.1%) | 349 tok paid per call for identical text |
| — recall | 2,100–4,500 | bimodal 1,200/3,200 digest (coverage intent), previously unrecorded |
| — synth | 1–2% | fires on 6.1% of queries; not a lever |
| answer-visible | ~28.2K | capsule 4.5%; raw turns 95.5% (24.9 × 4,819 chars) |

Structural findings behind the plan:

- **The payload pays twice**: 93.4% of capsule snippets appear *verbatim* inside
  the returned raw turns (event_ordering: 100%).
- **The payload pays a third time on the official path**: the same ~1.1K-char
  user-profile preamble is prefixed onto every returned turn — 22.6% of
  answer-visible chars. (The slice corpus carries no `context` field, so this
  redundancy exists only on the official artifact — recorded as a
  slice/official divergence.)
- **Hindsight's shape** (recovered from cached head-to-head prompts, 273 rows):
  136 memories/query × 572 chars, 90% distilled fact lines, 17.9K tokens. Same
  envelope as CSM, opposite economics.
- **Probe-depth data**: recalled shards span all 8 router ranks (top-4 covers
  only 40% of queries), so any FIXED probe cut loses recall by construction —
  reductions must be confidence-gated or mechanism-batched.

## Levers shipped (all default-off; flags echoed in run manifests)

### L0 — free wins *(committed 74dcd07)*
Synth JSON indent dropped (~10–15% of synth payload); `CSM_PROBE_INDEX_CHARS`
knob (was hardcoded 1200); probe `maxOutputTokens` 2048→512 (no cache existed to
be compatible with); `recallTokensPerShard` + `coverageEscalated` telemetry
(the invisible 2.7× recall-budget swing is now recorded).

### L1 — lean return payload *(committed cc9ade7, verdicts 3f2850b)*
`buildLeanDocs` — rendering-only, selection untouched, byte-identical when off:
`CSM_AMB_LEAN_K` / `CSM_AMB_LEAN_EXCERPT_CHARS` / `CSM_AMB_LEAN_PROFILE_DEDUPE`.

Token-free sweep (render/score split on the answer-arms firewall pattern;
scored over rendered TEXT, capsule reconstructed into every config):

| config | Δcov (proxy) | chars |
|---|---:|---:|
| dd-k16 | −3.0% | −32% |
| dd-k12 | −6.9% | −50% |
| dd-k8 | −14.6% | −68% |
| dd-ex360 | −20.9% | −88% |

**Paired answer-gate verdicts on minted virtual arms** (ids frozen from r1mI —
zero retrieval variance; this pairing alone cut the gate MDE to ~0.07–0.10):

| arm | payload | ALL Δ | CI95 | verdict |
|---|---:|---:|---|---|
| **dd-k16** | **−32%** | **−0.0009** | [−0.051, +0.050], 35/45 ties | **PASS** |
| dd-k12 | −50% | −0.0759 | [−0.152, −0.015], instr_following 0W/5L | FAIL |

Clean dose-response; the proxy predicted the ordering. **K=16 is the shipping
point.** On the slice that is ~11.3K answer-visible tokens vs ~15.2K; with the
official path's profile dedupe (−22.6%) on top, CSM's answer context lands
**below Hindsight's 17.9K**.

### L2a — router-confidence probe shrink *(committed a312217)*
`CSM_PROBE_SHRINK`: probe only candidates within 0.35 of top-1 (floor 4). Twice
guarded: hybrid-only, and only when the (now `select()`-routed) hybrid cut
DISCRIMINATED — shrinking on a degenerate ranking would replay the router bug
as a probe bug. Prior sizing: −13–18% pipeline input at 60% gating.

### L2b — batched probe *(committed 3f2850b)*
`CSM_PROBE_BATCH`: shards 2..N in one call; top-1 stays solo so the speculative
recall still overlaps the probe barrier (~1.2s on 94% of 1M queries).
Reconciliation contract test-pinned (pad missing / drop hallucinated /
first-wins dupes / requested order / own-shard event-id hints). Object-wrapped
schema so `completeAndValidate`'s array-salvage branch is unreachable.
Acceptance-rate shift (baseline 82%) is the arm's first check → r1mJ (running).

## Still open

- **L3** — local pre-gate A/B/C (cross-encoder may *skip* witnesses, never
  answer for them; `src/eval/rerank.ts` is spared from the baseline deletion).
  Pre-registered: B ships iff score ≥ −MDE and tokens −30%+; C is a ceiling
  diagnostic unless it wins outright, which goes back to the user with data.
- **L2a/L2b paired arms** (r1mJ first) — internal-token + acceptance-rate +
  answer-gate, reported as score + answer-ctx + internal + wall together.
- **L4** — write-time fact shift (the Hindsight/M-1 lesson; separate arc).

## Method notes carried forward

- Rendering levers are measured on **minted virtual arms** (frozen ids) — this
  removes probe nondeterminism from the comparison entirely and roughly halves
  the MDE; pipeline levers still need live paired arms.
- The lexical proxy over-penalises excerpts by construction
  (`textSupportsFacet` needs ≥50% of a facet's terms in ONE text); it is a
  pruner, never a verdict.
- Sidecar numbers are iteration-only; nothing here is publishable until the
  staged Gemini ladder runs (blocked on credits).
