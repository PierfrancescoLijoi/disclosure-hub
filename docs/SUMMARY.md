# Summary: architecture, decisions, trade-offs, next steps

One page. Every claim here is expanded, with its proof, in [BRIEF-RESPONSE.md](BRIEF-RESPONSE.md); the rest of the
documents are listed under "Additional details" in the [README](../README.md#documentation-map).

## What it is

Investor-relations software that takes a regulatory announcement from **draft to published** through one workflow, in three
jurisdictions: **UK** (RNS, UK MAR), **US** (EDGAR, Form 8-K, Reg FD) and **Denmark** (Nasdaq Copenhagen, EU MAR). The
newswires are mocks; everything else runs: UI, API, approvals, publishing, audit, public archive, subscriptions.

Run it: `npm install && npm start`, then open <http://localhost:3000> ([details](../README.md#run-it-in-30-seconds)).

## Architecture

A **modular monolith with hexagonal boundaries** in TypeScript. One codebase and one image, started in different **roles**
(`api`, `worker`, `events`) so each part scales on its own.

```text
 browser ──> api ──> database (SQLite locally, PostgreSQL in containers and Azure)
                       ▲   │ publication row = the truth
              worker ──┘   └─ queue = only a wake-up signal
                │
                └─> gateway (RNS | EDGAR | Nasdaq Copenhagen)  ──> receipt
 outbox (same transaction) ──> notifier, advisory agents
```

Diagrams: [use cases](diagrams/01-use-cases.drawio.png), [Azure](diagrams/02-azure-architecture.drawio.png),
[local](diagrams/03-local-architecture.drawio.png).

## What is shared and what differs (UK, US, Denmark)

| Layer | Written once, used by all three | Shared by UK and Denmark only | Written per jurisdiction |
|---|---|---|---|
| Workflow | State machine, revisions and hash, maker-checker, approval binding, audit chain, tenant isolation | | Nothing |
| Validation | Common checks in `definePolicy` (headline, empty body, placeholders, issuer profile, schema, deadline passed); business-day maths in `domain/calendar.ts`; identifier checks in `jurisdictions/identifiers.ts` | MAR rules and deadlines for inside information, managers' transactions and results (`mar.ts`, 122 lines), each policy supplying its own calendar, time zone and code prefix (`UK_MAR_*`, `EU_MAR_*`) | **Policy file:** `uk.ts` (97 lines), `us.ts` (248), `dk.ts` (383): categories and their fields, specific rules, deadlines, approvals, window, rendering, issuer profile |
| Publishing | Runner (lease, retry, idempotency key, sweeper), the `PublishGateway` contract, the mock gateway base class (lookup by key, replay safety, failure modes) | | **Gateway subclass:** what the channel accepts and rejects, and its receipt (RNS number, EDGAR accession number, `n/year`) |
| After publishing | Outbox, public archive, subscriptions, agents | | Post-publication obligations (in the policy) |
| API and UI | Whole REST API and whole UI; forms are generated from each category's schema | | Nothing (menus and forms read the registered policies); sample text for the example button |
| Data | One migration, no jurisdiction column constraint | | Holiday calendar (`jurisdictions/calendars.ts`) and seed data for the issuer's identifiers |

How they differ in substance (categories, deadlines, approvals, windows, identifiers, receipts) is tabulated in the
[README](../README.md) and, with where each difference lives, in [BRIEF-RESPONSE §2](BRIEF-RESPONSE.md#2-regulatory-and-operational-differences-two-kinds-two-homes).
The US does not share `mar.ts` because Form 8-K and Reg FD are a different regime, not another copy of MAR.

Adding a jurisdiction means writing only the right-hand column: one policy file, one gateway subclass, two registrations
([MODULES.md](MODULES.md#add-a-jurisdiction)).

## Key decisions

| Decision | Why |
|---|---|
| **Regulatory differences in a policy, operational differences in a gateway.** A policy holds categories, validation, deadlines, approvals, windows and rendering; a gateway holds the delivery to one channel. | They change for different reasons and have different owners (compliance vs engineering). The workflow never asks "which country". |
| **A new jurisdiction is a policy file, a gateway and two registrations.** | No duplicated effort. Denmark was added exactly this way, with no change to the workflow, the migrations or the UI. |
| **The database row is the truth; the queue is only an alarm clock.** A lease with a token and an idempotency key (`announcementId:revision`), checked at the channel before any resend. | The worst failure is publishing twice or never. Losing the queue loses nothing; a sweeper re-queues. |
| **Immutable revisions with a content hash; approvals bound to that hash; maker-checker; hash-chained audit.** | An approver can only approve what they read, and tampering is detectable. |
| **Everything after a workflow step is a consumer of a domain event, written in the same transaction (outbox).** | Notifications and agents cannot diverge from the published state and can be added without touching the workflow. |
| **AI is advisory only,** behind a port, validated, off by default with a real provider. | It cannot approve, edit or publish; the system works identically without it. |
| **Module boundaries enforced by a test.** | The domain stays pure; the build fails if a layer imports across a boundary. |

## Trade-offs accepted

| Choice | Gain | Cost |
|---|---|---|
| Modular monolith | Transactional consistency, one deploy | The single database is the shared bottleneck (exits defined in [ADR 0001](adr/0001-database-bottleneck-and-service-bus.md)) |
| Declarative policies | Rules reviewable in one file | A regime with a different workflow *shape* (regulator pre-clearance) needs a new transition |
| Text timestamps and JSON, one migration | Same tests on SQLite and PostgreSQL | No database-side JSON or date queries |
| Queue as hint, polled outbox | Survives queue loss, no broker | Up to one polling interval of latency, a table to prune |
| Mock newswires with failure modes | Error paths are demonstrable and tested | Real RNS/EDGAR/Nasdaq semantics are unknown until integrated |
| Simplified rules | Shows how jurisdiction logic is enforced | Not legal advice; needs review by counsel |

## What is proven and what is not

- **Verified by running it:** draft to published in all three jurisdictions; retries, lost acknowledgement, crash and
  takeover; 217 server tests on SQLite and all 224 on PostgreSQL 16 + Redis 7; real OIDC (Keycloak) in the container setup.
- **Measured on a laptop with Azure resource limits:** about 15 publications per second with 2 workers against an expected
  peak of 0.17 per second ([SIZING.md](SIZING.md)).
- **Designed, never applied:** the Azure Terraform. It is validated offline (42 mocked tests, lint and security scans), and
  the README of `infra/azure` lists the eleven points a first deploy must prove.

## What I would do next

1. A fourth jurisdiction with a different shape (a regulator pre-clearance step).
2. Scale workers on queue age instead of CPU (arrives with Service Bus).
3. A first deploy to a `test` Azure subscription, then record failover and restore times.
4. Transactional enqueue, row-level security, and anchoring the audit chain heads in write-once storage.
5. OpenTelemetry across API, queue, worker and channel; an evaluation gate before enabling a real LLM.
6. Scheduled and embargoed release, attachments, and a global cap on gateway concurrency.

Full list with reasons: [ARCHITECTURE.md §7](ARCHITECTURE.md#7-what-i-would-do-next).
