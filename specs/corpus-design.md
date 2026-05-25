# Synthetic Corpus Design — PaySwift

**Purpose.** This document is the authoritative spec for the Phase B synthetic corpus. Event-generation subagents and MCQ-authoring subagents are prompted directly from it. The benchmark stands or falls on whether the corpus produces realistic "narrative project memory" — fictional but coherent decisions, debates, and reversals that exercise CSM's strengths.

**Output.** `data/eval/corpus-synthetic/events.jsonl` + `queries.json` + tiered filler. ~150 core events (~75K tokens) authored against this spec; filler tiers grow the corpus to the 1B-token ceiling for the scaling study.

---

## The company

**PaySwift** — a B2B payments-infrastructure startup. The product is an API + dashboard that lets vertical-SaaS companies (e.g. dental-practice software, gym CRMs, salon-booking apps) embed payments without becoming PCI-compliant themselves. Think "Stripe Connect but with stronger compliance scaffolding for regulated verticals."

- **Founded:** December 2025 (incorporation), Feb 2026 marks the start of the corpus timeline
- **Stage:** pre-launch; public beta target = April 30, 2026
- **Funding:** $4.2M seed, raised Q4 2025 from Mosaic Ventures + 4 angels
- **HQ:** Remote-first, three timezones (PST, EST, CET)

## The team (5 people)

| Person | Role | Background | Voice / quirks |
|---|---|---|---|
| **Alex Park** | Co-founder, CEO | Ex-Stripe PM, 6yr | Risk-averse on compliance, optimistic on go-to-market. Writes long Slack messages. |
| **Mei Chen** | Co-founder, CTO | Ex-Square Cash engineer, 8yr | Pushes for boring, well-trodden tech. Distrusts ORM magic. Prefers Postgres for everything. |
| **Devon Reyes** | Lead engineer (founding) | Ex-Plaid, 5yr | Loves microservices. Has been talked down from k8s twice. Owns auth. |
| **Sarah Kim** | Head of Product | Ex-Affirm PM, 4yr | Customer-obsessed. Pushes for shipping with 50% of intended scope. |
| **Jordan Liu** | DevOps / SRE | Ex-AWS, 7yr | Cost-conscious. Has strong opinions about observability. Owns CI/CD. |

The team also references three frequent external voices:
- **Marcus (Mosaic VC lead):** asks pointed questions about regulatory exposure at every board sync.
- **Nico (fractional general counsel):** lawyer; advises on PCI / state money-transmission licensing.
- **Riley (design contractor):** part-time, builds the dashboard UX.

## Timeline

**3 months, Feb 2026 → Apr 2026**, broken into 6 fortnight-sized phases:

- **P1 (Feb 1–14):** Architecture lock-in. Decisions about stack, monorepo vs polyrepo, language for core service, payment network integrations.
- **P2 (Feb 15–28):** Auth + KYC. Build vs buy decisions. First customer LOIs come in.
- **P3 (Mar 1–14):** Core API build-out. Webhook system. First integration partner (a dental-SaaS called "ChairSync") starts sandbox testing.
- **P4 (Mar 15–28):** Dashboard MVP. Compliance audit prep. **First incident** (test environment data leak; nothing prod). Pricing model debate kicks off.
- **P5 (Apr 1–14):** Compliance pass. PCI Level 4 self-attestation. State money-transmitter strategy. Pricing locked. Second integration partner ("FitFlow") onboards.
- **P6 (Apr 15–29):** Final hardening, **second incident** (sandbox webhook storm, postmortem), launch prep, all-hands retro.

Inside each phase, events are dated with realistic densities (~5–10 events/day on weekdays, less on weekends).

## Shard structure (8 shards)

CSM-native organisation. Every event belongs to exactly one shard. Distribution roughly 15–25 events per shard:

| Shard ID | Theme | Typical event types |
|---|---|---|
| `s-architecture` | Stack choices, service boundaries, data model | Design docs, ADRs, PR descriptions, tech-debt log |
| `s-product` | Feature scope, UX, dashboard, integration shape | PRDs, Figma reviews, scope-cut decisions |
| `s-people` | Hiring, role changes, team norms | Hiring debate notes, role docs, 1:1 summaries |
| `s-customers` | Pilot integrations, design partner feedback | Customer call notes, sandbox bug reports, LOIs |
| `s-compliance` | Regulatory, PCI, state licensing, legal | Counsel memos, audit checklist, license filings |
| `s-incidents` | Postmortems, near-misses | Postmortem docs, runbook updates, alert tuning |
| `s-finance` | Pricing, runway, vendor costs | Pricing-model debate notes, vendor bills, burn projections |
| `s-meta` | All-hands, retros, planning offsites | Retro notes, OKR drafts, founder syncs |

## Event format

Every event is a `BenchEvent` (matches `src/eval/corpus.ts:BenchEvent`):

```json
{
  "id": "e0042",
  "shardId": "s-architecture",
  "content": "<200-700 token block of realistic narrative — Slack post, design-doc excerpt, PR description, retro entry, etc.>",
  "tokenCount": 412,
  "isCore": true,
  "tier": 0,
  "timestamp": "2026-02-09T14:21:00-08:00",
  "tags": ["adr", "monorepo", "decision"]
}
```

- **IDs:** zero-padded sequential `e0001` … `e0150` for core. Filler uses `f<tier>-<n>` (e.g. `f1-04217`).
- **Content style:** mixed first-person Slack-ish ("FWIW I think we should…"), brief design docs, ADR snippets, PR descriptions. Avoid third-person narration; this is a project's *records*, not a story about it.
- **Voice:** events from a specific person should sound like that person per the table above.
- **Token count:** computed at authoring time via the same approximation as `estimateTokens` (chars/4). The runner trusts this; we recompute at QA time to catch drift.

## Decisions / facts (the answer well)

These are the load-bearing facts the MCQ queries will probe. ~50 distinct facts, distributed across shards. Some examples (full list authored alongside events):

- **D-001 (architecture):** "Use a Postgres-backed monolith for the core service; defer service split until ≥3 distinct read patterns emerge."
- **D-002 (architecture):** "Adopt Hono on Bun for the API layer." (later reversed → D-031 below)
- **D-003 (auth):** "Build auth in-house using Lucia; revisit at 1k MAU."
- **D-007 (kyc):** "Use Persona for KYC, not in-house; cost is acceptable for the verticals."
- **D-011 (people):** "Defer hiring the second SRE — Jordan covers solo through launch."
- **D-019 (pricing):** "Tiered % + monthly platform fee; no per-transaction fixed component."
- **D-023 (compliance):** "Pursue PCI Level 4 self-attestation only; outsource Level 1 work to processor."
- **D-031 (architecture, reversal):** "Drop Bun; switch to Node 22 LTS after the runtime crash in Mar 12 incident."
- **D-038 (customer):** "Decline FitFlow's request for custom card-on-file holds — out of scope for v1."
- **D-044 (incidents):** "After sandbox webhook storm, add deterministic retry budget capped at 5 attempts."
- … (~40 more, authored to fully populate the queries)

Each decision lives in 2–6 events: the proposal, debate, decision, sometimes a later revisit. Multi-shard decisions (e.g. D-031 involves architecture + incidents) span events in both shards.

## Query design (~30 MCQ queries)

Each query targets one or more decisions/facts above. Format per `src/eval/mcq.ts:McqQuery`:

```json
{
  "id": "q01",
  "question": "What did the team decide about hiring a second SRE before launch?",
  "options": ["<40 strings>"],
  "correctOption": 17,
  "relevantEventIds": ["e0048", "e0049", "e0103"],
  "category": "single-shard",
  "shardHints": ["s-people"]
}
```

### Distribution

- **60% single-shard (~18 queries):** answer lives entirely in one shard. Tests router precision.
- **30% multi-shard (~9 queries):** answer requires synthesising 2–3 shards. Tests CSM's strength.
- **10% adversarial (~3 queries):** correct option = "the team did not decide / no record" or similar; tests false-positive resistance.

### Distractor strategy per query (40 options total, randomised)

- **1 correct option** — the true decision/fact from the corpus.
- **10 near-truths** — variants that differ in 1 key detail (wrong vendor, wrong date, wrong threshold, wrong shard). Hardest distractors; require careful retrieval.
- **15 plausible alternatives** — different decisions that *could* have been made in this domain but weren't. Tests whether the system reasoned from the corpus vs the prior.
- **14 irrelevant-but-true claims** — facts that ARE in the corpus but don't answer THIS question. Tests whether the system retrieved the right events vs just any relevant-sounding ones.

Distractor authoring is itself programmatic where possible: irrelevant-but-true claims can be machine-sourced from other queries' correct answers; near-truths are written by hand per question; plausible alternatives are LLM-generated then human-curated for fairness.

## Filler tiers (scaling to 1B tokens)

Filler is non-answer-bearing background noise. **No filler event must contain any fact that could plausibly answer one of the 30 queries.** Verification step: after generating filler, run each query's keyword set against filler content and reject overlaps.

| Tier | Events | Tokens | Generation strategy |
|---|---|---|---|
| 1 | ~1K | ~500K | LLM-generated: 10 similar-but-different fictional fintech startups, each with ~100 events of their own internal traffic. Curated for distinctness. |
| 2 | ~10K | ~5M | 10× LLM-templating of tier 1 seeds with entity / date / number substitutions. |
| 3 | ~100K | ~50M | Programmatic templating: take each tier-2 event, fork into 10 surface variants (synonym swap, paraphrase, date shift). |
| 4 | ~1M | ~1B | 10× programmatic expansion of tier 3 — pure substitution, no new LLM calls. |

Tier 1 takes effort (LLM-generated, human-curated). Tiers 2–4 are cheap once tier 1 exists.

## License

The whole corpus is original work and ships under **CC0 / public domain dedication** (`data/eval/corpus-synthetic/LICENSE`). No GitHub-scraped data, no real PII, no characters that resemble real people beyond stock roles. Generated content gets a `NOTICE` line crediting the LLM model used for filler.

## Authoring workflow (next steps for the runner)

1. **Spec sign-off** (this document).
2. **Core authoring:** one subagent generates ~150 core events from this spec, batch of ~20–30 events per shard. I curate inline.
3. **Query authoring:** second subagent drafts 30 MCQ queries with `correctOption` + `relevantEventIds` set against the curated core. I curate.
4. **Distractor authoring:** third subagent (or me) generates 39 distractors per query per the mix above.
5. **Filler tier 1 generation:** fourth subagent generates ~1K events of "other fictional companies." I spot-check.
6. **Filler tiers 2–4 generation:** programmatic script (`scripts/expand-filler.ts`) does the bulk expansion. No LLM calls.
7. **Verification pass:** keyword-overlap check between core/queries and filler. Reject any contamination.
8. **Smoke test:** load corpus at 10K tokens, run the long-context baseline against a few queries with `MockProvider`, sanity-check that distractors aren't trivially eliminable.

## Acceptance criteria

The corpus is "Phase B done" when:

- ≥150 core events, distributed across ≥8 shards (≥10/shard).
- ≥30 MCQ queries with valid `correctOption` (1–40) and ≥1 `relevantEventId` each.
- Distractor verification: no query's correct option matches any of its 39 distractors verbatim.
- Filler tier 1 generated, contains no answer-bearing facts (keyword check passes).
- Filler tier 2–4 generators are written and tested at small scales (don't need to run to full 1B yet).
- `loadCorpus(data/eval/corpus-synthetic, { targetTokens: 100_000 })` returns a valid `Corpus`.
- A stub-baseline smoke run completes successfully against the corpus.
