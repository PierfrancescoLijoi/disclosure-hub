# Sizing: a small or medium company

The platform is sized for **one listed company group** (or a small IR agency serving a handful of issuers), not for a
market operator. The numbers below are assumptions written down so they can be argued with, a capacity model built from
them, and the measurements that back the model. Where a number comes from a measurement it says so; where it is a guess it says that.

## 1. Assumptions

| | Assumed | Basis |
|---|---|---|
| Issuers | up to 5 | A group with a few listed entities, or an agency |
| People | up to 300 | Authors, company secretaries, legal, finance, publishers; most are occasional |
| Announcements | ~300 a month (about 10 a working day), each with several revisions | Regulatory news, results, board changes, holdings |
| Peak | 100 publications in 10 minutes (results day), 50 people active at once | Guess; the dominant event for an IR team |
| Growth headroom | 10x the peak with no change but replica count | The ceiling of the default configuration |
| Availability | 99.9 % a month, business hours matter most | A zone loss or a deploy must not stop publication |
| RPO / RTO, zone loss | 0 / minutes | Zone-redundant database with synchronous standby; two replicas minimum |
| RPO / RTO, region loss | minutes to the last replicated backup / hours | Geo-redundant backup restored in the paired region; no warm second region by design |
| Data | announcements, revisions, approvals, audit; well under 1 GB a year | 300 a month at tens of KB with revisions |

## 2. Capacity model

The things that can run out, in the order they would:

| Limit | Value | Where it comes from | Margin over the peak |
|---|---|---|---|
| Publications per second the platform can send | **~15 sustained** with 2 workers and a 200 ms gateway | Measured (section 3) | Peak is 100 in 600 s = 0.17/s: about 90x |
| Requests per second one API replica serves | **~80 write requests/s** (16 announcements/s, 5 calls each) | Measured, one API container at 0.5 vCPU | 50 active people at one request every 2 s = 25 req/s: 3x on one replica, 12x with the default two, 25x at the four-replica ceiling |
| What the outside world accepts | The gateway: RNS and EDGAR throttle submissions and have their own windows | Unknown here (mock gateway) | **This is the real ceiling**, not the platform; the runner retries with backoff and the idempotency key prevents a double filing |
| Database connections | (API max 4 + worker max 3 + job) x pool 5 = about 40 | `PG_POOL_MAX=5` per process; measured 16 with 1 API and 2 workers | Far under what a 2 vCPU server allows; an alert fires at 70 % of the replica ceiling's need |
| Workers | 2 to 3 (hard limit 6) | Every worker listens to every notification, so the cost of waking is paid by all of them | Past 6, move the queue to Service Bus or Redis (the BullMQ adapter exists) |
| Per-person request rate | 600 a minute, then `429` with `Retry-After` | `RATE_LIMIT_PER_MIN`, keyed by person | Stops a runaway script, never a human |
| Storage | 32 GiB, auto-grow on | Data volume above | Years |

**Sizing rule.** Add API replicas when concurrent requests per replica stay above 50 (the scale rule does it up to the
ceiling). Add a worker only when the oldest pending publication waits longer than the gateway's own latency. Raise the
database SKU when CPU is above 80 % for 15 minutes (alert) *after* looking at the slow-statement log. Every other
step up is a decision, listed in section 5.

## 3. Measurements

Run on a laptop with Docker Compose under the same resource limits the Azure configuration sets per replica
(API and worker 0.5 vCPU, database 1 vCPU), with real OIDC sign-in (Keycloak) on every call, the queue on PostgreSQL,
rate limiting off, and a mock gateway adding 200 ms to every submission. Each announcement goes draft, validate,
submit for approval, two approvals, then publication.

| Run | Concurrent people | Announcements | Draft-to-approved | End to end | Per-announcement latency (5 calls) | Failed attempts | Duplicate filings |
|---|---|---|---|---|---|---|---|
| SME profile | 5 | 200 | 16.4 /s | 15.5 published /s | p50 278 ms, p95 567 ms | 0 | 0 |
| Burst | 20 | 200 | 18 /s | 16 published /s | p50 1111 ms, p95 1490 ms (queueing) | 0 | 0 |

Database connections peaked at 16. Memory stayed far below the limits (API 65 MiB, workers about 50 MiB each,
database 68 MiB). The database held 402 publications at the end because it also contained the 200 + 2 announcements of earlier runs: all 402
acked, all with distinct external references.

**Limits of these measurements.** They are a laptop, a container database and a mock gateway, not Azure. They show the
shape (the platform is nowhere near the peak, correctness holds under concurrency) not an Azure figure. The Azure
database adds network latency in the zone and synchronous replication to a standby; each new connection fetches an Entra
token (connections are pooled and recycled every 30 minutes, so this is rare). Measuring on Azure needs a token source
the benchmark does not have yet (Keycloak's password grant has no Entra equivalent for accounts with MFA), and a real
test of the gateway needs the gateway's test endpoint. Both are listed as the first thing to do in `test` in
`infra/azure/README.md`.

## 4. The same numbers locally and on Azure

| | Local Compose | Azure |
|---|---|---|
| API | 1 container, 0.5 vCPU, 512 MiB | 2 to 4 replicas, 0.5 vCPU, 1 GiB each, scale on 50 concurrent requests |
| Worker | `--scale worker=2`, 0.5 vCPU, 512 MiB | 2 to 3 replicas, 0.5 vCPU, 1 GiB each |
| Database | PostgreSQL 16, 1 vCPU, 1 GiB, no standby | `GP_Standard_D2ds_v5` (2 vCPU, 8 GiB), zone-redundant standby, 14-day point-in-time restore, geo-redundant backup |
| Identity | Keycloak, five seeded people, one company | Entra ID, five app roles (groups), one company per deployment |
| Queue | PostgreSQL `LISTEN/NOTIFY` | Same |
| Rate limit | 600 a minute a person | Same |

## 5. What would make us change it

| If | Then |
|---|---|
| More than ~10 issuers, or companies that must not see each other at the database level | The data model is tenant-keyed already; add a company claim to the token (`OIDC_ISSUER_CLAIM`) instead of the single default, and review the DBA group's access |
| 3,000 people instead of 300 | API ceiling to 8, database SKU up one step, review the log volume and the rate limit |
| Publications must go to more venues than the gateways today | Add a jurisdiction (a policy file and a gateway adapter); no change to capacity |
| A worker ceiling above 6 | Move the queue to Service Bus or Redis |
| A regional outage must cost minutes, not hours | Warm second region: read replica, second container environment, Front Door for failover |
| Policy requires WAF, private endpoints for the registry and vault, an egress firewall | See "Not included" in `infra/azure/README.md`; none changes the application |

## 6. Cost: drivers, not prices

No price is quoted: prices change and differ by agreement; use the Azure pricing calculator with these line items.
The configuration's `monthly_budget_eur` (default 600) is a guard that mails at 80 % and 100 % of actual and 100 % of
forecast, not an estimate, and it does not stop spending.

| Line | Driver | Lever |
|---|---|---|
| PostgreSQL | Two zone-redundant compute instances plus storage and backup. **The largest line.** | SKU, or a non-HA `test` environment; Burstable cannot do zone-redundant HA, so production does not use it |
| Container Apps | 2 API + 2 worker replicas always on, plus the occasional job | Replica minimums are the floor of the availability promise; do not lower them in production |
| Log Analytics | Ingestion by volume, retention beyond the included period | `log_retention_days`, and not logging statements or bodies |
| Container Registry | Standard SKU, flat daily rate, storage | Prune old digests |
| Entra ID | Group-to-role assignment needs P1 (probably already licensed) | Assign roles to people if not |
