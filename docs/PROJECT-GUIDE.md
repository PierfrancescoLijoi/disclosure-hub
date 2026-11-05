# Disclosure Hub: project guide

A walkthrough of the whole project in plain language: what it does, how it does it, why it is built this way, what was cut, where
it is weak and what to answer when someone asks. It is written conversationally, as if told out loud. The other documents in this
repo are the source; this guide summarises them and says where to look.

Reference state: branch `master`, commit `509cc42`, 5 November 2026.

---

## 0. In sixty seconds

Disclosure Hub is investor relations (IR) software that takes a regulatory announcement from **draft to published** on an official
channel (in the United Kingdom the RNS, in the United States EDGAR, in Denmark Nasdaq Copenhagen), with one workflow and different
rules and delivery for each jurisdiction. It includes multi-person approvals, a check on the approved content, an audit trail with
a hash chain, safe retries that prevent double releases, a public archive with email or webhook subscriptions, and an AI pre-check
that is advisory only.

The three ideas that hold everything together:

1. **The real risk is publishing twice or never.** So the row in the database is the truth and the queue is only an alarm clock.
2. **The differences between countries live in two separate places:** a *policy* (what the law says) and a *gateway* (how it is
   delivered). The workflow never knows which country it is handling.
3. **Everything that follows a workflow step** (notifications, agents) **is a consumer of an event**, written in the same
   transaction as the step. The workflow never calls anyone.

What is true and what is not, in one line: the system **really runs** locally (UI, API, tests, containers). The rules are
**simplified models**, the newswires are **fake**, and the Azure architecture is **designed and validated offline but never applied**.

---

## 1. The problem and the people

A listed company has to release regulated information to the market, with different rules depending on the country. Today, in
practice, this often goes through email, spreadsheets and phone calls to a newswire: there is no enforced review, no proof of who
approved what, and a double or missed release is a regulatory incident.

The actors in the system:

| Role | Demo person | What they do |
|---|---|---|
| Author (`author`) | alice | writes and edits the draft, sends it to review |
| Company secretary (`company_secretary`) | bob | approves |
| Legal (`legal`, general counsel) | carol | approves |
| CFO (`cfo`) | dan | approves |
| Publisher (`publisher`) | erin | presses Publish |
| Author + publisher of another company | frank | exists only in the demo; belongs to Contoso, US only |
| Public and investors | no account | read the archive, subscribe |
| Newswire / regulator | external | RNS, EDGAR and Nasdaq Copenhagen, fake here |

One point to remember: the **author cannot approve their own revision** (maker-checker). Every required role has to be covered by
a different person.

---

## 2. The life of an announcement, step by step

Imagine alice has to publish a results announcement for Northwind Energy plc in the United Kingdom.

**1. Draft.** Alice chooses a jurisdiction and a category. The details form is *generated* from the Zod schema of the chosen
category, so there is no UI code per category. Every save creates an **immutable revision** with a SHA-256 hash of the content. If
she edits again, a new revision is created and everything that was validated or approved before lapses.

**2. Validation.** The system applies the common rules first (headline too long, empty body, leftover placeholders, issuer
profile, category schema, deadline passed) and then the jurisdiction's rules. It returns errors and warnings with a code and the
path of the field (for example `US_8K_2_02_EXHIBIT` for an 8-K item 2.02 without the Exhibit). If it passes, the status becomes
`validated`.

**3. Submit for review.** Alice submits the announcement. The system re-runs validation and takes a snapshot of the *approval
requirement* decided by the policy (how many approvers and which roles, which may depend on the metadata). The status becomes
`in_review`. The first domain event (`announcement.submitted`) is written here too.

**4. Approval.** Bob, carol and dan approve. Every approval is **bound to the hash of the revision they saw**: if the revision
changes in the meantime, the server answers 409 `STALE_REVISION`, so an approval can never land on a text the approver did not
read. If someone requests changes, the status goes back to `draft`. When the requirement is met, the status becomes `approved`.

**5. Publication.** Erin presses Publish. The system checks that the approved hash matches the one about to be sent. Then it
creates a *publication* with an idempotency key `announcementId:revision` and puts a message on the queue. The status becomes
`publishing`.

**6. The worker.** A worker takes the publication with a lease, asks the gateway whether a filing with that key already exists
(`find`), and only if it does not, sends it (`submit`). The gateway replies with a receipt: an RNS number (for example `0001B`),
an EDGAR accession number (for example `0001234567-26-000001`) with the filing date, or a Nasdaq Copenhagen company announcement
number (for example `3/2026`). The system stores the receipt, moves to `published` and writes the `announcement.published` event
in the same transaction.

**7. Afterwards.** The detail page shows the receipt, the deadline, what is left to do after publication (for example, in the
United Kingdom, notifying a delay to the authority) and the audit chain. The announcement appears in the public archive, and
followers get the notification from the *notifier* process.

The full announcement states are: `draft`, `validated`, `in_review`, `approved`, `publishing`, `published`, `failed`,
`withdrawn`. The terminal ones are `published` and `withdrawn`. From `failed` you can retry or reopen as a draft. The allowed
transitions are in a single table (`domain/state-machine.ts`); any other request gets 409. Publications have their own states:
`pending`, `in_flight`, `retry`, `acked`, `rejected`, `exhausted`.

---

## 3. How it is built inside

It is a **modular monolith with hexagonal boundaries**, all in TypeScript. One codebase, one image. Inside there are layers with a
fixed direction of dependency:

- `domain`: pure logic (state machine, permissions, hash, business-day calendar, the policy contract). It imports nothing from
  outside.
- `jurisdictions`: the UK, US and Denmark policies, the shared MAR rules (`mar.ts`), the identifier checks (LEI, ISIN, CVR) and the
  holiday calendars. This is the plug-in point.
- `ports`: the interfaces the application depends on (database, queue, gateway, AI, channels).
- `adapters`: the implementations: database (SQLite or PostgreSQL via Kysely), queue (in-process, PostgreSQL `LISTEN/NOTIFY`,
  BullMQ/Redis), gateways (fake RNS, EDGAR and Nasdaq Copenhagen), AI (fake or Anthropic), channels (log, SMTP, Azure Email,
  webhook).
- `application`: the services (announcements, publication runner, pre-check, event bus and reactor, agents, readers).
- `auth`: verification of OIDC tokens (Entra ID, Keycloak).
- `http`: Fastify, routes, authentication hook, rate limit, metrics, public routes.
- `apps/web`: the React + Vite SPA.

What makes the boundaries *real* and not just drawn: an **architecture test** that fails the build if `domain` imports from
outside itself, if `jurisdictions` touch adapters or application, or if `application` imports an adapter.

One structural choice that affects everything: **one codebase, different roles at runtime.** The `ROLE` variable decides what a
process does: `api`, `worker`, `events` or `all` (the local default). The `REACTOR_CONSUMERS` variable chooses which event
consumers that process runs. So the same container becomes an API, a worker or a notifier without changing code.

### The database

Kysely on SQLite (local) and PostgreSQL (containers, Azure) with **one portable migration**: ids as text, ISO-8601 timestamps as
text, JSON as text. The cost is that in PostgreSQL you do not use native `timestamptz` and `jsonb`; the gain is that the same
queries, the same tests and the same behaviour run on both. The same suite passes on SQLite and on PostgreSQL + Redis.

### The queue

There are three implementations behind the same port: in-process (local), PostgreSQL `LISTEN/NOTIFY` (containers and Azure),
BullMQ on Redis (still supported). In every case the queue is only a **signal**: the only truth is the publication row.

---

## 4. How it handles the differences between jurisdictions

The starting decision was to separate *what the law requires* from *how the channel works*, because they change for different
reasons and are owned by different people. Compliance reviews a policy; engineering and vendor management review a gateway.

### Policy (regulatory differences)

A policy is a value built with `definePolicy({...})` and registered in a `PolicyRegistry`. It contains:

- the **categories**, each with a Zod schema for its metadata (the UI form comes from `z.toJSONSchema`);
- the **validation rules**;
- the **deadlines** (when it has to be published, counted from which event);
- the **approval requirement** per category, in the form `{ min, mustInclude: roles }`, which can depend on the metadata;
- the channel **window** and the business-day **calendar**;
- the **identifier** checks (LEI with mod-97, ISIN with Luhn, CIK and CCC shapes, CVR with modulus 11);
- the **rendering** to the channel payload and the **post-publication obligations**.

Every policy answers the same six questions (`validate`, `approvalRequirement`, `timing`, `render`, `postPublication`,
`describe`). The workflow only asks those questions and never asks "which country is this". If you search for `'UK'`, `'US'` or
`'DK'` in the server, you find them in the policies, the demo data, the benchmarks and one rule of the fake AI, and nowhere in the
workflow.

The shared rules (maker-checker, hash binding) live in the defaults of `definePolicy`, once.

### Gateway (operational differences)

A gateway implements `PublishGateway` with two operations, `find` and `submit`, and reports errors as `GatewayError` of kind
`transient` (retry) or `permanent` (do not retry, a new revision is needed). There is a mock gateway per channel: RNS, EDGAR and
Nasdaq Copenhagen. Each models its own receipt, rejection, duplicate and outage. The Copenhagen one also enforces what the
exchange would: a valid CVR, LEI and ticker, a Danish or English announcement, a known market segment, no shareholder notices
from First North, and an inside-information flag that matches the type. It numbers company announcements per issuer and year
(`n/year`), as the real exchange does.

### What differs, concretely, in the model

| | United Kingdom | United States | Denmark (EU) |
|---|---|---|---|
| Framework and channel | UK MAR, Listing Rules, DTR; RNS | Exchange Act, Form 8-K, Reg FD; EDGAR | EU MAR, Transparency Directive, Companies Act; Nasdaq Copenhagen, stored in the Danish OAM (Finanstilsynet) |
| Categories | inside information, PDMR dealings, results, general | 8-K items 1.01, 1.05, 2.02, 5.02, 5.07, 7.01, 8.01; 6-K for foreign issuers | the UK's four plus major shareholder announcements, share buyback reports and notices of general meetings; each in Danish or English |
| Deadline | inside information: "as soon as possible" (a delay needs a recorded justification); PDMR: 3 business days **from the transaction**; DTR: results deadlines | 8-K: 4 business days from the event; item 1.05: from the materiality determination; items 7.01 and 8.01: voluntary, no deadline; Reg FD: simultaneous when intentional, otherwise the later of 24 hours and the next day's NYSE open | the same MAR and reporting rules counted on the Danish calendar; shareholder notice 3 trading days from the notification; buyback report 7 market sessions from the first trade in the report; meeting notice at least 21 days (annual) or 14 days (extraordinary) before the meeting |
| Approvals | inside information: two approvals including the company secretary; the others one | 8-K: legal plus one; item 2.02 requires legal **and** the CFO | as the UK; buyback reports need the CFO; meeting notices two approvers including the company secretary |
| Window | RNS hours, but inside information is never held for the window | EDGAR 06:00 to 22:00 ET; after 17:30 ET the filing date is the next business day | 07:00 to 22:00 Copenhagen; inside information is never held |
| Identifiers and issuer status | LEI, ISIN | CIK, CCC, filer status (domestic or foreign) | CVR, LEI, ISIN, ticker, market segment (main market, or First North with a Certified Adviser) |
| Receipt | RNS number | accession number and filing date | company announcement number per issuer and year |
| Failure | transient or permanent | an EDGAR suspension is permanent | transient or permanent, the same contract |

### How the model was corrected

After a domain review I corrected four points, which is proof that it is a model and not a claim: the PDMR deadline starts from the
transaction and not from the notification (L-19); items 7.01 and 8.01 have no deadline and 1.05 starts from the materiality
determination (L-20); the filer status decides between 8-K and 6-K (L-21); inside information is released even when the window is
closed (L-22). They are recorded in `discovery/ledger.md`.

### Adding a jurisdiction

Four steps: (1) write the policy in `apps/server/src/jurisdictions/<code>.ts` by copying `dk.ts` (and, if the law is the same as
another regime's, leaning on the rules in `mar.ts`); (2) write a gateway that implements `PublishGateway`; (3) register the policy
in `jurisdictions/index.ts` and the gateway in `runtime.ts`; (4) give the issuer the profile the policy requires. No migration, no
change to the workflow, no change to the UI: menus, forms, filters and console read the policies registered by the server. The
proof is Denmark, the third jurisdiction: one policy (`dk.ts`), one gateway class, two registrations and a profile in the seed;
the workflow was not touched. The test `operations.test.ts` ("adding a jurisdiction") registers it as the **only** jurisdiction and
takes a draft all the way to publication. The UK and Denmark share the MAR rules (inside information, managers' transactions,
results deadlines) written once in `mar.ts`; Denmark adds the mandatory language (Danish or English), a notification threshold for
managers' transactions, the CVR number, the Danish calendar and the Nasdaq Copenhagen channel.

Denmark is also the jurisdiction with the most categories (seven: the four of the UK plus major shareholder announcements, share
buyback reports and notices of general meetings), and it has an issuer status just as the United States has "domestic filer":
main market or First North (which needs a Certified Adviser and has no shareholder notices). Deadlines use the Danish calendar:
3 trading days from the notification for major shareholders, 7 sessions from the first trade in the report for buybacks, 21 days
(annual) or 14 (extraordinary) before the meeting for the notice. The company announcement number is per issuer and year
(`n/year`), as in reality, and stays unique even with simultaneous publications.

Two cosmetic places still have to be updated by hand: `apps/web/src/examples.ts` (sample text for the "Fill with example content"
button) and `labels.ts` (`SEND_NOUN`, the word "filing" for EDGAR).

---

## 5. Why publication is reliable

Releasing an announcement twice, or not releasing it, is the worst mistake in this domain. That is why the publication part is
built to be *reliable*, not just fast.

**The row is the truth, the queue is an alarm clock.** If Redis empties or a process dies, a periodic *sweeper* finds the expired
rows and re-queues them. So the queue can be unreliable without consequences. The price is up to one interval of latency after a
lost wake-up, and some polling.

**Lease with token.** A worker takes the publication with a compare-and-set that sets a lease; when it finishes it checks the
token. A worker that is too slow cannot overwrite the result of the one that took its place, and a second worker cannot take a
lease that is still valid.

**Idempotency key and `find` before `submit`.** The key `announcementId:revision` travels to the channel, and the runner asks
`find(key)` before sending. If the channel had accepted but the receipt was lost, the next attempt *finds* the filing instead of
sending a second one. This is the "lost acknowledgement" mode of the demo panel.

**Retries.** Transient errors retry with exponential backoff and jitter up to a budget, then the publication is `exhausted` and
the announcement `failed` with a visible **Retry** action. Permanent rejections are not retried: they are fixed with a new
revision.

**Surrounding protections.** A concurrency limit for each gateway and per worker, to respect the vendor's limits; a timeout on
every call (half the lease) so that a hanging connection fails as transient and frees the slot; and every exception after the
claim goes through the same retry budget, so a publication always ends in a visible state and does not loop forever at every
lease expiry.

**A race found and fixed.** A stress test showed that a delayed wake-up could arrive a millisecond before the intended moment
(different timer and database clocks) and was discarded. Now the runner re-arms it. It is covered by a test.

What I *cannot* do with a real vendor: real RNS, EDGAR and Nasdaq Copenhagen do not offer a lookup by idempotency key. Here the
mock models that capability so reconciliation can be tested; with a real vendor it becomes a lookup by headline, time and issuer,
or reading the vendor's history, and has to be designed separately.

---

## 6. Integrity and audit

- **Immutable revisions with hash.** An approval is bound to the hash of what was reviewed. Editing, reopening or requesting
  changes *voids* the approvals. At release time the runner checks again (`approvedContentProblem`).
- **Maker-checker** enforced by the server and reflected in the UI (the Approve button is disabled with an explanatory sentence
  for the author and for anyone who has already approved).
- **Per-announcement audit in a hash chain.** Every event contains the hash of the previous one, and `(announcement_id, seq)` is
  unique, so concurrent writers cannot fork the chain. `verifyAuditChain` detects edits, deletions and reordering; the UI and the
  demo print the result. It is *tamper-evident*, not tamper-proof: whoever can rewrite the whole table can rewrite the chain.
  The chain heads would have to be anchored in a write-once store.
- **Isolation between companies.** Every query is filtered by issuer. An announcement from another company gives 404, not 403, so
  its existence is not even revealed.
- **Optimistic concurrency.** Every announcement has a version and updates are compare-and-set. Two simultaneous Publish
  requests give one success and one clean 409.
- **Idempotent creation** through the `Idempotency-Key` header.

---

## 7. Events, readers and agents

Everything that happens *because of* a workflow step and is not part of it is a **consumer** of a **domain event**. The workflow
writes the event in the same transaction as the change (outbox pattern): one row in `domain_events` and one row for each
interested consumer in `event_deliveries` (`pending`, `in_flight`, `done`, `dead`). A **reactor** takes deliveries with a lease,
calls the consumer, and on error retries with backoff; after `REACTOR_MAX_ATTEMPTS` the delivery becomes `dead` and waits for a
person.

What you gain: no lost work (if the publication is committed, the event exists; if not, it does not), isolation (a slow mail does
not block publication), and a new consumer is registered instead of being wired into the workflow. What it costs: delivery is
*at least once*, so every consumer has to be idempotent; there is about one second of latency (polling); and a table to prune
(delivered events are deleted after 14 days).

Deliveries are created at write time, one per consumer. A consumer added later does not see the old events: no accidental replay
of a year of announcements to a new notifier.

### Readers

There is a **public archive** (published announcements only, with no people, approvals or unpublished text) filterable by
company, jurisdiction, category, date and text; an **Atom feed** per filter; and **subscriptions** by email or signed webhook. The
security rules are the carefully designed part:

- double opt-in: until the owner confirms, only the confirmation message is sent;
- the form always answers the same way (202), whether the address is known or not, so nobody can find out who is subscribed;
- every message has a one-click unsubscribe (`List-Unsubscribe`), and leaving deletes the address;
- webhooks are https only, signed, and never call private, loopback, link-local or metadata addresses (checked at connection time,
  even for literal IPs, which a test had to discover because Node skips the DNS lookup for literal IPs);
- limits: 10 subscriptions per address, 5 form submissions per hour per client, at most 5 search words.

The confirmation, unsubscribe and signing tokens are *derived* (HMAC of the subscription id with a single key,
`READER_TOKEN_KEY`), so there is nothing per reader to leak. The cost: rotating the key breaks links already sent.

### Agents

An agent is a consumer with guardrails. It is **advisory only**: it reads a copy of the announcement and writes to `ai_reports`,
but it has no hold on the workflow, so it cannot approve, edit, send or publish. Its output is validated with a schema, there is
one report per event, an agent that fails fails alone, and agents can chain up to `MAX_AGENT_CHAIN` (5) so two agents do not
trigger each other forever. With a real provider the agents do not start by themselves by default, because every submission
would cost money.

---

## 8. The AI pre-check

It suggests a classification, missing information and UK MAR / EU MAR (Denmark) / US Reg FD risks, with the quote that justifies
them. It also reads Danish wording and notes when the language declared for a Danish announcement does not match the language of
the text. **It does not approve, block or publish.** It lives in a separate table and a separate port, so it cannot change any
state. Its output is validated with Zod and against the category vocabulary of the policy; malformed or out-of-vocabulary output
is discarded. The announcement travels as quoted data, with a system prompt that tells the model not to follow instructions
contained in the text (defence against prompt injection). The default is a deterministic mock: tests and the demo need neither a
key nor a network. With `AI_PROVIDER=off` the feature disappears and a test runs the whole workflow that way.

Declared limit: the real Anthropic provider has never been tried against the real API, only with a simulated `fetch`. It would
also send unpublished text to a third party, and for that reason production would need explicit consent per company.

---

## 9. How it runs locally

There are three ways to run the *same* code. Only the adapters change (environment variables).

| | Mode 1: `npm start` | Mode 2: `docker compose up --build` | Mode 3: Azure |
|---|---|---|---|
| Login | demo characters (`x-user-id` header) | real OIDC with Keycloak (Authorization Code + PKCE) | OIDC with Entra ID |
| Database | SQLite file in `apps/server/data/` | PostgreSQL 16 | PostgreSQL Flexible Server |
| Queue | in-process | PostgreSQL `LISTEN/NOTIFY` | same |
| Processes | one | api, worker ×N, notifier, agents, migration job | separate Container Apps |
| Reader mail | in-memory demo mailbox (`/public/mailbox`) | Mailpit (mail on :8025) | Azure Communication Services Email |
| Public edge | none | nginx cache on `/api/public` | Front Door Premium |
| Status | tried | tried | validated offline, never applied |

### Mode 1 in practice

From an empty computer: download the ZIP, double-click `bootstrap.cmd` (Windows) or run `sh bootstrap.sh` (Linux/macOS). The
script looks for Node 22 or newer; if it is missing it downloads the official portable Node into `.tools/node` inside the folder,
checks its SHA-256 against the list from nodejs.org, then runs `npm install` and starts. It needs no administrator rights, does
not change the PATH and installs nothing system-wide. Open `http://localhost:3000`. The reason for Node ≥22 is that
`better-sqlite3` ships prebuilt binaries only from Node 22 up; with Node 20 it would have to be compiled (Python and a C++
toolchain needed), so the project refuses it with a clear message (`engines.node >=22` plus `engine-strict`).

To try it: choose **alice** on the sign-in page, create a UK, US or DK announcement, press "Fill with example content", save,
**Validate**, **Submit for review**. Then enter as **bob**, **carol**, **dan** to approve and as **erin** to publish. The **Mock
newswires (demo)** panel makes delivery fail on purpose: transient errors (then success), a permanent rejection, or a lost
acknowledgement (the channel accepts but the receipt does not arrive, and the retry *finds* the filing instead of duplicating it).

Without a browser: `npm run demo` (with the app running in another terminal) publishes one announcement per jurisdiction (UK, US,
Denmark) through the API and prints the receipts and the audit-chain check.

### Mode 2 in practice

You need Docker Desktop and ports 3000, 8080, 8081 and 8025 free. The first build takes about two minutes. Open
`http://localhost:8080`; the users are the same names (alice, bob, carol, dan, erin) with a local demo password defined in the
Keycloak realm. Services: `postgres`, `keycloak`, `migrate` (once), `api`, `worker`, `notifier`, `agents`, `mailpit`, `web`. For
more publishing capacity: `docker compose up --build --scale worker=2`. With `AUTH=oidc npm run demo` the demo uses a real token
for each person (run `npm install` once on the host first).

### Commands you need

| What | Command |
|---|---|
| Full start | `bootstrap.cmd` or `sh bootstrap.sh` |
| Prepare only | `bootstrap.cmd -NoStart` / `sh bootstrap.sh --no-start` |
| Demo through the API | `npm run demo` (or `bootstrap.cmd -Demo`) |
| Tests | `npm test` (219 server plus 12 web), `npm run typecheck` |
| Benchmark | `npm run bench`, `npm run bench:readers -w apps/server` |
| Start from scratch | delete `apps/server/data/` |
| Another port | `PORT=3001 npm start` (PowerShell: `$env:PORT=3001; npm start`) |

### The UI

It is the React + Vite SPA, built from a product specification ("SignalFlow IR", a working name; on screen the product is called
Disclosure Hub). The main routes: `/login`, `/app/overview` (KPIs and a "needs your attention" queue), `/app/announcements`
(filterable list), a four-step composer (Details, Content, Validate, Preview), a detail page with revision diff, a side-by-side
review room, a publishing console with the deliveries and the fake newswire controls, activity, and the public archive under
`/public`. The server remains the authority: the UI hides what a role cannot do, but the API refuses it anyway. Receipts are always
labelled **Published · Demo**, never a bare "Published" while the channel is fake. Accessibility was looked after (status with icon
plus text, native `<dialog>`, `prefers-reduced-motion`, layout down to 400 px), but an audit was *not* done.

---

## 10. Azure: what is there and what is not proven

`infra/azure` is the Terraform of the same architecture on managed services. The design:

- **Compute:** Azure Container Apps in a zone-redundant environment. API 2-4 replicas, worker 2-3 replicas, one app for each group
  of event consumers (`consumer_sets`), with at least one replica. The `migrate` job runs from the pipeline before every rollout
  with an identity *different* from the runtime one (the runtime cannot alter tables).
- **Database:** PostgreSQL Flexible Server 16, zone-redundant HA with a synchronous standby, private network, Entra-only
  authentication, 14-day point-in-time restore, geo-redundant backup, locked against deletion. No password: the managed
  identity's token is the password, renewed on every connection.
- **Access:** Microsoft Entra ID, two app registrations (API with five app roles, browser app PKCE-only), roles from groups.
- **Edge:** Front Door Premium with cache for the public routes, managed WAF rules (in Log mode at first) and a rate rule on the
  subscription form, Private Link to an environment that has no public address.
- **Network and secrets:** VNet, registry and Key Vault with private endpoints and no public access, a single outbound address (NAT).
- **Mail:** Azure Communication Services Email with the managed identity, no SMTP password.
- **Second region (optional):** database read replica, geo-replicated registry, standby API, writers at zero, Front Door with a
  fallback origin. Failover is *by decision*, not automatic (a false positive would promote the replica while the primary is still
  writing, and two writers do not merge). Design estimate: about 15 minutes after the decision.
- **Governance:** `infra/azure-landing-zone` (management groups, policy in report mode, RBAC per group), a separate root with its
  own state.
- **Operations:** Log Analytics, 8 alerts plus a publishing-backlog alert, a replica alert per consumer group, outbox-lag and
  dead-delivery alerts, and a budget.

### What is verified, offline

`terraform fmt`, `init` and `validate` against the real provider schemas; 42 tests with simulated providers that assert the
security and resilience properties (private network, Premium edge, two minimum replicas, `AUTH_MODE=oidc`, `DEMO=0`, only the app
subnet reaches the database, and so on); tflint, trivy and checkov. Deliberately changing one of those properties makes a test
fail (checked). Validation against the real schema already found an invalid Front Door compression type before any deploy.

### What is NOT verified

**Nothing has been applied.** There was no subscription. `infra/azure/README.md` lists eleven points that can only be proven with
a deploy, each with the check to run: Entra roles in the token; database connection with the token as password beyond the
30-minute recycle; `LISTEN/NOTIFY` on the direct port 5432 (not on the built-in PgBouncer, which breaks it); acceptance of
subnets, NSGs and the zone-redundant environment; names of the alert metrics; deploy workflow with federated credential; failover
and restore; assignment of groups to roles (needs Entra ID P1); Email API with the managed identity token; managed sender domain
and its volume limit; number of `TRUST_PROXY` hops behind Front Door.

### Two theoretical weaknesses I found on re-reading

1. **The worker scales on CPU at 70%** (`apps.tf`). But it spends its time waiting for the newswire (200 ms latency), so CPU stays
   low even with a long queue and autoscaling would not trigger on the real load. Today it does no harm because the range is fixed
   and small (2-3 replicas) and the expected peak is 0.17/s while 2 workers already handle about 15/s. This is now stated in the
   Terraform and covered by an alert on the age of the oldest waiting publication. The real fix is to scale on the age or number of
   waiting publications, which arrives with Service Bus (a KEDA rule on PostgreSQL is not possible because the database is
   Entra-only).
2. **WAF in Log mode and landing-zone policies in report mode.** They are sensible to start with, but before real traffic they must
   be moved to "block".

---

## 11. Is it scalable? The monolith argument

"Monolith" here describes how you write and release the code, not how it runs. One codebase and one image, but at runtime they are
separate processes by role, each in independent replicas. You scale the piece you need: more workers if publications are slow,
more APIs if there are many reads.

Why it works: the processes hold no state (all state is in the database), a signed token is verified locally with cached keys, and
the lease with token plus the idempotency key make any number of workers safe.

Why not microservices: announcement, approvals, publication and audit must be consistent in the same transaction, and splitting
them would mean distributed transactions exactly where an error costs most. There is also no scale reason (one team, a low load).
The seams for splitting later already exist: queue, worker role, database adapter, event consumers.

### The numbers (laptop under Azure resource limits; a method and a trend, not a capacity promise)

- 1 worker: 9 publications per second; 3 workers: 27. About 90% of the ceiling set by a 200 ms gateway. Over 900 publications: 900
  confirmed, 900 distinct external references, **0 duplicates, 0 failed attempts**.
- With real OIDC and the PostgreSQL queue under Azure limits: about 15 publications per second with 2 workers, p95 of 0.57 s for
  the 5-call draft→published sequence, 16 database connections. The sizing peak is 0.17/s (100 publications in 10 minutes): about
  90 times the margin.
- A 0.5 vCPU API handles about 80 write requests per second; 50 active people produce about 25 requests per second.
- Archive with 100,000 published announcements: from 506 ms to 2 ms after an index found by measuring (migration 004).
- Sweeper and claim read only non-terminal rows (two partial indexes): 0.28 ms with 300,000 finished publications.
- Notifier: about 275 followers per second (ceiling 500 for one process); 5,000 followers with nobody notified twice.
- Text search by word: 70-140 ms with 10,000 announcements, 0.9-2 s with 100,000 (a scan of the bodies).

### Assumed sizing

A listed group or a small IR agency: up to 5 issuers, 300 people, about 300 announcements a month, a peak of 100 publications in 10
minutes with 10 times the margin. The initial figure of 5,000 issuers was a market-operator estimate and was discarded.

### Where it stops

The **single database** acts as queue, outbox, search and archive, and writes on one instance. The first limit I expect is the
connection pool, then text search. ADR 0001 gives the numbers that trigger the exits:

- queue on Service Bus: above about 100 sustained events per second, or an external consumer, or more than about 100,000
  followers per announcement, or more than 6 workers (every worker listens to every notification);
- search outside the database: p95 above 500 ms at the source, or above about 50,000 announcements (first a `pg_trgm` index, then
  Azure AI Search fed from the same outbox);
- 10 issuers or more, or companies that must not see each other at database level: a company claim in the token
  (`OIDC_ISSUER_CLAIM`).

And the real ceiling is external: RNS, EDGAR and Nasdaq Copenhagen throttle submissions. The platform limits concurrency per
gateway, but **per worker process**, not globally: with N workers the vendor sees up to N x 2 calls (12 at the 6-worker ceiling).
It is a knob to set against the vendor's limit, not a guarantee; a global cap needs shared state and is a later step.

A second honest limit: the worker autoscaling on Azure is on CPU, and a worker waiting on a slow vendor is idle, so CPU does not see
a growing queue. The real capacity is the minimum of 2 workers (about 15 publications per second measured, against a peak of 0.17).
The queue is watched by an alert on the age of the oldest waiting publication (the worker logs it every minute). A queue-driven
scaler arrives with Service Bus: today it cannot be tied to the database because it is Entra-only (no password for a `postgresql`
scaler).

What I can claim about scale, in the wording to use: it scales out per project, and I measured it for the workers locally; I did
not measure it on Azure.

---

## 12. The trade-offs, reasoned

This is the part that matters most in the interview. Every choice has a gain and a cost; you must be able to say both.

**Declarative policies.** Gain: a new jurisdiction is mostly data, and the rules are reviewed in one file. Cost: a jurisdiction
whose workflow *shape* is different (for example a regulator pre-clearance step) needs a new transition, not just a policy. That is
what the next jurisdiction might force first. Policies are also code reviewed in a pull request: if a compliance officer had to
change them without engineers, an admin UI or policies in the database would be needed (option listed, ASR-2, not built).

**Timestamps and JSON as text.** Gain: one migration, two databases, identical tests. Cost: no JSON or date queries on the database
side; a reporting layer would want real types.

**Row as truth, queue as hint.** Gain: survives the loss of Redis, simple reasoning. Cost: the sweeper adds up to one interval of
latency after a lost wake-up, and polling.

**Hash chain per announcement.** Gain: cheap, local, verifiable. Cost: it does not stop a privileged actor who rewrites everything
(external anchoring is needed).

**OIDC tokens with roles from the token.** Gain: works the same with Entra ID and Keycloak, no password stored, MFA and conditional
access remain the company's policy. Cost: a deployment serves a default company unless the token carries one; no per-role step-up
on publish; `npm start` still has the demo characters (active only in demo mode).

**`LISTEN/NOTIFY` as queue in the small topology.** Gain: no Redis to run, update and pay for, and the row is the truth anyway.
Cost: every worker wakes on every notification, so few workers (hard limit 6); a notification during a listener outage is lost
and the sweeper recovers it.

**Outbox in the same database, with polling.** Gain: a published announcement and its notifications cannot diverge, and there is
no broker. Cost: about a second of latency, a table to prune, and a few hundred events per second before a broker is worth it.

**Fake newswires with failure modes.** Gain: the error paths can be shown and tested. Cost: the real semantics of RNS, EDGAR and
Nasdaq Copenhagen (rejections, costs, test filings) are unknown until integrated.

**Vite + React instead of Next.js.** Gain: smaller, no server-side rendering needed. Cost: a departure from the example stack in
the brief.

**A domain system with simplified rules.** Gain: it shows *how* jurisdiction logic is expressed and enforced. Cost: it is not legal
advice and must be reviewed by a lawyer before real use.

**Advisory, optional AI.** Gain: no risk of a wrong state, the system works the same without it. Cost: it does not automate
decisions.

**Modular monolith.** Gain: transactional consistency and a single deploy. Cost: the single database is the common bottleneck.

**The scope.** You built more than a short take-home asked for (readers, webhooks, agents, Terraform, DR). It is an advantage if
you explain it as a choice of depth on reliability; it is a risk if it looks like a distraction or if you cannot stand up to
questions on every part. That is why the README points to the short path.

---

## 13. What you cut, and why

Cut in this order to protect the complete flow, the quality of the tests and the reliability of publication:

- **Scheduled release and embargo.** A real feature but orthogonal to the main path; the mechanism of delayed jobs and windows
  that it would need already exists. Note: results and the London 07:00 opening depend on exactly this.
- **Attachments and iXBRL / structured financial data.** Wide surface, little extra architectural evidence. EDGAR exhibits are
  modelled only as a mandatory flag.
- **Real integrations with the newswires.** Interfaces and error taxonomy exist; the vendor's behaviour is unknown without access.
- **Translations, more categories** (other DTR items, other 8-K items).
- **Regulatory scope a compliance expert will ask about:** corrections after publication (published is terminal), linking the two
  announcements of a dual-listed issuer, insider lists (MAR Art. 18), PDMR closed periods, major-holdings notifications for the UK
  (DTR 5, TR-1; Denmark has its own), 10-Q and 10-K forms, Section 16 forms, and a timed deadline for an intentional disclosure
  under Reg FD.
- **Vendor facts to check before a real filing:** real RIS and EDGAR have no lookup by key; EDGAR Next changed access and the CCC
  code may be legacy; the 17:30 ET limit is the 8-K rule, other forms differ.
- **Notifications to approvers** (they exist for readers, but not to tell someone who must approve that they have work), reporting
  and agents that *act* instead of advising.
- **Distributed tracing.** There are structured logs and `/metrics`; there is no OpenTelemetry across API, queue and worker.
- **Authentication:** built, but per-role step-up, SCIM provisioning and company-per-user mapping beyond the default or a claim
  are out.

---

## 14. Verified, measured, designed

| What | Status |
|---|---|
| Draft→published in the UK, US and Denmark, from the UI, the REST demo and the tests | **Verified by running it** |
| Retries, exhaustion, permanent rejection, lost acknowledgement, lease takeover after a crash, recovery of a lost wake-up | **Verified** (tests) |
| 219 tests on SQLite; 7 gated integration tests run in CI with PostgreSQL 16 + Redis 7, including two worker processes with no double release | **Verified locally except the gated adapter tests; CI verifies the full 226** |
| OIDC with Keycloak, Authorization Code + PKCE from a real browser | **Verified** |
| Compose twin: separate api, worker, notifier, agents; mail delivered to Mailpit; nginx cache | **Verified** |
| Bootstrap from scratch on Windows and Linux (Node 22.12/22.23.4/24, refusal of Node 18/20, Docker from a fresh clone) | **Verified**; macOS, Docker on a Linux host and a truly clean Windows **not** tried |
| Independent code and security review | Done; fixed: auth decided on the route (an encoded path such as `/%61pi/` skipped it), persona auth refused with `DEMO=0`, malformed cursor → 400, approval bound to the revision, race on publish → 409, timeouts and crash after the claim, Compose ports on localhost |
| Throughput and latency numbers | **Measured** on a laptop with Azure limits |
| Azure Terraform | **Designed**; validate, tflint, trivy, checkov and 42 tests with mocks pass; **never applied** |
| Second region and failover | **Designed**, never tried |
| Anthropic provider against the real API | Not tried (only with a simulated `fetch`) |
| Legal correctness of the rules | Not verified |
| Real RNS, EDGAR and Nasdaq Copenhagen | Unknown without access |
| p95 per single API call under 200 ms (NFR-2) | Not demonstrated |
| 5-year audit retention (NFR-6) | Not enforced by any policy |
| More than one browser, accessibility audit | Not done |

---

## 15. The weaknesses, stated honestly

Ordered by how hard a reviewer might push:

1. **Azure never applied.** It is not your fault and you say so, but it remains the biggest risk. The first `apply` may need fixes.
2. **The three jurisdictions have the same workflow shape.** If a regime needs a new transition (pre-clearance), the policy is not
   enough. The Danish rules are a model (notification thresholds, general-meeting notice periods, hours and calendar are
   assumptions to be confirmed by a Danish lawyer, as for the UK and US).
3. **The worker autoscaling signal is CPU**, which is not suited to a process waiting on I/O (mitigated by the backlog alert).
4. **The single database** is the common bottleneck; the exits are defined but not built.
5. **The measurements are from a laptop.** Not measured: more than 3 workers, a remote database, load over hours, failure of Redis
   or PostgreSQL under load.
6. **The rules are simplified models** and must be validated by a lawyer.
7. **"Find before resending"** does not exist at real vendors.
8. **The volume.** A lot of documentation and many features beyond the brief: you must be able to defend all of them.
9. **The repo is private.** The reviewer must be given access or the ZIP.
10. **You have two small cosmetic lists of jurisdictions** (`examples.ts`, `labels.ts`) that a pedantic reviewer will find.

---

## 16. Likely questions and ready answers

**Why a modular monolith?** One team, one deploy, and a state machine that needs transactional consistency across announcement,
approvals, publication and audit. The seams that matter for scale (queue, worker role, database adapter, consumers) are already
separate, so it can be cut along them.

**What happens if the queue or Redis is lost?** Nothing is lost: the row is the truth and the sweeper re-queues the expired ones.

**How do you avoid a double release?** Lease with token, an idempotency key looked up at the channel before a resend, and a single
claim. Tested with a worker that crashes and with a lost acknowledgement.

**What if the mail service is down?** The notification retries on its delivery row; publication is not affected.

**How did you add the third market?** Policy + gateway + two registrations; the UI reads it from the server. I chose Denmark (EU,
Nasdaq Copenhagen): it reuses the UK's MAR rules and adds language, threshold, CVR, market segment, calendar, channel and three
categories of its own. A fourth (Sweden, Germany) would reuse `mar.ts` the same way.

**Where does it break first?** Database connections and text search; the ADR has the numbers and the exit.

**Is AI on the critical path?** No. It is advisory, behind a port, validated, and the whole workflow is tested with AI off.

**Why two places (policy and gateway)?** Because regulatory and operational differences change for different reasons and have
different owners: compliance versus engineering.

**What is not done?** Scheduled release/embargo, attachments and iXBRL, corrections after publication, real newswires. The list
with the reason for each is in `ARCHITECTURE §5`.

**Is it production-ready?** Not on Azure: the design is complete and validated offline, but never applied. First you need a staged
deploy in `test` that ticks off the eleven points, a failover drill with measured times, a load test inside Azure, sandbox access
to the newswires with a redesign of idempotency, and a legal review of the rules.

**Does it really scale in production?** Say it this way: it scales out per project, I measured it for the workers locally, and I
did not measure it on Azure.

**Why did you not apply Azure?** I had no subscription. For every unproven point I wrote how to prove it at the first deploy.

**How much does it handle?** About 15 publications per second with 2 workers (measured under Azure limits) against an expected
peak of 0.17: about 90 times the margin. The real ceiling is the vendor.

---

## 17. What I would do next

1. A **fourth jurisdiction** with a different shape (Sweden, Germany, or a regime with pre-clearance, which needs a new
   transition).
2. Change the worker scaling signal: from CPU to queue length or age.
3. A **first deploy** into a `test` subscription following `infra/azure/README.md`, then record failover and restore times in
   `docs/SIZING.md`.
4. Enqueue with a **transactional outbox**, so a crash between commit and enqueue does not depend on the sweeper.
5. **Row-level security** in PostgreSQL as a second isolation layer under the query filter.
6. **Anchor the audit chain heads** in a write-once store.
7. **OpenTelemetry** across API, queue, worker and channel; alerts on exhausted publications.
8. An **evaluation threshold** for the real LLM: a labelled set and a recall threshold on risks before enabling it in production.
9. Per-role step-up on publishing and scheduled release/embargo.
10. A **global cap on gateway concurrency** and separating "accepted" from "published" in the data model.

---

## 18. File map (where to look for what)

| What you are looking for | Where |
|---|---|
| Overview and start | `README.md`, `bootstrap.cmd`, `bootstrap.sh`, `scripts/bootstrap.ps1` |
| Answer to the three points of the brief | `docs/BRIEF-RESPONSE.md` |
| Requirements, assumptions, decisions, open points | `docs/REQUIREMENTS.md`, `discovery/spec.md`, `discovery/ledger.md`, `discovery/handoff.md`, `discovery/questions.md` |
| Terms | `docs/GLOSSARY.md` |
| Architecture, trade-offs, cuts | `docs/ARCHITECTURE.md` |
| Extending (events, agents, channels, jurisdictions) | `docs/MODULES.md` |
| Capacity and costs | `docs/SIZING.md`, `docs/adr/0001-database-bottleneck-and-service-bus.md` |
| Disaster recovery | `docs/DR.md` |
| UI | `docs/UI.md` |
| Diagrams | `docs/diagrams/` (use cases, Azure, local; draw.io sources) |
| Azure | `infra/azure/README.md`, `infra/azure-landing-zone` |
| State machine | `apps/server/src/domain/state-machine.ts` |
| Policies | `apps/server/src/jurisdictions/uk.ts`, `us.ts`, `dk.ts`, `mar.ts` (shared MAR rules), `index.ts`; contract in `domain/policy.ts` |
| Ports (gateway, queue, etc.) | `apps/server/src/ports/` |
| Assembly and registrations | `apps/server/src/runtime.ts`, configuration in `config.ts` |
| Tests that prove the claims | `operations.test.ts` (boundaries, Denmark as the only jurisdiction), `workflow.test.ts`, `hardening.test.ts`, `events.test.ts`, `readers.test.ts`, `http.test.ts`, `auth.test.ts`, `pgqueue.test.ts` |
| License | `LICENSE` (all rights reserved, with evaluation permission for reviewers) |

---

## 19. Five sentences to keep in your head

1. "The worst risk is publishing twice or never: that is why the row in the database is the truth and the queue is only an alarm clock."
2. "I separated what the law says from how it is delivered: a policy and a gateway. The workflow never knows which country it is handling."
3. "A new country is a policy file, a gateway and two registrations: Denmark was added that way, and a test registers it as the only jurisdiction without touching the workflow."
4. "It scales out on the stateless processes; the limit is the single database, and I have the number that says when to move to Service Bus."
5. "The Azure design is complete and validated offline, but I never applied it: for every unproven point I wrote how to prove it at the first deploy."
