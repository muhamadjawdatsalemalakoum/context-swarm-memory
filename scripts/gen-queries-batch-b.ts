#!/usr/bin/env tsx
/**
 * Generates the 40-option MCQ queries for batch B (q11-q20) of the PaySwift
 * benchmark. Each query has 1 correct option + 39 distractors (10 near-truth,
 * 15 plausible-alternative, 14 irrelevant-but-true) shuffled with a
 * deterministic seed derived from the query id.
 *
 * Run with:  npx tsx scripts/gen-queries-batch-b.ts
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  McqQueriesFileZ,
  validateMcqQuery,
  type McqQuery,
} from "../src/eval/mcq.js";

// ---- Deterministic shuffle (mulberry32 seeded by query id) -----------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = items.slice();
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

// ---- Per-query authoring data ---------------------------------------------

interface QuerySpec {
  id: string;
  question: string;
  correct: string;
  nearTruths: string[]; // exactly 10
  plausibleAlternatives: string[]; // exactly 15
  irrelevantButTrue: string[]; // exactly 14
  relevantEventIds: string[];
  category: "single-shard" | "multi-shard";
  shardHints: string[];
}

const SPECS: QuerySpec[] = [
  // ---------------------------------------------------------------- q11
  {
    id: "q11",
    question:
      "Which integration partner from the dental-SaaS vertical signed the first LOI in February?",
    correct:
      "ChairSync — a dental practice software with about 80 practices and ~$2K MRR potential.",
    nearTruths: [
      "ChairSync — a dental practice software with about 80 practices and ~$5K MRR potential, signed in February.",
      "ChairSync — a dental practice software with about 40 practices and ~$2K MRR potential, signed in February.",
      "ChairSync — a dental practice software with about 80 practices, signed in March instead of February.",
      "DentalDesk — a dental practice software with about 80 practices and ~$2K MRR potential, signed in February.",
      "ChairSync — a dental-equipment marketplace with about 80 vendors and ~$2K MRR potential, signed in February.",
      "ChairSync — a dental practice software with about 80 practices and ~$2K MRR potential, but the LOI was binding and exclusive.",
      "ChairSync — a dental practice software, signed an MSA (not an LOI) in February with ~$2K MRR potential.",
      "ChairSync — a dental practice software with about 80 practices, but it was technically the second LOI signed (FitFlow was first).",
      "ChairSync — a dental practice software with about 800 practices and ~$2K MRR potential, signed in February.",
      "ChairSync — a dental practice software with about 80 practices and ~$2K MRR potential, signed by Alex (not Sarah).",
    ],
    plausibleAlternatives: [
      "Toothly — a dental scheduling SaaS with ~120 practices and ~$3K MRR potential, signed in late February.",
      "Smileworks — a dental records platform with ~50 practices and ~$1.5K MRR potential, signed mid-February.",
      "PearlOps — a dental practice management suite with ~200 practices and ~$4K MRR potential, signed in February.",
      "EndoEHR — an endodontics-focused EHR with ~30 practices and ~$900 MRR potential, signed in February.",
      "DentaStream — a dental telehealth platform with ~60 practices and ~$2.5K MRR potential, signed in February.",
      "OrthoBoard — an orthodontics dashboard with ~75 practices and ~$2K MRR potential, signed in February.",
      "BiteRite — a dental imaging vendor with ~40 practices and ~$1.2K MRR potential, signed in February.",
      "PracticePilot — a multi-vertical clinic OS with dental as the lead vertical, signed in February.",
      "ClearCanal — a root-canal-specialist scheduling tool with ~25 practices, signed in February.",
      "PolishPro — a dental hygienist-focused billing tool with ~90 practices, signed in February.",
      "RootRouter — a referral platform between general dentists and specialists, signed in February.",
      "ChewSync — a chairside payment terminal with ~110 practices, signed in February.",
      "FlossOS — a dental SaaS with ~80 practices, signed an LOI but later withdrew it in March.",
      "ToothTrack — a dental analytics product with ~80 practices, signed an MSA directly without an LOI.",
      "ImplantIQ — a dental implant CRM with ~80 practices, signed in February with revenue-share terms.",
    ],
    irrelevantButTrue: [
      "FitFlow — a gym CRM with about 30 boutique gyms and ~$900 MRR potential.",
      "Persona — selected as the KYC vendor at approximately $1.50 per verification.",
      "Adyen — chosen as the payments processor and the entity to register as agent of for state money-transmitter purposes.",
      "Lucia — adopted as the in-house authentication library with a planned revisit at 1k MAU.",
      "pgroll — adopted as the database migration tool for zero-downtime migrations.",
      "Postgres 17 on AWS RDS Aurora Serverless v2 — the database backing the core service.",
      "Hono on Bun — the API runtime adopted in February (later reversed to Node 22 LTS).",
      "Grafana Cloud plus Sentry — the observability stack chosen over a self-hosted Prometheus setup.",
      "Riley — the design contractor whose contract was extended through May 31.",
      "Marcus — the Mosaic VC lead who consulted on the pricing-model lock at the Apr 3 sync.",
      "Nico — the fractional general counsel who recommended PCI Level 4 self-attestation only.",
      "ChairSync agreed to be the launch-day reference customer with a quote drafted with their CTO.",
      "Devon proposed hiring a second SRE in late March; the proposal was rejected.",
      "PCI Level 4 self-attestation was submitted Apr 4 and approved Apr 9.",
    ],
    relevantEventIds: ["e0031", "e0032"],
    category: "single-shard",
    shardHints: ["s-customers"],
  },

  // ---------------------------------------------------------------- q12
  {
    id: "q12",
    question:
      "What did the team decide about FitFlow's request for custom card-on-file holds?",
    correct: "Declined as out of scope for v1.",
    nearTruths: [
      "Declined as out of scope for v1, but committed to shipping it in v1.1 within 60 days.",
      "Accepted as a v1 feature because FitFlow threatened to walk away from the LOI.",
      "Declined as out of scope for v2.",
      "Declined for ChairSync but accepted for FitFlow as a paid custom integration.",
      "Accepted but only for the auto-reauth-on-card-change step (step 6 of FitFlow's flow).",
      "Declined as out of scope for v1, with a firm Q1 2027 commitment to revisit.",
      "Accepted for v1 because Devon estimated only 1 week of work.",
      "Declined as out of scope for v1, and the FitFlow LOI was lost as a result.",
      "Accepted but only steps 1 through 5; step 6 was scoped at 3-4 weeks and shipped in v1.",
      "Declined as out of scope for v1, with the decision made by Alex over Sarah's objection.",
    ],
    plausibleAlternatives: [
      "Accepted as a v1 feature, with a 4-week scoped engineering commitment under Devon.",
      "Accepted with a paid customization SOW worth $25K to offset the engineering cost.",
      "Accepted as a v1 feature but limited to FitFlow's top-10 gyms in a private beta.",
      "Built a generic auth-intent primitive in v1 that FitFlow could compose into their own holds flow.",
      "Punted the decision to a customer advisory board vote scheduled for April.",
      "Declined and pointed FitFlow to a third-party vendor (Stripe Issuing) for the holds use case.",
      "Accepted but contingent on FitFlow paying a $5K/month integration premium.",
      "Compromised on a 'manual holds' v1 feature where FitFlow staff confirmed each hold by hand.",
      "Accepted and made it a v1 feature but renamed it 'preauthorization tokens' to dodge regulatory scope.",
      "Declined the holds feature but accepted FitFlow's adjacent ask for partial-capture support.",
      "Built holds as a separate paid add-on at $99/month per gym on top of base pricing.",
      "Declined the v1 holds feature but committed Devon to a public RFC by end of Q2.",
      "Accepted but only for boutique-class subscriptions, not single-class drop-ins.",
      "Pushed the holds feature to a 'launch-week surprise' to be revealed Apr 30.",
      "Declined and used the moment to renegotiate FitFlow's MRR commitment upward.",
    ],
    irrelevantButTrue: [
      "Used Persona for KYC at approximately $1.50 per verification.",
      "Adopted a Postgres-backed monolith and deferred service split until at least 3 distinct read patterns emerge.",
      "Switched the API runtime from Bun to Node 22 LTS after the Mar 12 runtime crash.",
      "Pursued PCI Level 4 self-attestation, with Level 1 work outsourced to the processor (Adyen).",
      "Locked tiered take rates at 0.5/0.4/0.3 percent plus a $99/month platform fee, with no per-transaction fixed component.",
      "Mandated all infrastructure changes go through Terraform after the Mar 24 sandbox data leak.",
      "Adopted Lucia for authentication in-house, with a plan to revisit at 1k MAU.",
      "Locked the dashboard MVP to payment list, customer list, refund flow, and webhook log viewer; cut analytics, reports, and multi-user.",
      "Pushed multi-currency support out of v1 to the Q3 backlog despite a ChairSync request for it.",
      "Selected Grafana Cloud plus Sentry for observability over a self-hosted Prometheus stack.",
      "Devon proposed hiring a second SRE in late March; the proposal was rejected and the original deferral stood.",
      "Signed an LOI with ChairSync covering about 80 dental practices with ~$2K MRR potential.",
      "Riley's contract was extended through May 31 (originally set to end Mar 31).",
      "OpenTelemetry spans were added on every API endpoint as a last-mile change before launch.",
    ],
    relevantEventIds: ["e0039", "e0040", "e0041", "e0046"],
    category: "single-shard",
    shardHints: ["s-customers"],
  },

  // ---------------------------------------------------------------- q13
  {
    id: "q13",
    question: "Which features were cut from the Dashboard MVP scope?",
    correct:
      "Analytics, custom reports, and multi-user support — kept in v1: payment list, customer list, refund flow, and webhook log viewer.",
    nearTruths: [
      "Analytics, custom reports, and SSO support — kept in v1: payment list, customer list, refund flow, and webhook log viewer.",
      "Analytics, custom reports, and multi-user support — kept in v1: payment list, customer list, refund flow, and dispute viewer.",
      "Analytics, audit logs, and multi-user support — kept in v1: payment list, customer list, refund flow, and webhook log viewer.",
      "Custom reports and multi-user support — analytics was kept in v1 as a chart on the home page.",
      "Analytics and custom reports were cut; multi-user support was kept in v1 with a 5-seat cap.",
      "Analytics, custom reports, and multi-user support — kept in v1: payment list, customer list, dispute flow, and webhook log viewer.",
      "Analytics, custom reports, and multi-user support — but the cuts were partially reversed in P5 to add basic analytics.",
      "Refunds, analytics, and multi-user support — kept in v1: payment list, customer list, dispute flow, and webhook log viewer.",
      "Analytics, custom reports, and multi-user support — the decision was made by Alex (not Sarah) in March, not February.",
      "Analytics, custom reports, multi-user support, and webhook log viewer — kept in v1: payment list, customer list, and refund flow only.",
    ],
    plausibleAlternatives: [
      "Real-time charts, exportable CSV reports, and role-based access control were cut from v1.",
      "Bulk refund operations, scheduled report emails, and a developer-mode toggle were cut from v1.",
      "Saved searches, dashboard widgets, and multi-account switching were cut from v1.",
      "A reconciliation hub, in-product chat support, and configurable webhook templates were cut from v1.",
      "Mobile push notifications, an admin audit log, and SAML SSO were cut from v1.",
      "A fraud-rules editor, refund approvals workflow, and a sandbox simulator were cut from v1.",
      "Multi-currency reporting, dispute templates, and two-factor enforcement were cut from v1.",
      "A refund-reason taxonomy editor, customer tagging, and webhook replay were cut from v1.",
      "Inline dispute uploads, partial-refund presets, and a payouts ledger were cut from v1.",
      "A merchant-facing reports API, custom branding, and embedded help docs were cut from v1.",
      "Activity feeds, pinned filters, and an 'export to QuickBooks' integration were cut from v1.",
      "An in-app changelog, a payments map view, and per-team dashboards were cut from v1.",
      "Customer-lifetime-value charts, cohort views, and a webhook canary were cut from v1.",
      "A refunds approver hierarchy, expense categorization, and email digests were cut from v1.",
      "Dynamic dashboards, customizable navigation, and a 'switch tenant' picker were cut from v1.",
    ],
    irrelevantButTrue: [
      "FitFlow's request for custom card-on-file holds was declined as out of scope for v1.",
      "Multi-currency support was pushed to the Q3 backlog despite a ChairSync request for it.",
      "Postgres 17 on AWS RDS Aurora Serverless v2 was chosen as the database backing the core service.",
      "The team adopted Lucia for authentication in-house, with a planned revisit at 1k MAU.",
      "PCI Level 4 self-attestation was approved on Apr 9 after submission on Apr 4.",
      "The mobile webhook log viewer was redesigned by Riley over two days after a UX flag from ChairSync.",
      "ChairSync agreed to be the launch-day reference customer; quote drafted with their CTO.",
      "Pricing locked at tiered 0.5/0.4/0.3 percent plus a $99/month platform fee with no per-transaction fixed component.",
      "Devon proposed hiring a second SRE in late March; the proposal was rejected.",
      "The Apr 18 sandbox webhook storm produced ~18,000 webhook calls in 4 minutes during a ChairSync load test.",
      "All infrastructure changes were mandated to flow through Terraform after the Mar 24 data leak.",
      "Persona was chosen for KYC at approximately $1.50 per verification.",
      "The team committed to a 90-day API token rotation cadence post-launch per Nico's recommendation.",
      "OpenTelemetry spans were added on every API endpoint as a last-mile change before launch.",
    ],
    relevantEventIds: ["e0043", "e0044", "e0045", "e0077"],
    category: "single-shard",
    shardHints: ["s-product"],
  },

  // ---------------------------------------------------------------- q14
  {
    id: "q14",
    question: "When did the team decide multi-currency support would ship?",
    correct:
      "Pushed out of v1 to the Q3 backlog (despite a ChairSync request for it).",
    nearTruths: [
      "Pushed out of v1 to the Q4 backlog despite a ChairSync request for it.",
      "Pushed out of v1 to the Q2 backlog despite a ChairSync request for it.",
      "Shipped in v1 specifically for ChairSync's six Canadian practices, with USD as the default.",
      "Pushed out of v1 to the Q3 backlog because of a FitFlow request, not a ChairSync request.",
      "Pushed out of v1 to the Q3 backlog, with CAD-only support added quietly in v1.1 in May.",
      "Pushed out of v1 to the Q3 backlog, with a hard trigger of 100 Canadian practices to revisit.",
      "Locked into v1 as a partner-by-partner opt-in feature with CAD as the only added currency.",
      "Pushed out of v1 to 2027 entirely, given the FX and regulatory complexity flagged by Mei.",
      "Pushed out of v1 to the Q3 backlog by Alex over Sarah's objection.",
      "Pushed out of v1 to the Q3 backlog with a guaranteed CAD pilot for ChairSync's 6 Canadian practices in May.",
    ],
    plausibleAlternatives: [
      "Shipped in v1 with CAD and EUR support sourced from Adyen FX rates and a flat 1.2% conversion fee.",
      "Shipped in v1 with USD plus CAD support, EUR and GBP held for v1.2.",
      "Shipped in v1 as a beta feature gated behind a feature flag for ChairSync only.",
      "Shipped a 'multi-currency display' (presentment-only) in v1 with USD settlement.",
      "Built a third-party FX adapter using Wise's API to defer the settlement-currency build.",
      "Shipped a USD-only v1 but with a documented 'BYO FX' pattern for partners to handle their own conversions.",
      "Postponed multi-currency entirely to a planned v2.0 launch in 2027.",
      "Shipped in v1 specifically for the EU pilot of FitFlow with EUR support only.",
      "Built a placeholder webhook payload field for currency in v1, with non-USD settlement deferred.",
      "Built multi-currency support but disabled it at the API gateway pending a compliance review by Nico.",
      "Outsourced multi-currency to a partner (Airwallex) for the first 12 months post-launch.",
      "Shipped in v1 with a single non-USD pilot in Canada, gated behind a per-merchant approval.",
      "Built a 'currency conversion API' in v1 that converted on the fly without changing settlement.",
      "Made multi-currency a paid premium tier add-on at $199/mo per non-USD currency activated.",
      "Decided to revisit multi-currency at 100k cumulative transactions instead of by date.",
    ],
    irrelevantButTrue: [
      "Switched the API runtime from Bun to Node 22 LTS in March after the runtime crash.",
      "Pursued PCI Level 4 self-attestation only, with Level 1 work outsourced to Adyen.",
      "Adopted pgroll for zero-downtime database migrations.",
      "Selected Grafana Cloud and Sentry as the observability stack over self-hosted Prometheus.",
      "Set per-tenant retry budget at 5/min and a global circuit breaker at 1k/sec after the webhook storm.",
      "Defer hiring the second engineer until April; founders cover workload through architecture phase.",
      "Mandated all infrastructure changes through Terraform after the Mar 24 data leak.",
      "Signed an LOI with FitFlow for ~30 boutique gyms with ~$900 MRR potential.",
      "ChairSync agreed to be the launch-day reference customer with a quote drafted with their CTO.",
      "Added canary alerts on S3 bucket policy changes (Jordan implemented over ~4 days).",
      "Q2 OKRs locked: GA launch, 5 paying customers by end of June, ≥99.5% sandbox uptime.",
      "Public docs site went live Apr 28 with placeholder copy and an API reference.",
      "Async standup via Slack thread plus a weekly Wed 10am PST all-hands; no daily sync meeting.",
      "OpenTelemetry spans added on every API endpoint as a last-mile change before launch.",
    ],
    relevantEventIds: ["e0058", "e0059", "e0074"],
    category: "single-shard",
    shardHints: ["s-product"],
  },

  // ---------------------------------------------------------------- q15
  {
    id: "q15",
    question:
      "What did the team decide in February about hiring a second engineer?",
    correct:
      "Defer the hire until April; founders cover the workload through the architecture phase.",
    nearTruths: [
      "Defer the hire until May; founders cover the workload through the architecture phase.",
      "Defer the hire until June; founders cover the workload through the architecture phase.",
      "Defer the hire until April, but specifically for an SRE role rather than a software engineer.",
      "Hire immediately in February; the team agreed they could not absorb the architecture-phase workload alone.",
      "Defer the hire indefinitely; the founders committed to operating as a 5-person team through launch.",
      "Defer the hire until April; Devon, Sarah, and Riley cover the workload through the architecture phase.",
      "Defer the hire until April, with the explicit caveat that compliance bandwidth would be backfilled by Nico.",
      "Open the req in February but slow-walk it; the founders cover until a serendipitous candidate emerged.",
      "Defer the hire until March; founders cover the workload only through the first fortnight.",
      "Defer the hire until April; the workload would be covered by a contract engineer in the interim.",
    ],
    plausibleAlternatives: [
      "Hire a contract engineer in February at a $150/hr rate to cover the architecture-phase workload.",
      "Hire a senior engineer immediately and reduce founder cash compensation to offset the burn impact.",
      "Defer the hire until after PCI approval, regardless of calendar date.",
      "Outsource the second-engineer-equivalent workload to a development agency through April.",
      "Hire two junior engineers in February instead of one senior to spread the workload.",
      "Defer the hire until the team raised a Series A bridge round.",
      "Hire a fractional CTO-for-hire to mentor Devon and Mei through the architecture-phase workload.",
      "Hire a second engineer in February conditional on a $1K MRR design partner being signed first.",
      "Open the req in February with a public application form; hire whoever applied first at the bar.",
      "Hire a part-time engineer at 20 hours/week to ease the architecture-phase load.",
      "Promote Riley from contractor to full-time engineer to cover the gap.",
      "Defer the hire until the Q2 board sync and let Marcus weigh in on the timing.",
      "Hire from Devon's network at Plaid and skip the formal interview loop to compress timelines.",
      "Cap engineer headcount at 2 (Devon and Mei) until launch; absorb the work via longer hours.",
      "Hire an embedded engineer-in-residence from Mosaic Ventures' talent network as a stopgap.",
    ],
    irrelevantButTrue: [
      "Devon proposed hiring a second SRE in late March; the proposal was rejected and the original deferral stood.",
      "Riley's contract was extended through May 31 (originally Mar 31).",
      "The second engineer req was opened post-launch with a plan to interview in May.",
      "Adopted a Postgres-backed monolith with the service split deferred until ≥3 distinct read patterns emerge.",
      "Switched the API runtime from Bun to Node 22 LTS in March after the runtime crash.",
      "Pursued PCI Level 4 self-attestation only, with Level 1 work outsourced to Adyen.",
      "Selected Grafana Cloud plus Sentry for observability over self-hosted Prometheus.",
      "Locked pricing at tiered 0.5/0.4/0.3 percent plus a $99/mo platform fee.",
      "Signed an LOI with ChairSync covering ~80 dental practices with ~$2K MRR potential.",
      "Async standup via Slack thread plus a weekly Wed 10am PST all-hands; no daily sync meeting.",
      "Mandated all infrastructure changes through Terraform after the Mar 24 sandbox data leak.",
      "Pushed multi-currency support to the Q3 backlog despite a ChairSync request for it.",
      "Persona was chosen for KYC at approximately $1.50 per verification.",
      "Added OpenTelemetry spans on every API endpoint as a last-mile change before launch.",
    ],
    relevantEventIds: ["e0022", "e0023", "e0027", "e0083"],
    category: "single-shard",
    shardHints: ["s-people"],
  },

  // ---------------------------------------------------------------- q16
  {
    id: "q16",
    question:
      "When Devon proposed hiring a second SRE in late March, what was decided?",
    correct:
      "Rejected; the original deferral stood and Jordan covered solo through April.",
    nearTruths: [
      "Approved; the SRE was offered in early April with a target start date of May 1.",
      "Rejected; Jordan covered solo through May, not April.",
      "Approved conditional on the data-leak postmortem; the SRE start date was set for June.",
      "Rejected, but Devon was given hiring authority for an SRE post-launch.",
      "Rejected; Jordan was promoted to Head of Infrastructure with no additional headcount.",
      "Approved; the SRE was offered immediately and started Apr 15 to cover launch hardening.",
      "Rejected; Mei agreed to take on half of Jordan's on-call duties through April.",
      "Rejected by Mei over Alex's objection; the original deferral stood.",
      "Approved as a contract SRE through May, then converted to full-time after launch.",
      "Rejected; the original deferral stood and Devon (not Jordan) covered solo through April.",
    ],
    plausibleAlternatives: [
      "Approved; a senior SRE was hired at $235K loaded with an Apr 14 start date.",
      "Approved as an embedded SRE-in-residence loaned from Mosaic Ventures' talent network.",
      "Compromised on a part-time fractional SRE at 20 hours/week through launch.",
      "Approved with a 30-day probationary period and a contingency to reduce founder pay.",
      "Outsourced overnight on-call to a managed-SRE vendor (PagerOps) for $4K/month.",
      "Approved but delayed to allow Devon to write the JD and run the interview loop.",
      "Approved conditional on Marcus signing off on the burn-rate impact at the next board sync.",
      "Hired a second SRE specifically for compliance evidence collection during the PCI audit.",
      "Created a 'site reliability rotation' across all five engineers instead of hiring an SRE.",
      "Approved an SRE backfill from Jordan's old AWS team at $200K loaded.",
      "Rejected the SRE proposal but added a per-incident on-call bonus pool of $5K/quarter.",
      "Approved an SRE hire only if the team met the 5-paying-customer Q2 OKR by end of April.",
      "Rejected the SRE proposal in favor of a managed observability vendor that included on-call.",
      "Approved a junior SRE hire to shadow Jordan, with the headcount funded from the design budget.",
      "Approved the SRE hire as a six-month contract with a buyout clause if launch slipped.",
    ],
    irrelevantButTrue: [
      "Defer the second-engineer hire until April; founders cover the architecture-phase workload.",
      "Riley's contract was extended through May 31 (originally Mar 31).",
      "The second engineer req was opened post-launch with a plan to interview in May.",
      "Switched the API runtime from Bun to Node 22 LTS in March after the runtime crash.",
      "Mandated all infrastructure changes through Terraform after the Mar 24 sandbox data leak.",
      "Added canary alerts on S3 bucket policy changes (Jordan implemented over ~4 days).",
      "Locked pricing at tiered 0.5/0.4/0.3 percent plus a $99/mo platform fee.",
      "Pursued PCI Level 4 self-attestation, with Level 1 work outsourced to Adyen.",
      "Adopted a Postgres-backed monolith with service split deferred until ≥3 distinct read patterns.",
      "Selected Grafana Cloud plus Sentry for observability over self-hosted Prometheus.",
      "Q2 OKRs locked: GA launch, 5 paying customers by end of June, ≥99.5% sandbox uptime.",
      "Pushed multi-currency support to the Q3 backlog despite a ChairSync request for it.",
      "ChairSync agreed to be the launch-day reference customer with a quote drafted with their CTO.",
      "Per-tenant retry budget set at 5/min plus a global circuit breaker at 1k/sec after the webhook storm.",
    ],
    relevantEventIds: ["e0082", "e0083", "e0102", "e0103"],
    category: "single-shard",
    shardHints: ["s-people"],
  },

  // ---------------------------------------------------------------- q17
  {
    id: "q17",
    question: "What is the final pricing model PaySwift launched with?",
    correct:
      "Tiered take rate (0.5%, 0.4%, 0.3% by volume band) plus a $99/month platform fee. No per-transaction fixed fee. No revenue-share.",
    nearTruths: [
      "Tiered take rate (0.6%, 0.5%, 0.4% by volume band) plus a $99/month platform fee. No per-transaction fixed fee. No revenue-share.",
      "Tiered take rate (0.5%, 0.4%, 0.3% by volume band) plus a $149/month platform fee. No per-transaction fixed fee. No revenue-share.",
      "Tiered take rate (0.5%, 0.4%, 0.3% by volume band) plus a $99/month platform fee. A $0.05 per-transaction fixed fee was added. No revenue-share.",
      "Tiered take rate (0.5%, 0.4%, 0.3% by volume band) plus a $99/month platform fee, with a small revenue-share kicker on the top tier.",
      "Flat 0.4% take rate across all volume bands plus a $99/month platform fee. No per-transaction fixed fee. No revenue-share.",
      "Tiered take rate (0.5%, 0.4%, 0.3% by volume band) plus a $99/month platform fee. The bands are at $25K and $250K monthly TPV (not $50K and $500K).",
      "Tiered take rate (0.5%, 0.4%, 0.3% by volume band) plus an annual $1,200 platform fee billed yearly. No per-transaction fixed fee. No revenue-share.",
      "Tiered take rate (0.5%, 0.4%, 0.3% by volume band) plus a $99/month platform fee, locked in February (not April).",
      "Tiered take rate (0.5%, 0.4%, 0.3% by volume band) only. No platform fee. No per-transaction fixed fee. No revenue-share.",
      "Tiered take rate (0.5%, 0.4%, 0.3% by volume band) plus a $99/month platform fee. Includes a 5% revenue-share with ChairSync only.",
    ],
    plausibleAlternatives: [
      "Flat 1% of TPV across all volume bands with no monthly platform fee and no per-transaction fixed fee.",
      "Stripe-style 2.9% + $0.30 per transaction with no monthly platform fee.",
      "Pure revenue-share: 12% of integration partners' processing revenue with no upfront or monthly fee.",
      "Subscription-only: $499/month all-in per integration partner, with no per-transaction or percentage fee.",
      "Hybrid: 0.4% flat take rate plus $0.05 per transaction plus a $49/month platform fee.",
      "Volume-discounted flat percentage starting at 0.7% and dropping to 0.2% above $1M monthly TPV.",
      "Two-sided: 0.3% from the integration partner and 0.2% from the end merchant.",
      "Marketplace model: PaySwift takes 0.5% of TPV and remits the rest to a platform partner.",
      "Pay-as-you-grow: starts at $0/mo with a 0.7% take rate, dropping to 0.3% with a $499/mo subscription.",
      "Per-feature pricing: $99/mo base, plus $50/mo for webhooks, plus $30/mo for the dashboard.",
      "Token-bucket pricing: $99/mo for 1000 transactions, then $0.10 per transaction overage.",
      "Custom-quote pricing only: every integration partner negotiates a bespoke contract.",
      "Tiered annual subscriptions: $1,200, $4,800, $14,400 by partner volume band, no take rate.",
      "Pay-on-success: take rate scales with the partner's net revenue from PaySwift-enabled flows.",
      "Cost-plus: PaySwift charges Adyen passthrough plus a 25% margin uplift.",
    ],
    irrelevantButTrue: [
      "Selected Adyen as the payments processor and registered as agent of Adyen for state money-transmitter purposes for the first 6 months.",
      "Adopted a Postgres-backed monolith with service split deferred until ≥3 distinct read patterns emerge.",
      "Pursued PCI Level 4 self-attestation, with Level 1 work outsourced to Adyen.",
      "Selected Grafana Cloud plus Sentry for observability over a self-hosted Prometheus stack.",
      "Mandated all infrastructure changes through Terraform after the Mar 24 sandbox data leak.",
      "Switched the API runtime from Bun to Node 22 LTS in March after the runtime crash.",
      "Used Persona for KYC at approximately $1.50 per verification.",
      "Per-tenant retry budget set at 5/min plus a global circuit breaker at 1k/sec after the webhook storm.",
      "ChairSync agreed to be the launch-day reference customer with a quote drafted with their CTO.",
      "Pushed multi-currency support to the Q3 backlog despite a ChairSync request for it.",
      "Devon proposed hiring a second SRE in late March; the proposal was rejected.",
      "Adopted Lucia for in-house authentication, with a planned revisit at 1k MAU.",
      "Riley's contract was extended through May 31 (originally Mar 31).",
      "Async standup via Slack thread plus a weekly Wed 10am PST all-hands; no daily sync meeting.",
    ],
    relevantEventIds: ["e0106", "e0107", "e0110", "e0111", "e0125"],
    category: "single-shard",
    shardHints: ["s-finance"],
  },

  // ---------------------------------------------------------------- q18
  {
    id: "q18",
    question: "What is the team's standup and all-hands cadence?",
    correct:
      "Weekly all-hands every Wednesday at 10am PST; async standup via Slack thread; no daily sync meeting.",
    nearTruths: [
      "Weekly all-hands every Wednesday at 10am PST; daily synchronous standup via Zoom; async Slack thread for blockers.",
      "Weekly all-hands every Tuesday at 10am PST; async standup via Slack thread; no daily sync meeting.",
      "Weekly all-hands every Wednesday at 9am PST; async standup via Slack thread; no daily sync meeting.",
      "Bi-weekly all-hands every other Wednesday at 10am PST; async standup via Slack thread; no daily sync meeting.",
      "Weekly all-hands every Wednesday at 10am EST; async standup via Slack thread; no daily sync meeting.",
      "Weekly all-hands every Wednesday at 10am PST; async standup via Slack thread; daily sync meeting added during the launch sprint.",
      "Weekly all-hands every Wednesday at 10am PST; async standup via Notion; no daily sync meeting.",
      "Weekly all-hands every Friday at 10am PST; async standup via Slack thread; no daily sync meeting.",
      "Weekly all-hands every Wednesday at 10am PST; async standup via email digest; no daily sync meeting.",
      "Weekly all-hands every Wednesday at 10am PST; async standup via Slack thread; with a Monday-Friday daily standup added by Sarah's team only.",
    ],
    plausibleAlternatives: [
      "Daily 9am PST standup via Zoom with a 15-minute time box; no separate all-hands meeting.",
      "Three weekly syncs: Mon kickoff, Wed mid-week, Fri retro, all 30 minutes via Zoom.",
      "Twice-weekly all-hands (Tuesday and Thursday at 11am PST) plus async Slack standup.",
      "Async-only with no synchronous meetings of any kind; weekly written status reports replace standups.",
      "Daily standup at noon PST (chosen as the union-of-timezones overlap), no all-hands.",
      "Weekly all-hands plus paired 1:1s every other week between every founder and every report.",
      "Quarterly in-person offsites only; no recurring synchronous meetings.",
      "Daily standup in Slack Huddles with a 5-minute hard cap; no all-hands.",
      "All-hands every Monday at 8am PST plus a Friday demo session; no separate standup.",
      "Weekly all-hands plus a daily kanban-walk in Linear with no synchronous meeting.",
      "Daily 8:30am PST standup via Discord with a rotating facilitator.",
      "Weekly all-hands plus a 'design review' synchronous meeting every Tuesday afternoon.",
      "All meetings async-by-default; synchronous meetings require a one-page pre-read.",
      "Weekly all-hands every Wed at 10am PST plus on-demand 'office hours' from each founder.",
      "Standups twice weekly (Mon/Thu at 9am PST) plus a Friday retro; no all-hands meeting.",
    ],
    irrelevantButTrue: [
      "Adopted a Postgres-backed monolith with service split deferred until ≥3 distinct read patterns emerge.",
      "Pursued PCI Level 4 self-attestation, with Level 1 work outsourced to Adyen.",
      "Locked pricing at tiered 0.5/0.4/0.3 percent plus a $99/mo platform fee.",
      "Switched the API runtime from Bun to Node 22 LTS in March after the runtime crash.",
      "Used Persona for KYC at approximately $1.50 per verification.",
      "Mandated all infrastructure changes through Terraform after the Mar 24 sandbox data leak.",
      "Selected Grafana Cloud plus Sentry for observability over a self-hosted Prometheus stack.",
      "Defer hiring the second engineer until April; founders cover workload through architecture phase.",
      "Devon proposed hiring a second SRE in late March; the proposal was rejected.",
      "Q2 OKRs locked: GA launch, 5 paying customers by end of June, ≥99.5% sandbox uptime.",
      "Per-tenant retry budget set at 5/min plus a global circuit breaker at 1k/sec after the webhook storm.",
      "Riley's contract was extended through May 31 (originally Mar 31).",
      "ChairSync agreed to be the launch-day reference customer with a quote drafted with their CTO.",
      "Pushed multi-currency support to the Q3 backlog despite a ChairSync request for it.",
    ],
    relevantEventIds: ["e0001", "e0020", "e0021", "e0027"],
    category: "single-shard",
    shardHints: ["s-meta"],
  },

  // ---------------------------------------------------------------- q19 (multi-shard)
  {
    id: "q19",
    question:
      "Why did the team switch the API runtime from Bun to Node 22 LTS in March?",
    correct:
      "The Mar 12 Bun runtime crash under sustained load blocked sandbox testing for ~6 hours, which triggered the reversal of the earlier Bun decision. The migration was budgeted at 4 days but completed in 1.5 under pressure.",
    nearTruths: [
      "The Mar 12 Bun runtime crash under sustained load blocked sandbox testing for ~12 hours, which triggered the reversal of the earlier Bun decision. The migration was budgeted at 4 days and completed in 4.",
      "The Mar 12 Bun runtime crash under sustained load blocked production for ~6 hours, which triggered the reversal of the earlier Bun decision. The migration was budgeted at 4 days but completed in 1.5 under pressure.",
      "The Mar 19 Bun runtime crash under sustained load blocked sandbox testing for ~6 hours, which triggered the reversal of the earlier Bun decision. The migration was budgeted at 4 days but completed in 1.5 under pressure.",
      "The Mar 12 Bun memory exhaustion blocked sandbox testing for ~6 hours; the team migrated to Deno (not Node 22 LTS) over 1.5 days.",
      "The Mar 12 Bun runtime crash blocked sandbox testing for ~6 hours, but the migration was to Node 20 LTS (not Node 22 LTS), completed in 1.5 days.",
      "The Mar 12 Bun runtime crash blocked sandbox testing for ~6 hours, and Mei (not Devon) owned the migration in 1.5 days.",
      "The Mar 12 Bun runtime crash under sustained load blocked sandbox testing for ~6 hours; the migration was budgeted at 7 days but completed in 1.5 days under pressure.",
      "The Mar 12 Bun runtime crash blocked sandbox testing for ~6 hours, and the migration was triggered specifically by ChairSync threatening to walk away.",
      "The Mar 12 Bun runtime crash blocked sandbox testing for ~6 hours; the migration completed in 4 days as originally budgeted, with no compression.",
      "The Mar 12 Bun runtime crash blocked sandbox testing for ~6 hours; Hono was also dropped during the migration, replaced by Express.",
    ],
    plausibleAlternatives: [
      "The team migrated proactively after a benchmark showed Node 22 LTS handled their load shape 30% better; no incident triggered the move.",
      "Bun was dropped because of a licensing-policy concern raised by Nico during PCI audit prep; no runtime crash was involved.",
      "The team migrated to Node 22 LTS because hiring candidates kept asking about Bun and pushing back; the decision was recruiting-driven.",
      "Bun was dropped because of a CVE disclosed in early March affecting the JS engine; the migration to Node was a security patch.",
      "The team migrated to Cloudflare Workers (not Node 22 LTS) after the Bun crash, to gain edge deployment.",
      "Bun was dropped because Marcus expressed a strong preference for boring tech at the Q1 board sync.",
      "The team migrated to Deno after the Bun crash because Devon wanted a permissive permissions model.",
      "Bun was kept; the team added a process supervisor with memory-bounded restarts and absorbed the operational risk.",
      "The team migrated to Go (not Node 22 LTS) after the Bun crash, citing latency-tail concerns.",
      "Bun was dropped after FitFlow's engineering team flagged it as a non-starter for their compliance review.",
      "The team migrated to Node 22 LTS after a board mandate from Mosaic Ventures following a portfolio-wide Bun ban.",
      "Bun was kept for the API but replaced with Node for the webhook dispatcher only, as a partial mitigation.",
      "The team migrated to Bun 1.2 (a newer minor) instead of Node, on the grounds that the bug was already fixed upstream.",
      "Bun was dropped because of a sustained-load test in CI that caught the regression before any incident occurred.",
      "The team migrated to AWS Lambda (not Node 22 LTS) after the Bun crash to remove runtime ownership entirely.",
    ],
    irrelevantButTrue: [
      "The Mar 24 sandbox S3 data leak was caused by a manual policy override that bypassed Terraform; the bucket was public for ~14h.",
      "The Apr 18 sandbox webhook storm produced ~18,000 webhook calls in 4 minutes during a ChairSync load test.",
      "Pricing locked at tiered 0.5/0.4/0.3 percent plus a $99/mo platform fee, no per-transaction fixed fee, no revenue-share.",
      "PCI Level 4 self-attestation was submitted Apr 4 and approved Apr 9.",
      "Devon proposed hiring a second SRE in late March; the proposal was rejected and Jordan covered solo through April.",
      "Persona was selected as the KYC vendor at approximately $1.50 per verification.",
      "ChairSync agreed to be the launch-day reference customer with a quote drafted with their CTO.",
      "Mandated all infrastructure changes through Terraform after the Mar 24 sandbox data leak; no console writes after Apr 1.",
      "Selected Grafana Cloud plus Sentry for observability over a self-hosted Prometheus stack.",
      "Per-tenant retry budget set at 5/min plus a global circuit breaker at 1k/sec after the webhook storm.",
      "Riley's contract was extended through May 31 (originally Mar 31).",
      "Adopted a Postgres-backed monolith with service split deferred until ≥3 distinct read patterns.",
      "Async standup via Slack thread plus a weekly Wed 10am PST all-hands; no daily sync meeting.",
      "OpenTelemetry spans were added on every API endpoint as a last-mile change before launch.",
    ],
    relevantEventIds: [
      "e0063",
      "e0064",
      "e0065",
      "e0066",
      "e0067",
      "e0068",
      "e0069",
      "e0070",
      "e0071",
      "e0072",
    ],
    category: "multi-shard",
    shardHints: ["s-incidents", "s-architecture"],
  },

  // ---------------------------------------------------------------- q20 (multi-shard)
  {
    id: "q20",
    question:
      "What infrastructure mandate did the team adopt after the March 24 test-environment data leak?",
    correct:
      "All infrastructure changes must go through Terraform; no console access for production after April 1. The leak's root cause was a manual policy override that bypassed Terraform.",
    nearTruths: [
      "All infrastructure changes must go through Terraform; no console access for production after April 15. The leak's root cause was a manual policy override that bypassed Terraform.",
      "All infrastructure changes must go through Terraform; no console access for production after April 1. The leak's root cause was a Terraform module misconfiguration that the team applied as written.",
      "All infrastructure changes must go through Pulumi; no console access for production after April 1. The leak's root cause was a manual policy override that bypassed Pulumi.",
      "All infrastructure changes must go through Terraform; sandbox console access also became read-only after April 1.",
      "All infrastructure changes must go through Terraform; no console access for production after May 1. The leak's root cause was a manual policy override that bypassed Terraform.",
      "All infrastructure changes must go through Terraform; no console access for production after April 1. The leak's root cause was an IAM role propagation delay during the Bun-to-Node migration.",
      "All infrastructure changes must go through Terraform; no console access for production after April 1. The leak's root cause was a Lambda function that incorrectly granted public access.",
      "All infrastructure changes must go through Terraform; no console access for production after April 1. The leak exposed real cardholder data (in addition to tokenised refs).",
      "All infrastructure changes must go through Terraform; no console access for production after April 1. The leak was caused by an external attacker exploiting a misconfigured S3 bucket.",
      "All infrastructure changes must go through Terraform with a strict PR-review SLA; console writes remained allowed for sandbox-only after April 1.",
    ],
    plausibleAlternatives: [
      "The team mandated AWS Config Rules with auto-remediation as the enforcement layer, leaving console access intact.",
      "The team adopted a CI-gated 'permissions-boundary' on every IAM role to prevent over-permissive policies.",
      "The team migrated all infrastructure to AWS CDK and deprecated Terraform entirely after the leak.",
      "The team adopted Pulumi as the IaC tool for new infrastructure while keeping Terraform for legacy resources.",
      "The team mandated dual-control review (two engineers) on every infrastructure change with no IaC tool change.",
      "The team adopted a 'no S3 in sandbox' policy and routed all event payloads through Kinesis instead.",
      "The team purchased a third-party CSPM (Wiz) to continuously scan for misconfigurations; no IaC mandate.",
      "The team built an internal 'infra-as-code admission controller' on top of Open Policy Agent.",
      "The team adopted Crossplane and Kubernetes for infrastructure orchestration after the leak.",
      "The team mandated KMS encryption with customer-managed keys on every S3 bucket as the primary fix.",
      "The team rolled out a service mesh (Istio) and routed S3 access through it for centralized auditing.",
      "The team adopted SCPs (Service Control Policies) at the org level to forbid public S3 buckets entirely.",
      "The team migrated S3 to Cloudflare R2 with private-by-default access as the structural mitigation.",
      "The team built a custom 'least-privilege diff' tool that ran on every IAM PR.",
      "The team mandated quarterly infrastructure security audits by a third-party assessor as the response.",
    ],
    irrelevantButTrue: [
      "Switched the API runtime from Bun to Node 22 LTS in March after the Mar 12 runtime crash.",
      "The Apr 18 sandbox webhook storm produced ~18,000 webhook calls in 4 minutes during a ChairSync load test.",
      "Pricing locked at tiered 0.5/0.4/0.3 percent plus a $99/mo platform fee with no per-transaction fixed fee.",
      "PCI Level 4 self-attestation was submitted Apr 4 and approved Apr 9.",
      "Devon proposed hiring a second SRE in late March; the proposal was rejected and Jordan covered solo through April.",
      "Persona was selected as the KYC vendor at approximately $1.50 per verification.",
      "ChairSync agreed to be the launch-day reference customer with a quote drafted with their CTO.",
      "Selected Grafana Cloud plus Sentry for observability over a self-hosted Prometheus stack.",
      "Per-tenant retry budget set at 5/min plus a global circuit breaker at 1k/sec after the webhook storm.",
      "Riley's contract was extended through May 31 (originally Mar 31).",
      "Pushed multi-currency support to the Q3 backlog despite a ChairSync request for it.",
      "Adopted a Postgres-backed monolith with service split deferred until ≥3 distinct read patterns emerge.",
      "Async standup via Slack thread plus a weekly Wed 10am PST all-hands; no daily sync meeting.",
      "Q2 OKRs locked: GA launch, 5 paying customers by end of June, ≥99.5% sandbox uptime.",
    ],
    relevantEventIds: [
      "e0086",
      "e0087",
      "e0088",
      "e0089",
      "e0090",
      "e0091",
      "e0101",
      "e0103",
    ],
    category: "multi-shard",
    shardHints: ["s-incidents", "s-compliance"],
  },
];

// ---- Build queries with seeded shuffle ------------------------------------

function buildQuery(spec: QuerySpec): McqQuery {
  const allOptions = [
    spec.correct,
    ...spec.nearTruths,
    ...spec.plausibleAlternatives,
    ...spec.irrelevantButTrue,
  ];

  // Sanity: counts
  if (spec.nearTruths.length !== 10) {
    throw new Error(
      `${spec.id}: expected 10 near-truths, got ${spec.nearTruths.length}`
    );
  }
  if (spec.plausibleAlternatives.length !== 15) {
    throw new Error(
      `${spec.id}: expected 15 plausible alts, got ${spec.plausibleAlternatives.length}`
    );
  }
  if (spec.irrelevantButTrue.length !== 14) {
    throw new Error(
      `${spec.id}: expected 14 irrelevant-but-true, got ${spec.irrelevantButTrue.length}`
    );
  }
  if (allOptions.length !== 40) {
    throw new Error(
      `${spec.id}: expected 40 options, got ${allOptions.length}`
    );
  }

  // Sanity: dedupe check (case-insensitive trim)
  const seen = new Set<string>();
  for (const opt of allOptions) {
    const key = opt.trim().toLowerCase();
    if (seen.has(key)) {
      throw new Error(`${spec.id}: duplicate option detected: ${opt}`);
    }
    seen.add(key);
  }

  // Sanity: word-count window
  for (const opt of allOptions) {
    const words = opt.trim().split(/\s+/).length;
    if (words < 5 || words > 50) {
      throw new Error(
        `${spec.id}: option outside 5-50 words (got ${words}): ${opt}`
      );
    }
  }

  // Seeded shuffle.
  const seed = parseInt(spec.id.slice(1), 10) * 1000;
  const shuffled = shuffle(allOptions, seed);

  // Locate the correct option's new position (1-indexed).
  const correctIdx = shuffled.indexOf(spec.correct);
  if (correctIdx < 0) {
    throw new Error(`${spec.id}: correct answer disappeared after shuffle`);
  }
  const correctOption = correctIdx + 1;

  return {
    id: spec.id,
    question: spec.question,
    options: shuffled,
    correctOption,
    relevantEventIds: spec.relevantEventIds,
    category: spec.category,
    shardHints: spec.shardHints,
  };
}

async function main(): Promise<void> {
  const queries: McqQuery[] = SPECS.map(buildQuery);

  // Validate each query through the Zod schema + range check.
  for (const q of queries) {
    validateMcqQuery(q);
  }

  // Validate the file shape.
  const fileObj = { version: 1 as const, queries };
  McqQueriesFileZ.parse(fileObj);

  const outPath = resolve(
    process.cwd(),
    "data/eval/corpus-synthetic/queries-batch-b.json"
  );
  await writeFile(outPath, JSON.stringify(fileObj, null, 2) + "\n", "utf8");

  // Per-query report.
  for (const q of queries) {
    const optsLen = q.options.length;
    console.log(
      `${q.id}: ${optsLen} options, correctOption=${q.correctOption}, eventIds=${q.relevantEventIds.length}, category=${q.category}`
    );
  }
  console.log(`\nWrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
