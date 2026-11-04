# Requirements, assumptions, decisions and open points

One page that gathers what the system must do, how well, what was assumed, what was decided and what is still to be
defined. It is an **overview with status**; the full wording lives in the files it points to, so this page does not
repeat them.

| Source of truth | What it holds |
|---|---|
| [discovery/spec.md](../discovery/spec.md) | Problem, goals, actors, epics and stories, functional requirements (EARS), business rules, non-functional requirements, integrations, known limits of the regulatory model |
| [discovery/ledger.md](../discovery/ledger.md) | Every assumption and confirmed fact (L-1 to L-28), with state and next step |
| [discovery/handoff.md](../discovery/handoff.md) | The architecture-driving decisions (ASR-1 to ASR-20), the MVP slice, the risks |
| [discovery/questions.md](../discovery/questions.md) | Questions for the panel, with the default assumed meanwhile |

Status words used below: **Verified** (a test or a run proves it), **Measured** (a number from a laptop, not production),
**Designed** (written, not run), **Not built**.

## 1. Scope and actors

**Problem.** A listed company must release regulated information to the market under jurisdiction-specific rules. Today
that runs through email, spreadsheets and phone calls to a newswire: no enforced review, no proof of who approved what, and a
duplicate or missed release is a regulatory incident.

**In scope.** Draft, validate, review, approve, publish and audit an announcement in the UK (RNS) and the US (EDGAR); the
public archive and follow-by-email or webhook; an extension seam for new jurisdictions, consumers and agents.

**Actors.** Author (IR team), approver (company secretary, general counsel, CFO), publisher (head of IR), auditor,
reader (the public, no account), the newswire (external). Glossary: [GLOSSARY.md](GLOSSARY.md).

**Diagrams.** [Roles and use cases](diagrams/01-use-cases.drawio.png) ·
[Azure architecture](diagrams/02-azure-architecture.drawio.png) · [Local twin](diagrams/03-local-architecture.drawio.png).

## 2. Functional requirements

| Area | Requirement (ids in spec.md) | Status | Proof |
|---|---|---|---|
| Workflow | Only the transitions in the state table are allowed; anything else is 409 (FR-1) | Verified | `domain.test.ts`, `workflow.test.ts` |
| Revisions | Immutable, SHA-256 content hash; an edit voids earlier validation and approvals (FR-2, BR-8) | Verified | `workflow.test.ts` |
| Validation | Shared rules, then the jurisdiction's rules; report stored with the revision (FR-3) | Verified | `policies.test.ts` |
| Review | Submit re-runs validation and snapshots the approval requirement; the author, a duplicate approver and a non-approver are refused (FR-4, FR-5) | Verified | `workflow.test.ts`, `hardening.test.ts` |
| Publication | Approved hash re-checked before any gateway call; idempotency key looked up at the wire before a resubmit; retry with back-off and jitter, then `failed` with a Retry action (FR-6 to FR-8) | Verified | `workflow.test.ts` (lease takeover, lost acknowledgement, exhaustion, permanent rejection) |
| Audit | An event for every state change, publication attempt and AI report, hash-chained per announcement (FR-9) | Verified | `domain.test.ts` (tamper detection), `workflow.test.ts` |
| Tenancy | Every query filters by issuer (FR-10) | Verified | `workflow.test.ts`, `http.test.ts` |
| AI pre-check | Advisory only; never a precondition for a transition (FR-11) | Verified | `operations.test.ts` (whole workflow with AI off) |
| Events | A domain event is written in the same transaction as the change; consumers receive it at least once and are idempotent; a process can run a chosen subset of consumers (FR-12, FR-13) | Verified | `events.test.ts` |
| Agents | Advisory, validated output, one report per event, bounded chaining (FR-14) | Verified | `events.test.ts` |
| Public archive | Published items only, no people or approvals, filter by company, jurisdiction, category, date and text (FR-15) | Verified | `readers.test.ts`, `public-http.test.ts` |
| Subscriptions | Double opt-in, same answer for known and unknown addresses, one-click unsubscribe, address erased on leaving (FR-16) | Verified | `readers.test.ts` |
| Webhooks | https, signed, never a private, loopback, link-local or metadata address, including literal IPs (FR-17) | Verified | `readers.test.ts` |
| Sign-in | OIDC bearer tokens, roles from the token; a persona picker only in demo mode | Verified (Keycloak); Designed (Entra ID) | `auth.test.ts`, a browser run against Keycloak |

### Jurisdiction rules (business rules)

| Rule | Jurisdiction | Summary |
|---|---|---|
| BR-1 | UK | Inside information as soon as possible; a delay needs a recorded justification (MAR Art. 17(4)) |
| BR-2 | UK | PDMR dealing published within 3 business days of the transaction (Art. 19(3)); a late notification to the issuer raises a warning |
| BR-3 | UK | Inside information needs two approvals including the company secretary; others one |
| BR-10 | UK | Inside information is never held for the RNS opening hours; routine categories wait when windows are enforced |
| BR-4 | US | 8-K due 4 business days after the event; late is a warning; 7.01 and 8.01 voluntary (no deadline); 1.05 from the materiality determination |
| BR-5 | US | Item 2.02 needs Exhibit 99.1 and is furnished; 7.01 carries intentional or unintentional selective disclosure (Reg FD) |
| BR-6 | US | 8-K needs two approvals including legal |
| BR-7 | US | Filings accepted after 17:30 ET carry the next business day |
| BR-9 | US | Filer status gates the form: domestic filers 8-K, foreign private issuers 6-K |

These are **simplified models, not legal advice**; sources are named in code comments next to each rule. Status of the
rules as code: Verified by `policies.test.ts`. Status of their legal correctness: **Not verified**.

## 3. Non-functional requirements

| Id | Requirement | Target | Status | Evidence |
|---|---|---|---|---|
| NFR-1 | Tenancy and volume | up to 5 issuers, about 300 announcements a month, burst of 100 publications in 10 minutes, 10x headroom by replica count | Measured | [SIZING.md](SIZING.md) |
| NFR-2 | API latency | p95 under 200 ms for reads and transitions, gateway excluded | **Not proven per call.** A five-call draft-to-publish-request sequence had p95 567 ms (5 people) | SIZING.md §3 |
| NFR-3 | Enqueue-to-ack | p95 under 5 s, gateway latency excluded | Not measured as such; throughput and zero failures were | ARCHITECTURE §4 |
| NFR-4 | Durability | An acknowledged approval or acknowledgement is never lost; commit before enqueue; RPO 0 for the database in a zone | Verified (crash-after-claim, lost wake-up tests); Designed (zone-redundant database) | `workflow.test.ts`, [infra/azure/README.md](../infra/azure/README.md) |
| NFR-5 | Exactly-once in effect | 0 duplicates in the crash and retry matrix | Verified; Measured (900 publications, 900 distinct references) | `workflow.test.ts`, `pgqueue.test.ts`, `bullmq.test.ts` |
| NFR-6 | Audit | Tamper evidence; kept at least 5 years | Tamper evidence Verified. Retention: nothing deletes audit rows, but no archive or retention policy is built | `domain.test.ts`; [ARCHITECTURE §2.3](ARCHITECTURE.md#23-integrity-and-audit) |
| NFR-7 | Gateway protection | A concurrency cap per gateway per worker, so a burst cannot exceed a vendor limit | Implemented (`GATEWAY_CONCURRENCY`); exercised in the benchmark; not tested against a real vendor limit | `publication-runner.ts` |
| NFR-8 | Code boundaries | `domain` imports nothing from adapters or http; the application never imports an adapter | Verified, fails the build | `operations.test.ts` |
| NFR-9 | Readers | Public reads cacheable 30 to 60 s; the subscription form limited per client; an address capped at 10 subscriptions | Verified locally; Designed at the Azure edge | `public-http.test.ts`, `edge.tf` |
| NFR-10 | Outbox health | A delivery older than 5 minutes alerts; a dead delivery alerts; a failing consumer never delays publishing | Verified (metrics, isolation); Designed (Azure alerts) | `events.test.ts`, `monitoring.tf` |
| NFR-11 | Availability | 99.9 % a month; a zone loss or a deploy must not stop publication | Designed (two replicas minimum, zone-redundant) | SIZING.md §1 |
| NFR-12 | Recovery from a region loss | With `dr_location`: RPO the replica lag (alert at 5 min); RTO about 15 minutes after a person decides | Designed; **never rehearsed** | [DR.md](DR.md) |
| NFR-13 | Security | No secrets in the repository; no database password on Azure; rate limits; SSRF guard; authentication decided on the matched route; approvals bound to the reviewed revision | Verified (reviews and tests); Designed (managed identities, Key Vault) | [ARCHITECTURE §6](ARCHITECTURE.md#6-verified-and-only-designed), `hardening.test.ts` |
| NFR-14 | Portability | The same business logic on SQLite and PostgreSQL; the same image in every mode | Verified | the same suite on both |
| NFR-15 | Observability | Structured logs, `/metrics` including the age of the oldest waiting publication | Verified; tracing **Not built** | README, "Observability" |
| NFR-16 | Accessibility and browser support | Not specified in the brief | Not audited; one browser tried | [UI.md](UI.md) |

NFR-11 to NFR-16 are derived from the sizing, DR and architecture documents; they are not numbered in `spec.md`.

## 4. Assumptions

Full list with state: [ledger.md](../discovery/ledger.md). The ones a reader should challenge first:

| Assumption | Ledger | Effect if wrong |
|---|---|---|
| The rules are simplified models of UK MAR, the Listing Rules, DTR, Form 8-K and Reg FD | L-10, L-19 to L-22 | A compliance expert corrects a policy file; the workflow does not change |
| Scale is one listed group or a small IR agency, not a market operator | L-13, L-16 | Sizing, SKUs and the broker trigger move ([ADR 0001](adr/0001-database-bottleneck-and-service-bus.md)) |
| Load is spiky (earnings, 07:00 UK, 16:05 ET) with a low steady rate; the outside gateway is the ceiling | L-13 | Per-gateway caps and queue depth need tuning |
| Newswires are mocks that behave like real ones (acknowledgement, suspense, a duplicate key, outages) | L-12, L-23 | Real RIS and EDGAR have no idempotency-key lookup; reconciliation needs a different design |
| The AI is advisory and optional; liability for a disclosure stays with the issuer | L-8 | If it must block, it becomes part of the critical path and needs an evaluation gate |
| Readers are the public and need no account | L-26 | A preference centre and digests would need accounts |
| Azure is the target cloud; the design is validated offline and never applied | L-17 | Items unproven until the first deploy ([infra/azure/README.md](../infra/azure/README.md)) |
| One default company per deployment unless the token carries one | L-11 | Multi-company users need a token claim or a mapping |

## 5. Decisions

Where each one is argued. The architecture decision records are ASR-1 to ASR-20 in [handoff.md](../discovery/handoff.md).

| Decision | ASR | Argued in |
|---|---|---|
| Modular monolith, hexagonal, one image, roles by environment variable | 1 | [ARCHITECTURE §1](ARCHITECTURE.md#1-shape) |
| A jurisdiction is a policy plus a gateway, registered | 2, 12, 13, 14 | [ARCHITECTURE §2.1](ARCHITECTURE.md#21-jurisdictions-are-data-plus-two-small-adapters-not-branches-in-the-workflow), [BRIEF-RESPONSE §2 and §3](BRIEF-RESPONSE.md) |
| The database row is the truth, the queue is a hint; lease with a token; idempotency key | 3, 4, 11 | [ARCHITECTURE §2.2](ARCHITECTURE.md#22-publishing-is-the-risky-step-so-it-is-built-to-be-reliable-not-fast) |
| Immutable revisions, approvals bound to a hash, per-announcement hash chain | 5, 6 | [ARCHITECTURE §2.3](ARCHITECTURE.md#23-integrity-and-audit) |
| Tenant filter inside every query | 7 | ARCHITECTURE §2.3; row-level security is listed as next |
| AI behind a port, advisory, validated | 8 | [ARCHITECTURE §2.5](ARCHITECTURE.md#25-ai-is-advisory-and-optional) |
| One portable migration for SQLite and PostgreSQL | 9 | [ARCHITECTURE §2.4](ARCHITECTURE.md#24-storage-and-queue-behind-ports-one-migration) |
| OIDC bearer tokens | 10 | ARCHITECTURE §3 |
| Domain events through an outbox; consumers per process; guarded agents | 16, 17, 18 | [MODULES.md](MODULES.md) |
| Public reads separate and cacheable; double opt-in subscriptions | 19, 20 | MODULES.md, [ADR 0001](adr/0001-database-bottleneck-and-service-bus.md) |
| The database stays the single store until a measured trigger | n/a | [ADR 0001](adr/0001-database-bottleneck-and-service-bus.md) |
| Azure Terraform twin, private network, second region, landing zone | 15 | [infra/azure/README.md](../infra/azure/README.md), [DR.md](DR.md) |
| Vite and React, not Next.js | n/a | README, "Assumptions and deviations" |

Trade-offs accepted and what each costs: [ARCHITECTURE §3](ARCHITECTURE.md#3-trade-offs-i-accepted).

## 6. Open points: to define, with the default assumed

None of these blocks the system; each has a default so the work could proceed.

| # | To define | Default assumed | Decides | Where |
|---|---|---|---|---|
| 1 | Which jurisdiction is third (EU, Nasdaq Copenhagen, ASX) | None built | Which policy primitives to generalise first (national storage mechanisms, language rules) | questions.md #1, L-15 |
| 2 | Integrate with each newswire directly, or sit in front of a vendor the customer already pays | Direct, behind a gateway port | Gateway ownership, cost, SLA | questions.md #2 |
| 3 | Who signs off disclosure today, and does it differ per customer | Approval requirement per category | Whether approval rules must be configurable per tenant (policies are code today) | questions.md #3 |
| 4 | Is scheduled release at an exact time (07:00 UK results) a launch requirement | Cut | A time-critical path and an embargo state | questions.md #4 |
| 5 | May the AI pre-check ever block a release | Advisory only | Whether it enters the critical path and needs an evaluation gate | questions.md #5 |
| 6 | Volumes per customer and peak clustering | Low steady rate, earnings-season bursts | Sizing and the broker trigger | questions.md #6, SIZING.md |
| 7 | US customers: domestic filers, foreign private issuers or both | Both, gated by filer status | Categories offered (8-K, 6-K, 10-Q, 10-K, 20-F) | questions.md #7, L-21 |
| 8 | Must the company prove the PDMR 3-day limit, the PDMR's own notification and the closed period | First modelled, second warned, third not built | Compliance evidence and a closed-period feature | questions.md #8 |
| 9 | Who owns the insider list and the delayed-disclosure record | The delay is recorded in the announcement; the list is not modelled | A new module | questions.md #9 |
| 10 | How corrections and supplements are handled after release | A new, unlinked announcement (published is terminal) | A correction transition and a link between announcements | questions.md #10 |
| 11 | Which RIS and which EDGAR access arrangement customers use | Mock with an idempotency lookup | Whether a lookup exists at all; EDGAR Next credentials (L-24) | questions.md #11, L-23, L-24 |
| 12 | Audit retention and archival policy (5 years assumed) | Never delete | A retention job and an external anchor for the chain | NFR-6, ARCHITECTURE §7 |
| 13 | Per-tenant opt-in before a real LLM may see unpublished text | Provider off by default in production | Privacy and contract terms | ARCHITECTURE §6 |
| 14 | A first deploy to a test subscription, and the results to record (failover, restore, Azure throughput) | Not done | Converts Designed into Verified | infra/azure/README.md, SIZING.md |

## 7. Out of scope, and what was cut

Scheduled release and embargo, attachments and iXBRL, translations, real newswire connections, billing, mobile, reporting,
notifications to approvers, distributed tracing, agents that act rather than advise, corrections after publication, links
between dual-listed announcements, insider lists, PDMR closed periods and the 20,000 euro threshold, major-holdings
notifications (DTR 5, TR-1), Forms 10-Q and 10-K, Section 16 forms. Reasons and order of cutting:
[ARCHITECTURE §5](ARCHITECTURE.md#5-what-was-cut-and-why); regulatory scope a compliance expert will raise first:
the end of [spec.md](../discovery/spec.md).
