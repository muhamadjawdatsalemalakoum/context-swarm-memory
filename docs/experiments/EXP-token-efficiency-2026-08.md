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

## Levers shipped (flags echoed in run manifests)

*(Correction 2026-09-05: this heading said "all default-off". `CSM_PROBE_BATCH` (L2b) has been default ON for hosted providers since 2026-08-01, and lean K=16 (L1) was flipped ON on 2026-08-01 and REVERTED on 2026-08-02 after a 500K information_extraction regression — see STATUS.md and `tests/env.test.ts`.)*

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
point.** *(It shipped 2026-08-01 and was reverted 2026-08-02: 500K lean-off won all three wider categories. Lean return is OFF; the projection below did not survive cross-tier measurement.)* On the slice that is ~11.3K answer-visible tokens vs ~15.2K; with the
official path's profile dedupe (−22.6%) on top, CSM's answer context lands
**below Hindsight's 17.9K**.

### L2a — router-confidence probe shrink *(committed a312217)*
`CSM_PROBE_SHRINK`: probe only candidates within 0.35 of top-1 (floor 4). Twice
guarded: hybrid-only, and only when the (now `select()`-routed) hybrid cut
DISCRIMINATED — shrinking on a degenerate ranking would replay the router bug
as a probe bug. Prior sizing: −13–18% pipeline input at 60% gating.

### L2b — batched probe *(committed 3f2850b)* — **VERDICT: PASS, ship candidate**
`CSM_PROBE_BATCH`: shards 2..N in one call; top-1 stays solo so the speculative
recall still overlaps the probe barrier (~1.2s on 94% of 1M queries).
Reconciliation contract test-pinned (pad missing / drop hallucinated /
first-wins dupes / requested order / own-shard event-id hints). Object-wrapped
schema so `completeAndValidate`'s array-salvage branch is unreachable.

**Paired arm r1mJ-batchprobe-v1 vs control r1mI2-cleanvocab-v2** (same config,
fixed answer gate, judge v2, n=45, 1M split):

| | score (ALL) | answer-ctx tok | internal input | wall/query |
|---|---|---|---|---|
| I2 control | 0.8250 | ctxTok 7,143 | 8 probe calls | 45.5s |
| J batched | 0.8565 | ctxTok 6,999 | 2 probe calls | 45.6s |
| delta | **+0.0315, CI [−0.017,+0.093], MDE 0.079 → NOT an effect** (6W/3L/36T; knowledge_update 15/15 ties) | ≈unchanged | **−~2,090 tok/query scaffold (−21% of internal input, by construction)** | neutral |

- Probe **count** preserved at 8.00/query (reconciliation working); acceptance
  72.8→64.7% (batched prompt judges slightly stricter) but **recalls unchanged**
  (2.98→3.16) — the extra rejections fall on shards recall never read anyway.
- Internal saving is arithmetic, not telemetry: the sidecar's usage accounting
  is broken (~23 in-tok/query reported), but the scaffold dedup is structural —
  349 fixed tok × 8 calls → × 2 calls; digest text total unchanged. The staged
  Gemini ladder is where the measured number lands.
- Wall neutral as predicted (cost lever, not latency lever). The earlier "−12%
  wall" note was J-vs-arm-I cross-run variance: the I2 same-config repeat also
  ran 45s vs arm I's 51s.
- **Same-config repeat noise floor** (arm I v1 vs I2 v2, retrieval level):
  accept 5.87→5.82, recalls 3.09→2.98, ctxTok 7,008→7,143 — tight; the F11-class
  variance lives in the answer/judge stage, not retrieval.

## Still open

- **L3 — VERDICT: KILLED.** No setting satisfies both halves of the
  pre-registered rule. Three-point dose-response vs the same I2 control
  (n=45 @1M, fixed gate):

  | probes/query | score | delta | MDE | recalls | knowledge_update |
  |---:|---:|---:|---:|---:|---:|
  | 8 (control) | 0.8250 | — | — | 2.98 | 0.8667 |
  | 6 (arm L) | 0.7963 | −0.0287 | 0.114 | 2.84 | 0.7667 (0W/2L/13T) |
  | 4 (arm K) | 0.7537 | −0.0713 | 0.162 | 2.71 | 0.7500 (1W/3L/11T) |

  keep=6 saves only ~18% of internal input (probe stage is 72% of it, and 6/8
  calls is −25% of that) — **below the −30% token bar**. keep=4 clears the
  token bar (−36%) but sits at the bottom of a monotone decline with a
  mechanism visible in telemetry: fewer probes → fewer recalls → the
  latest-value witness that knowledge_update needs is the one being skipped.
  Every individual delta is below its MDE and is NOT an effect on its own; the
  kill rests on the ORDERING (three points monotone in dose, same per-category
  pattern at both doses), not on any single point.

  **L2b strictly dominates**: −21% internal input, +0.0315 (also below MDE),
  and it removes NO witness — all 8 shards are still judged, just in one call.
  The lesson generalises: *cheapen the question, don't drop the witness.*
  Cross-encoder pre-gating remains sound for reranking retrieved items (that
  is what `src/eval/rerank.ts` is spared for); it is not sound for deciding
  which memories get read at all.

- *(historical, superseded by the row above)* keep=4 was first WITHHELD despite
  a letter-of-the-rule pass, pending the keep=6 dose-response:
  Arm K vs I2, fixed gate, n=45 @1M: ALL −0.0713, CI [−0.184,+0.040], MDE
  0.162 → formally "not an effect" and tokens −36% (probes 8→4), so the
  pre-registered ship rule passes on paper. Withheld anyway (the conservative
  deviation): every category leans negative (IF −0.022 / KU −0.117 / PF
  −0.075), losses 12 vs wins 6, the point estimate matches the size of the
  CONFIRMED lean K=12 regression (−0.0759), and telemetry shows the mechanism
  — recalls 2.98→2.71, the cross-encoder occasionally skips a witness the LLM
  probe would have recalled. Playbook = the lean lever's dose-response: if
  keep=6 ≈ 0 while keep=4 ≈ −0.07, ship keep=6 (~−18% probe input); if keep=6
  also leans negative, L3 dies and L2b batching remains the probe-cost lever.
  Arm K run notes: first launch interrupted (process exit) left one
  NUL-corrupted line in each artifact file (Windows kill-mid-write) — cleaned
  before resume; a TaskStop'd relaunch left a ZOMBIE writer that ran to
  completion alongside the real resume → 87 rows/45 queries; deduped by
  pairing each payload row with its synth-doc set and byte-LENGTH-verifying
  every csm-* doc against the payload's declared contentChars (all 45 resolved
  as first-occurrence pairs, zero re-runs). Kill-by-PID, not TaskStop.
- **L2a — SHELVED, built and default-off.** It is the same *drop a witness*
  family L3 just falsified: it shrinks the probe set on a confident route.
  Its own prior sizing (−13–18% pipeline input) is below the −30% bar even in
  the best case, so a passing arm still would not clear the rule that killed
  L3. The guard (hybrid-only, discriminated-only) is genuinely stronger than
  L3's blind top-N cut, so this is shelved rather than killed — worth an arm
  only if a future capsule/fact lever makes the tail witnesses provably
  redundant.
- **Composition arm r1mM-shipstack-v1** (running): L2b batching + lean K=16
  together vs the same I2 control. Both passed individually and both are
  default-off; the repo's own scar tissue says compositions must be measured
  (a router bench predicting +0.24 assembled into −0.12). Defaults flip only
  on this arm's verdict.
- **L4** — write-time fact shift (the Hindsight/M-1 lesson; separate arc, now
  scoped as R1/R2/R3 in `EXP-relations-and-hops-2026-08.md`).

## Sidecar token accounting — fixed, with a caveat that outlives the fix

The agent-sdk sidecar reported **~23 input tokens/query** all campaign, which is
why every saving above is stated as arithmetic rather than measured. Cause:
Anthropic usage reports `input_tokens` as the **uncached** portion only; cached
prompt content is billed through `cache_read_input_tokens` /
`cache_creation_input_tokens`. The sidecar read the first field alone.

Measured after the fix on a trivial 8-word prompt:

```
inputTokens 8549 = uncached 2 + cacheRead 0 + cacheWrite 8547
```

**The caveat is the real finding:** those ~8.5K tokens are the Claude Code
harness's own system prompt, not CSM's. So the sidecar carries a large fixed
per-call overhead that has nothing to do with the memory system — sidecar
token totals are still NOT a measure of CSM's token cost, they are
CSM + harness. The breakdown now makes that overhead visible and subtractable
instead of invisible. Published token numbers must still come from the Gemini
path, which was always the rule; this just removes a number that looked
usable and was not.

Operational note: killing the sidecar with `pkill -f server.mjs` did NOT free
port 8787 on Windows — the replacement silently failed to bind with
`EADDRINUSE` and the OLD process kept serving, so the "restarted" server was
the pre-fix build. Kill by PID
(`Get-NetTCPConnection -LocalPort 8787 | Stop-Process -Id …`) and verify the
new behaviour in the response before trusting it. Same family as the
kill-by-PID lesson already recorded for ladder runs.

## Method notes carried forward

- Rendering levers are measured on **minted virtual arms** (frozen ids) — this
  removes probe nondeterminism from the comparison entirely and roughly halves
  the MDE; pipeline levers still need live paired arms.
- The lexical proxy over-penalises excerpts by construction
  (`textSupportsFacet` needs ≥50% of a facet's terms in ONE text); it is a
  pruner, never a verdict.
- Sidecar numbers are iteration-only; nothing here is publishable until the
  staged Gemini ladder runs (blocked on credits).
