# PaySwift Decisions Ledger

The 50 load-bearing facts that the synthetic corpus must encode. Each decision is grounded by 2–4 events authored across the phase-parallel subagents. Query authoring later builds MCQ items against these decisions.

**Format per decision:**
- ID + one-line description
- Shard(s) — primary; secondary in parens if cross-shard
- Phase (P1–P6)
- Driver(s) and a one-sentence elaboration

---

## Phase 1 (Feb 1–14) — Architecture lock-in

- **D-001** — Use a Postgres-backed monolith for the core service; defer service split until ≥3 distinct read patterns emerge. _s-architecture, P1, Mei. Rejected microservices-first proposal from Devon._
- **D-002** — Adopt **Hono on Bun** for the API layer. _s-architecture, P1, Devon pushed; Mei reluctant. **Reversed in P3 (D-019).**_
- **D-003** — TypeScript everywhere, strict mode, NodeNext modules. No JS files in `src/`. _s-architecture, P1, Mei._
- **D-004** — **Monorepo** (pnpm workspaces) with packages: `api`, `dashboard`, `sdk-js`, `sdk-python`, `infra`. _s-architecture, P1, Devon pushed for polyrepo; lost after 2-day debate._
- **D-005** — Defer hiring 2nd engineer until April. Founders cover the workload through architecture phase. _s-people, P1, Alex + Mei aligned on conserving runway._
- **D-006** — Postgres 17 on AWS RDS Aurora Serverless v2. _s-architecture, P1, Mei pushed; Jordan accepted reluctantly (cost concern, ~$1200/mo expected)._
- **D-007** — Pursue **PCI Level 4 self-attestation** only; outsource Level 1 work to processor (Adyen). _s-compliance, P1, Nico's recommendation._
- **D-008** — Weekly all-hands Wed 10am PST. Async standup via Slack thread. **No daily sync meeting.** _s-meta, P1, Alex; Sarah pushed for daily, lost._
- **D-009** — Use **Lucia** for auth (build, not buy). Revisit at 1k MAU. _s-architecture, P1, Devon pushed._

## Phase 2 (Feb 15–28) — Auth + KYC + first LOIs

- **D-010** — Use **Persona** for KYC ($1.50/verification). Buy, not build. _s-compliance, P2, Sarah + Nico aligned._
- **D-011** — Sign LOI with **ChairSync** (dental SaaS, ~80 practices, ~$2K MRR potential). _s-customers, P2, Sarah closed Feb 19._
- **D-012** — Sign LOI with **FitFlow** (gym CRM, ~30 boutique gyms, ~$900 MRR potential). _s-customers, P2, Sarah closed Feb 24._
- **D-013** — Decline FitFlow's request for **custom card-on-file holds** — out of scope for v1. _s-product (s-customers), P2, Sarah communicated; saved scope._
- **D-014** — Webhook system v1: **HMAC-SHA256** signed payloads, **deterministic retry budget capped at 5 attempts**. _s-architecture, P2, Devon designed. **Amended in P6 (D-039)** after the storm._
- **D-015** — Burn rate Feb projected $87K/mo. **Runway 28 months** at current spend. _s-finance, P2, reviewed at Feb 18 board sync; Marcus comfortable._
- **D-016** — Dashboard MVP scope locked: payment list, customer list, refund flow, webhook log viewer. **Cut**: analytics, custom reports, multi-user. _s-product, P2, Sarah ruthless._

## Phase 3 (Mar 1–14) — Core build

- **D-017** — Webhook idempotency: **Stripe-compatible** `Idempotency-Key` header, 24h dedupe window. _s-architecture, P3, Devon._
- **D-018** — **Mar 12 — Bun runtime crash** under sustained load. Test-env. No data loss but blocked sandbox testing for ~6 hours. _s-incidents (s-architecture), P3, postmortem by Devon._
- **D-019** — **D-002 REVERSED** after D-018. Drop Bun. Switch to **Node 22 LTS**. Mei diplomatic. Devon owned migration over 4 days. _s-architecture (s-incidents), P3._
- **D-020** — ChairSync starts sandbox testing Mar 8. First bug Mar 9 (typo in error msg). Fixed Mar 10. _s-customers, P3._
- **D-021** — Begin **SOC 2 Type 1 prep** parallel with PCI. Aim audit-ready by August. _s-compliance, P3, Nico advised._
- **D-022** — Database migrations via **pgroll** (zero-downtime). Reviewed knex, drizzle-kit native. _s-architecture, P3, Mei's call._
- **D-023** — Don't ship multi-currency in v1. Push to Q3 backlog. _s-product, P3, Sarah trimmed despite ChairSync ask._

## Phase 4 (Mar 15–28) — Dashboard MVP + audit prep + pricing debate

- **D-024** — **Mar 24 — test-environment data leak.** Sandbox payment records (no real card data, but tokenised refs and partner IDs) exposed via misconfigured S3 bucket for ~14h. Discovered by Jordan during routine alert tuning. Root cause = manual policy override that bypassed Terraform. _s-incidents (s-compliance), P4, postmortem 3 days._
- **D-025** — Mandate after D-024: **ALL infra changes through Terraform**; no console access for production after Apr 1. _s-compliance (s-architecture), P4._
- **D-026** — Add **canary alerts on S3 bucket policy changes**. Jordan owned implementation; took 4 days. _s-incidents (s-architecture), P4._
- **D-027** — **Pricing model debate begins.** Three proposals: (a) % of TPV + monthly platform fee, (b) flat $0.05/transaction, (c) revenue-share with ChairSync. Sarah leans (a), Alex leans (c). _s-finance (s-product), P4._
- **D-028** — Dashboard MVP **shipped Mar 27** to ChairSync sandbox. First UX feedback: "webhook log viewer is unusable on mobile." Riley redesigned in 2 days. _s-product, P4._
- **D-029** — Devon proposes hiring **2nd SRE**; rejected. **D-005 stands**; Jordan covers solo through April. _s-people, P4._
- **D-030** — State money-transmitter strategy: register as **agent of processor** (Adyen) for first 6 months; revisit once volume warrants direct license in CA + NY. _s-compliance, P4, Nico advised._

## Phase 5 (Apr 1–14) — Compliance pass + pricing lock + 2nd pilot

- **D-031** — **PCI Level 4 self-attestation** submitted Apr 4. **Approved Apr 9.** _s-compliance, P5._
- **D-032** — **D-027 RESOLVED.** Pricing locked: **tiered % (0.5% / 0.4% / 0.3% by volume band) + $99/mo platform fee.** No per-transaction fixed component. No revenue-share. _s-finance (s-product), P5, Sarah's model won; Alex agreed after Marcus's input._
- **D-033** — FitFlow goes to sandbox **Apr 7**. First webhook integration test Apr 9 (worked first try). _s-customers, P5._
- **D-034** — Observability stack: **Grafana Cloud** (logs + metrics) + **Sentry** for errors. Decided over self-hosted Prometheus after Jordan estimated 1.5 SRE-weeks of setup. _s-architecture, P5, Jordan + Mei._
- **D-035** — Add **fraud-flag field** to webhook events as P0 ask from FitFlow during integration. 2-day turnaround. _s-product (s-customers), P5._
- **D-036** — Riley's contract **extended through May**. Was originally Mar 31 end date. _s-people, P5._
- **D-037** — Q2 OKRs: (1) GA launch, (2) 5 paying customers by end of June, (3) ≥99.5% sandbox uptime. _s-meta, P5._

## Phase 6 (Apr 15–29) — Hardening + 2nd incident + launch prep

- **D-038** — **Apr 18 — sandbox webhook storm.** ChairSync's load test triggered our retry logic into a fan-out cascade. ~18,000 webhook calls in 4 minutes. Sandbox briefly OOM'd. No prod impact. _s-incidents (s-customers), P6._
- **D-039** — **D-014 AMENDED** after D-038. Per-tenant retry budget capped at **5/min**. **Global circuit breaker at 1k/sec.** _s-architecture (s-incidents), P6, Devon owned._
- **D-040** — Postmortem from D-038 surfaces lack of **synthetic load testing in CI**. Jordan added to Q2 backlog (post-launch). _s-incidents (s-meta), P6._
- **D-041** — Launch checklist locked Apr 22. **23 items.** Owners assigned. Daily standups Mon–Fri until Apr 29. _s-product (s-meta), P6._
- **D-042** — ChairSync agrees to be **launch-day reference customer.** Quote drafted with their CTO. _s-customers (s-product), P6._
- **D-043** — Final **security review by Nico Apr 24.** No blockers. One recommendation: rotate API tokens on **90-day cadence** post-launch. _s-compliance, P6._
- **D-044** — Q2 board update: **$98K April burn** (slightly over due to D-024 remediation), runway revised to **26 months**, no fundraise needed pre-Series A. _s-finance, P6._
- **D-045** — Final pre-launch retro Apr 26: top callout was "we shipped slightly more than 50% scope, which Sarah credits to D-005." Jordan flags burnout from solo SRE; commitment to hire by July. _s-meta (s-people), P6._
- **D-046** — **Decision NOT to run a load test on prod** before launch. Risk-accepted by founders given gradual pilot ramp. **Devon dissented; logged.** _s-architecture (s-meta), P6._
- **D-047** — Public docs site goes live Apr 28 (placeholder + API reference; full guides post-launch). _s-product, P6, Riley + Sarah._
- **D-048** — Public-launch announcement copy locked Apr 27. Alex final sign-off. Marcus reviewed. _s-meta (s-product), P6._
- **D-049** — Open the **second engineer req** post-launch. Defer specific person; plan to interview May. _s-people, P6._
- **D-050** — Add **OpenTelemetry spans on every API endpoint** as last-mile change before launch. Jordan implemented in one weekend. Mei reviewed. _s-architecture, P6._

---

## Shard distribution check

| Shard | Decisions |
|---|---|
| s-architecture | 14 |
| s-product | 6 |
| s-people | 5 |
| s-customers | 5 |
| s-compliance | 7 |
| s-incidents | 5 |
| s-finance | 4 |
| s-meta | 4 |
| **Total** | **50** |

Architecture-heavy is realistic for a payments-infrastructure startup. Phase subagents may add supporting events that increase counts in lighter shards.

## Phase distribution

| Phase | Decisions | Target events |
|---|---|---|
| P1 (Feb 1–14) | 9 | 22–27 (IDs e0001–e0027) |
| P2 (Feb 15–28) | 7 | 18–22 (IDs e0028–e0050) |
| P3 (Mar 1–14) | 7 | 18–22 (IDs e0051–e0075) — incident-heavy |
| P4 (Mar 15–28) | 7 | 22–28 (IDs e0076–e0103) — incident + dashboard ship |
| P5 (Apr 1–14) | 7 | 22–27 (IDs e0104–e0128) |
| P6 (Apr 15–29) | 13 | 28–35 (IDs e0129–e0163) — launch-heavy |
| **Total** | **50** | **130–161 events** |
