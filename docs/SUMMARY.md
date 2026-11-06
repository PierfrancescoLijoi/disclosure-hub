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
[local](diagrams/03-local-architecture.drawio.png), [local scaling](diagrams/04-local-scaling.drawio.png).

**Containers, why each is separate, and what each scales on.** The split follows how each part waits and fails, not the code layout:
a process that waits on a slow vendor, a mail server or a model must not slow the one that answers people.

| Container | What is in it | Why it is separate | Scales on | One copy handles |
|---|---|---|---|---|
| `api` | REST, public reads, token check | It must never wait on a newswire | People and readers (requests) | About 80 write requests/s on 0.5 vCPU |
| `worker` | Files to the newswire, retries, lease | It waits on the vendor and may fail; a slow or down newswire must not slow the API | Publications per second | 2 in flight / vendor latency: 10/s at 200 ms (9 measured). Up to 6 copies |
| `notifier` (`ROLE=events`) | Reader e-mails and webhooks, drained from the outbox | A slow mail server must never delay a publication | Followers per announcement | About 275 followers/s |
| `agents` (`ROLE=events`) | The AI pre-check, advisory only | A slow or costly model must not slow publishing or e-mails; a new agent is one more process | Submissions (one model call each) | Set by the model, not the CPU |
| `migrate` | The schema, run once before `api` and `worker` start | One owner for the schema, with its own rights | Does not scale | Runs once |
| `postgres` | Data, job queue, event outbox, audit chain | One database so a step, its audit entry and its event commit in one transaction | Does not scale out here | The shared limit: 1 vCPU, and `(api + workers + events) x 5` connections under 100 |
| `web`, `keycloak`, `mailpit` | The app and edge limit; sign-in; an SMTP sink | Stand-ins for Front Door, Entra ID and Communication Services Email | Do not scale | Azure replaces them |

Measured on one laptop with Azure-sized limits: 1 worker 9 published/s, 3 workers 16/s (the API is the limit), 2 APIs about 20/s
(PostgreSQL is the limit). The expected peak is 0.17/s. Commands and detail: [Scale it locally](../README.md#scale-it-locally).

## What is shared and what differs (UK, US, Denmark)

| Layer | Written once, used by all three | Shared by UK and Denmark only | Written per jurisdiction |
|---|---|---|---|
| Workflow | State machine, revisions and hash, maker-checker, approval binding, audit chain, tenant isolation | | Nothing |
| Validation | Common checks in `definePolicy` (headline, empty body, placeholders, issuer profile, schema, deadline passed); business-day maths in `domain/calendar.ts`; identifier checks in `jurisdictions/identifiers.ts` | MAR rules and deadlines for inside information, managers' transactions and results (`mar.ts`, 122 lines), each policy supplying its own calendar, time zone and code prefix (`UK_MAR_*`, `EU_MAR_*`) | **Policy file:** `uk.ts` (97 lines), `us.ts` (248), `dk.ts` (383): categories and their fields, specific rules, deadlines, approvals, window, rendering, issuer profile |
| Publishing | Runner (lease, retry, idempotency key, sweeper), the `PublishGateway` contract, the mock gateway base class (lookup by key, replay safety, failure modes) | | **Gateway subclass:** what the channel accepts and rejects, and its receipt (RNS number, EDGAR accession number, `n/year`) |
| After publishing | Outbox, public archive, subscriptions, agents | | Post-publication obligations (in the policy) |
| API and UI | Whole REST API and whole UI; forms are generated from each category's schema | | Nothing (menus and forms read the registered policies); the sample text for the example button and the channel's send word are fields of the policy |
| Data | One migration, no jurisdiction column constraint | | Holiday calendar (`jurisdictions/calendars.ts`) and seed data for the issuer's identifiers |

How they differ in substance (categories, deadlines, approvals, windows, identifiers, receipts) is tabulated in the
[README](../README.md) and, with where each difference lives, in [BRIEF-RESPONSE §2](BRIEF-RESPONSE.md#2-regulatory-and-operational-differences-two-kinds-two-homes).
A test fails the build if the workflow, the API or the web app names a jurisdiction or a channel. The US does not share `mar.ts` because Form 8-K and Reg FD are a different regime, not another copy of MAR.

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
  takeover; 224 server tests on SQLite, with 7 PostgreSQL/Redis integration tests run by CI; real OIDC (Keycloak) in the container setup.
- **Scaling on one machine:** every container, its limit and whether it was run are in the README section [Scale it locally](../README.md#scale-it-locally).
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
