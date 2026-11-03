# Disclosure Hub

Regulatory announcements for listed companies: an announcement goes from **draft to published** in two
jurisdictions, with one shared workflow and per-jurisdiction rules and delivery.

| | UK | US |
|---|---|---|
| Regime | UK MAR, Listing Rules, DTR | Exchange Act, Form 8-K, Reg FD |
| Channel | RNS (mock) | SEC EDGAR (mock) |
| Categories | inside information, PDMR dealing, results, general | Form 8-K (items 1.01, 2.02, 5.02, 7.01, 8.01) |
| Acknowledgement | RNS number, e.g. `0001B` | accession number, e.g. `0001234567-26-000001` |

> **The rules are simplified models, not legal advice.** They show how jurisdiction logic is
> expressed and enforced, and they are only as good as their stated sources. Real use needs review by
> counsel and the real channel integrations. Both newswires are mocks. Sign-in is real OIDC in the container and Azure
> setups (Keycloak locally, Microsoft Entra ID on Azure); `npm start` uses seeded personas for a zero-install demo.

The write-up of design, trade-offs, what was cut and what comes next is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Sizing for a small or medium company, with measurements:
[docs/SIZING.md](docs/SIZING.md). The Azure deployment: [infra/azure/README.md](infra/azure/README.md).

## One architecture, three ways to run it

| | `npm start` | `docker compose up` (the Azure twin) | Azure (`infra/azure`) |
|---|---|---|---|
| Sign-in | Seeded personas (`x-user-id`), demo only | **OIDC**: Keycloak, Authorization Code + PKCE | **OIDC**: Microsoft Entra ID, roles from app roles |
| Database | SQLite file | PostgreSQL 16 | PostgreSQL Flexible Server, zone-redundant, Entra-only |
| Queue | In-process | PostgreSQL `LISTEN/NOTIFY` | Same |
| Processes | One | api, worker x N, migrate job | Container Apps api, worker (2+ each), migrate job |
| Secrets | none | demo passwords in the compose file | none stored: managed identities, Key Vault |
| Status | run and tested | run and tested | **validated offline, not applied** |

The same container image and the same business logic run in all three; environment variables choose the adapters.

## Run it

### Mode 1: local, nothing to install but Node

Needs Node 20.19 or newer.

```bash
npm install
npm start
```

Open <http://localhost:3000>. SQLite file in `apps/server/data/`, in-process job queue, one process.
For development, `npm run dev` runs the server with reload and `npm run dev -w apps/web` serves the UI on
<http://localhost:5173> (proxies `/api` to :3000).

### Mode 2: containers, PostgreSQL, real sign-in (the local twin of Azure)

```bash
docker compose up --build
```

Open <http://localhost:8080> and sign in (nginx serves the app and proxies `/api`; the API is also on :3000).
Services: `postgres`, `keycloak` (identity provider, realm imported from `deploy/keycloak`), `migrate` (one-shot),
`api`, `worker`, `web`. Resource limits match the Azure replicas (see [docs/SIZING.md](docs/SIZING.md)).
More publishing capacity is one flag, nothing else changes (two workers is the Azure default):

```bash
docker compose up --build --scale worker=2
```

The browser signs in with Authorization Code + PKCE and the API verifies the signed token (issuer, audience, signature,
expiry); roles come from the token. Users `alice`, `bob`, `carol`, `dan`, `erin` with the password `hub-dev-only`
(a local value, in `deploy/keycloak/realm-hub.json`). Keycloak's admin console is on <http://localhost:8081>.

Modes 1 and 2 run **the same business logic, API, rules and state machine**. Only the adapters differ (database,
queue, identity, process split). `docker compose down -v` removes the data. The previous Redis/BullMQ topology is still
supported: set `QUEUE_URL=redis://...`.

### Mode 3: Azure

`infra/azure` is the Terraform for the same architecture on managed services, with Entra ID sign-in and no stored
credentials. It was validated, linted, scanned and tested offline (`bash infra/azure/scripts/verify.sh`); it was
**never applied**, and the README there lists exactly what the first deploy still has to prove.

### Try it

Personas (in `npm start` pick one on the sign-in page, the API reads the `x-user-id` header; in Compose sign in as the same names; `frank` exists only in demo mode):

| Persona | Roles | Company |
|---|---|---|
| `alice` | author | Northwind Energy plc (UK + US) |
| `bob` | company secretary | Northwind |
| `carol` | general counsel (legal) | Northwind |
| `dan` | CFO | Northwind |
| `erin` | publisher | Northwind |
| `frank` | author + publisher | Contoso Biologics Inc. (US only) |

Walk-through in the UI: as `alice` choose *New announcement*, pick a jurisdiction and category, use
*Fill with example content*, save, **Validate**, **Submit for review**. Switch to the approvers the page asks for
and approve. As `erin` press **Publish**. The detail page shows the acknowledgement, the deadline
and what is still owed after publishing, and the hash-chained audit trail.

The **Mock newswires (demo)** panel makes delivery fail on purpose: transient failures (then success),
a permanent rejection, or a lost acknowledgement (the wire accepts, the acknowledgement never
arrives; the retry finds the earlier filing instead of sending a duplicate).

Without a browser, drive the whole thing through the REST API (one announcement per jurisdiction):

```bash
npm run demo                              # npm start on http://localhost:3000, persona header
AUTH=oidc npm run demo                    # the Compose stack, with a real bearer token per person
```

## Throughput check

```bash
npm run bench                                       # 300 announcements through the REST API
GATEWAY_LATENCY_MS=200 N=300 npm run bench          # newswire answering in 200 ms
```

The per-actor rate limit would throttle the benchmark (one person sends everything), so start the stack with `RATE_LIMIT_PER_MIN=0 docker compose up --build --scale worker=2`
and run `AUTH=oidc GATEWAY_LATENCY_MS=200 N=200 CONCURRENCY=5 npm run bench`. Results under the Azure-sized limits are in
[docs/SIZING.md](docs/SIZING.md); worker scaling in the architecture write-up. Note that `GATEWAY_LATENCY_MS` stays set in the mock until you change it.

## Observability

`GET /metrics` (Prometheus text, on the API port): publications and announcements by status, and the age of the oldest publication waiting for a worker. That last gauge is the one to alert on: it grows when workers are down, the queue is lost, or a newswire is failing. It is not proxied by the nginx container; keep it off the public edge. Logs are structured JSON.

## Tests

```bash
npm test            # 114 server tests (7 need PostgreSQL or Redis and are skipped), SQLite in memory, a few seconds
npm test -w apps/web   # 12 UI logic tests (diff, attention queue, readiness)
npm run typecheck
```

The same suite runs against the production adapters:

```bash
docker run -d --name hub-test-pg -e POSTGRES_USER=hub -e POSTGRES_PASSWORD=hub-dev-only -e POSTGRES_DB=hub_test -p 55432:5432 postgres:16-alpine
docker run -d --name hub-test-redis -p 56379:6379 redis:7-alpine

TEST_PG_URL=postgres://hub:hub-dev-only@localhost:55432/hub_test \
TEST_REDIS_URL=redis://localhost:56379 \
npm test -w apps/server -- --no-file-parallelism     # 121 tests
```

With `TEST_PG_URL` every integration test runs on PostgreSQL (the schema is dropped and recreated per
test). With `TEST_REDIS_URL` the BullMQ tests run, including two worker processes sharing eight
publications with no double release. The gated tests are skipped, not faked, when the variables
are missing.

What the tests cover:

- `domain`: state machine, permissions, content hash, audit chain tamper detection, business-day calendar and time-zone windows.
- `policies`: UK and US validation, deadlines, approval requirements, rendering, identifier checks (LEI, ISIN).
- `workflow`: the full draft to published path in both jurisdictions, revisions and voided approvals, retry, lost acknowledgement, lease takeover, lost wake-up recovery, idempotent publish, permanent rejection.
- `hardening`: approvals bound to the reviewed revision, a hanging gateway times out and fails visibly, rate limits per actor, metrics output, the sweeper indexes, concurrent idempotent create.
- `operations`: publication windows, adding a third jurisdiction without touching the workflow, AI pre-check safety, an architecture test that fails the build on forbidden imports.
- `auth`: OIDC bearer tokens against a local JWKS: valid, expired, wrong audience or issuer, forged signature, unknown role, discovery down (503), company from claim.
- `pgqueue`: the PostgreSQL `LISTEN/NOTIFY` queue on a real database, two workers, and recovery after the listener connection is cut.
- `http`: the same through the REST API, including error-code mapping, idempotent create and the health probes. Tenant isolation (another company gets 404, empty lists) is covered in both `workflow` and `http`.

## Configuration

All settings are environment variables, validated at startup (a bad value stops the process with a message).

| Variable | Default | Meaning |
|---|---|---|
| `ROLE` | `all` | `api`, `worker` or `all` |
| `PORT` | `3000` | HTTP port |
| `DATABASE_URL` | `sqlite:./data/hub.db` | `sqlite:...` or `postgres://...` |
| `QUEUE_URL` | `inproc` | `inproc`, `pg` (PostgreSQL LISTEN/NOTIFY, needs a PostgreSQL `DATABASE_URL`) or `redis://...`; split roles need `pg` or Redis |
| `AUTH_MODE` | `demo` | `demo` (persona header, needs `DEMO=1`) or `oidc` (bearer tokens) |
| `OIDC_ISSUER`, `OIDC_AUDIENCE` | | required with `AUTH_MODE=oidc`; the token's `iss` and `aud` must match |
| `OIDC_JWKS_URI` | discovery | skip discovery when the keys are served elsewhere |
| `OIDC_ROLES_CLAIM` | `roles` | dotted path to the roles in the token (`roles` for Entra, `realm_access.roles` for Keycloak) |
| `OIDC_ISSUER_CLAIM`, `OIDC_DEFAULT_ISSUER` | `issuer_id` | which company the person acts for: from the claim, else the default |
| `OIDC_AUTHORITY`, `OIDC_SPA_CLIENT_ID`, `OIDC_SPA_SCOPE` | | handed to the browser app through `/api/config` for the PKCE sign-in |
| `DATABASE_AUTH` | `password` | `azure-managed-identity`: the Entra token is the database password; with `PG_SSL=require` |
| `SEED_ISSUERS_JSON` | | companies to create at migration time (identifiers only, never credentials) |
| `AUTO_MIGRATE` | `1` | run migrations at start (Compose uses the `migrate` job instead) |
| `DEMO` | `1` | seeded demo data and mock-newswire controls. Persona auth exists **only** with `AUTH_MODE=demo` and `DEMO=1`; `AUTH_MODE=oidc` works with either. Compose binds its ports to 127.0.0.1 |
| `ENFORCE_WINDOWS` | `0` | hold a release while the channel is closed instead of sending at any hour |
| `AI_PROVIDER` | `mock` | `off`, `mock` or `anthropic` |
| `ANTHROPIC_API_KEY`, `AI_MODEL` | | only for `AI_PROVIDER=anthropic` |
| `MAX_ATTEMPTS`, `RETRY_BASE_MS`, `RETRY_MAX_MS` | `5`, `2000`, `60000` | retry budget and exponential backoff |
| `LEASE_MS`, `SWEEP_INTERVAL_MS` | `60000`, `5000` | publication lease and lost-wake-up sweeper |
| `WORKER_CONCURRENCY`, `GATEWAY_CONCURRENCY` | `4`, `2` | parallel jobs, parallel calls per newswire per worker |
| `RATE_LIMIT_PER_MIN`, `PRECHECK_RATE_LIMIT_PER_MIN` | `600`, `20` | requests per actor per minute (`0` = off); the pre-check is tighter because a real provider costs money |
| `PG_POOL_MAX` | `10` | Postgres connections per process; size `(api + workers) x PG_POOL_MAX` against the server limit |

The database and Keycloak passwords in `docker-compose.yml` are local demo values. On Azure there is no database password at all.
No secrets are stored in the repository.

## AI pre-check

An advisory regulatory pre-check (classification, missing information, UK MAR and US Reg FD risks,
structured and explainable). It **never approves, blocks, or publishes**. The platform works the
same with `AI_PROVIDER=off`.

- `mock` (default): deterministic, rule-and-pattern based, no network.
- `anthropic`: set `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`. Output is validated against a
  schema and a controlled vocabulary; a provider failure returns an error for the pre-check only and
  leaves the workflow untouched. The real provider was not exercised against the live API in this repository.

## Repository layout

```
apps/server/src
  domain/         pure rules: state machine, permissions, hashing, calendar, policy contract
  jurisdictions/  UK and US policies, identifiers, holiday calendars  (the plug-in point)
  ports/          interfaces the application depends on
  adapters/       db (Kysely: SQLite, Postgres), queue (in-process, Postgres LISTEN/NOTIFY, BullMQ), gateways (mock RNS, EDGAR), ai
  application/    announcement service, publication runner, pre-check
  auth/           OIDC bearer-token verification (Entra ID, Keycloak)
  http/           Fastify routes, auth hook, rate limit, metrics, static web serving
apps/web          React + Vite single-page app, SignalFlow-style UI (see docs/UI.md): composer, review room, publishing console, public feed; OIDC sign-in
deploy/keycloak   the local identity provider's realm
infra/azure       Terraform for the Azure deployment, mocked tests, verify script
discovery/        requirements work: assumptions, EARS requirements, open questions
docs/             architecture write-up
```

## Assumptions and deviations

- Vite + React for the UI instead of Next.js: nothing here needs server rendering.
- `npm start` keeps seeded personas so it runs with nothing installed; Compose and Azure use real OIDC. The company a person acts for is one default per deployment unless the token carries it.
- Azure Terraform is not applied (no subscription was available); see `infra/azure/README.md` for the checklist the first deploy must run.
- Rule sources are named in code comments next to each rule. Scheduling and embargo, attachments, iXBRL, translations and real newswire connections are out of scope (see the write-up).
- Full list of assumptions and the questions I would put to the panel: `discovery/ledger.md` and `discovery/questions.md`.
