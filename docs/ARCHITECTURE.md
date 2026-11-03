# Architecture write-up

Scope: an investor-relations platform that takes a regulatory announcement from draft to published in
the **UK (RNS, UK MAR)** and the **US (EDGAR, Form 8-K, Reg FD)**. The rules are simplified models, not
legal advice; both newswires are mocks.

## 1. Shape

A modular monolith with hexagonal boundaries, in TypeScript end to end. One codebase, one image;
`ROLE=api | worker | all` decides what a process does.

```
 React SPA ──REST (Zod)──▶ http ──▶ application ──▶ domain (pure)
                                        │  │            ▲
                                        │  └──▶ jurisdictions (policy plug-ins)
                                        ▼
                                     ports ◀── adapters: db (SQLite | Postgres)
                                                         queue (in-process | BullMQ/Redis)
                                                         gateways (mock RNS | mock EDGAR)
                                                         ai (mock | Anthropic)
```

An architecture test fails the build if `domain` imports anything outside itself, if `jurisdictions`
touch adapters or the application layer, or if the application layer imports an adapter. The
boundaries are enforced, not just drawn.

**Why a monolith:** one team, one deployable, a state machine that needs transactional consistency
between announcement, approvals, publication and audit. The seams that matter for scale (the queue,
the worker role, the database adapter) are already separate; services can be cut along them later.

## 2. Key decisions

### 2.1 Jurisdictions are data plus two small adapters, not branches in the workflow

The workflow (state machine, approvals, revisions, publish, retry, audit) exists **once**. A jurisdiction
is a `definePolicy({...})` value plus a gateway adapter, registered in a `PolicyRegistry`:

- categories, each with a **Zod schema** for its metadata (the UI form is generated from `z.toJSONSchema`, so a new category needs no UI work);
- validation rules, deadlines and publication windows, post-publication obligations, rendering to the wire payload;
- an approval requirement per category: `{ min, mustInclude: roles }`, which can depend on the metadata (US: an 8-K with item 2.02 needs legal **and** the CFO, other items need legal and one more);
- identifier checks (LEI mod-97, ISIN Luhn, CIK/CCC shapes) and the business-day calendar.

Shared rules (e.g. maker-checker, content-hash binding) live in `definePolicy` defaults, once.
**Evidence:** `operations.test.ts` registers a made-up third country with one policy and one fake
gateway and runs it through the unchanged workflow. No workflow file is touched.

What the two jurisdictions actually differ on, as modelled:

| | UK | US |
|---|---|---|
| Timing | MAR Art. 17: as soon as possible (a delay needs a recorded reason); PDMR: 3 business days; DTR 4 results deadlines | 8-K: 4 business days; Reg FD: later of 24 h or next market open |
| Window | RNS hours | EDGAR 06:00 to 22:00 ET; after 17:30 ET the filing date is the next business day |
| Extra | PDMR / results categories | Exhibit 99.1 required for item 2.02; Reg FD flag for item 7.01 |
| Acknowledgement | RNS number | accession number + filing date |

### 2.2 Publishing is the risky step, so it is built to be reliable, not fast

Releasing a regulatory announcement twice, or not at all, is the worst failure in this domain.

- **The database row is the source of truth; the queue is only a wake-up.** A lost job (Redis flushed, process killed) is recovered by a sweeper that re-enqueues overdue rows. The queue can therefore be at-least-once and unreliable without consequence.
- **Lease with a token.** A worker claims a publication with a compare-and-set that sets a lease; finishing checks the token, so a worker that was too slow cannot overwrite the result of the one that took over. A second worker cannot claim a live lease.
- **Idempotency key `announcementId:revision`** is sent to the wire, and the runner calls `find(key)` before `submit`. If the wire accepted but the acknowledgement was lost, the next attempt finds the filing instead of sending a duplicate. This is the "ack lost" demo mode.
- **Retry policy:** transient errors back off exponentially with jitter up to a budget, then the publication is `exhausted` and the announcement `failed` with a visible **Retry** action; permanent rejections are not retried (the fix is a corrected revision).
- **Per-gateway concurrency limit** per worker, to respect vendor rate limits, and a **timeout** on every gateway call (half the lease) so a hung vendor connection fails as transient and frees its slot instead of blocking the channel.
- **Anything unexpected after a claim** (a throw in a rule, a store error) is routed through the same retry budget, so a publication always ends in a visible state and never loops on lease expiry.
- **Delayed wake-ups can land early** (timer and database clocks differ by a millisecond). The runner re-arms them rather than dropping them. A stress run found exactly this race (a dropped wake-up when the remainder had already elapsed), now fixed and covered.

### 2.3 Integrity and audit

- **Immutable revisions** with a content hash. An approval is bound to the hash of what was reviewed; editing, re-opening or requesting changes **voids** approvals. At release time the runner re-checks that the approved hash is the content being sent (`approvedContentProblem`).
- **Maker-checker:** the author of a revision cannot approve it; each required role needs a distinct approver. The UI sends the revision the approver was looking at, and the server answers 409 `STALE_REVISION` if it was replaced meanwhile, so an approval never lands on text the approver has not seen.
- **Per-announcement audit trail, hash-chained:** each event hashes the previous one, and `(announcement_id, seq)` is unique, so concurrent writers cannot fork the chain. `verifyAuditChain` detects edits, deletions and reordering; the UI and the demo print the result. This is tamper-evident, not tamper-proof: someone who can rewrite the whole table can rewrite the chain (see section 5).
- **Tenant isolation:** every query is filtered by issuer; another company's announcement is a 404, not a 403.
- **Optimistic concurrency:** each announcement has a version; updates are compare-and-set.
- **Idempotent create** through the `Idempotency-Key` header. Publish takes the announcement version check first, so two concurrent publishes give one success and one clean 409.

### 2.4 Storage and queue behind ports, one migration

Kysely over SQLite (local) and PostgreSQL (Compose) with one portable migration: text ids, ISO-8601
text timestamps, JSON stored as text. The cost is no native `timestamptz`/`jsonb` in Postgres;
the gain is that the same SQL, the same tests and the same behaviour run on both. BullMQ/ioredis is
the production queue, an in-process queue (with delays and bounded concurrency) is the local one.

### 2.5 AI is advisory and optional

A pre-check suggests classification, missing information and UK MAR / US Reg FD risks, with the
quoted evidence for each. It is a separate table and a separate port, so it cannot affect a status.

- Output is validated with Zod and against the policy's category vocabulary; malformed or out-of-vocabulary output is discarded.
- The Anthropic provider sends the announcement as quoted data with a system prompt that tells the model not to follow instructions inside it (prompt-injection guard). Provider failure returns an error for the pre-check only.
- Default is a deterministic mock, so tests and the demo need no key or network. `AI_PROVIDER=off` hides the feature; a test runs the whole workflow with it off.

## 3. Trade-offs I accepted

| Choice | Gain | Cost |
|---|---|---|
| Declarative policies | New jurisdiction is mostly data; rules are reviewable in one file | Jurisdictions needing very different workflow *shape* (e.g. a regulator pre-clearance step) need a new transition, not just a policy |
| Text timestamps and JSON text | One migration, two databases, identical tests | No DB-side JSON/time queries; a reporting layer would want real types |
| DB row as truth, queue as hint | Survives Redis loss, simple reasoning | Sweeper adds up to one interval of latency after a lost wake-up; polling cost |
| Hash chain per announcement | Cheap, local, verifiable | Does not stop a privileged actor rewriting history (needs external anchoring) |
| Persona auth | No identity-provider work in a time-boxed build | Not a security boundary; authorization logic is real, authentication is not |
| Mock newswires with chaos modes | Failure paths are demonstrable and tested | Real RNS/EDGAR semantics (rejections, fee, test filings) are unknown until integrated |
| Vite + React, not Next.js | Smaller, no server rendering needed | A deviation from the brief's example stack |

## 4. Scaling

What exists and was checked:

- **Stateless API** processes behind any load balancer; all state in PostgreSQL.
- **Workers scale horizontally**: `docker compose up --scale worker=3` ran end to end, and a test runs two worker processes against one Postgres and one Redis over eight publications and asserts eight distinct releases, no duplicates.
- **Backpressure and fairness** come from per-worker job concurrency and per-gateway concurrency.
- **Hot paths are indexed row lookups.** The one scan, the sweeper, reads overdue publications in batches of 100.

**Measured** (`npm run bench`, Compose stack on one laptop under Docker Desktop, REST only, 300 announcements, 20 in flight, mock newswire answering in 200 ms, per-worker gateway concurrency 2):

| Workers | Published per second | Theoretical ceiling (2 / 0.2 s per worker) |
|---|---|---|
| 1 | 9 | 10 |
| 3 | 27 | 30 |

Throughput scales linearly with workers and sits at about 90% of the ceiling set by the vendor call. Across both runs plus a first one (900 publications): 900 acknowledged, 900 distinct external references, 0 failed attempts, so no duplicate releases under concurrency. The API accepted about 55 to 60 full draft-to-publish-request sequences per second (5 calls each, p95 under 0.6 s) on a single API process.

The benchmark found a real artefact on its first run: the mock newswire allocated release numbers with an optimistic max+1 insert, so concurrent submissions collided and were retried by the platform with 2 s backoff, capping the rate near 7 per second. The platform handled it correctly (no duplicates); the mock was changed to retry the number allocation itself, as a real wire would.

**Sweeper cost.** The sweeper and the claim path only read non-terminal rows, served by two partial indexes (`publications_waiting`, `publications_leased`). Checked with `EXPLAIN ANALYZE` on PostgreSQL 16 with 300,000 finished publications and 5 waiting: bitmap index scans on both, 0.28 ms, independent of history size.

**Capacity controls that exist:** per-actor rate limit (600/min default), tighter limit on the AI pre-check (20/min), an nginx per-address limit in front of the API, a Postgres pool size per process (`PG_POOL_MAX`), per-worker job and per-gateway concurrency, and `GET /metrics` including the age of the oldest waiting publication for alerting.

Not measured: more than 3 workers, a remote database, sustained load over hours, Redis or Postgres failure under load. The first limits I expect are the database connection pool and the sweeper scan; a partial index on non-terminal publications is the next step. These are laptop numbers, a trend and a method, not a capacity promise.

Next steps for real scale: partitioning or archiving the audit table, a connection pooler (PgBouncer), moving the queue enqueue into a transactional outbox, per-tenant (not only per-actor) quotas.

### Deployment topology (designed, not applied)

Compose is the only environment I ran. The shape for a real deployment follows from the design and needs no code change:

- API and worker as separate stateless deployments, at least two replicas each, spread across availability zones; workers scale on the *oldest waiting publication* metric rather than CPU.
- PostgreSQL as a managed multi-AZ primary with a synchronous standby; Redis as a managed replicated cache. Redis loss is survivable by design (the sweeper rebuilds the queue from the database); database loss is not, so the database is where durability money goes.
- Secrets (database URL, provider key) from a secret manager, not environment files; managed identity to the database where the platform allows it.
- No Terraform or Kubernetes manifests are included: I could not validate them here, and unvalidated infrastructure code would claim more than I have verified.

## 5. What was cut, and why

Cut in this order, to protect the end-to-end flow, test quality and publish reliability:

- **Scheduled release and embargo.** Real feature, orthogonal to the core path; the delayed-job and window machinery it needs already exists.
- **Attachments and iXBRL / structured financial data.** Large surface, little extra evidence of architecture. EDGAR exhibits are modelled only as a required flag.
- **Real authentication (OIDC / SSO) and per-user MFA.** Roles and tenant isolation are enforced; identity is seeded.
- **Real newswire integrations.** Interfaces and error taxonomy are in place; vendor behaviour is unknown without access.
- **Translations / multilingual notices, additional categories** (UK: more DTR items; US: more 8-K items).
- **Notifications** (email/Slack to approvers), **reporting** and search.
- **Distributed tracing.** Structured logs and a metrics endpoint exist; no OpenTelemetry traces across api, queue and worker.

## 6. Verified, and only designed

Verified by running it:

- Draft to published in UK and US through the UI, the REST demo and the tests.
- Retry with backoff, exhaustion and manual retry, permanent rejection, lost acknowledgement (reconciled), lease takeover after a crash, lost wake-up recovery by the sweeper.
- Same suite on SQLite (96 tests) and on PostgreSQL + Redis (99 tests, including two workers).
- An independent code review and security review of the final code. Fixed from them: authentication decided on the matched route (an encoded path such as `/%61pi/...` skipped it), persona auth refused when `DEMO=0`, malformed list cursor now 400, approval bound to the reviewed revision, publish race now 409, gateway timeout and crash-after-claim handling, Compose ports on localhost.
- The `docker compose up --build` stack (migrate, api, worker, web) with the demo run through nginx, and with three workers.
- Typecheck for server and web.

Not verified, or only designed:

- The Anthropic provider against the live API (the request/response shape is tested against a stubbed `fetch`).
- Load, soak and failure injection at the infrastructure level (Postgres failover, Redis eviction under memory pressure).
- Browser compatibility beyond one browser; accessibility was not audited.
- The legal correctness of the rules.

Known, deliberately not fixed (noted by the reviews): `DEMO` defaults to on so that `npm start` works out of the box; the real-LLM provider sends unpublished text to a third party and needs an explicit per-tenant opt-in before production. Fixed after the reviews: rate limiting, the closed-channel release rule, and the idempotent-create race.

## 7. What I would do next

1. **A third jurisdiction** (EU/ESMA via a national channel, or Nasdaq Copenhagen) to test the abstraction on a shape other than UK/US; add a "regulator pre-clearance" transition if it needs one.
2. **Transactional outbox** for enqueue, so a crash between commit and enqueue never relies on the sweeper.
3. **Row-level security** in Postgres as a second tenant-isolation layer under the query filter.
4. **Anchoring audit chain heads** to write-once storage (or a signed timestamp) to turn tamper-evident into tamper-resistant.
5. **OpenTelemetry**: traces across api, queue, worker and the wire; metrics for lease takeovers, retries, time to acknowledgement; alerts on exhausted publications.
6. **Evaluation gate for the real LLM:** a labelled set of announcements and a threshold on recall for risk flags before the provider is allowed on in production.
7. **Real identity** (OIDC), per-role step-up for publish, and scheduled / embargoed release.
