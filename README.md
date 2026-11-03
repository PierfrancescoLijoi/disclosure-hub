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
> counsel and the real channel integrations. Both newswires are mocks. Auth is seeded personas.

The write-up of design, trade-offs, what was cut and what comes next is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

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

### Mode 2: containers, PostgreSQL + Redis/BullMQ

```bash
docker compose up --build
```

Open <http://localhost:8080> (nginx, proxies `/api` to the API; the API is also on :3000).
Services: `postgres`, `redis`, `migrate` (one-shot), `api`, `worker`, `web`.
More publishing capacity is one flag, nothing else changes:

```bash
docker compose up --build --scale worker=3
```

Both modes run **the same business logic, API, rules and state machine**. Only the infrastructure
adapters differ (database, queue, process split). `docker compose down -v` removes the data.

### Try it

Personas (pick one in the top bar; the API reads the `x-user-id` header):

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
npm run demo                              # server on http://localhost:3000
BASE_URL=http://localhost:8080 npm run demo   # against the Compose stack
```

## Throughput check

```bash
npm run bench                                       # 300 announcements through the REST API
GATEWAY_LATENCY_MS=200 N=300 npm run bench          # newswire answering in 200 ms
```

The per-actor rate limit would throttle the benchmark (one persona sends everything), so start the stack with `RATE_LIMIT_PER_MIN=0 docker compose up --build`.
Run it against `docker compose up --scale worker=1` and `--scale worker=3` to see publishing capacity follow the
number of workers (measured results in the architecture write-up). Note that `GATEWAY_LATENCY_MS` stays set in the mock until you change it.

## Observability

`GET /metrics` (Prometheus text, on the API port): publications and announcements by status, and the age of the oldest publication waiting for a worker. That last gauge is the one to alert on: it grows when workers are down, the queue is lost, or a newswire is failing. It is not proxied by the nginx container; keep it off the public edge. Logs are structured JSON.

## Tests

```bash
npm test            # 96 tests, SQLite in memory, a few seconds
npm run typecheck
```

The same suite runs against the production adapters:

```bash
docker run -d --name hub-test-pg -e POSTGRES_USER=hub -e POSTGRES_PASSWORD=hub-dev-only -e POSTGRES_DB=hub_test -p 55432:5432 postgres:16-alpine
docker run -d --name hub-test-redis -p 56379:6379 redis:7-alpine

TEST_PG_URL=postgres://hub:hub-dev-only@localhost:55432/hub_test \
TEST_REDIS_URL=redis://localhost:56379 \
npm test -w apps/server -- --no-file-parallelism     # 99 tests
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
- `http`: the same through the REST API, including error-code mapping, idempotent create and the health probes. Tenant isolation (another company gets 404, empty lists) is covered in both `workflow` and `http`.

## Configuration

All settings are environment variables, validated at startup (a bad value stops the process with a message).

| Variable | Default | Meaning |
|---|---|---|
| `ROLE` | `all` | `api`, `worker` or `all` |
| `PORT` | `3000` | HTTP port |
| `DATABASE_URL` | `sqlite:./data/hub.db` | `sqlite:...` or `postgres://...` |
| `QUEUE_URL` | `inproc` | `inproc` or `redis://...` (split roles need Redis) |
| `AUTO_MIGRATE` | `1` | run migrations at start (Compose uses the `migrate` job instead) |
| `DEMO` | `1` | seeded personas, mock-newswire controls. Persona auth exists **only** in demo mode: with `DEMO=0` every `/api` call is refused until a real identity provider replaces the auth hook. Compose binds its ports to 127.0.0.1 |
| `ENFORCE_WINDOWS` | `0` | hold a release while the channel is closed instead of sending at any hour |
| `AI_PROVIDER` | `mock` | `off`, `mock` or `anthropic` |
| `ANTHROPIC_API_KEY`, `AI_MODEL` | | only for `AI_PROVIDER=anthropic` |
| `MAX_ATTEMPTS`, `RETRY_BASE_MS`, `RETRY_MAX_MS` | `5`, `2000`, `60000` | retry budget and exponential backoff |
| `LEASE_MS`, `SWEEP_INTERVAL_MS` | `60000`, `5000` | publication lease and lost-wake-up sweeper |
| `WORKER_CONCURRENCY`, `GATEWAY_CONCURRENCY` | `4`, `2` | parallel jobs, parallel calls per newswire per worker |
| `RATE_LIMIT_PER_MIN`, `PRECHECK_RATE_LIMIT_PER_MIN` | `600`, `20` | requests per actor per minute (`0` = off); the pre-check is tighter because a real provider costs money |
| `PG_POOL_MAX` | `10` | Postgres connections per process; size `(api + workers) x PG_POOL_MAX` against the server limit |

The database password in `docker-compose.yml` is a local demo value. No secrets are stored in the repository.

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
  adapters/       db (Kysely: SQLite, Postgres), queue (in-process, BullMQ), gateways (mock RNS, EDGAR), ai
  application/    announcement service, publication runner, pre-check
  http/           Fastify routes, persona auth, static web serving
apps/web          React + Vite single-page app (form generated from the category schemas)
discovery/        requirements work: assumptions, EARS requirements, open questions
docs/             architecture write-up
```

## Assumptions and deviations

- Vite + React for the UI instead of Next.js: nothing here needs server rendering.
- Persona auth (`x-user-id`) replaces a real identity provider. Authorization (roles, tenant isolation, maker-checker) is enforced for real behind it.
- Rule sources are named in code comments next to each rule. Scheduling and embargo, attachments, iXBRL, translations and real newswire connections are out of scope (see the write-up).
- Full list of assumptions and the questions I would put to the panel: `discovery/ledger.md` and `discovery/questions.md`.
