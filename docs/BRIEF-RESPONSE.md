# Response to the brief

The take-home asked for an investor-relations system that publishes regulatory announcements, in at least two
jurisdictions, **working** (draft to published in each), with three things the reviewers look for. This page answers each
one in black and white: the claim, where it lives, the proof, and the limit. Every claim points at a file or a test, and
says whether it was **verified by running it**, **measured** (a laptop, not production), or only **designed**.

Map of all the other documents: [README, "Documentation map"](../README.md#documentation-map).

## The brief, and where each part is answered

| The brief | Short answer | Section |
|---|---|---|
| A working system: draft to published, in each of at least two jurisdictions | Three: UK (RNS, UK MAR), US (EDGAR, Form 8-K, Reg FD) and Denmark (Nasdaq Copenhagen, EU MAR), one workflow, mock newswires | [0](#0-a-working-system) |
| "A system built for scale, both in the code you write and in the architecture behind it" | Enforced module boundaries and stateless processes in the code; a queue that is only a hint, an outbox for everything that follows, roles that split into separate processes in the architecture; measured | [1](#1-built-for-scale-in-the-code-and-in-the-architecture) |
| "A clear way of handling the regulatory and operational differences between your chosen jurisdictions" | Two kinds of difference, two homes: regulatory rules in a **policy**, operational delivery in a **gateway adapter** | [2](#2-regulatory-and-operational-differences-two-kinds-two-homes) |
| "Good choices about how to handle those differences without duplicating effort, so the system can be extended to more jurisdictions later" | The workflow exists once. A jurisdiction is a policy value plus a gateway; the UI, the archive and the follow form read it. Denmark was added that way (one policy, one gateway, two registrations) without touching the workflow | [3](#3-without-duplicating-effort-extending-to-more-jurisdictions) |

## 0. A working system

**Run it** (needs Node 22+; details in the [README](../README.md#run-it)):

```bash
npm install
npm start          # http://localhost:3000, seeded personas, SQLite, one process
```

or `docker compose up --build` for the production-shaped twin (PostgreSQL, Keycloak sign-in, separate api, worker,
notifier and agents processes).

**Take an announcement from draft to published** (the same eight steps in all three jurisdictions):

1. `alice` (author): *New announcement*, pick the jurisdiction and category, *Fill with example content*, save.
2. **Validate**: errors and warnings with codes and field paths (the rules of that jurisdiction).
3. **Submit for review**: the policy decides which approvals are needed.
4. `bob`, `carol`, `dan` approve (the author cannot approve their own revision).
5. `erin` (publisher) presses **Publish**; the content hash is re-checked against what was approved.
6. A worker sends it to the mock newswire; the **acknowledgement** is stored: an RNS number (`0001B`) or an EDGAR
   accession number (`0001234567-26-000001`) with a filing date.
7. The detail page shows the deadline, what is still owed after publishing, and the hash-chained audit trail.
8. Anyone (no account) finds it in the public archive and followers receive a notification.

Without a browser: `npm run demo` drives one announcement per jurisdiction through the REST API.

**What is mocked, on purpose:** both newswires (they model acknowledgement, rejection, duplicate detection and outages),
the mail service locally, and the AI provider by default. Sign-in is real OIDC in the container setup and in the Azure
design. Nothing is submitted to a regulator.

**Evidence that it works:** 224 server tests pass on SQLite; 7 more are gated integration tests that CI runs with PostgreSQL 16 and Redis 7;
12 UI logic tests pass. The workflow tests run the full path in all three jurisdictions; the container stack was
run end to end with the demo and a benchmark. See [ARCHITECTURE.md §6](ARCHITECTURE.md#6-verified-and-only-designed).

## 1. Built for scale, in the code and in the architecture

### In the code

| Property | How | Proof |
|---|---|---|
| Boundaries that cannot rot | `domain` is pure; `jurisdictions` cannot touch adapters or the application; `application` never imports an adapter. The build fails if any of that is violated. | `operations.test.ts`, "module boundaries" |
| Swap infrastructure without touching rules | Everything outside goes through ports: database (SQLite or PostgreSQL), queue (in-process, PostgreSQL `LISTEN/NOTIFY`, BullMQ), gateway, AI, mail and webhook channels. One portable migration, one set of tests on both databases. | The same suite passes on SQLite and PostgreSQL |
| Correct under concurrency | Immutable revisions with a content hash; approvals bound to the hash; optimistic version on every announcement; idempotent create; maker-checker enforced on the server | `hardening.test.ts`, `workflow.test.ts` |
| Small, typed surface | TypeScript end to end, Zod schemas at the boundary, configuration validated at start (a bad value stops the process) | `config.test.ts`, `typecheck` |

### In the architecture

| Property | How | Where |
|---|---|---|
| **Publishing is reliable, not just fast.** A release twice, or never, is the worst failure in this domain. | The database row is the truth and the queue only wakes a worker; a lease with a token (compare-and-set) so a slow worker cannot overwrite the one that took over; an idempotency key `announcementId:revision` and a `find` at the wire before any resubmit; retry with exponential backoff and jitter, then a visible `failed` state with a manual **Retry**; a timeout on every gateway call; a sweeper that recovers a lost wake-up | [ARCHITECTURE §2.2](ARCHITECTURE.md#22-publishing-is-the-risky-step-so-it-is-built-to-be-reliable-not-fast); tests for lease takeover, lost acknowledgement, exhausted retries, lost wake-up |
| **Everything that follows a step is a consumer of an event.** | Submitting and publishing write a domain event in the same transaction (an outbox); a reactor delivers it at least once to each interested consumer (notifier, agents) with back-off and a `dead` state. A slow mail service or a failing agent cannot block publishing. | [MODULES.md](MODULES.md), `events.test.ts`, `readers.test.ts` |
| **Processes split by role.** | One image; `ROLE=api / worker / events / all` and `REACTOR_CONSUMERS` choose what a process does. Locally they are separate Compose services; on Azure separate Container Apps. | [README, Configuration](../README.md#configuration), [infra/azure/README.md](../infra/azure/README.md) |
| **Tenant isolation.** | The issuer filter is inside every query; another company's announcement is a 404, not a 403. | `workflow.test.ts`, `http.test.ts` |
| **Public reads are separate and cacheable.** | A people-free published view, cache headers of 30 to 60 seconds, a read-replica switch, Front Door and a WAF rule in the Azure design | [ADR 0001](adr/0001-database-bottleneck-and-service-bus.md), `public-http.test.ts` |
| **A defined exit for each limit.** | The database is queue, outbox, search and store at this size; the ADR names the number that triggers Service Bus, Redis, a search index or a pooler | [ADR 0001](adr/0001-database-bottleneck-and-service-bus.md) |

### Numbers (measured on a laptop under the Azure-sized resource limits; a method and a trend, not a capacity promise)

- Workers scale until the API is the limit: with the Azure-sized limits 1 worker 9 publications a second, 3 workers 16
  (the 0.5 vCPU API, about 80 write requests a second), a second API replica about 20, where PostgreSQL reaches its
  1 vCPU limit; a 200 ms gateway. 900 earlier publications, 900 distinct external references, **0 duplicates, 0 failed attempts**.
- With real OIDC and the PostgreSQL queue under the Azure-sized limits: about 15 publications a second with 2 workers, p95
  of a five-call draft-to-publish sequence 0.57 s, 16 database connections; the sizing peak is 0.17 a second (about 90x
  headroom).
- Archive listing with 100,000 published announcements went from 506 ms to 2 ms after an index found by measuring it.
- Sweeper and claim queries read only non-terminal rows (two partial indexes): 0.28 ms with 300,000 finished rows.

Full model, assumptions and what would change them: [SIZING.md](SIZING.md). Method: `npm run bench`, `npm run bench:readers`.

### Limits, stated

- Nothing was measured on Azure, and nothing was applied there (see [section 4](#4-verified-measured-designed)).
- Not measured: more than 3 workers, a remote database, sustained load over hours, Redis or PostgreSQL failure under load.
- The first limits I expect are the database connection pool and the archive text search (a scan). Both have a trigger
  and a next step in the ADR.
- The real ceiling is the outside world: RNS, EDGAR and Nasdaq Copenhagen throttle submissions. The platform caps concurrency per gateway *per
  worker process* (default 2), so the vendor sees at most workers x 2 calls (12 at the 6-worker ceiling). That is a knob to
  set against the vendor's limit, not a guarantee: a global cap needs shared state and is a next step.
- The Azure worker autoscale rule is CPU, which does not see a publishing backlog (a worker waiting on a vendor is idle).
  Capacity is the floor of 2 workers (about 15 a second against a 0.17 peak); the backlog is watched by an alert on the age
  of the oldest due publication. A backlog scaler comes with Service Bus.

## 2. Regulatory and operational differences: two kinds, two homes

The first decision was to separate *what the law requires* from *how the channel works*, because they change for
different reasons and are owned by different people.

| | Regulatory difference | Operational difference |
|---|---|---|
| Question it answers | What must be said, by when, approved by whom? | How is it delivered, and what comes back? |
| Where it lives | A **policy**: `jurisdictions/uk.ts` (97 lines), `us.ts` (248), `dk.ts` (383), with the shared MAR text in `mar.ts` (122) | A **gateway adapter** implementing `PublishGateway` (`find`, `submit`): `adapters/gateways/mock.ts` today |
| Contract | `JurisdictionPolicy` in `domain/policy.ts`, built with `definePolicy({...})` | `PublishGateway`, `PublishAck`, `GatewayError` (`transient` or `permanent`) in `ports/index.ts` |
| Reviewed by | Compliance / legal (one file per regime, rule sources named in comments) | Engineering / vendor management |

What differs between the three jurisdictions as modelled, and where each difference sits:

| | UK | US | Denmark (EU) | Lives in |
|---|---|---|---|---|
| Regime and channel | UK MAR, Listing Rules, DTR; RNS | Exchange Act, Form 8-K, Reg FD; EDGAR | EU MAR, Transparency Directive; Nasdaq Copenhagen, stored in the Danish OAM | policy `code`, `channel` |
| Categories and their fields | inside information, PDMR dealing, results, general | 8-K items 1.01, 1.05, 2.02, 5.02, 5.07, 7.01, 8.01; 6-K for foreign private issuers | the UK's four plus **major shareholder announcements**, **share buyback reports** and **notices of general meetings**; each with a required **language** (Danish or English) | policy `categories`, each with a Zod schema (the UI form is generated from it) |
| Deadline | MAR Art. 17 "as soon as possible" (a delay needs a recorded reason); PDMR 3 business days from the transaction; DTR 4 results deadlines | 8-K 4 business days from the event; 1.05 from the materiality determination; 7.01 and 8.01 voluntary (none); Reg FD simultaneous when intentional, otherwise later of 24 h or the next day's NYSE open | the same MAR and reporting rules as the UK, counted on the **Danish calendar** (Ascension Day is not a business day); shareholder notices 3 trading days from the notification; buyback reports 7 market sessions from the first trade in the report; a meeting notice at least 21 days (annual) or 14 days (extraordinary) before the meeting | category `deadline`; the shared rules in `jurisdictions/mar.ts` |
| Approval | inside information: two approvals including the company secretary; others one | 8-K: legal plus one more; item 2.02 legal **and** the CFO | as the UK | category `approval` (can depend on the metadata) |
| Extra rules | | filer status, Exhibit 99.1, Reg FD flag | a **notification threshold** for managers' transactions (a warning below it); shareholder notices only for main-market issuers (First North needs a Certified Adviser instead); flagging levels, buyback totals against the authorisation and meeting-notice periods checked; the Finanstilsynet notice only when disclosure was delayed | category `rules`, `postPublication` |
| Channel window | RNS hours, but inside information is never held for them | EDGAR 06:00 to 22:00 ET; after 17:30 ET the filing date is the next business day | 07:00 to 22:00 Copenhagen, inside information never held | policy `window`, `calendar`; category `releaseOutsideWindow`; the gateway stamps the filing date |
| Identifiers | LEI (mod-97), ISIN (Luhn) | CIK and CCC shapes, filer status | **CVR number** (modulus 11), LEI, ISIN, market segment | `issuerProfile` schema, `jurisdictions/identifiers.ts` |
| Rendering | MAR statement in English | 8-K items, Exhibit 99.1 | MAR statement in the announcement's language (Danish or English) | policy `render` |
| Acknowledgement | RNS number | accession number and filing date | company announcement number, numbered per issuer and year (`n/year`) | the gateway's `PublishAck` |
| Failure semantics | transient (retry) or permanent (new revision) | EDGAR suspense is permanent | transient or permanent, the same contract | `GatewayError.kind` |

**One regulation, written once.** The UK and the EU apply the same MAR text, so inside information, managers'
transactions and the reporting deadlines live in `jurisdictions/mar.ts` and both policies plug in their own calendar,
time zone and issue-code prefix (`UK_MAR_*`, `EU_MAR_*`). The UK is 97 lines because the shared part is not repeated; Denmark is longer (383) because it
also carries what only it has: the market segment, three more categories and the Danish wording.

**Where the difference stops.** All three policies answer the same six questions (`validate`, `approvalRequirement`, `timing`,
`render`, `postPublication`, `describe`), and the workflow only ever asks those. It never asks "which country is this".
Outside the tests, a search for `'UK'`, `'US'` or `'DK'` in the server finds the policies, the demo data, the benchmarks and one rule in the mock AI, and nothing in the workflow.

**The regulatory model was corrected after a domain review**, which is the honest evidence that it is a model and not a
claim: the PDMR clock runs from the transaction, not from the notification (L-19); 7.01 and 8.01 have no deadline and 1.05
counts from the materiality determination (L-20); filer status gates 8-K against 6-K (L-21); inside information is
released even when the RNS window is closed (L-22). Logged in [discovery/ledger.md](../discovery/ledger.md).

## 3. Without duplicating effort: extending to more jurisdictions

### What is written once

The state machine and its transitions, revisions and hashing, the MAR rules the UK and the EU share (`mar.ts`), maker-checker and approval binding, the publication runner
(lease, retry, idempotency, sweeper), the audit chain, tenant isolation, the event outbox, readers and subscriptions, the
REST API, and the whole UI. Shared validation (headline length, empty body, leftover placeholders, issuer profile, schema,
deadline passed) lives in `definePolicy` once.

### What a jurisdiction supplies

1. **A policy file** in `apps/server/src/jurisdictions/`: categories with schemas, rules, deadlines, approval
   requirements, window and calendar, identifier checks, rendering.
2. **A gateway adapter** implementing `PublishGateway`.
3. **Two registrations**: the policy in `jurisdictions/index.ts`, the gateway in `runtime.ts`.
4. **Issuer profile data** for the identifiers the channel needs.

No migration, no workflow change, and no UI change: the jurisdiction menu, the category menu, the generated detail form,
the filters in the archive and the activity log, the publishing console and the follow form all read the registered
policies from the server.

### Proof

Denmark is the proof. It was added as one policy file (`dk.ts`), one gateway class, two registrations and a profile in the
seed, and the workflow was not touched; it has since grown to the widest category set of the three without touching the workflow again. `operations.test.ts`, "adding a jurisdiction", registers Denmark as the **only**
jurisdiction and runs a draft to publication through the unchanged workflow; a second check shows an unregistered one is
refused with a clear error; `workflow.test.ts` covers Denmark end to end, including a retry. `JurisdictionCode` is a plain string and no database column restricts it.

### Costs and limits, stated

- A jurisdiction whose **workflow shape** differs (for example a regulator pre-clearance step before release) needs a new
  transition, not only a policy. That is the first thing the next jurisdiction may force
  ([ARCHITECTURE §3](ARCHITECTURE.md#3-trade-offs-i-accepted)).
- Nothing in the UI or the workflow names a jurisdiction any more: the sample text for the "Fill with example content"
  button and the word a channel uses for sending ("filing" for EDGAR) are fields of the policy, and a test fails the
  build if `domain`, `application`, `http`, `ports`, `auth` or the web app contain a jurisdiction or channel name.
- The demo data, benchmarks and the mock-AI rules name the jurisdictions; they are not logic. The AI pre-check reads Danish and English wording and flags a language mismatch.
- All three jurisdictions are models. The Danish thresholds (flagging levels, notice periods, the managers' transaction limit), hours and wording are assumptions to confirm with Danish counsel before real use, as the UK and US ones are for their own counsel.
- Policies are code, reviewed in a pull request. Policies from a database or an admin UI for non-engineers are a listed
  option, not built (ASR-2 in [handoff.md](../discovery/handoff.md)).
- The extension guide: [MODULES.md, "Add a jurisdiction"](MODULES.md#add-a-jurisdiction).

## 4. Verified, measured, designed

| | Status |
|---|---|
| Draft to published in UK, US and Denmark, through the UI, the REST demo and the tests | **Verified by running it** |
| Retry, exhaustion, permanent rejection, lost acknowledgement, lease takeover, lost wake-up | **Verified** (tests) |
| Same suite on SQLite and on PostgreSQL + Redis, two worker processes, no double release | **Verified** |
| OIDC against Keycloak, Authorization Code + PKCE through a real browser | **Verified** |
| Compose twin: separate api, worker, notifier, agents; mail delivered; cache hit | **Verified** |
| Throughput and latency numbers | **Measured** on a laptop under Azure-sized limits |
| Azure Terraform | **Designed**; `validate`, tflint, trivy, checkov and 42 mocked tests pass; **never applied**. The unproven items and the check for each are in [infra/azure/README.md](../infra/azure/README.md) |
| Second region and failover | **Designed**, never rehearsed ([DR.md](DR.md)) |
| The Anthropic provider against the live API | Not exercised (tested against a stubbed `fetch`) |
| Legal correctness of the rules | Not verified: simplified models, not legal advice |
| Real RNS, EDGAR and Nasdaq Copenhagen behaviour | Unknown without access; real providers have no idempotency-key lookup, so the "find before resubmit" step needs a different design there |

## 5. Questions I expect, and the short answers

- **Why a modular monolith?** One team, one deployable, and a state machine that needs transactional consistency across
  announcement, approvals, publication and audit. The seams that matter (queue, worker role, database adapter, consumers)
  are already separate, so services can be cut along them.
- **What if Redis or the queue is lost?** Nothing is lost: the row is the truth and the sweeper re-enqueues overdue rows.
- **How do you stop a double release?** The lease token, the idempotency key looked up at the wire before a resubmit, and a
  unique claim; tested with a crashed worker and a lost acknowledgement.
- **What if the mail service is down?** The notification retries on its own delivery row; publishing is unaffected.
- **How did you add the third market?** Section 3. Denmark reuses the MAR rules the UK uses and adds a language rule, a
  notification threshold, a CVR number, a market segment, its own calendar and its own channel, and adds three categories (major shareholders, buybacks, meeting notices). A fourth (Sweden, Germany) would reuse
  `mar.ts` the same way; the first thing a very different regime could force is a new workflow transition (pre-clearance).
- **Where would it break first?** Database connections and text search; the ADR has the numbers and the exit.
- **Is the AI in the critical path?** No. It is advisory, behind a port, validated, and the whole workflow is tested with
  it off ([ARCHITECTURE §2.5](ARCHITECTURE.md#25-ai-is-advisory-and-optional)).
- **What is not done?** Scheduled release and embargo, attachments and iXBRL, corrections after publication, real newswires.
  The list, with the reason each was cut, is [ARCHITECTURE §5](ARCHITECTURE.md#5-what-was-cut-and-why).
