# EXP — BEAM session spine, Stage 0 (decode validation)

**Status: PASS.** Free, offline, zero LLM calls. Validated on the local 100K
slice (`data/eval/corpus-beam-slice/100k/documents.json.gz`, 170 documents,
20 users, 90 sessions).

## Why this matters

The 10M tier is where CSM collapses (`multi_session_reasoning` 0.12), and the
cause is **candidate generation, not packing**. Telemetry from
`data/eval/runs/amb-beam-10m-official-v1/csm-token-telemetry.jsonl` (n=208):

- median `probe_count` = 1, median `recall_count` = 1
- 29 retrieved candidates against a document whose turn ids run to `1#turn-15083`
- the RETURN_K slice discards a mean of only ~2.5 events, and at 24% of 10M
  queries `retrieved <= 24` so the slice does nothing at all

At 10M each unit is ONE ~11.7M-token document, so shard-level routing is a
no-op: one document means one shard means one probe. No selection or packing
change can reach this. Breadth has to be recovered at candidate generation, by
giving CSM sub-document structure.

BEAM already serializes that structure in its own text. Stage 0 asks only:
**does it decode reliably?**

## What the corpus serializes

```
[March-15-2024 | Turn 0] User: ...text... ->-> 1,1
[Turn 1] Assistant: ...text...
```

- `->-> S,T` closes user turns. **S is the session number, T a running turn
  counter within that session.**
- A dated header `[Month-DD-YYYY | Turn N]` appears on the first document of
  each session.
- At 100K only, document ids also encode it (`1_s0_0` = user 1, session 0,
  doc 0) — which is what makes 100K a *labeled* set for validating a
  text-only parser that must stand alone at 10M.

## Results

| check | result |
|---|---|
| doc ids matching `N_sN_N` | 170/170 (100%) — ground truth available |
| docs carrying `->->` markers | 164/170 (96%) |
| **`firstSpine.S === sessionIndex + 1`** | **164/164 (100.0%)** |
| sessions with exactly one date | **90/90 (100.0%)** |
| sessions with no date | 0 |
| sessions with a single pure S value | 89/90 (98.9%) |
| total `[Turn n]` markers | 5,642 |

`T` is continuous across document splits — `1_s0_0` ends at `1,16` and
`1_s0_1` resumes at `1,17` — so turn order is recoverable across the split
boundaries that exist at 100K and are absent at 10M.

### The one exception

Session `20|s2` carries 24 markers at `S=3` (correct) and 2 strays at `S=4`.
Majority share 92.3%, so **majority-vote per session resolves it**. A parser
must not assume purity; take the modal S rather than the first.

## Falsification criteria (from the research plan) — both cleared

1. *Markers absent* — no: 96% of documents carry them, and S maps to session
   index at 100%.
2. *Dates inconsistent* — no: every session has exactly one date, so
   forward-fill is well defined.

## What Stage 0 does NOT establish

- It was validated at **100K**. The 10M slice is not on disk, so the parser is
  proven against labeled data but not yet *exercised* where it is needed.
  Fetching a 10M unit is the first step of Stage 1.
- It says nothing about whether virtual sharding actually raises retrieved
  coverage. That is Stage 1: does the union of top-k virtual chapters beat
  today's 29-candidate baseline?
- Retrieval coverage remains a **proxy**. Conversion to judge score is
  unproven and needs the paid answer+judge gate.

## Recommended parser shape

Build a pluggable `StructureExtractor` with a fallback chain so this is
"parse whatever structure the source serializes", not a BEAM special case:

1. `->-> S,T` markers (modal S per session, T for ordering)
2. document-id pattern (`N_sN_N`), where present
3. in-text dated header, forward-filled
4. insertion order

Then, when a shard exceeds ~200 events, synthesize child shards along session
boundaries so router/probe/recall stop being no-ops.
