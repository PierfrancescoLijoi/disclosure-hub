# Disclosure Hub

Regulatory announcements for listed companies: an announcement goes from **draft to published** in three
jurisdictions (UK, US and Denmark), with one shared workflow and per-jurisdiction rules and delivery.

| | UK | US | Denmark (EU) |
|---|---|---|---|
| Regime | UK MAR, Listing Rules, DTR | Exchange Act, Form 8-K, Reg FD | EU MAR, Transparency Directive |
| Channel | RNS (mock) | SEC EDGAR (mock) | Nasdaq Copenhagen (mock) |
| Categories | inside information, PDMR dealing, results, general | Form 8-K (items 1.01, 1.05, 2.02, 5.02, 5.07, 7.01, 8.01), Form 6-K | the UK's four, plus major shareholder announcements, share buyback reports and notices of general meetings; every one in Danish or English |
| Issuer status | none | domestic filer (8-K) or foreign private issuer (6-K) | main market or First North (with a Certified Adviser) |
| Acknowledgement | RNS number, e.g. `0001B` | accession number, e.g. `0001234567-26-000001` | company announcement number, e.g. `1/2026` |

> **The rules are simplified models, not legal advice.** They show how jurisdiction logic is
> expressed and enforced, and they are only as good as their stated sources. Real use needs review by
> counsel and the real channel integrations. All three newswires are mocks. Sign-in is real OIDC in the container and Azure
> setups (Keycloak locally, Microsoft Entra ID on Azure); `npm start` uses seeded personas for a zero-install demo.

## Run it in 30 seconds

With Node.js 22 or newer:

```bash
npm install
npm start          # open http://localhost:3000
```

Then sign in as **alice** (author), create a UK, US or Denmark announcement, press *Fill with example content*, and take it
through *Validate*, *Submit for review*, three approvals (bob, carol, dan) and *Publish* (erin). The full walk-through is under
[Try it](#try-it). Without a browser: `npm run demo` (with the app running) publishes one announcement per jurisdiction.
No Node.js yet? Use the bootstrap below, which installs nothing system-wide.

**Reading order (about 10 minutes):** [docs/SUMMARY.md](docs/SUMMARY.md) (architecture, decisions, trade-offs, next steps on
one page), then [docs/BRIEF-RESPONSE.md](docs/BRIEF-RESPONSE.md) (each point of the brief with its proof). Everything else is
under [Additional details](#additional-details).

## Quick start from a clean computer

Nothing needs to be installed first: no Node.js, no Git, no database, no Docker, no compiler, no Python, no account, no API
key. You need the code folder and an internet connection.

### 1. Get the code

The repository is private, so sign in to GitHub with an account that has access, then on the repository page choose
*Code, Download ZIP* and unzip it (or `git clone https://github.com/PierfrancescoLijoi/disclosure-hub.git`).
No access? Ask the Author to invite your GitHub account, or use the ZIP you were sent.

### 2. Run the bootstrap

| System | Do this |
|---|---|
| **Windows** | Double-click **`bootstrap.cmd`** in the unzipped folder, or run `bootstrap.cmd` in a terminal |
| **Linux, macOS** | In a terminal, in the folder: `sh bootstrap.sh` |

It runs three steps and prints each one (`1/3`, `2/3`, `3/3`):

1. **Node.js.** Looks for Node.js 22 or newer. If it is missing, it downloads the official portable Node.js from
   nodejs.org into `.tools/node` **inside this folder** and checks its SHA-256 against nodejs.org's published list. Nothing
   is installed system-wide, no administrator rights are used, and your PATH is not changed.
2. **Dependencies.** Runs `npm install`. They are ready-made, so no compiler or Python is needed.
3. **Start.** Builds the web app, creates a local SQLite database in `apps/server/data/`, seeds demo companies and people,
   and starts the app. When it prints `Open http://localhost:3000`, open that address in a browser.

On Windows, a ZIP downloaded from the internet may make a *Windows protected your PC* (SmartScreen) window appear when you
double-click `bootstrap.cmd`: choose *More info*, then *Run anyway*. The script is plain text; read it first if you wish.

Run the same command again later to start it; it will not download anything twice. To only prepare it without starting:
`bootstrap.cmd -NoStart` (Windows) or `sh bootstrap.sh --no-start`. To remove everything, delete the folder.

Needs: **Windows** with PowerShell (built in); **Linux or macOS** with `sh`, `tar`, and `curl` or `wget`. The bootstrap
stops with a clear message if one is missing, if the download is blocked (a proxy or a firewall), or if a checksum does not
match. In that case use the manual route below.

#### Manual route for step 2 (if you prefer, or the bootstrap cannot download)

Install **Node.js 22 or newer** (the current LTS from <https://nodejs.org>) and check it:

```bash
node -v
```

It must print `v22` or higher. **Node 20 or older is refused** with an `EBADENGINE` message that names the required
version, because the SQLite driver (`better-sqlite3`) ships ready-made binaries for Node 22 and newer only: older versions
would have to compile it, which needs Python and a C++ toolchain (Visual Studio Build Tools on Windows). Then, in the
code folder (the same commands on Windows PowerShell, macOS and Linux):

```bash
npm install
npm start
```

### 3. Use it

On the sign-in page pick **alice** (author), write and submit an announcement for the UK, the US or Denmark, then
sign in as the approvers (**bob**, **carol**, **dan**) and approve, then as **erin** to publish. The step-by-step walk-through
is under [Try it](#try-it). To watch the whole flow without a browser, with the app running, open a second terminal in the same folder and run `bootstrap.cmd -Demo` (Windows), `sh bootstrap.sh --demo` (Linux, macOS) or, if you installed Node yourself:

```bash
npm run demo
```

It publishes one announcement in each jurisdiction (UK, US, Denmark) through the REST API and prints the acknowledgements and the audit-chain check.

**Stop** with `Ctrl+C`. **Start from scratch** by deleting the `apps/server/data/` folder. **Run the tests** with `npm test`.

**Port 3000 is taken?** Choose another one: `PORT=3001 npm start` (macOS, Linux, Git Bash) or
`$env:PORT=3001; npm start` (PowerShell), and open that port.

Want the production-shaped setup (PostgreSQL, real sign-in with Keycloak, separate worker, notifier and agent processes)?
That needs **Docker Desktop**: see [Mode 2](#mode-2-containers-postgresql-real-sign-in-the-local-twin-of-azure). Azure is
design and Terraform only and is not needed to run anything.

## The brief, answered

| The brief asked for | Answer in one line | Detail |
|---|---|---|
| A working system: draft to published in each of three jurisdictions | UK (RNS), US (EDGAR, 8-K) and Denmark (Nasdaq Copenhagen, EU MAR) through one workflow; mock newswires; `npm start` | [Run it](#run-it), [Try it](#try-it) |
| A system built for scale, in the code and the architecture | Enforced module boundaries; the database row is the truth and the queue a hint; an event outbox; processes split by role; measured and sized | [BRIEF-RESPONSE §1](docs/BRIEF-RESPONSE.md#1-built-for-scale-in-the-code-and-in-the-architecture), [SIZING](docs/SIZING.md) |
| A clear way of handling regulatory and operational differences | Regulatory rules live in a **policy**, delivery in a **gateway adapter** | [BRIEF-RESPONSE §2](docs/BRIEF-RESPONSE.md#2-regulatory-and-operational-differences-two-kinds-two-homes) |
| No duplicated effort, extensible to more jurisdictions | The workflow exists once; a jurisdiction is one policy file, one gateway and two registrations; the UI reads it from the server; Denmark was added that way, with no workflow change | [SUMMARY: what is shared and what differs](docs/SUMMARY.md#what-is-shared-and-what-differs-uk-us-denmark), [BRIEF-RESPONSE §3](docs/BRIEF-RESPONSE.md#3-without-duplicating-effort-extending-to-more-jurisdictions), [MODULES](docs/MODULES.md#add-a-jurisdiction) |

What is **verified by running it**, what is **measured** on a laptop and what is only **designed** (the whole Azure
deployment) is stated in [BRIEF-RESPONSE §4](docs/BRIEF-RESPONSE.md#4-verified-measured-designed).

## Documentation map

### Start here

| Document | What it answers |
|---|---|
| [docs/SUMMARY.md](docs/SUMMARY.md) | Architecture, key decisions, trade-offs, what is proven, what comes next: one page |
| [docs/BRIEF-RESPONSE.md](docs/BRIEF-RESPONSE.md) | The three points of the brief, each with its claim, proof and limit; likely questions |
| [Azure diagram](docs/diagrams/02-azure-architecture.drawio.png) | The target architecture on one picture |
| [Scale it locally](#scale-it-locally) | Every container, how it scales on one machine, the limit, and what was run versus only designed |

### Additional details

Reference material behind the pages above. Nothing here is needed to run or review the system.

| Document | What it answers |
|---|---|
| [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) | Functional and non-functional requirements with status, assumptions, decisions, open points |
| [docs/GLOSSARY.md](docs/GLOSSARY.md) | Every term (system, regulatory, cloud) with the file that defines it |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Design, key decisions, trade-offs, scaling, what was cut, verified versus designed, next steps |
| [docs/MODULES.md](docs/MODULES.md) | Extension guide: events, consumers, agents, channels, jurisdictions |
| [docs/SIZING.md](docs/SIZING.md) | Capacity model, measurements, cost drivers |
| [docs/adr/0001-database-bottleneck-and-service-bus.md](docs/adr/0001-database-bottleneck-and-service-bus.md) | When the single database stops being enough, and the triggers |
| [docs/DR.md](docs/DR.md) | Losing a region: what exists, numbers, how to fail over |
| [docs/UI.md](docs/UI.md) | Screens, routes, deviations from the product spec |
| [docs/PROJECT-GUIDE.md](docs/PROJECT-GUIDE.md) | Plain-language walkthrough of the whole project: flow, reliability, jurisdictions, Azure, trade-offs, likely questions |
| [infra/azure/README.md](infra/azure/README.md) | The Azure design, what is verified offline, what the first deploy must prove, cost |
| [infra/azure-landing-zone](infra/azure-landing-zone/README.md) | Governance base: management groups, policy, RBAC |
| [discovery/spec.md](discovery/spec.md) | Problem, goals, stories, requirements (EARS), business rules, known limits of the regulatory model |
| [discovery/ledger.md](discovery/ledger.md) | Assumptions and open points (L-1 to L-28) |
| [discovery/handoff.md](discovery/handoff.md) | The architecture-driving decisions (ASR-1 to ASR-20) and risks |
| [discovery/questions.md](discovery/questions.md) | Questions for the panel, with the default assumed |

Diagrams (draw.io sources next to each PNG) are under [Diagrams](#diagrams).

Short on time: the run block above, then [docs/SUMMARY.md](docs/SUMMARY.md), then the [Azure diagram](docs/diagrams/02-azure-architecture.drawio.png).

**For readers, not only staff.** Published announcements are public: an archive filterable by company, category, date and
text (`/public/announcements`), an Atom feed per filter, and follow-by-email or signed webhook with double opt-in and
one-click unsubscribe. Everything that follows a workflow step (telling followers, running advisory agents) is a consumer of
a domain event, so adding another agent or channel does not touch the workflow.

## Diagrams

Editable draw.io sources with PNG exports, in `docs/diagrams/`:

- [`01-use-cases`](docs/diagrams/01-use-cases.drawio.png): the four roles and what each does.
- [`02-azure-architecture`](docs/diagrams/02-azure-architecture.drawio.png): the Azure design with its resources (validated offline, not applied).
- [`03-local-architecture`](docs/diagrams/03-local-architecture.drawio.png): the Compose twin and how one filing flows through it.
- [`04-local-scaling`](docs/diagrams/04-local-scaling.drawio.png): how each container scales on one machine, how far, what was run and what was only designed, and the four commands to show it.

## One architecture, three ways to run it

| | `npm start` | `docker compose up` (the Azure twin) | Azure (`infra/azure`) |
|---|---|---|---|
| Sign-in | Seeded personas (`x-user-id`), demo only | **OIDC**: Keycloak, Authorization Code + PKCE | **OIDC**: Microsoft Entra ID, roles from app roles |
| Database | SQLite file | PostgreSQL 16 | PostgreSQL Flexible Server, zone-redundant, Entra-only |
| Queue | In-process | PostgreSQL `LISTEN/NOTIFY` | Same |
| Processes | One | api, worker x N, notifier, agents, migrate job | Container Apps api, worker (2+ each), one app per consumer set, migrate job |
| Reader mail | In-memory demo mailbox (`/public/mailbox`) | Mailpit (inbox on :8025) | Azure Communication Services Email, managed identity |
| Public edge | none | nginx cache on `/api/public` | Front Door Premium, managed WAF and Private Link (production); Standard public edge in the cheaper development profile |
| Secrets | none | demo passwords in the compose file | none stored: managed identities, Key Vault |
| Status | run and tested | run and tested | **validated offline, not applied** |

The same container image and the same business logic run in all three; environment variables choose the adapters.

## Run it

### Mode 1: local (SQLite, one process)

This is what the [Quick start](#quick-start-from-a-clean-computer) runs. With Node 22 or newer already installed it is
just `npm install` then `npm start`, and the app is on <http://localhost:3000>. SQLite file in `apps/server/data/`,
in-process job queue, one process.
For development, `npm run dev` runs the server with reload and `npm run dev -w apps/web` serves the UI on
<http://localhost:5173> (proxies `/api` to :3000).

### Mode 2: containers, PostgreSQL, real sign-in (the local twin of Azure)

Needs **Docker Desktop** (or Docker Engine with the Compose plugin) running, and the ports 3000, 8080, 8081 and 8025 free.
You do not need Node for this mode. The first build takes about two minutes (it pulls the base images and builds one image
for every role).

```bash
docker compose up --build
```

Open <http://localhost:8080> and sign in (nginx serves the app and proxies `/api`; the API is also on :3000).
Services: `postgres`, `keycloak` (identity provider, realm imported from `deploy/keycloak`), `migrate` (one-shot),
`api`, `worker`, `notifier` and `agents` (`ROLE=events`, each running only its own event consumers), `mailpit`
(SMTP sink, inbox on <http://localhost:8025>, where subscription confirmations and announcement mail arrive), `web`.
Follow an announcement on <http://localhost:8080/public/announcements>, open the confirmation in Mailpit, publish as a
signed-in user, and the notification arrives from the `notifier` process. Resource limits match the Azure replicas (see [docs/SIZING.md](docs/SIZING.md)).
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
| `alice` | author | Northwind Energy plc (UK + US + DK) |
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
AUTH=oidc npm run demo                    # the Compose stack, with a real bearer token per person (run npm install once on the host first)
```

## Scale it locally

The container stack (Mode 2) is the way to see scaling on one machine. Every process is the same image started with a different `ROLE`, so
each part scales on its own; [the diagram](docs/diagrams/04-local-scaling.drawio.png) shows it on one page. Resource limits match the Azure
replicas, so the numbers below are the ones the sizing document is built on. All of it was run on 6 Nov (Docker Desktop, one laptop).

| Container | Scales? | How | What happened when run |
|---|---|---|---|
| `worker` (files to the newswire) | Yes, horizontally | `docker compose up -d --scale worker=3` | 1 worker 9 published/s, 3 workers 16/s, no duplicates. Past 6 workers every one is woken by every `NOTIFY`: move the queue to Service Bus or Redis |
| `api` | Yes, it is stateless | `API_HOST_PORTS=127.0.0.1:3000-3005 docker compose up -d --scale api=2` (each replica gets its own host port; `web` on :8080 balances them and re-resolves every 5 s) | 2 replicas with 3 workers: about 20 published/s. Stopping one replica: `web` kept answering within 8 s |
| `notifier`, `agents` (`ROLE=events`) | Yes, each delivery is claimed with a lease | `docker compose up -d --scale notifier=2 --scale agents=2` | Under load: 1,490 deliveries done, none dead, one report per announcement revision |
| `postgres`, `web`, `keycloak`, `mailpit` | No, single instance on purpose | | `postgres` is the shared limit (see below). Azure replaces all four with managed services |
| `migrate` | Runs once | | |

What limits throughput, in the order you meet it (300 announcements, 20 in flight, 200 ms mock newswire):

| Stack | Published per second | The limit |
|---|---|---|
| 1 api, 1 worker | 9 | The worker: 2 in flight / 0.2 s = 10 per second |
| 1 api, 3 workers | 16 | The API: 16 announcements x 5 calls = about 80 write requests per second on 0.5 vCPU |
| 2 api, 3 workers | about 20 | PostgreSQL, at about 100 % of its 1 vCPU. Next step: a bigger database or the exits in [ADR 0001](docs/adr/0001-database-bottleneck-and-service-bus.md) |

Every process holds a pool of 5 connections, so `(api + workers + events) x 5` must stay under `max_connections` (100). The expected peak is
0.17 per second, so even one worker has about 50 times the margin: the point of scaling here is to show the mechanism and where it stops.

Show it in four steps (the stack needs `RATE_LIMIT_PER_MIN=0`, or the per-person limit throttles the benchmark):

```bash
RATE_LIMIT_PER_MIN=0 docker compose up --build -d --scale worker=1
AUTH=oidc GATEWAY_LATENCY_MS=200 npm run bench
RATE_LIMIT_PER_MIN=0 docker compose up -d --scale worker=3
AUTH=oidc GATEWAY_LATENCY_MS=200 npm run bench
```

The first run prints about 9 published per second (the worker is the limit), the second about 16 (now the API is). To go past that, add API
replicas, then run one benchmark per replica, because the edge in front of `web` limits each address to 100 requests per second:

```bash
API_HOST_PORTS=127.0.0.1:3000-3005 RATE_LIMIT_PER_MIN=0 docker compose up -d --scale worker=3 --scale api=2
docker compose ps api        # note the two host ports
BASE_URL=http://localhost:<port> AUTH=oidc GATEWAY_LATENCY_MS=200 N=150 CONCURRENCY=10 npm run bench      # in two terminals, one per port
```

Keep the same variables on every `docker compose up`, or Compose recreates the container. Watch it while it runs: `docker stats` for CPU per
replica (the database reaches its limit first) and `GET /metrics` for the age of the oldest publication waiting. The Azure numbers (2 workers
about 15/s under Azure limits) are in [docs/SIZING.md](docs/SIZING.md); Azure itself was never applied.

## Throughput check

```bash
npm run bench                                       # 300 announcements through the REST API
GATEWAY_LATENCY_MS=200 N=300 npm run bench          # newswire answering in 200 ms
```

The per-actor rate limit would throttle the benchmark (one person sends everything), so start the stack with `RATE_LIMIT_PER_MIN=0 docker compose up --build --scale worker=2`
and run `AUTH=oidc GATEWAY_LATENCY_MS=200 N=200 CONCURRENCY=5 npm run bench`. Results under the Azure-sized limits are in
[docs/SIZING.md](docs/SIZING.md); worker scaling in the architecture write-up. Note that `GATEWAY_LATENCY_MS` stays set in the mock until you change it.

## Observability

`GET /metrics` (Prometheus text, on the API port): publications and announcements by status, and the age of the oldest publication waiting for a worker. That last gauge is the one to alert on: it grows when workers are down, the queue is lost, or a newswire is failing (on Azure the workers log it every minute and a Log Analytics alert fires past 2 minutes; CPU autoscaling cannot see this backlog, so the worker floor of 2 is the capacity). It is not proxied by the nginx container; keep it off the public edge. Logs are structured JSON.

## Tests

```bash
npm test               # 224 server tests pass (7 integration tests skipped without PostgreSQL/Redis), then 12 web tests
npm test -w apps/web   # run only the 12 UI logic tests (diff, attention queue, readiness)
npm run typecheck
```

The same suite runs against the production adapters:

```bash
docker run -d --name hub-test-pg -e POSTGRES_USER=hub -e POSTGRES_PASSWORD=hub-dev-only -e POSTGRES_DB=hub_test -p 55432:5432 postgres:16-alpine
docker run -d --name hub-test-redis -p 56379:6379 redis:7-alpine

TEST_PG_URL=postgres://hub:hub-dev-only@localhost:55432/hub_test \
TEST_REDIS_URL=redis://localhost:56379 \
npm test -w apps/server -- --no-file-parallelism     # all 231 server tests; CI runs this with PostgreSQL 16 + Redis 7
```

With `TEST_PG_URL` every integration test runs on PostgreSQL (the schema is dropped and recreated per
test). With `TEST_REDIS_URL` the BullMQ tests run, including two worker processes sharing eight
publications with no double release. The gated tests are skipped, not faked, when the variables
are missing.

What the tests cover:

- `domain`: state machine, permissions, content hash, audit chain tamper detection, business-day calendar and time-zone windows.
- `policies`: UK, US and Denmark validation, deadlines, approval requirements, rendering, identifier checks (LEI, ISIN, CVR); for Denmark also the market segment, major shareholder, buyback and general-meeting rules.
- `workflow`: the full draft to published path in all three jurisdictions, revisions and voided approvals, retry, lost acknowledgement, lease takeover, lost wake-up recovery, idempotent publish, permanent rejection.
- `hardening`: approvals bound to the reviewed revision, a hanging gateway times out and fails visibly, rate limits per actor, metrics output, the sweeper indexes, concurrent idempotent create.
- `operations`: publication windows, Denmark as the only registered jurisdiction running through the unchanged workflow, AI pre-check safety, an architecture test that fails the build on forbidden imports.
- `auth`: OIDC bearer tokens against a local JWKS: valid, expired, wrong audience or issuer, forged signature, unknown role, discovery down (503), company from claim.
- `pgqueue`: the PostgreSQL `LISTEN/NOTIFY` queue on a real database, two workers, and recovery after the listener connection is cut.
- `events`: the outbox (delivered once, retry with back-off, dead, lease takeover, per-process consumer filter) and agents (autorun, a second agent chained on the first, one report per event, bounded ping-pong, invalid output rejected, a failing agent never blocks the workflow, the agent only gets a copy).
- `readers`: follow, confirm, notified once (a redelivery does not repeat it), delivery by the chosen filters, unsubscribe erases the address, forged, swapped and expired links, abuse caps, transient retry versus permanent failure, signed webhooks, private-address refusal (including literal IPs), Atom escaping, archive filters and text search. `public-http`: the public routes, feed validators (304), cache headers, the one-click unsubscribe post, the form's rate limit, the demo mailbox. `config`: the reader and role settings are validated.
- `http`: the same through the REST API, including error-code mapping, idempotent create and the health probes. Tenant isolation (another company gets 404, empty lists) is covered in both `workflow` and `http`.

## Configuration

All settings are environment variables, validated at startup (a bad value stops the process with a message).

| Variable | Default | Meaning |
|---|---|---|
| `ROLE` | `all` | `api`, `worker` (publication queue and sweeper), `events` (the event reactor only) or `all` |
| `REACTOR_CONSUMERS` | all | comma list of consumer ids this process runs (`notifier`, `agent:precheck`, ...); the processes of a split deployment each name theirs |
| `REACTOR_POLL_MS`, `REACTOR_MAX_ATTEMPTS` | `1000`, `8` | how often the reactor looks for due events, and attempts before a delivery is `dead` |
| `AGENTS` | pre-check when `AI_PROVIDER=mock`, else none | agents that run by themselves on events (a real provider costs money per submit) |
| `PUBLIC_BASE_URL` | `http://localhost:3000` | the site's public address: links in mail and in the feed |
| `READER_TOKEN_KEY` | demo value in `DEMO=1` | 32+ characters; confirmation, unsubscribe and webhook-signing secrets derive from it; required elsewhere unless readers are off |
| `EMAIL_TRANSPORT`, `EMAIL_FROM` | `log` in demo, else `off` | `off`, `log` (in-memory demo mailbox), `smtp` (`SMTP_URL`) or `acs` (`ACS_ENDPOINT`, uses the managed identity) |
| `WEBHOOKS`, `WEBHOOK_ALLOW_PRIVATE` | `1`, `0` | reader webhooks on or off; private addresses and plain http only for a local demo (refused unless `DEMO=1`) |
| `TRUST_PROXY` | `0` | proxies in front of the API whose `X-Forwarded-For` is trusted, so per-client limits see the reader |
| `EDGE_ID` | | Azure Front Door id: requests without it in `X-Azure-FDID` get 403 (probes exempt), so the edge's WAF and cache cannot be skipped |
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

An advisory regulatory pre-check (classification, missing information, UK MAR, EU MAR (Denmark) and US Reg FD risks,
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
  jurisdictions/  UK, US and Denmark policies, the shared MAR rules, identifiers, holiday calendars  (the plug-in point)
  ports/          interfaces the application depends on
  adapters/       db (Kysely: SQLite, Postgres), queue (in-process, Postgres LISTEN/NOTIFY, BullMQ), gateways (mock RNS, EDGAR, Nasdaq Copenhagen), ai, channels (email, webhook)
  application/    announcement service, publication runner, pre-check, event bus and reactor, agents, readers (subscriptions, notifier, feed)
  auth/           OIDC bearer-token verification (Entra ID, Keycloak)
  http/           Fastify routes, auth hook, rate limit, metrics, public routes, static web serving
apps/web          React + Vite single-page app (UI built from the SignalFlow IR product spec, see docs/UI.md): composer, review room, publishing console, public archive with follow, confirm and unsubscribe pages; OIDC sign-in
bootstrap.cmd, bootstrap.sh, scripts/   one-command setup for a computer with nothing installed (portable Node, dependencies, start)
deploy/keycloak   the local identity provider's realm
infra/azure       Terraform for the Azure deployment, mocked tests, verify script
discovery/        requirements work: assumptions, EARS requirements, open questions
docs/             brief response, requirements, glossary, architecture write-up, extension guide (MODULES.md), sizing, DR, UI, ADRs, diagrams
```

## Assumptions and deviations

- Vite + React for the UI instead of Next.js: nothing here needs server rendering.
- `npm start` keeps seeded personas so it runs with nothing installed; Compose and Azure use real OIDC. The company a person acts for is one default per deployment unless the token carries it.
- Azure Terraform is not applied (no subscription was available); see `infra/azure/README.md` for the checklist the first deploy must run.
- Regulatory model, in short: the UK PDMR deadline runs from the transaction (MAR Art. 19(3)); inside information is released even when the RNS window is closed; the US issuer profile has a filer status (domestic filers file Form 8-K, foreign private issuers Form 6-K); an 8-K with only Items 7.01 or 8.01 has no deadline; Item 1.05 counts from the materiality determination. What is not modelled (corrections, dual listing, insider lists, closed periods, TR-1, 10-Q/10-K, scheduled release) and what must be verified against a real provider (no idempotency lookup at real RIS or EDGAR, EDGAR Next credentials) is at the end of `discovery/spec.md`.
- Rule sources are named in code comments next to each rule. Scheduling and embargo, attachments, iXBRL, translations and real newswire connections are out of scope (see the write-up).
- Full list of assumptions and the questions I would put to the panel: `discovery/ledger.md` and `discovery/questions.md`.

## Licence and authorship

Copyright (c) 2026 Pierfrancesco Lijoi. All rights reserved. This is the Author's own work. Anyone given access to this
repository to assess it (for example the reviewers of a take-home exercise) may read it and run it for that purpose;
every other use needs the Author's written permission. Full terms in [LICENSE](LICENSE). Third-party packages keep their
own licences. The regulatory rules are simplified models, not legal advice.
