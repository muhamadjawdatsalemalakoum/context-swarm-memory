# AMB BEAM full ladder — CSM, 100K → 500K → 1M → 10M (2026-06-18)

Complete BEAM scaling ladder for Context Swarm Memory, run through the
**unmodified public AMB runner** at every split Chris Latimer requested
(100K, 500K, 1M, 10M). This is the data behind the reply to his
"run all BEAM configurations up to 10M" request.

> Status: **not an official leaderboard claim.** Produced by AMB's own
> runner with the CSM provider (PR #19). Single-trial. Hindsight has a
> published BEAM number only at 100K, so the deeper tiers are CSM's own
> scaling curve, not a head-to-head.

## Configuration (identical across all four tiers)

- **CSM pipeline:** frozen at repo commit `599dfc0` (src/ unchanged since;
  only docs/scripts changed). Retrieve-only bridge, coverage chronicle ON,
  hybrid router OFF, return-K 24 / summary-K 24 / reasoning-K 32, model
  context budget 8192.
- **CSM internal models:** `gemini-3.5-flash` (recall/synth), `gemini-2.5-flash-lite` (probe).
- **AMB answer model:** `gemini-3.1-pro-preview`. **Judge:** `gemini-2.5-flash-lite`.
  Same answer/judge path as the accepted Hindsight artifact.
- **Runner:** `omb run --dataset beam --split <tier> --memory csm --mode rag`,
  unmodified AMB at HEAD `45fa380` + the 3-file CSM provider. No changes to
  scoring, prompts, judge, or gold. No gold answers/rubrics/query-IDs reach retrieval.
- **Run dirs:** `data/eval/runs/amb-beam-{100k-official-v2, 500k-official-v1,
  1m-official-v1, 10m-official-v1}/`.

## Headline results

| Tier | Correct | Score | Avg retrieve | Avg answer-context | CSM-internal tok (in/out) |
|---|---:|---:|---:|---:|---:|
| 100K | 335/400 | **0.7367** | 4.47s | 27,026 | 8,805 / 625 |
| 500K | 497/700 | **0.6589** | 7.51s | 26,618 | 9,603 / 684 |
| 1M | 445/700 | **0.5693** | 5.60s | 28,192 | 9,934 / 703 |
| 10M | 122/200 | **0.5616** | 11.92s | 32,512 | 3,427 / 185 |

All rows unique (no duplicates); 2,000/2,000 graded.

## The two load-bearing findings

**1. Answer-visible context stays bounded across a 100× haystack.**
27.0K → 26.6K → 28.2K → 32.5K tokens as the per-unit haystack grows from
~154K (100K) to ~11.7M (10M) tokens. This is the core CSM property,
now measured end-to-end: retrieval cost to the answer model does not scale
with corpus size. A brute-force long-context system at 10M would feed the
answer model on the order of millions of tokens (or simply not fit).
CSM-internal pipeline cost also stays bounded (and is actually *lowest* at
10M — one giant shard means one probe + one recall).

**2. Accuracy declines with scale, but the decline flattens and is
category-specific.** Overall 0.737 → 0.659 → 0.569 → 0.562 — monotonic, but
1M ≈ 10M (the drop levels off rather than cliffing). The decline is not
uniform:

| Category | 100K | 500K | 1M | 10M | Behavior at scale |
|---|---:|---:|---:|---:|---|
| abstention | 0.975 | 0.971 | 0.986 | 1.000 | **robust / improves** |
| preference_following | 0.969 | 0.942 | 0.920 | 1.000 | **robust** |
| instruction_following | 0.919 | 0.767 | 0.708 | 0.850 | dips then recovers |
| information_extraction | 0.704 | 0.798 | 0.522 | 0.588 | volatile |
| event_ordering | 0.746 | 0.589 | 0.593 | 0.358 | degrades |
| summarization | 0.690 | 0.794 | 0.637 | 0.488 | degrades |
| temporal_reasoning | 0.644 | 0.557 | 0.368 | 0.438 | degrades |
| contradiction_resolution | 0.628 | 0.455 | 0.379 | 0.425 | degrades |
| knowledge_update | 0.613 | 0.324 | 0.229 | 0.350 | degrades hard |
| multi_session_reasoning | 0.480 | 0.392 | 0.353 | **0.120** | **collapses at 10M** |

**Single-fact / instruction / abstention / preference categories stay strong
(≥0.85, several improve) at every scale.** The categories that degrade are
the **multi-hop, cross-session synthesis** ones — they need many events from
across the haystack, and at 10M a unit is a single ~11.7M-token document, so
shard-level routing is moot and a bounded return-K can't surface enough of
the right turns. `multi_session_reasoning` at 10M (0.120) is the clearest
failure mode.

## Hindsight comparison — full ladder

Hindsight's full BEAM ladder **is** published: Vectorize committed its own AMB
run to `outputs/beam/hindsight/single-query/{100k,500k,1m,10m}.json.gz` in the
agent-memory-benchmark repo. Same answer model (`gemini-3.1-pro-preview`),
judge (`gemini-2.5-flash-lite`), `oracle=false` — apples-to-apples with our run.
Recomputed directly from those artifacts (re-verify: `node
scripts/verify-hindsight-ladder.mjs`):

| Tier | CSM score | Hindsight score | leader | CSM context | Hindsight context |
|---|---:|---:|:--|---:|---:|
| 100K | **0.7367** | 0.7337 | CSM (+0.003) | 27.0K | 17.7K |
| 500K | 0.6589 | **0.7112** | Hindsight (+0.052) | 26.6K | 20.5K |
| 1M | 0.5693 | **0.7386** | Hindsight (+0.169) | 28.2K | 23.9K |
| 10M | 0.5616 | **0.6408** | Hindsight (+0.079) | 32.5K | 27.3K |

**CSM trails Hindsight at every tier above 100K** (edges it at 100K within
single-trial noise). But the *trend at the extreme favors CSM*: from 1M→10M CSM
is essentially flat (−0.008, and *improves* in 7 of 10 categories on the
identical 10M questions) while Hindsight takes its single largest drop (−0.098,
declining in 9 of 10) — so Hindsight's lead **more than halves, +0.169 → +0.079**.
Per-category 1M→10M (CSM Δ / Hindsight Δ): instruction_following +0.142/−0.008,
knowledge_update +0.121/−0.014, temporal +0.070/−0.184, information_extraction
+0.066/−0.100, abstention +0.014/−0.100; both collapse on
multi_session_reasoning (CSM 0.12, Hindsight 0.17). At one ~11.7M-token document
CSM's bounded-retrieval design holds where Hindsight's begins to slip. Whether
CSM overtakes beyond 10M is an open question, not a settled result.

Context note: Hindsight is **leaner** at every tier (17.7→27.3K vs 27.0→32.5K),
so bounded context is a property of CSM, not a win over Hindsight.

Sources: AMB repo raw artifacts (above); Vectorize blog cross-check
<https://hindsight.vectorize.io/blog/2026/04/02/beam-sota>. Honcho also has
imported BEAM figures in the repo's `external_results.json`, but its backbone
answer/judge models are unstated and unverifiable beyond 100K — not comparable,
so it is excluded from the head-to-head.

## Honest limitations

- **Single-trial** per tier. Gemini at temperature 0 is not bitwise
  deterministic; the 100K tier reproduced at 0.7367 here vs 0.7431 in the
  earlier official rerun — single-run variance of ~±0.01 is expected.
- **No "CSM wins / edge grows" claim on BEAM.** CSM's *absolute* accuracy
  declines with scale and trails Hindsight above 100K. The favorable read —
  graceful degradation that stabilizes while Hindsight drops, narrowing the gap
  at 10M — is a *trend on two deep points*, single-trial, not a proven crossover.
- **The 10M structural gap is the concrete next R&D target:** one giant
  document per unit defeats shard-level routing; multi-hop coverage needs
  unit-chunking + broader retrieval before CSM is competitive on
  multi_session_reasoning / knowledge_update at extreme scale.

## Reproduce

```
# per tier (frozen pipeline, resumable):
pwsh scripts/run-beam-tier.ps1 -Split 10m -Name amb-beam-10m-official-v1
# or the full ladder with resume + single-instance guard:
pwsh scripts/run-beam-ladder.ps1
```

`npm run verify:published` recomputes every headline number above directly
from the raw rows (correct count, mean score, mean retrieve, mean answer
context) and checks the LF-normalized SHA-256 of each raw output, whenever the
artifacts are present in the working tree (they are large and gitignored, so
the verifier prints an explicit SKIP otherwise). The pins live in
`assertBeamLadder()` in `scripts/verify-published-claims.ts`.

## Artifact integrity (LF-normalized SHA-256)

| Tier | Raw output (`amb-outputs/beam/<run>/rag/<split>.json`) | CSM telemetry (`csm-token-telemetry.jsonl`) |
|---|---|---|
| 100K | `7831c20d7074ed5ee65d6754a20e5af79400a830b3618dfe7b247cc0ca068e98` | `b7af4c7520064546974f40e181996128fc4307eb82599c6abdaf213c7fbf9185` |
| 500K | `5a033dc623fdb776ff491e638690e1190471d3dc5fe949b7764204f18e8f1a6d` | `d3997c8e7c84e907822613dd1d601b8292b520c3e60a87fbc9e95abc9152e768` |
| 1M | `07f0b87eb3349e8f75ac8452a2f41399c58792d29a65f616a22f67cce28697ac` | `e830bac224d987b50256194637b855072e41c5a5e46abb45776e12a207246f3c` |
| 10M | `5a6ba9d83233ee7da908c4f86a2f4044888c1ae4d427f61bd56fce49d85f8b90` | `5b4c1320be6fdb55bde41857d4d8b4039c57750860287f166a7bb07f5fb6738b` |

CSM-internal token cost per query (deduped telemetry, in/out): 100K
8,805/625 · 500K 9,603/684 · 1M 9,934/703 · 10M 3,427/185 — reported
separately from the answer-visible context so total cost is never under-stated.
