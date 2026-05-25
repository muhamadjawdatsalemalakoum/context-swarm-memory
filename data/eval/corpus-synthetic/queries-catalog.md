# MCQ Query Catalog (30 questions)

Each entry below is the source-of-truth for one MCQ in `queries.json`. Distractor subagents read this catalog + the corpus + the decisions ledger to generate 39 distractors per question. Event IDs are resolved from `decision-events-map.json` (built by the indexer subagent).

**Distribution:** 18 single-shard, 9 multi-shard, 3 adversarial = 30. Locked per `specs/corpus-design.md`.

---

## SINGLE-SHARD (18)

### Q01 — Service architecture
- **Question:** What did the team decide about the service architecture for the core API at the start of the project?
- **Correct answer:** Postgres-backed monolith; service split deferred until at least 3 distinct read patterns emerge.
- **Decisions:** D-001
- **Category:** single-shard
- **Shard hint:** s-architecture

### Q02 — Initial API runtime
- **Question:** What runtime did the API layer initially adopt in February?
- **Correct answer:** Hono on Bun.
- **Decisions:** D-002
- **Category:** single-shard
- **Shard hint:** s-architecture

### Q03 — Repo structure
- **Question:** What repository structure did the team choose for the codebase?
- **Correct answer:** Monorepo using pnpm workspaces, with packages api, dashboard, sdk-js, sdk-python, infra.
- **Decisions:** D-004
- **Category:** single-shard
- **Shard hint:** s-architecture

### Q04 — Database choice
- **Question:** What database technology backs the core service?
- **Correct answer:** Postgres 17 running on AWS RDS Aurora Serverless v2.
- **Decisions:** D-006
- **Category:** single-shard
- **Shard hint:** s-architecture

### Q05 — Authentication approach
- **Question:** What did the team decide about the authentication system?
- **Correct answer:** Build it in-house using Lucia, with a plan to revisit at 1k MAU.
- **Decisions:** D-009
- **Category:** single-shard
- **Shard hint:** s-architecture

### Q06 — Database migration tool
- **Question:** What tool was chosen for managing database migrations?
- **Correct answer:** pgroll, for zero-downtime migrations.
- **Decisions:** D-022
- **Category:** single-shard
- **Shard hint:** s-architecture

### Q07 — Observability stack
- **Question:** What observability stack did the team adopt?
- **Correct answer:** Grafana Cloud (logs and metrics) plus Sentry for errors, decided over a self-hosted Prometheus stack.
- **Decisions:** D-034
- **Category:** single-shard
- **Shard hint:** s-architecture

### Q08 — PCI compliance level
- **Question:** What PCI compliance level is the team pursuing for launch?
- **Correct answer:** PCI Level 4 self-attestation, with Level 1 work outsourced to the processor (Adyen).
- **Decisions:** D-007
- **Category:** single-shard
- **Shard hint:** s-compliance

### Q09 — KYC vendor
- **Question:** How does the team handle Know-Your-Customer (KYC) verification?
- **Correct answer:** Outsourced to Persona at approximately $1.50 per verification (build vs. buy debate resolved in favour of buy).
- **Decisions:** D-010
- **Category:** single-shard
- **Shard hint:** s-compliance

### Q10 — State money-transmitter strategy
- **Question:** What is the team's strategy for state money-transmitter licensing in CA and NY?
- **Correct answer:** Register as agent of the processor (Adyen) for the first 6 months; revisit direct licensing once volume warrants it.
- **Decisions:** D-030
- **Category:** single-shard
- **Shard hint:** s-compliance

### Q11 — First LOI partner
- **Question:** Which integration partner from the dental-SaaS vertical signed the first LOI in February?
- **Correct answer:** ChairSync, a dental practice software with about 80 practices and ~$2K MRR potential.
- **Decisions:** D-011
- **Category:** single-shard
- **Shard hint:** s-customers

### Q12 — FitFlow custom-holds request
- **Question:** What did the team decide about FitFlow's request for custom card-on-file holds?
- **Correct answer:** Declined as out of scope for v1.
- **Decisions:** D-013
- **Category:** single-shard
- **Shard hint:** s-customers

### Q13 — Dashboard MVP cuts
- **Question:** Which features were cut from the Dashboard MVP scope?
- **Correct answer:** Analytics, custom reports, and multi-user support — kept in v1: payment list, customer list, refund flow, webhook log viewer.
- **Decisions:** D-016
- **Category:** single-shard
- **Shard hint:** s-product

### Q14 — Multi-currency timing
- **Question:** When did the team decide multi-currency support would ship?
- **Correct answer:** Pushed out of v1 to the Q3 backlog (despite a ChairSync request for it).
- **Decisions:** D-023
- **Category:** single-shard
- **Shard hint:** s-product

### Q15 — Second engineer (February)
- **Question:** What did the team decide in February about hiring a second engineer?
- **Correct answer:** Defer the hire until April; founders cover the workload through the architecture phase.
- **Decisions:** D-005
- **Category:** single-shard
- **Shard hint:** s-people

### Q16 — Second SRE (March)
- **Question:** When Devon proposed hiring a second SRE in late March, what was decided?
- **Correct answer:** Rejected; the original deferral (D-005) stood and Jordan covered solo through April.
- **Decisions:** D-029
- **Category:** single-shard
- **Shard hint:** s-people

### Q17 — Final pricing model
- **Question:** What is the final pricing model PaySwift launched with?
- **Correct answer:** Tiered take rate (0.5%, 0.4%, 0.3% by volume band) plus a $99/month platform fee. No per-transaction fixed fee. No revenue-share.
- **Decisions:** D-032
- **Category:** single-shard
- **Shard hint:** s-finance

### Q18 — Standup / all-hands cadence
- **Question:** What is the team's standup and all-hands cadence?
- **Correct answer:** Weekly all-hands every Wednesday at 10am PST; async standup via Slack thread; no daily sync meeting.
- **Decisions:** D-008
- **Category:** single-shard
- **Shard hint:** s-meta

---

## MULTI-SHARD (9)

### Q19 — Bun → Node 22 reversal
- **Question:** Why did the team switch the API runtime from Bun to Node 22 LTS in March?
- **Correct answer:** The Mar 12 Bun runtime crash under sustained load blocked sandbox testing for ~6 hours, which triggered the reversal of D-002. The 4-day-budgeted migration finished in 1.5 days under pressure.
- **Decisions:** D-018, D-019, D-002
- **Category:** multi-shard
- **Shard hints:** s-incidents, s-architecture

### Q20 — Post-leak Terraform mandate
- **Question:** What infrastructure mandate did the team adopt after the March 24 test-environment data leak?
- **Correct answer:** All infrastructure changes must go through Terraform; no console access to production after April 1. The leak's root cause was a manual policy override that bypassed Terraform.
- **Decisions:** D-024, D-025
- **Category:** multi-shard
- **Shard hints:** s-incidents, s-compliance

### Q21 — Post-leak detection control
- **Question:** What detection control was added after the March data leak to catch future S3 misconfigurations?
- **Correct answer:** Canary alerts on S3 bucket policy changes (Jordan implemented over 4 days).
- **Decisions:** D-024, D-026
- **Category:** multi-shard
- **Shard hints:** s-incidents, s-architecture

### Q22 — Post-storm webhook retry changes
- **Question:** What changes were made to the webhook retry policy after the April 18 sandbox webhook storm?
- **Correct answer:** Per-tenant retry budget capped at 5 per minute, plus a global circuit breaker at 1k/sec — amending the original 5-attempt-per-event policy from D-014.
- **Decisions:** D-038, D-039, D-014
- **Category:** multi-shard
- **Shard hints:** s-incidents, s-architecture

### Q23 — Data leak financial impact
- **Question:** What was the financial impact of the March data leak on April's burn?
- **Correct answer:** April burn came in at $98K, slightly over projection due to D-024 remediation costs; runway revised to 26 months.
- **Decisions:** D-024, D-044
- **Category:** multi-shard
- **Shard hints:** s-incidents, s-finance

### Q24 — Hiring deferral outcome
- **Question:** How did the decision to defer hiring affect the launch outcome and team health?
- **Correct answer:** The team shipped slightly more than 50% of intended scope (Sarah credited the deferral for forcing focus), but Jordan flagged burnout from solo SRE coverage; the team committed to hiring by July.
- **Decisions:** D-005, D-029, D-045
- **Category:** multi-shard
- **Shard hints:** s-people, s-meta

### Q25 — Pricing debate resolution
- **Question:** How was the March-April pricing-model debate resolved, and what tipped the decision?
- **Correct answer:** Sarah's tiered-percentage model (Proposal A) won. Alex initially leaned toward the ChairSync revenue-share (Proposal C) but agreed after Marcus's input at the board sync.
- **Decisions:** D-027, D-032
- **Category:** multi-shard
- **Shard hints:** s-finance, s-product

### Q26 — Storm-exposed design flaw
- **Question:** What flaw in the original webhook design did the April 18 storm expose?
- **Correct answer:** The original retry budget was per-event (capped at 5 attempts each) with no per-tenant cap and no global rate limit, which let one tenant's load test fan out into a cascade.
- **Decisions:** D-014, D-038
- **Category:** multi-shard
- **Shard hints:** s-architecture, s-incidents

### Q27 — Why early Bun was a mistake
- **Question:** In hindsight, why was the early adoption of Bun considered a mistake by the team?
- **Correct answer:** It caused a production-blocking runtime crash under sustained load (Mar 12), required an emergency 1.5-day Node 22 migration, and validated Mei's earlier reservations about the trade-off between novelty and operational stability.
- **Decisions:** D-002, D-018, D-019
- **Category:** multi-shard
- **Shard hints:** s-architecture, s-incidents

---

## ADVERSARIAL (3)

These have NO supporting events in the corpus — the correct answer is "no decision was made / not in the corpus." Tests false-positive resistance.

### Q28 — Kubernetes adoption (never proposed)
- **Question:** What did the team decide about adopting Kubernetes for orchestration?
- **Correct answer:** No decision was made — Kubernetes was never proposed in the corpus (the team chose a Postgres-backed monolith and never raised k8s).
- **Decisions:** (none — adversarial)
- **Category:** adversarial
- **Shard hints:** none

### Q29 — OAuth provider (never integrated)
- **Question:** Which third-party OAuth provider (Google / GitHub / Auth0) did the team integrate for end-user authentication?
- **Correct answer:** None — the team built authentication in-house using Lucia (D-009); no OAuth provider was integrated in the corpus timeline.
- **Decisions:** (none — adversarial)
- **Category:** adversarial
- **Shard hints:** none

### Q30 — IPO / public-company plans (out of scope)
- **Question:** What did the team decide about pursuing a Series A or going public during the corpus window?
- **Correct answer:** No such decision was made — the company is pre-launch on $4.2M seed funding and no Series A discussion appears; D-044 explicitly states "no fundraise needed pre-Series A."
- **Decisions:** (none — adversarial; reference D-044 only as evidence of absence)
- **Category:** adversarial
- **Shard hints:** none

---

## Resolution step (post-indexer)

When `decision-events-map.json` lands, run a small script (or do it manually) to populate `relevantEventIds` for each query:

- Single-shard / multi-shard: `relevantEventIds` = union of `eventIds` for the listed Decisions.
- Adversarial Q28/Q29: `relevantEventIds` = `[]` (no events ground them).
- Adversarial Q30: `relevantEventIds` = the events for D-044 (the closest "absence-of-decision" evidence).

Question IDs in `queries.json` will use `q01`–`q30` (lowercase, zero-padded).
