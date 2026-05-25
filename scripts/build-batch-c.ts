#!/usr/bin/env tsx
/**
 * Build queries-batch-c.json — MCQ queries q21..q30 (10 entries).
 *
 * Each query has exactly 40 options, with deterministic shuffling seeded
 * from the query id, and `correctOption` (1-indexed) pointing at the
 * post-shuffle position of the correct answer.
 *
 * Distractor mixes:
 *   - q21..q27 (multi-shard): 1 correct + 10 near-truth + 15 plausible + 14 irrelevant
 *   - q28..q30 (adversarial): 1 correct + 25 plausible-affirmative (>=2 negatives)
 *                             + 14 irrelevant
 *
 * Run with:  npx tsx scripts/build-batch-c.ts
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface RawQuery {
  id: string;
  question: string;
  category: "multi-shard" | "adversarial";
  shardHints: string[];
  relevantEventIds: string[];
  correct: string;
  nearTruths: string[];
  plausible: string[];
  irrelevant: string[];
}

interface OutQuery {
  id: string;
  question: string;
  options: string[];
  correctOption: number;
  relevantEventIds: string[];
  category: "multi-shard" | "adversarial";
  shardHints: string[];
}

// ---------- deterministic RNG ----------
// FNV-1a hash → seed; Mulberry32 PRNG → uniform [0,1).

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

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

function shuffleWithSeed<T>(arr: T[], seed: number): T[] {
  const out = arr.slice();
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

// ---------- IRRELEVANT-BUT-TRUE pool ----------
// Verbatim-ish facts from the corpus's other decisions; query-specific picks
// avoid the decisions that are central to the current question.

const IRRELEVANT_POOL: Record<string, string> = {
  "D-001":
    "The team chose a Postgres-backed monolith for the core service, deferring any service split until at least three distinct read patterns emerge in production.",
  "D-003":
    "TypeScript with strict mode and NodeNext modules was made non-negotiable; no plain JavaScript files were permitted under the src directory.",
  "D-004":
    "The codebase was organised as a monorepo using pnpm workspaces, with packages api, dashboard, sdk-js, sdk-python, and infra.",
  "D-006":
    "Postgres 17 was selected and deployed on AWS RDS Aurora Serverless v2, with Jordan accepting the roughly $1,200-per-month cost reluctantly.",
  "D-007":
    "The team decided to pursue PCI Level 4 self-attestation only and outsource any Level 1 work to the processor, which is Adyen.",
  "D-008":
    "The team set a weekly all-hands every Wednesday at 10am PST plus async standup via a Slack thread, with no daily synchronous standup meeting.",
  "D-009":
    "Authentication was built in-house using Lucia, with a planned revisit only when the platform crosses one thousand monthly active users.",
  "D-010":
    "KYC verification was outsourced to Persona at roughly $1.50 per verification, with the build-versus-buy debate resolved in favour of buy.",
  "D-011":
    "ChairSync, a dental-practice software with about 80 practices and roughly $2K of MRR potential, signed the first integration LOI in February.",
  "D-012":
    "FitFlow, a gym CRM with about 30 boutique gyms and roughly $900 of MRR potential, signed the second integration LOI in late February.",
  "D-013":
    "FitFlow's request for custom card-on-file holds was declined as out of scope for v1, with Sarah communicating the decision back to FitFlow.",
  "D-015":
    "February burn was projected at $87K per month, giving the company a runway of roughly 28 months at that spend level, which Marcus signed off on.",
  "D-016":
    "The dashboard MVP scope was locked to payment list, customer list, refund flow, and webhook log viewer, cutting analytics, custom reports, and multi-user support.",
  "D-017":
    "Webhook idempotency was implemented using a Stripe-compatible Idempotency-Key header with a 24-hour deduplication window in the receiver layer.",
  "D-021":
    "SOC 2 Type 1 preparation began in parallel with the PCI work, with the team aiming to be audit-ready by August of the same year.",
  "D-022":
    "Database migrations were standardised on pgroll for zero-downtime changes, after a brief review of knex and drizzle-kit's native migration tooling.",
  "D-023":
    "Multi-currency support was deferred from v1 to the Q3 backlog, with Sarah trimming it despite an explicit request from ChairSync to include it.",
  "D-025":
    "After the March data leak, all infrastructure changes were mandated to go through Terraform, with no console access for production after April 1.",
  "D-027":
    "The pricing-model debate kicked off in March with three live proposals: percent of TPV plus a platform fee, flat per-transaction, and a revenue-share with ChairSync.",
  "D-028":
    "The dashboard MVP was shipped to ChairSync's sandbox on March 27, and the mobile webhook log viewer was redesigned by Riley in two days after feedback.",
  "D-030":
    "For state money-transmitter exposure, the team registered as an agent of the processor (Adyen) for the first six months, planning to revisit direct licensing later.",
  "D-031":
    "The PCI Level 4 self-attestation package was submitted on April 4 and the acquirer approved it on April 9, well ahead of the public-beta target.",
  "D-033":
    "FitFlow moved to the sandbox on April 7, and their first webhook integration test on April 9 worked on the first try with no remediation needed.",
  "D-034":
    "The observability stack was set as Grafana Cloud for logs and metrics plus Sentry for errors, decided over a self-hosted Prometheus stack on cost grounds.",
  "D-035":
    "A fraud-flag field was added to webhook events as a P0 ask from FitFlow during integration, with engineering completing the change in a two-day turnaround.",
  "D-036":
    "Riley's design contract was extended through May 31, having originally been scheduled to end on March 31 alongside the dashboard MVP delivery.",
  "D-037":
    "The team's Q2 OKRs were set as: ship a public GA launch, sign five paying customers by end of June, and maintain at least 99.5% sandbox uptime.",
  "D-040":
    "The April webhook-storm postmortem surfaced a lack of synthetic load testing in CI, and Jordan added that work to the Q2 backlog as a post-launch item.",
  "D-041":
    "The launch checklist was locked on April 22 with 23 items, owners assigned to each, and daily Monday-through-Friday standups scheduled until April 29.",
  "D-042":
    "ChairSync agreed to be the launch-day reference customer, and Sarah drafted the public quote with their CTO and routed it through Marcus for review.",
  "D-043":
    "Nico's final pre-launch security review on April 24 surfaced no blockers and recommended rotating API tokens on a 90-day cadence after launch.",
  "D-046":
    "The team explicitly decided not to run a load test against production before launch, with Devon dissenting in writing and the dissent logged in the ledger.",
  "D-047":
    "The public docs site went live on April 28 with a placeholder landing page plus the API reference; full integration guides were deferred to post-launch.",
  "D-048":
    "The public-launch announcement copy was locked on April 27, with Alex giving final sign-off and Marcus reviewing the language before publication.",
  "D-049":
    "The req for the second engineer was opened post-launch, with the specific person deferred and a plan to begin candidate interviews in May.",
  "D-050":
    "OpenTelemetry spans were added on every API endpoint as a last-mile change before launch, with Jordan implementing the work over a single weekend.",
  "D-014":
    "Webhook v1 used HMAC-SHA256 signed payloads with a per-tenant secret and a deterministic retry budget capped at five attempts using exponential backoff.",
  "D-005":
    "Hiring of the second engineer was deferred until April, with the founders planning to cover the engineering workload through the architecture phase.",
  "D-019":
    "After the March 12 Bun runtime crash, the team dropped Bun and migrated the API runtime to Node 22 LTS, with Devon owning the migration in 1.5 working days.",
  "D-020":
    "ChairSync started sandbox testing on March 8, with the first bug (a typo in an error message) surfacing on March 9 and being fixed by Devon on March 10.",
  "D-018":
    "On March 12, the Bun runtime crashed under sustained synthetic load in sandbox, blocking ChairSync's planned afternoon testing window for roughly six hours.",
  "D-002":
    "In February the team adopted Hono on Bun for the API layer at Devon's urging, with a P3 checkpoint clause that the choice would be reversed if it bit them.",
  "D-024":
    "On March 24 a sandbox S3 bucket holding tokenised payment events was found publicly readable for roughly 14 hours, with no real cardholder data or PII exposed.",
  "D-026":
    "Canary alerts on S3 bucket policy changes were implemented by Jordan over four days, using EventBridge plus Lambda to page within seconds of a public-grant policy edit.",
  "D-029":
    "Devon's late-March proposal to hire a second SRE was rejected; the original deferral stood and Jordan covered solo SRE through April under D-005's spirit.",
  "D-038":
    "On April 18 the sandbox webhook dispatcher emitted roughly 18,000 webhook calls in four minutes during a ChairSync load test, OOMing one pod for 90 seconds.",
  "D-032":
    "Pricing was locked as a tiered take rate of 0.5%, 0.4%, and 0.3% by volume band plus a $99-per-month platform fee, with no per-transaction fixed fee and no revenue-share.",
  "D-039":
    "After the April 18 storm, the per-event five-attempt retry policy was retained but a per-tenant 5-per-minute budget and a 1k-per-second global circuit breaker were added.",
  "D-044":
    "The Q2 board update reported $98K of April burn, slightly over projection due to D-024 remediation, with runway revised to 26 months and no fundraise needed pre-Series A.",
  "D-045":
    "The final pre-launch retro on April 26 credited scope discipline to the deferred-hire decision and recorded Jordan flagging burnout from solo SRE coverage.",
};

// Pick 14 irrelevant facts for a query, excluding decisions central to it.
function pickIrrelevant(excludeDecisions: string[]): string[] {
  const exclude = new Set(excludeDecisions);
  const candidates = Object.entries(IRRELEVANT_POOL)
    .filter(([k]) => !exclude.has(k))
    .map(([, v]) => v);
  if (candidates.length < 14) {
    throw new Error(
      `Not enough irrelevant facts: have ${candidates.length}, need 14`
    );
  }
  return candidates.slice(0, 14);
}

// ---------- Per-question content ----------

const queries: RawQuery[] = [
  // -------- q21 --------
  {
    id: "q21",
    question:
      "What detection control was added after the March data leak to catch future S3 misconfigurations?",
    category: "multi-shard",
    shardHints: ["s-incidents", "s-architecture"],
    relevantEventIds: [
      "e0086",
      "e0087",
      "e0088",
      "e0089",
      "e0092",
      "e0100",
      "e0103",
    ],
    correct:
      "Canary alerts on S3 bucket policy changes, implemented by Jordan over roughly four days using EventBridge plus a Lambda that pages on principal-asterisk grants or PublicAccessBlock weakening.",
    // 10 near-truths (one detail wrong each)
    nearTruths: [
      "Canary alerts on S3 bucket policy changes, implemented by Devon over roughly four days using EventBridge plus a Lambda that pages on principal-asterisk grants.",
      "Canary alerts on S3 bucket policy changes, implemented by Jordan over roughly two weeks using EventBridge plus a Lambda that pages on principal-asterisk grants.",
      "Canary alerts on IAM role changes, implemented by Jordan over roughly four days using EventBridge plus a Lambda that pages on overly-broad permission grants.",
      "Canary alerts on S3 bucket policy changes, implemented by Jordan over roughly four days using AWS Config exclusively, with no EventBridge or Lambda component.",
      "Canary alerts on S3 bucket policy changes, implemented by Mei over roughly four days using EventBridge plus a Lambda that pages on PublicAccessBlock weakening.",
      "Canary alerts on S3 bucket policy changes, implemented by Jordan over roughly four hours using EventBridge plus a Lambda, paging on principal-asterisk grants on read actions.",
      "Canary alerts on S3 bucket policy changes that auto-remediate the offending policy within seconds, implemented by Jordan over roughly four days as the v1 release.",
      "Canary alerts on S3 bucket policy changes, implemented by Jordan over roughly four days using GuardDuty findings as the primary trigger and EventBridge as backstop.",
      "Canary alerts on S3 bucket policy changes, implemented by Jordan over roughly four days, paging Slack only with no PagerDuty integration in the v1 release.",
      "Canary alerts on RDS parameter-group changes, implemented by Jordan over roughly four days using EventBridge plus a Lambda that pages on parameter weakening.",
    ],
    // 15 plausible alternatives — controls that *could* have been chosen
    plausible: [
      "Adoption of AWS Macie scanning across all sandbox and production buckets, with daily classification reports surfaced into a dedicated Slack channel.",
      "Quarterly external penetration testing of the S3 surface area by a third-party security firm, with findings tracked as P1 tickets in the engineering backlog.",
      "Mandatory use of pre-signed URLs for all sandbox payload reads, eliminating direct bucket-policy reliance for the partner-facing event archive.",
      "Migration of the sandbox event archive from S3 to a private VPC endpoint backed by EFS, removing public reachability as a possible failure mode.",
      "Replacement of S3 bucket policies with bucket ACLs and SCPs at the AWS Organization level, blocking public grants centrally rather than per-bucket.",
      "A weekly manual audit checklist run by Jordan covering bucket policies, IAM roles, and security groups, signed off in a shared compliance worksheet.",
      "Adoption of HashiCorp Sentinel policy-as-code in front of every Terraform apply, blocking any plan that would grant principal-asterisk on read actions.",
      "Deployment of a third-party CSPM tool (Wiz or Lacework) for continuous misconfiguration scanning, with findings routed to a daily digest email.",
      "A nightly diff job comparing Terraform state against live AWS state, with any drift opening an automatic GitHub issue assigned to the SRE on call.",
      "Mandatory two-person review on any pull request touching infra/s3-buckets module, with a CODEOWNERS rule enforcing dual sign-off in the repository.",
      "A dedicated security-only AWS account holding all sandbox payloads, accessed only via cross-account role assumption with one-hour session limits.",
      "Replacing S3 entirely with Cloudflare R2 for sandbox payloads, since R2's default-private model removes the public-bucket failure class outright.",
      "Adoption of OPA-based admission control on every CI pipeline targeting AWS, rejecting plans that include any newly-public storage resource.",
      "A bug-bounty program scoped to PaySwift's sandbox endpoints and storage, paying out for any researcher who finds a misconfigured bucket first.",
      "An hourly cron-driven CloudTrail scrape that emails the SRE channel a digest of any bucket-policy changes, with manual triage on each entry.",
    ],
    irrelevant: pickIrrelevant(["D-024", "D-026", "D-025"]),
  },

  // -------- q22 --------
  {
    id: "q22",
    question:
      "What changes were made to the webhook retry policy after the April 18 sandbox webhook storm?",
    category: "multi-shard",
    shardHints: ["s-incidents", "s-architecture"],
    relevantEventIds: [
      "e0131",
      "e0132",
      "e0133",
      "e0134",
      "e0135",
      "e0136",
      "e0138",
    ],
    correct:
      "The original 5-attempts-per-event budget was retained but amended with a per-tenant retry budget of 5 per minute and a global circuit breaker that opens when sustained outbound rate exceeds 1k per second for ten seconds.",
    nearTruths: [
      "The per-event 5-attempt budget was retained but a per-tenant retry budget of 50 per minute and a global circuit breaker at 10k per second were added on top.",
      "The per-event 5-attempt budget was retained but a per-tenant retry budget of 5 per second and a global circuit breaker at 1k per second were added on top.",
      "The per-event 5-attempt budget was reduced to 3 attempts and a per-tenant retry budget of 5 per minute plus a 1k-per-second global circuit breaker were added.",
      "The per-event budget was retained but a per-endpoint (not per-tenant) retry budget of 5 per minute plus a 1k-per-second global circuit breaker were added.",
      "The per-event 5-attempt budget was retained but a per-tenant retry budget of 5 per hour and a global circuit breaker at 1k per second were added on top.",
      "The per-event budget was retained but a per-tenant token bucket of 5 tokens per minute and a global circuit breaker at 100 per second were added on top.",
      "The per-event 5-attempt budget was retained but a per-tenant retry budget of 5 per minute was added; no global circuit breaker was deployed in this round.",
      "A global circuit breaker that opens above 1k per second was deployed, but no per-tenant cap was added because Devon argued tenants should not be penalised.",
      "The per-event 5-attempt budget was retained but a per-tenant retry budget of 5 per minute and a global circuit breaker at 1k per minute were added on top.",
      "The per-event 5-attempt budget was reversed entirely; the new policy is no per-event cap, a 5-per-minute per-tenant cap, and a 1k-per-second global breaker.",
    ],
    plausible: [
      "All retries were moved to a Redis-backed durable queue with priority lanes per tenant, with the in-memory worker queue removed entirely from the dispatch path.",
      "The exponential backoff schedule was lengthened from 1-2-4-8-16 seconds to 30s-2m-10m-1h-6h, with the per-event 5-attempt cap unchanged.",
      "Retries were moved off the critical path entirely, queued into AWS SQS for asynchronous processing with a 24-hour visibility timeout per message.",
      "A token-bucket rate limiter was added at the edge of the dispatcher, configured to 100 deliveries per second per tenant with 1k burst capacity.",
      "Outbound retries were sharded across three independent dispatcher pods, with a consistent-hash router keyed by tenant ID to avoid noisy-neighbour cascades.",
      "Tenants were tiered into bronze, silver, and gold rate-limit pools, with bronze capped at 1 per minute and gold capped at 100 per minute on retries.",
      "Retries were eliminated entirely; the new design pushes failure handling to a partner-side polling endpoint that lists undelivered events for the last 7 days.",
      "A flat per-second global rate limit of 500 deliveries was applied across all tenants, with no per-tenant differentiation and no circuit breaker semantics.",
      "Webhook delivery was moved from push to a hybrid push-then-pull design, where two failed pushes promote the event to a partner-pulled queue.",
      "A back-pressure protocol using HTTP 429 from the receiver was added, with the dispatcher reading Retry-After headers and respecting them across all tenants.",
      "The retry queue was moved to Kafka with per-tenant partitions, providing natural per-tenant ordering and isolation against fan-out cascades.",
      "An adaptive concurrency control was added, dynamically reducing per-tenant dispatch parallelism when receiver-side latency crosses a 500ms threshold.",
      "All retries were gated behind a manual approval queue in the admin dashboard, requiring an SRE to release them in batches during business hours.",
      "The dispatcher was rewritten in Rust for memory safety, eliminating the OOM class of failure entirely without any policy change to retry semantics.",
      "Tenants were given configurable retry policies through the dashboard, defaulting to 5 attempts but allowing them to dial up to 20 if they accept the risk.",
    ],
    irrelevant: pickIrrelevant(["D-014", "D-038", "D-039"]),
  },

  // -------- q23 --------
  {
    id: "q23",
    question:
      "What was the financial impact of the March data leak on April's burn?",
    category: "multi-shard",
    shardHints: ["s-incidents", "s-finance"],
    relevantEventIds: [
      "e0086",
      "e0087",
      "e0088",
      "e0089",
      "e0103",
      "e0141",
      "e0143",
      "e0157",
    ],
    correct:
      "April burn came in at $98K, up from the $87K February projection, driven by data-leak remediation (canary alert work, accelerated SOC 2 prep, and a Cloudflare WAF upgrade); runway was revised to 26 months at the Q2 board update.",
    nearTruths: [
      "April burn came in at $98K, up from the $97K February projection, driven by data-leak remediation costs; runway was revised to 26 months at the Q2 board update.",
      "April burn came in at $89K, up from the $87K February projection, driven by data-leak remediation costs; runway was revised to 26 months at the Q2 board update.",
      "April burn came in at $98K, up from the $87K February projection, driven by data-leak remediation costs; runway was revised to 22 months at the Q2 board update.",
      "April burn came in at $98K, up from the $87K February projection, driven by data-leak remediation costs; runway was revised to 28 months at the Q2 board update.",
      "April burn came in at $108K, up from the $87K February projection, driven by data-leak remediation costs; runway was revised to 26 months at the Q2 board update.",
      "April burn came in at $98K, driven by hiring the second SRE and data-leak remediation costs; runway was revised to 26 months at the Q2 board update.",
      "April burn came in at $98K, up from the $87K February projection, driven entirely by Persona KYC verifications hitting volume; runway was revised to 26 months.",
      "April burn came in at $98K, up from the $87K February projection, driven by data-leak remediation costs; runway was revised to 26 months at the Q1 board update.",
      "April burn came in at $98K, up from the $87K February projection, driven by data-leak remediation costs; the company immediately raised a Series A bridge.",
      "April burn came in at $98K, up from the $87K February projection, driven by data-leak remediation costs paid to ChairSync as a goodwill gesture; runway 26 months.",
    ],
    plausible: [
      "April burn was materially unchanged from projection because the data-leak remediation was absorbed by the existing legal and infra retainer, with runway holding at 28 months.",
      "April burn came in at $87K exactly on plan, with the data-leak remediation costs deferred into the Q2 cost-of-incident accrual rather than April actuals.",
      "April burn jumped to $130K because the data-leak triggered an emergency forensic investigation by an external firm, cutting runway to 21 months.",
      "April burn rose by $4K only, reflecting a one-time WAF licence and four engineer-days of canary work, with runway holding at 27 months.",
      "April burn rose by $11K from projection, but it was offset by an early payment from ChairSync's reference-customer agreement, leaving runway flat.",
      "April burn was $98K, but the variance was attributed to FitFlow integration costs, not the data leak; the leak's costs are deferred to May's books.",
      "April burn jumped to $115K due to data-leak fines levied by the California Attorney General, with runway revised down sharply to 19 months.",
      "April burn rose by exactly the cost of Jordan's overtime during the postmortem week; total impact was under $3K and runway was unchanged.",
      "April burn was $98K, with the variance funded by a small follow-on cheque from one of the Q4 angels who heard about the incident response handling.",
      "April burn was $98K, but the company immediately opened a small bridge round from Mosaic Ventures specifically to refill the runway buffer to 30 months.",
      "April burn was $98K, with the data-leak costs fully reimbursed by AWS as a goodwill credit, leaving net runway impact at zero months.",
      "April burn rose to $98K because the leak triggered a full re-platforming of the sandbox onto Cloudflare R2 over six weeks, doubling infra spend.",
      "April burn was $98K with $40K of that attributable to a class-action plaintiff's-firm settlement; runway revised to 24 months at the board update.",
      "April burn was $98K because Nico's firm raised hourly rates after the incident, retroactively applied to all prior months as a one-time true-up.",
      "April burn was $98K, but the team treated the variance as a one-time and continued reporting at the $87K plan-of-record figure to the board indefinitely.",
    ],
    irrelevant: pickIrrelevant(["D-024", "D-044", "D-015", "D-026", "D-025"]),
  },

  // -------- q24 --------
  {
    id: "q24",
    question:
      "How did the decision to defer hiring affect the launch outcome and team health?",
    category: "multi-shard",
    shardHints: ["s-people", "s-meta"],
    relevantEventIds: [
      "e0022",
      "e0023",
      "e0082",
      "e0083",
      "e0102",
      "e0103",
      "e0144",
      "e0145",
    ],
    correct:
      "The team shipped slightly more than 50% of the originally-intended scope (Sarah explicitly credited the deferral for forcing focus), but Jordan flagged burnout from solo SRE coverage at the final retro and the team committed to opening the hire by end of July.",
    nearTruths: [
      "The team shipped slightly more than 50% of intended scope; Devon (not Sarah) credited the deferral for forcing focus, and Jordan flagged burnout with a hire commitment by end of July.",
      "The team shipped slightly more than 80% of intended scope (Sarah credited the deferral for forcing focus); Jordan flagged burnout and the team committed to hiring by end of July.",
      "The team shipped slightly more than 50% of intended scope (Sarah credited the deferral); Mei flagged burnout from solo platform engineering and the team committed to hiring by end of July.",
      "The team shipped slightly more than 50% of intended scope (Sarah credited the deferral); Jordan flagged burnout from solo SRE work and the team committed to hiring by end of October.",
      "The team shipped slightly more than 50% of intended scope (Sarah credited the deferral); Jordan flagged burnout but the team explicitly chose NOT to commit to a near-term SRE hire.",
      "The team shipped slightly more than 50% of intended scope (Sarah credited the deferral); Devon flagged burnout from solo eng coverage and the team committed to hiring by end of July.",
      "The team shipped slightly more than 50% of intended scope (Alex credited the deferral); Jordan flagged burnout from solo SRE coverage and the team committed to hiring by end of July.",
      "The team shipped slightly more than 50% of intended scope (Sarah credited the deferral); Jordan flagged burnout, and the team opened a contractor (not full-time) req by July.",
      "The team shipped slightly less than 50% of intended scope (Sarah credited the deferral); Jordan flagged burnout from solo SRE coverage and committed to hiring by end of July.",
      "The team shipped roughly 50% of intended scope (Sarah credited the deferral for forcing focus); Jordan flagged burnout from solo SRE coverage and the team committed to hiring within two weeks.",
    ],
    plausible: [
      "The deferral let the team ship 100% of the originally-planned scope on time, with no burnout concerns flagged at the final retro and no near-term hire planned.",
      "The deferral was widely regretted in the final retro; the team committed to opening both an SRE and a second engineer req before launch day and accepted the burn impact.",
      "The team explicitly disagreed with the deferral in retrospect, characterising it as 'penny-wise pound-foolish' and committing to a four-person engineering team by June.",
      "Sarah credited the deferral for forcing focus but Mei flagged that the team had cut too aggressively, with three core features deferred to Q2 that customers wanted at launch.",
      "The deferral led to a quiet attrition risk: Jordan resigned shortly after launch and Devon took on SRE responsibilities until a permanent backfill arrived in September.",
      "The deferral was credited with enabling a clean launch, with Devon noting that the small-team forcing function was as valuable as any architectural decision the team made.",
      "Sarah disagreed with the deferral in retrospect; she would have hired earlier and shipped more dashboard surface, even at the cost of a shorter runway by two months.",
      "The deferral had no notable impact on outcome; the team shipped on time, on scope, with no burnout flagged and no near-term change to hiring plans.",
      "The deferral led the team to outsource mid-pre-launch, contracting a fractional SRE through April and May to relieve Jordan's load until a full-time hire was made.",
      "The deferral forced a scope cut but the team also extended Riley's contract through May and added an extra contractor for the final hardening week to compensate.",
      "The deferral was treated as the single most important decision of the half, with Alex committing to keep team size below six until the company hits $1M ARR.",
      "The deferral was reversed in late March after the data leak; the team made an emergency offer to a candidate the following week and onboarded them by mid-April.",
      "The deferral was upheld but Jordan's burnout led the team to pause launch by two weeks to avoid shipping under stress, ultimately moving GA from April 30 to May 14.",
      "The deferral led to a brief OKR miss on sandbox uptime in mid-April, but Sarah and Devon agreed it was worth it for the focus benefit at the final retro.",
      "The deferral was characterised by Marcus at the board update as the single decision he most agreed with; the team committed to keeping the same posture through Q3.",
    ],
    irrelevant: pickIrrelevant(["D-005", "D-029", "D-045", "D-049"]),
  },

  // -------- q25 --------
  {
    id: "q25",
    question:
      "How was the March-April pricing-model debate resolved, and what tipped the decision?",
    category: "multi-shard",
    shardHints: ["s-finance", "s-product"],
    relevantEventIds: [
      "e0079",
      "e0080",
      "e0081",
      "e0093",
      "e0095",
      "e0106",
      "e0107",
      "e0110",
      "e0111",
      "e0125",
    ],
    correct:
      "Sarah's tiered-percentage proposal won: 0.5/0.4/0.3% by volume band plus a $99 monthly platform fee, no per-transaction fixed fee, no revenue-share. Alex initially leaned toward the ChairSync revenue-share but agreed after Marcus's input at the board sync.",
    nearTruths: [
      "Sarah's tiered-percentage model won at 0.6/0.5/0.4% by volume band plus a $99 platform fee; Alex agreed after Marcus's input at the board sync, dropping his revenue-share lean.",
      "Sarah's tiered-percentage model won at 0.5/0.4/0.3% by volume band plus a $149 platform fee; Alex agreed after Marcus's input, dropping his revenue-share lean.",
      "Alex's revenue-share proposal won; Sarah's tiered-percentage was rejected after Marcus argued the integrator alignment was the company's wedge.",
      "Sarah's tiered-percentage model won at 0.5/0.4/0.3% plus a $99 platform fee, with a small per-transaction fixed component of $0.05 layered on top of the tiers.",
      "Sarah's tiered-percentage model won at 0.5/0.4/0.3% plus a $99 platform fee; Devon (not Marcus) tipped the decision by costing out the revenue-share engineering work.",
      "Sarah's tiered-percentage model won at 0.5/0.4/0.3% plus a $99 platform fee, with a hybrid revenue-share kicker on the highest tier; Marcus suggested the hybrid.",
      "Sarah's flat $0.05-per-transaction model (Proposal B) won after Marcus's input; the percentage model was rejected as too Stripe-like.",
      "Sarah's tiered-percentage model won at 0.5/0.4/0.3% plus a $99 platform fee; the decision was tipped by Mei pointing out the engineering simplicity at the all-hands.",
      "Sarah's tiered-percentage model won at 0.5/0.4/0.3% plus a $99 platform fee; Alex held out for revenue-share until ChairSync explicitly rejected it in writing.",
      "Sarah's tiered-percentage model won at 0.5/0.4/0.3% plus a $99 platform fee; Alex initially leaned toward FLAT per-transaction (not revenue-share), then switched after Marcus.",
    ],
    plausible: [
      "The team adopted a hybrid model: tiered percentage with a 5% revenue-share kicker on customers above the $500K monthly TPV band, accommodating Alex's integrator-alignment thesis.",
      "The debate was punted indefinitely and the team launched without published pricing, defaulting to one-off custom contracts negotiated per pilot through the first six months.",
      "The team adopted ChairSync's preferred model: a flat $0.04 per transaction across all volume bands with no monthly fee, accepting the razor-thin margin for distribution velocity.",
      "Pricing was set as flat 0.4% on all volume with a $199 monthly platform fee, splitting the difference between Sarah's tiered and Alex's revenue-share proposals.",
      "The team adopted enterprise-style 'contact sales' pricing for v1, hiding the actual numbers behind a sales-qualification step to preserve negotiation flexibility.",
      "The team adopted Stripe Connect's published pricing as a starting point, undercutting it by 10% across all tiers as a deliberate competitive positioning.",
      "Pricing was tiered by vertical (dental cheaper than gym cheaper than salon) rather than by volume, on the theory that vertical-specific value justified per-vertical rates.",
      "The team launched with usage-based pricing only, charging $0.0008 per API call across all endpoints with no percentage-of-volume component at all.",
      "The team adopted a freemium model for the first 100 transactions per month per tenant, with usage above that priced at a flat 0.4% across all customers.",
      "Pricing was set as a percentage of TPV plus a one-time onboarding fee of $5,000 per integration partner, recurring monthly fees waived for the first year.",
      "The team adopted a per-seat model in the dashboard ($49/seat/month) plus a small percentage of TPV, on the theory that seat count would track customer value.",
      "Pricing was set at 0.7% flat on all TPV with no platform fee, deliberately positioned as the 'simplest invoice' in the integrator-payments market.",
      "The team adopted a 50/50 revenue-share with all integration partners on PaySwift's processing margin, with the integrator setting the end-merchant rate freely.",
      "Pricing was set as a $499 monthly platform fee with no percentage of volume, on the theory that flat platform pricing would scale better with high-volume integrators.",
      "The team published two pricing tiers (Starter at 0.5% and Scale at 0.3% with a $999 floor) and let merchants self-select, with no explicit volume-band logic.",
    ],
    irrelevant: pickIrrelevant(["D-027", "D-032", "D-011", "D-012", "D-013"]),
  },

  // -------- q26 --------
  {
    id: "q26",
    question:
      "What flaw in the original webhook design did the April 18 storm expose?",
    category: "multi-shard",
    shardHints: ["s-architecture", "s-incidents"],
    relevantEventIds: [
      "e0035",
      "e0036",
      "e0037",
      "e0131",
      "e0132",
      "e0133",
      "e0136",
    ],
    correct:
      "The original retry budget was per-event (5 attempts each) with no per-tenant cap and no global circuit breaker, which let one tenant's load test fan retries out into a self-amplifying cascade that OOM'd the dispatcher pod.",
    nearTruths: [
      "The original retry budget was per-event (5 attempts each) with no per-tenant cap and no global rate limit, which let one tenant's load test fan out into a database lock cascade.",
      "The original retry budget was per-tenant (5 per minute) with no per-event cap and no global circuit breaker, which let one tenant's load test fan retries out into a cascade.",
      "The original retry budget was per-event (3 attempts each) with no per-tenant cap and no global circuit breaker, which let one tenant's load test fan out into a cascade.",
      "The original retry budget was per-event (5 attempts each) with no per-tenant cap and a global circuit breaker that was misconfigured at 10k per second instead of 1k.",
      "The original retry budget was per-event (5 attempts each) and used a token bucket per tenant, but the bucket size of 100 was too generous and allowed a cascade.",
      "The original retry budget was per-event (5 attempts each) with a per-endpoint cap but no per-tenant cap, which allowed one tenant with many endpoints to fan out into a cascade.",
      "The original retry budget was per-event (5 attempts each) with no per-tenant cap and no rate limit, but the actual flaw was that retries used a constant interval, not exponential backoff.",
      "The original retry budget was per-event (5 attempts each) with no per-tenant cap and no global circuit breaker, AND the dispatcher's queue was on disk rather than in memory.",
      "The original retry budget was unlimited (no per-event cap) with no per-tenant cap and no global rate limit, which let one tenant's load test fan out into a cascade.",
      "The original retry budget was per-event (5 attempts each) with no per-tenant cap and no global circuit breaker, but the actual cascade trigger was a missing idempotency-key check.",
    ],
    plausible: [
      "The flaw was that webhooks were delivered synchronously inline with the originating API call, blocking the request thread and creating a self-DOS under burst load.",
      "The flaw was that webhook signatures used HMAC-SHA1 instead of SHA256, allowing a hash-collision attack that the load test inadvertently triggered.",
      "The flaw was that the dispatcher used UUID v4 surrogate keys for delivery records, causing index bloat that drove the OOM under sustained insert volume.",
      "The flaw was that retries used a fixed 30-second interval instead of exponential backoff, concentrating retry load into evenly-spaced bursts that overwhelmed the receiver.",
      "The flaw was that the dispatcher had no health-check endpoint, so the load balancer could not pull it out of rotation when its queue depth crossed the OOM threshold.",
      "The flaw was that the dead-letter table was missing entirely from the v1 design, causing infinitely-retried events to fill the working queue indefinitely.",
      "The flaw was that the dispatcher trusted client-supplied delivery IDs and ChairSync's load test reused IDs, causing the deduplication cache to misroute events.",
      "The flaw was that webhook payloads included full event data (not just IDs) and the resulting payload size combined with retry pressure exhausted bandwidth quotas.",
      "The flaw was that the dispatcher ran on a single pod with no horizontal scaling, so any retry pressure beyond 100 per second would saturate the only worker.",
      "The flaw was that the retry queue was backed by Postgres rather than Redis, so retry pressure under load created lock contention and degraded the primary database.",
      "The flaw was that webhook deliveries used long-lived TCP connections without explicit pooling, exhausting file descriptors on the dispatcher under sustained load.",
      "The flaw was that the dispatcher had no observability metrics for retry queue depth, so SREs could not see the cascade building until the OOM had already occurred.",
      "The flaw was that the per-tenant secrets were stored in plaintext in environment variables, requiring a process restart for rotation that prolonged the storm.",
      "The flaw was that the dispatcher used Node's built-in fetch with default 30-second timeouts, holding connections open against degraded receivers far longer than needed.",
      "The flaw was that the original design had no kill switch for individual tenants, requiring an emergency database edit to halt the runaway delivery loop.",
    ],
    irrelevant: pickIrrelevant(["D-014", "D-038", "D-039", "D-017"]),
  },

  // -------- q27 --------
  {
    id: "q27",
    question:
      "In hindsight, why was the early adoption of Bun considered a mistake by the team?",
    category: "multi-shard",
    shardHints: ["s-architecture", "s-incidents"],
    relevantEventIds: [
      "e0006",
      "e0007",
      "e0009",
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
    correct:
      "It triggered a reproducible SIGSEGV in Bun's HTTP server under sustained load on March 12 that blocked sandbox testing for roughly six hours, forced an emergency Node 22 LTS migration completed in 1.5 days, and validated Mei's earlier reservations about novelty versus operational stability.",
    nearTruths: [
      "It triggered a reproducible SIGSEGV in Bun's HTTP server on March 12 that blocked sandbox testing for six hours, forced a Node 18 LTS migration in 1.5 days, and validated Mei's earlier reservations.",
      "It triggered a reproducible SIGSEGV in Bun's HTTP server on March 12 that blocked sandbox for roughly six hours, forced a Deno migration in 1.5 days, and validated Mei's earlier reservations.",
      "It triggered a reproducible memory leak in Bun's HTTP server on March 12 that blocked sandbox for six hours, forced a Node 22 LTS migration in four working days, and validated Mei's reservations.",
      "It triggered a Bun HTTP-server crash on February 12 that blocked sandbox testing for six hours, forced a Node 22 LTS migration in 1.5 days, and validated Mei's earlier reservations.",
      "It triggered a Bun HTTP-server crash on March 12 that blocked production for roughly six hours, forced a Node 22 LTS migration in 1.5 days, and validated Mei's earlier reservations.",
      "It triggered a Bun HTTP-server crash on March 12 that blocked sandbox for roughly twelve hours, forced an emergency Node 22 LTS migration in 1.5 days, and validated Mei's reservations.",
      "It triggered a Bun HTTP-server crash on March 12 that blocked sandbox for six hours, forced an emergency Node 22 LTS migration that Devon completed in 4 working days as planned.",
      "It triggered a Bun crash on March 12 that blocked sandbox for six hours, forced a Node 22 migration in 1.5 days, and validated Devon's (not Mei's) prior reservations.",
      "It triggered a SIGSEGV in Bun's PostgreSQL driver on March 12 that blocked sandbox for roughly six hours, forced a Node 22 LTS migration in 1.5 days, and validated Mei's reservations.",
      "It triggered a Bun crash on March 12 that blocked sandbox for six hours and forced a Node 22 LTS migration in 1.5 days, but Mei never raised reservations about Bun in the original ADR.",
    ],
    plausible: [
      "Bun's bundled package manager dropped support for our private npm registry during a routine point release, blocking CI for a full day during the runtime decision review.",
      "Bun's TypeScript transpiler diverged from tsc semantics on a generic-narrowing edge case, producing subtly-wrong types in our Adyen SDK wrapper that surfaced as a billing bug.",
      "Bun's built-in Postgres driver developed a slow memory leak in production that escaped pre-launch testing, triggering pod restarts every 4 hours under steady load.",
      "Bun's hiring story turned out to be much harder than anticipated; two senior backend candidates withdrew citing the runtime as a deal-breaker for their personal stack.",
      "Bun's Docker base images proved too thin for our compliance auditor, who flagged the missing standard userland tooling during the PCI Level 4 self-attestation review.",
      "Bun's behaviour on AWS Lambda was unstable with cold-start times spiking to 8 seconds, breaking our serverless webhook receivers and forcing a hasty rewrite.",
      "Bun's worker-thread implementation differed enough from Node's that our background-job library required a full rewrite, costing two engineer-weeks the team did not have.",
      "Bun's HTTP server lacked first-class HTTP/2 support, blocking integration with a partner that required HTTP/2 push for their inbound webhook receiver design.",
      "Bun's bundled vitest equivalent did not produce JUnit-format reports, breaking our CI's test-summary integration with GitHub Pull Request status checks.",
      "Bun's environment-variable resolution differed from Node's in a subtle way that caused our secrets-manager integration to misroute production credentials to staging.",
      "Bun's BigInt arithmetic implementation had an off-by-one edge case that caused our financial-rounding helper to produce results one cent off on certain TPV values.",
      "Bun's API for streaming HTTP responses was incompatible with the AWS SDK's chunked-upload helper, blocking direct uploads to S3 from API handlers.",
      "Bun's process-signal handling differed enough from Node's that our graceful-shutdown logic dropped in-flight requests during deploys, surfacing as 502 spikes for partners.",
      "Bun's cluster-mode story was missing entirely, forcing us to handle multi-process orchestration through systemd, which conflicted with our Kubernetes-style health probes.",
      "Bun's GitHub Actions runner image was deprecated mid-quarter, requiring a manual self-hosted runner build that consumed two weeks of Jordan's time.",
    ],
    irrelevant: pickIrrelevant(["D-002", "D-018", "D-019"]),
  },

  // -------- q28 (adversarial: Kubernetes) --------
  {
    id: "q28",
    question:
      "What did the team decide about adopting Kubernetes for orchestration?",
    category: "adversarial",
    shardHints: [],
    relevantEventIds: [],
    correct:
      "No such decision was made — Kubernetes was never proposed in the corpus and the team chose a Postgres-backed monolith. Devon had been talked down from k8s twice prior and the topic was never raised again during the corpus window.",
    nearTruths: [], // not used for adversarial
    plausible: [
      "Adopted EKS (Elastic Kubernetes Service) on AWS for orchestrating the API and webhook dispatcher, with managed node groups sized for 5x launch load.",
      "Self-hosted vanilla Kubernetes on EC2 instances, managed via kubeadm, with Devon owning the cluster and Jordan handling the worker-node lifecycle.",
      "Adopted Nomad over Kubernetes after Mei argued it was operationally simpler for a five-person team and Devon agreed it covered the workloads in scope.",
      "Adopted ECS Fargate with a thin Terraform wrapper, deferring Kubernetes adoption to a post-Series A re-platforming exercise per Alex's recommendation.",
      "Adopted GKE Autopilot specifically so Jordan would not have to manage the control plane, with multi-region failover added as a P5 follow-up.",
      "Self-hosted k8s on bare metal in a Hetzner data centre, on cost-control grounds, with Jordan estimating $2,800/month savings versus EKS at projected scale.",
      "Adopted k3s for production after a brief evaluation, on the theory that the lighter footprint matched the team's actual workload size more honestly than full k8s.",
      "Adopted DigitalOcean Kubernetes Service, on simplicity grounds, with Devon arguing the managed offering was 'good enough' for v1 and the cost predictable.",
      "Hand-rolled orchestration with systemd units on EC2 instances, treating Kubernetes as future work and explicitly logging the decision as a 'we'll revisit at $1M ARR.'",
      "Adopted OpenShift via Red Hat's hosted offering, on enterprise-customer-readiness grounds, after Marcus suggested it would unblock larger pilot conversations.",
      "Adopted Linode Kubernetes Engine after Jordan benchmarked it against EKS and found it cheaper for the team's workload profile by roughly 40%.",
      "Adopted Civo Kubernetes for the sandbox tier and EKS for production, with the split intended as a learning exercise for the eventual full migration.",
      "Adopted Azure Kubernetes Service through Microsoft's startup credits programme, recovering most of the year-one cost as a non-cash benefit.",
      "Adopted CoreOS Tectonic after a pilot, because Mei had shipped on it at Square Cash and could onboard the team quickly with no external help.",
      "Adopted Rancher to manage a federation of small k3s clusters per environment, with the goal of letting tenants eventually run on dedicated clusters at scale.",
      "Adopted EKS but deliberately ran a single large pod per workload (no replicas) to avoid Kubernetes-style failover complexity for the launch quarter.",
      "Adopted Kubernetes only for the dashboard tier (read-only, low-stakes) and kept the API on plain EC2, as a hedged learning step before full adoption.",
      "Adopted Kubernetes via Talos Linux on dedicated bare metal, on the security-and-determinism argument that Mei made during the architecture phase.",
      // Negative-style distractors (>=2 required)
      "Evaluated EKS but rejected it after Jordan estimated 3 SRE-weeks of upfront setup that would compete with PCI prep; deferred to a post-launch revisit.",
      "Considered Kubernetes seriously over a two-week debate but Mei vetoed it on operational-complexity grounds; the team chose a single-process monolith instead.",
      "Evaluated GKE Autopilot for the dashboard tier but rejected it after Devon's spike showed a 200ms cold-start regression versus the existing Cloud Run baseline.",
      "Adopted Kubernetes informally for personal-development workloads only; production stayed on EC2, with the formal adoption decision deferred to Q3 planning.",
      "Adopted EKS for the webhook dispatcher specifically (the only stateful workload), keeping the API on EC2 to limit the blast radius of orchestration changes.",
      "Adopted Kubernetes the day after the April 18 webhook storm, on Devon's argument that pod-level isolation would have prevented the OOM cascade.",
      "Adopted KubeVirt to run Postgres on Kubernetes alongside the API workloads, with Mei reluctantly approving after Jordan demonstrated the failover story.",
    ],
    irrelevant: pickIrrelevant(["D-001", "D-006"]),
  },

  // -------- q29 (adversarial: OAuth) --------
  {
    id: "q29",
    question:
      "Which third-party OAuth provider (Google, GitHub, or Auth0) did the team integrate for end-user authentication?",
    category: "adversarial",
    shardHints: [],
    relevantEventIds: [],
    correct:
      "None — the team built authentication in-house using Lucia and never integrated a third-party OAuth provider during the corpus timeline; the plan was to revisit the build-versus-buy decision only at one thousand monthly active users.",
    nearTruths: [],
    plausible: [
      "Integrated Google Sign-In as the primary OAuth provider, with email/password as a fallback for partners whose IT policies blocked Google authentication.",
      "Integrated GitHub OAuth for the dashboard, on the theory that most early-stage technical buyers already had GitHub accounts and friction was minimised.",
      "Adopted Auth0 as the identity layer, with Devon arguing the SOC 2 inheritance from Auth0's existing certifications would shorten the team's audit timeline.",
      "Adopted Clerk as a hosted auth provider, after a side-by-side spike against Lucia showed faster integration time and a friendlier dashboard UX out of the box.",
      "Adopted WorkOS for SSO, on the basis that mid-market integration partners would expect SAML/OIDC and Lucia's enterprise SSO story was not yet ready.",
      "Integrated Microsoft Entra ID (formerly Azure AD) as the OAuth provider, specifically to unblock conversations with two enterprise prospects who required it.",
      "Integrated Okta as the primary OAuth provider, on Marcus's recommendation that enterprise sales conversations would always assume Okta as table stakes.",
      "Adopted Supabase Auth for the dashboard, on cost-and-ergonomics grounds, with Devon arguing it was 'Lucia plus a UI' and the team got both in one.",
      "Adopted Stytch as the auth provider, on the basis that its passwordless-first model would reduce support load from forgot-password flows post-launch.",
      "Adopted FusionAuth self-hosted, on data-residency grounds, with Jordan running it on a small EC2 fleet behind the existing Postgres instance.",
      "Adopted Firebase Auth as the OAuth proxy, with the dashboard using Firebase tokens and the API translating them into PaySwift session JWTs at the edge.",
      "Integrated Apple Sign-In specifically (not Google), on the basis that the team's early customers in California valued Apple's privacy posture as a buying signal.",
      "Integrated LinkedIn OAuth as the only third-party provider, on the theory that the team's B2B buyers were all professionally active on LinkedIn anyway.",
      "Integrated Magic.link for passwordless authentication via email, with Lucia as the underlying session manager rather than as the OAuth surface.",
      "Adopted Ory Kratos self-hosted, on Mei's recommendation, after a brief evaluation of Lucia, Auth0, and Clerk concluded Kratos had the cleanest data model.",
      "Adopted Frontegg as the customer-identity layer, with Sarah arguing the embedded admin portal would save engineering time on tenant-management UI.",
      "Adopted SuperTokens self-hosted, on the basis that the team needed a fully open-source story to satisfy a specific compliance requirement from Nico.",
      "Adopted Descope, on the basis that its drag-and-drop workflow builder would let Sarah and Riley iterate on auth flows without engineering involvement.",
      "Integrated Discord OAuth specifically, as a deliberate moonshot bet that the team's early developer-customer base would be most active on Discord.",
      "Integrated Twitter (X) OAuth as a low-friction option for the partner-developer dashboard, deprecated three months later when Twitter's API pricing changed.",
      "Adopted Hanko as the auth provider, on the basis of its passkey-first design aligning with the team's compliance-and-security posture for v1.",
      "Adopted Logto self-hosted, on cost grounds, with Devon arguing the team wanted control over the auth surface and Logto's MIT licence allowed it.",
      "Adopted Keycloak self-hosted, on enterprise-customer-readiness grounds, after Marcus flagged that several Mosaic-portfolio buyers expected Keycloak.",
      // Negative-style distractors (>=2 required)
      "Evaluated Auth0 in February but rejected it after Jordan calculated the per-MAU pricing would cost the team $7,200 by year two; built in-house instead with a different vendor.",
      "Adopted Clerk only briefly during a one-week spike, then rolled it back after Devon found the session-cookie semantics conflicted with the SDK's existing JWT design.",
    ],
    irrelevant: pickIrrelevant(["D-009", "D-010", "D-007"]),
  },

  // -------- q30 (adversarial: Series A / IPO) --------
  {
    id: "q30",
    question:
      "What did the team decide about pursuing a Series A or going public during the corpus window?",
    category: "adversarial",
    shardHints: ["s-finance"],
    relevantEventIds: ["e0141", "e0143", "e0157"],
    correct:
      "No such decision was made — the company is pre-launch on $4.2M of seed funding and the Q2 board update explicitly stated 'no fundraise needed pre-Series A,' with Alex committed to a 12-month-at-GA runway bar already exceeded at 26 months.",
    nearTruths: [],
    plausible: [
      "Opened a $12M Series A round led by Mosaic Ventures with three angel-cheque follow-ons, targeting close two weeks after public beta on the strength of the launch-customer testimonials.",
      "Raised a $3M seed extension from existing investors as a runway buffer post-data-leak, on Alex's argument that the SOC 2 acceleration justified the dilution.",
      "Filed a confidential S-1 with the SEC for a direct listing on Nasdaq, on Marcus's recommendation that the public-pricing transparency would differentiate the brand.",
      "Closed a $20M Series A led by Sequoia, with the term sheet signed two days after PCI Level 4 approval came through on April 9.",
      "Engaged Goldman Sachs as bookrunner for a planned IPO in Q4 2026, contingent on hitting 50 paying customers and $1M ARR by end of Q3.",
      "Pursued a SAFE-style bridge from Tiger Global at a $50M valuation cap, on the theory that the cap would convert favourably at a real Series A in 2027.",
      "Closed a $7.5M Series A led by Andreessen Horowitz, with the term sheet driven by ChairSync's reference-customer status during public beta.",
      "Raised a $5M convertible note from Mosaic Ventures plus three new angels, on Alex's argument that priced rounds were dilutive too early.",
      "Closed a $15M Series A co-led by Lightspeed and Index Ventures, with Marcus stepping aside as lead VC to bring in larger growth capital.",
      "Filed for a Reg A+ mini-IPO at a $100M valuation, on the theory that the brand-and-customer story justified retail-investor participation pre-revenue.",
      "Opened secondary purchase windows for early employees and angels, on Alex's argument that the seed cap table was already too crowded for growth-stage participation.",
      "Pursued an SPAC merger with a fintech-focused vehicle, on the theory that the public-company structure would unlock enterprise sales conversations.",
      "Closed a $10M Series A led by Bessemer, with Marcus retaining his board seat as a Series A observer rather than a full member.",
      "Raised a $6M debt facility from Silicon Valley Bank, on Jordan's cost-conscious argument that debt would extend runway without diluting equity.",
      "Closed a $25M growth round led by Insight Partners on the basis of the launch-week customer pipeline, despite being pre-revenue at the time of the cheque.",
      "Pursued a strategic investment from Adyen as part of the agent-of-processor arrangement, on the basis that the relationship was already operationally entangled.",
      "Raised a $4M extension from a single new angel investor on a $40M cap, with the proceeds explicitly earmarked for the post-launch second-engineer hire.",
      "Closed an oversubscribed $9M Series A on launch day, with the term sheet driven by FitFlow's CEO making an introduction to a vertical-SaaS-focused fund.",
      "Opened a public crowdfunding round on Republic, raising $1.2M from 4,800 investors, on Sarah's argument that the customer-aligned cap table was a marketing win.",
      "Filed a confidential listing on the Long-Term Stock Exchange (LTSE) on Mei's argument that the LTSE's governance model matched the team's operating philosophy.",
      "Closed a $50M Series A on a $300M valuation post-launch, the largest pre-revenue B2B fintech raise of the quarter, led by Founders Fund with Mosaic supporting.",
      "Pursued an acquihire conversation with Stripe in late April after the data leak, with Alex framing it as a 'safety valve' rather than an active intent to sell.",
      "Closed a $14M Series A in a tender offer that included full secondary liquidity for Marcus and the four seed angels, refreshing the cap table for growth-stage participation.",
      // Negative-style distractors (>=2 required)
      "Evaluated three Series A term sheets in late April but rejected all three after Marcus argued the company should let the launch metrics speak for themselves over the next quarter.",
      "Opened informal Series A conversations with four growth-stage funds but explicitly paused the process at the launch checklist meeting, on Alex's argument that fundraising would distract from operations.",
    ],
    irrelevant: pickIrrelevant(["D-015", "D-044", "D-005"]),
  },
];

// ---------- assemble + shuffle ----------

function assembleQuery(raw: RawQuery): OutQuery {
  const expectedTotal = 40;
  let assembled: string[];

  if (raw.category === "adversarial") {
    // 1 correct + 25 plausible (>=2 negatives mixed in) + 14 irrelevant
    if (raw.plausible.length !== 25) {
      throw new Error(
        `${raw.id}: adversarial plausible must be exactly 25, got ${raw.plausible.length}`
      );
    }
    if (raw.irrelevant.length !== 14) {
      throw new Error(
        `${raw.id}: irrelevant must be exactly 14, got ${raw.irrelevant.length}`
      );
    }
    // Confirm at least 2 negative-style plausibles by keyword.
    const negKeywords = [
      "rejected",
      "evaluated",
      "vetoed",
      "considered",
      "deferred",
      "paused",
      "rolled it back",
    ];
    const negs = raw.plausible.filter((p) =>
      negKeywords.some((k) => p.toLowerCase().includes(k))
    );
    if (negs.length < 2) {
      throw new Error(
        `${raw.id}: need >=2 negative-style plausibles, got ${negs.length}`
      );
    }
    assembled = [raw.correct, ...raw.plausible, ...raw.irrelevant];
  } else {
    if (raw.nearTruths.length !== 10) {
      throw new Error(
        `${raw.id}: near-truths must be exactly 10, got ${raw.nearTruths.length}`
      );
    }
    if (raw.plausible.length !== 15) {
      throw new Error(
        `${raw.id}: plausible must be exactly 15, got ${raw.plausible.length}`
      );
    }
    if (raw.irrelevant.length !== 14) {
      throw new Error(
        `${raw.id}: irrelevant must be exactly 14, got ${raw.irrelevant.length}`
      );
    }
    assembled = [
      raw.correct,
      ...raw.nearTruths,
      ...raw.plausible,
      ...raw.irrelevant,
    ];
  }

  if (assembled.length !== expectedTotal) {
    throw new Error(
      `${raw.id}: assembled ${assembled.length} options, expected ${expectedTotal}`
    );
  }

  // No duplicates within a query.
  const seen = new Set<string>();
  for (const s of assembled) {
    const key = s.trim();
    if (seen.has(key)) {
      throw new Error(`${raw.id}: duplicate option detected: ${key.slice(0, 60)}…`);
    }
    seen.add(key);
  }

  // Word-count check: 5..50 words per option.
  for (const s of assembled) {
    const wc = s.trim().split(/\s+/).length;
    if (wc < 5 || wc > 50) {
      throw new Error(
        `${raw.id}: option word count ${wc} out of range 5..50: ${s.slice(0, 80)}…`
      );
    }
  }

  // Deterministic shuffle keyed off the query id.
  const seed = fnv1a(raw.id);
  const shuffled = shuffleWithSeed(assembled, seed);

  // Find correctOption (1-indexed).
  const idx = shuffled.indexOf(raw.correct);
  if (idx < 0) {
    throw new Error(`${raw.id}: correct option lost during shuffle`);
  }

  return {
    id: raw.id,
    question: raw.question,
    options: shuffled,
    correctOption: idx + 1,
    relevantEventIds: raw.relevantEventIds,
    category: raw.category,
    shardHints: raw.shardHints,
  };
}

function main(): void {
  const out = {
    version: 1 as const,
    queries: queries.map(assembleQuery),
  };
  // Write next to the other corpus files.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const outPath = path.resolve(
    here,
    "..",
    "data",
    "eval",
    "corpus-synthetic",
    "queries-batch-c.json"
  );
  writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`Wrote ${out.queries.length} queries to ${outPath}`);
  for (const q of out.queries) {
    console.log(
      `  ${q.id}: ${q.options.length} options, correctOption=${q.correctOption}, category=${q.category}`
    );
  }
}

main();
