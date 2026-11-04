# Spec: Disclosure Hub

## Problem
Listed issuers must release regulated information to the market under jurisdiction-specific rules (UK MAR Art. 17 via a Regulatory Information Service such as RNS; US Form 8-K / Reg FD via EDGAR). Today this runs through email, spreadsheets and phone calls to a newswire: no enforced review, no proof of who approved what, and a duplicate or missed release is a regulatory incident.

## Goals (measurable)
- G1: one workflow takes an announcement from draft to published acknowledgement in UK and US; adding a jurisdiction touches zero workflow code (proved by a test).
- G2: publication is exactly-once in effect: no duplicate and no lost release across retries, worker crashes and gateway timeouts (proved by tests).
- G3: every state change is recorded in a tamper-evident audit trail, and approvals are bound to the exact content approved.
- G4: same business logic, API and state transitions in both run modes; only infrastructure adapters differ.

## Out of scope
Real newswire/EDGAR integration, scheduled/embargoed release, attachments and Inline XBRL, translations, billing, mobile.
Built since the first cut (no longer out of scope): OIDC sign-in (Entra ID, Keycloak), the PostgreSQL queue, the Compose twin, and an Azure Terraform deployment that is validated offline and never applied.
Known limits of the regulatory model (what a compliance expert would ask about) are listed at the end of this file.

## Actors
Author (IR team), Approver (company secretary, general counsel, CFO), Publisher (head of IR), Issuer admin (out of scope), Regulator/newswire (external), Auditor (reads audit trail). Sponsor/payer: issuer's IR or legal function.

## Epics and stories
- EP-1 Drafting and revisions
  - US-1.1 As an author I create a draft for a jurisdiction and category. Given an issuer with a UK profile, when I create a `results` draft, then it is `draft` revision 1.
  - US-1.2 As an author I edit a draft. Given a draft, when I save, then a new immutable revision is stored and any earlier validation or approvals are void.
- EP-2 Jurisdiction validation
  - US-2.1 As an author I validate a draft and see errors and warnings with codes and field paths. Given an invalid 8-K (item 2.02 without exhibit), when I validate, then status stays `draft` with `US_8K_2_02_EXHIBIT`.
  - US-2.2 Given a valid draft, when I validate, then status is `validated` and the report is stored against the revision.
- EP-3 Review and approval (maker-checker)
  - US-3.1 As an author I submit a validated draft for review; the policy decides how many and which approvals are needed.
  - US-3.2 As an approver I approve or request changes. Given I authored the revision, then approve is refused (four-eyes).
  - US-3.3 When the requirement is met the announcement becomes `approved`; request changes returns it to `draft`.
- EP-4 Publication
  - US-4.1 As a publisher I publish an approved announcement; the content hash is re-checked against the approved hash.
  - US-4.2 Given a transient gateway failure, then the system retries with backoff and jitter without duplicating the release.
  - US-4.3 Given a permanent rejection (e.g. EDGAR suspense), then the announcement is `failed` with the reason, and can be reopened as a new revision.
  - US-4.4 Given a crash after the gateway accepted but before the ack was stored, then retry reconciles by idempotency key and stores one ack.
  - US-4.5 On success the ack (RNS number or EDGAR accession, filing date) is stored and the status is `published`.
- EP-5 Audit
  - US-5.1 As an auditor I list every event for an announcement and verify the hash chain.
- EP-6 AI pre-check (advisory)
  - US-6.1 As a reviewer I request a pre-check that classifies the announcement, lists missing information and flags possible UK MAR / Reg FD risks, each with evidence and explanation. It never changes status.
- EP-8 Readers and extension
  - US-8.1 As a member of the public I search published announcements by company, category, date and text, and open one without signing in.
  - US-8.2 As an investor I follow a company or a topic by email or webhook, confirm it, and leave with one click from any message.
  - US-8.3 As a developer I add a notifier, an agent or a channel without changing the publishing workflow.
- EP-7 Operability
  - US-7.1 `npm install && npm start` runs everything locally; `docker compose up --build` runs Postgres, Redis, api, worker, web.

## Functional requirements (EARS)
- FR-1 The system shall allow only the transitions in the state table; any other request shall return 409.
- FR-2 When a revision is saved, the system shall store it immutably with a SHA-256 content hash.
- FR-3 When validating, the system shall apply shared rules, then the jurisdiction policy rules, and persist the report.
- FR-4 When submitting for review, the system shall re-run validation and snapshot the approval requirement from the policy.
- FR-5 The system shall refuse an approval from the revision author, from a duplicate approver, or from a user lacking an approver role.
- FR-6 When publishing, the system shall verify the approved hash equals the revision hash before calling any gateway.
- FR-7 The system shall derive the gateway idempotency key from announcement and revision, and shall look it up at the gateway before any resubmit.
- FR-8 If a gateway call fails transiently, then the system shall retry up to N times with exponential backoff and jitter, then mark `failed`.
- FR-9 The system shall append an audit event for every state change, publication attempt and AI report, chained by hash per announcement.
- FR-10 Every query shall filter by issuer (tenant).
- FR-11 The AI pre-check shall never be a precondition for any transition.
- FR-12 When a revision is submitted or published, the system shall record a domain event in the same transaction as the change; consumers shall receive it at least once and shall be idempotent.
- FR-13 The system shall let a process run a chosen subset of event consumers, so consumers can be deployed and scaled separately.
- FR-14 An agent shall be advisory: it reads a copy of the announcement, stores a validated report once per event, shall not change workflow state, and a chain of agents shall be bounded.
- FR-15 The public archive shall return only published announcements, with no people, approvals or unpublished text, filterable by company, jurisdiction, category, date range and every word of a text query.
- FR-16 A subscription shall be confirmed by its owner before anything but the confirmation is sent; the form shall answer the same whether or not an address is known; every message shall carry a one-click unsubscribe; leaving shall erase the address.
- FR-17 A webhook subscription shall be https, signed with a per-subscription secret, and shall never call a private, loopback, link-local or metadata address (checked at connect time, including literal addresses).

## Business rules
- BR-1 (UK) Inside information is disclosed as soon as possible; a delayed disclosure needs a recorded justification (modelled from MAR Art. 17(4)).
- BR-2 (UK) The issuer publishes a PDMR dealing within 3 business days of the transaction (MAR Art. 19(3)); the clock starts at the transaction, not when the issuer was told. A PDMR who told the issuer later than 3 business days after the transaction (Art. 19(1)) raises a warning.
- BR-3 (UK) Inside-information announcements need two approvals including the company secretary; others need one.
- BR-4 (US) A domestic filer's Form 8-K is due 4 business days after the triggering event; late is a warning, not a block. Items 7.01 and 8.01 are voluntary, so an 8-K that reports only those has no deadline. Item 1.05 (cybersecurity) counts the 4 business days from the materiality determination, which the author must record. Item 5.07 (votes) follows the standard clock.
- BR-5 (US) Item 2.02 needs Exhibit 99.1 and is furnished, not filed; Item 7.01 (Reg FD) carries intentional vs unintentional selective disclosure; unintentional needs prompt disclosure (later of 24 hours or the next NYSE open after the senior official learned of it, today's open if it has not happened yet).
- BR-6 (US) 8-K needs two approvals including legal.
- BR-7 Filings accepted after 17:30 ET carry the next business day as filing date.
- BR-8 Approvals are void when the content changes.
- BR-9 (US) The issuer profile records whether the issuer is a domestic filer or a foreign private issuer. Domestic filers file Form 8-K; foreign private issuers file Form 6-K (no fixed deadline: promptly after the information is public at home). Filing the wrong form is an error.
- BR-10 (UK) Inside information is never held for the channel's opening hours, because the duty is "as soon as possible". Routine categories wait for the window when windows are enforced.

## Non-functional requirements (scale / target / meter)
- NFR-1 Tenants: sized for one listed group or a small IR agency (up to 5 issuers, ~300 announcements a month, burst 100 publications in 10 minutes); 10x headroom by replica count. The first 5,000-issuer figure was a market-operator guess and was dropped; the reasoning and measurements are in docs/SIZING.md.
- NFR-2 API p95 < 200 ms for reads and transitions, excluding gateway. Meter: request histogram.
- NFR-3 Enqueue-to-ack p95 < 5 s excluding gateway latency. Meter: publication timestamps.
- NFR-4 Durability: an acknowledged approval or ack is never lost (commit before enqueue; DB is source of truth). RPO 0 on the DB.
- NFR-5 Exactly-once in effect per (announcement, revision): 0 duplicates in the crash/retry test matrix.
- NFR-6 Audit retained at least 5 years (MAR Art. 17(1) website retention; filing records); tamper evidence verified by chain walk.
- NFR-7 Gateway protection: concurrency cap per gateway, so a burst cannot exceed vendor limits.
- NFR-9 Readers: public reads are cacheable for 30 to 60 seconds so a crowd after a big announcement costs the origin one read per lifetime; the subscription form is limited per client (5 an hour at the API, a rate rule at the edge) and an address is capped at 10 subscriptions. Meter: edge cache status, 429 counts.
- NFR-10 Outbox: a delivery older than 5 minutes alerts; a delivery that used all its attempts (`dead`) alerts; a failing consumer never delays publishing. Meter: oldest pending delivery, dead deliveries (also in /metrics).
- NFR-8 Code boundary: `domain` imports nothing from adapters/http (checked by test).

## Integrations
| System | Owner | Contract | Here |
|---|---|---|---|
| RNS / FCA-approved RIS | LSEG / vendor | API or SFTP (assumed) | Mock gateway, RNS number ack |
| EDGAR | SEC | EDGAR Next API (assumed) | Mock gateway, accession + acceptance/suspense |
| LLM provider | Anthropic (optional) | HTTPS JSON | Port + mock default |
| IdP | Customer | OIDC (Entra ID, Keycloak); persona picker only in demo mode | Built; Keycloak verified, Entra ID designed |

## Known limits of the regulatory model
Simplified on purpose. A compliance expert should expect to hear these first:
- Real RIS and EDGAR APIs have no standard idempotency key and no "find by key" call. The mock models that capability so the reconciliation logic can be tested; against a real provider it becomes a lookup by headline, time and issuer, or a check of the provider's own history, and needs its own design.
- EDGAR access: EDGAR Next replaced the old access model, and the CIK Confirmation Code may now be legacy. Verify the current credential model before any real filing. The 17:30 ET cut-off is the general rule for an 8-K; some form types have other cut-offs.
- No scheduled or embargoed release, although earnings and the 07:00 London open depend on it.
- No correction or supplementary announcement after publication: published and withdrawn are terminal.
- One announcement for a dual-listed issuer is two independent announcements; they are not linked.
- UK MAR items not modelled: insider lists (Art. 18), closed periods for PDMRs (Art. 19(11)), the 20,000 euro dealing threshold (Art. 19(8)), the FCA notification of a delay as a tracked task rather than a post-publication reminder, and DTR 5 major-holdings notifications (TR-1).
- US items not modelled: Forms 10-Q and 10-K, Section 16 forms, other 8-K items beyond 1.01, 1.05, 2.02, 5.02, 5.07, 7.01 and 8.01, and a Reg FD intentional disclosure (which requires simultaneous public disclosure) as a timed duty.
- The AI pre-check is advisory; liability for the disclosure stays with the issuer.
