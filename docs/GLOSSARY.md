# Glossary

Terms used across the code and the documents, each with a one-line meaning and where to read more. Regulatory terms
describe the **simplified model** in this repository, not the law (see the disclaimer in the [README](../README.md)).

**Find an answer fast**

| If you want to know | Go to |
|---|---|
| How the three points of the brief are answered | [BRIEF-RESPONSE.md](BRIEF-RESPONSE.md) |
| What the system must do, how well, what was assumed, what is open | [REQUIREMENTS.md](REQUIREMENTS.md) |
| Why it is built this way, trade-offs, what was cut | [ARCHITECTURE.md](ARCHITECTURE.md) |
| How to add a jurisdiction, consumer, agent or channel | [MODULES.md](MODULES.md) |
| How big it is, what was measured | [SIZING.md](SIZING.md), [ADR 0001](adr/0001-database-bottleneck-and-service-bus.md) |
| What happens if a region fails | [DR.md](DR.md) |
| What is deployed on Azure and what is unproven | [infra/azure/README.md](../infra/azure/README.md) |
| How the screens behave | [UI.md](UI.md) |
| Pictures | [Use cases](diagrams/01-use-cases.drawio.png), [Azure](diagrams/02-azure-architecture.drawio.png), [Local](diagrams/03-local-architecture.drawio.png) |

## The announcement and its workflow

| Term | Meaning | Read more |
|---|---|---|
| **Announcement** | One regulatory release, for one issuer, in one jurisdiction and category. It has a status and a list of revisions. | `domain/types.ts` |
| **Status** | `draft`, `validated`, `in_review`, `approved`, `publishing`, `published`, `failed`, `withdrawn`. `published` and `withdrawn` are terminal. | `domain/state-machine.ts` |
| **Transition** | A legal move between statuses (submit, publish, retry, reopen, withdraw...). The table exists once and no jurisdiction changes it. | `domain/state-machine.ts`, spec FR-1 |
| **Revision** | An immutable saved version of the headline, body and jurisdiction details. Editing creates a new revision and voids earlier validation and approvals. | spec FR-2, BR-8 |
| **Content hash** | SHA-256 of a revision. Approvals are bound to it, and the runner re-checks it before sending. | `domain/hash.ts`, ARCHITECTURE §2.3 |
| **Validation** | Running the shared rules and the jurisdiction's rules on a revision; returns errors (block) and warnings (do not). | `policies.test.ts` |
| **Approval requirement** | How many approvals and which roles a category needs, snapshotted when the revision is submitted. | `domain/policy.ts` |
| **Maker-checker (four-eyes)** | The author of a revision cannot approve it, and each required role needs a distinct approver. | spec FR-5 |
| **Stale revision** | An approval sent for a revision that has since been replaced; the server answers 409 `STALE_REVISION`. | ARCHITECTURE §2.3 |
| **Publication** | The act of sending a revision to a channel, stored as its own row with attempts, a lease and a result. | ARCHITECTURE §2.2 |
| **Acknowledgement (ack)** | What the channel returns on acceptance: an RNS number or an EDGAR accession number, plus the accepted time and filing date. | `ports/index.ts` (`PublishAck`) |
| **Audit trail / audit chain** | Every state change, attempt and AI report recorded as an event; each event hashes the previous one, per announcement, so edits, deletions and reordering are detectable. Tamper-evident, not tamper-proof. | ARCHITECTURE §2.3, spec FR-9 |
| **Pre-check** | The advisory AI report: classification, missing information, possible UK MAR or Reg FD risks, each with evidence. Never changes a status. | ARCHITECTURE §2.5 |

## Jurisdictions and channels

| Term | Meaning | Read more |
|---|---|---|
| **Jurisdiction** | A regulatory regime plus its delivery channel, identified by a code (`UK`, `US`). The code is a plain string. | BRIEF-RESPONSE §2 |
| **Policy** | The regulatory half of a jurisdiction: categories, validation, deadlines, approval requirements, window, calendar, rendering. Built with `definePolicy`. | `domain/policy.ts`, `jurisdictions/uk.ts`, `us.ts` |
| **Category** | A kind of announcement within a jurisdiction (inside information, PDMR dealing, 8-K item 2.02...). It carries a Zod schema for its details, its rules, deadline and approval. | `domain/policy.ts` |
| **Metadata (details)** | The jurisdiction-specific fields of a revision. The form is generated from the category's schema. | UI.md |
| **Policy registry** | Where policies are registered; the only list of jurisdictions the workflow knows. | `jurisdictions/index.ts` |
| **Gateway** | The operational half of a jurisdiction: an adapter with `find` and `submit` that talks to the channel. Today a mock. | `ports/index.ts` (`PublishGateway`), `adapters/gateways/mock.ts` |
| **Channel** | The outside system a release goes through: RNS, EDGAR. (Reader channels, such as email and webhook, are a different thing: see Readers.) | policy `channel` |
| **Transient / permanent error** | A gateway failure that is retried with back-off, or one that is not (the fix is a corrected revision). | `GatewayError` |
| **Idempotency key** | `announcementId:revision`, sent to the wire; the runner asks `find(key)` before resubmitting so a lost acknowledgement never causes a duplicate. | ARCHITECTURE §2.2, spec FR-7 |
| **Window** | The hours a channel accepts submissions. Categories may declare that they are never held for it (`releaseOutsideWindow`). | `domain/calendar.ts`, spec BR-7, BR-10 |
| **Calendar** | Business days and holidays of a jurisdiction, used for deadlines and the filing date. | `jurisdictions/calendars.ts` |
| **Deadline** | When the duty falls due, or none (as soon as possible, or voluntary). Late is a warning, not a block. | `domain/policy.ts` (`Deadline`) |
| **Issuer** | A listed company. Also the **tenant**: every query is filtered by issuer. | spec FR-10 |
| **Issuer profile** | Per-jurisdiction identifiers and status the channel needs (LEI, ISIN; CIK, CCC, filer status). | `jurisdictions/identifiers.ts` |
| **Mock newswire** | An in-process model of RNS or EDGAR with controls to fail on purpose (transient, permanent, lost acknowledgement). | README, "Try it" |

## Reliability and processes

| Term | Meaning | Read more |
|---|---|---|
| **Worker** | A process that takes publications from the queue and sends them (`ROLE=worker`). | README, Configuration |
| **Lease** | A time-limited claim on a publication, taken by compare-and-set and checked by token on completion, so a slow worker cannot overwrite the one that took over. | ARCHITECTURE §2.2 |
| **Sweeper** | A loop that re-enqueues overdue publications, so a lost wake-up costs latency, not a release. | ARCHITECTURE §2.2 |
| **Queue** | Only a wake-up for workers; the database row is the truth. Three implementations: in-process, PostgreSQL `LISTEN/NOTIFY`, BullMQ over Redis. | ARCHITECTURE §2.4 |
| **Backoff with jitter** | Exponential delay with randomness between attempts, up to a budget; then the publication is `exhausted` and the announcement `failed`. | `publication-runner.ts` |
| **Domain event** | A fact written in the same transaction as the change (`announcement.submitted`, `announcement.published`, `agent.report.created`). | MODULES.md |
| **Outbox** | The `domain_events` and `event_deliveries` tables: one event, one delivery per interested consumer. | MODULES.md, `adapters/db/event-store.ts` |
| **Reactor** | The loop that claims due deliveries with a lease, calls the consumer, and retries or marks them `dead`. | `application/reactor.ts` |
| **Consumer** | Anything that reacts to a domain event (the notifier, an agent). Idempotent, at-least-once, registered not wired in. | MODULES.md |
| **Consumer set** | The consumers one process runs (`REACTOR_CONSUMERS`); on Azure one Container App per entry of `consumer_sets`. | `infra/azure/events.tf` |
| **Role (`ROLE`)** | What a process does: `api`, `worker`, `events` or `all`. One image for every role. | README, Configuration |
| **Agent** | A consumer with guardrails: advisory (no handle on the workflow), validated output, one report per event, bounded chaining (`MAX_AGENT_CHAIN`). | MODULES.md, spec FR-14 |
| **Dead delivery** | A delivery that used all its attempts; it waits for a person and raises an alert. | spec NFR-10 |

## Readers

| Term | Meaning | Read more |
|---|---|---|
| **Reader** | A member of the public: no account, sees published announcements only. | spec US-8.1, FR-15 |
| **Archive / feed** | The public, people-free, cacheable list of published announcements, and its Atom feed. | `http/public.ts`, `application/readers/feed.ts` |
| **Subscription** | A follow of a company, jurisdiction or category, by email or signed webhook. | `application/readers/subscriptions.ts` |
| **Double opt-in** | Nothing but the confirmation is sent until the owner of the address confirms. | spec FR-16 |
| **Notifier** | The consumer that tells followers once per announcement, in chunks (`NOTIFY_CHUNK`) with a per-reader ledger. | `application/readers/notifier.ts` |

## Architecture and quality vocabulary

| Term | Meaning | Read more |
|---|---|---|
| **Hexagonal / ports and adapters** | The core depends on interfaces (ports); databases, queues, gateways and AI are adapters behind them. An architecture test enforces it. | ARCHITECTURE §1 |
| **Modular monolith** | One codebase and one deployable with enforced internal boundaries. | ARCHITECTURE §1 |
| **Twin** | The Docker Compose setup, which mirrors the Azure design component for component. | README, "One architecture, three ways to run it" |
| **Demo mode / persona** | `DEMO=1`: seeded users chosen with a header, mock-newswire controls. Never with real sign-in. | README, Configuration |
| **ASR** | Architecturally significant requirement: a decision that shapes the architecture (ASR-1 to ASR-20). | discovery/handoff.md |
| **ADR** | Architecture decision record: context, decision, triggers to revisit. | [ADR 0001](adr/0001-database-bottleneck-and-service-bus.md) |
| **FR / NFR / BR** | Functional requirement, non-functional requirement, business rule (jurisdiction rule). | discovery/spec.md, REQUIREMENTS.md |
| **EARS** | The phrasing pattern of the requirements ("When..., the system shall..."). | spec.md |
| **L-n** | A ledger entry: an assumption, a confirmed fact or an open point. | discovery/ledger.md |
| **Verified / Measured / Designed** | Proven by a test or a run / a laptop number / written but not run. | REQUIREMENTS.md |
| **RPO / RTO** | How much data may be lost, and how long recovery may take, after a failure. | SIZING.md §1, DR.md |
| **Landing zone** | The governance base of a cloud tenant (management groups, policy, RBAC), separate from a workload. | `infra/azure-landing-zone` |

## Identity and cloud

| Term | Meaning | Read more |
|---|---|---|
| **OIDC / PKCE** | OpenID Connect sign-in; the browser uses Authorization Code with PKCE, the API verifies the signed bearer token. | README, Mode 2 |
| **Entra ID / Keycloak** | The identity provider on Azure / in Compose. Roles come from the token. | infra/azure/README.md |
| **Managed identity** | An Azure identity for a service, used instead of passwords (database, mail, registry). | infra/azure/README.md |
| **Container Apps** | The Azure runtime for api, worker and consumer sets. | [Azure diagram](diagrams/02-azure-architecture.drawio.png) |
| **Front Door / WAF** | The public edge on Azure: cache for public reads, managed web application firewall rules, Private Link to the origin. | `infra/azure/edge.tf` |
| **SSRF guard** | Refusing webhook targets that are private, loopback, link-local or metadata addresses, checked at connect time including literal IPs. | spec FR-17, `adapters/channels/url-guard.ts` |

## Regulatory vocabulary

| Term | Meaning (as modelled) |
|---|---|
| **RNS** | Regulatory News Service, a UK Regulatory Information Service run by LSEG. The UK channel here. |
| **RIS** | Regulatory Information Service: an FCA-approved distributor of regulated news. |
| **UK MAR** | UK Market Abuse Regulation. Art. 17: disclose inside information as soon as possible, a delay needs a recorded reason. Art. 19: PDMR transaction notifications. |
| **Inside information** | Non-public, price-sensitive information. Never held for the RNS window in this model. |
| **PDMR** | Person discharging managerial responsibilities. A dealing by one is published within 3 business days of the transaction (Art. 19(3)). |
| **Listing Rules / DTR** | FCA Listing Rules and Disclosure Guidance and Transparency Rules (for example the results deadlines). |
| **LEI / ISIN** | Legal Entity Identifier (mod-97 check) / International Securities Identification Number (Luhn check). |
| **EDGAR** | The SEC's filing system. The US channel here. EDGAR Next changed access; the CIK Confirmation Code may be legacy (open point). |
| **Form 8-K / Item** | The current report for domestic filers, due 4 business days after the event. Items modelled: 1.01, 1.05, 2.02, 5.02, 5.07, 7.01, 8.01. |
| **Form 6-K** | The report foreign private issuers file, promptly, with no fixed deadline. |
| **Filer status** | Domestic filer or foreign private issuer; gates 8-K against 6-K. |
| **Reg FD** | Regulation Fair Disclosure: selective disclosure must be made public (promptly if unintentional: later of 24 hours or the next NYSE open). |
| **Exhibit 99.1** | The attachment item 2.02 requires; modelled only as a required flag. |
| **CIK / CCC / accession number** | EDGAR identifiers: the company key, its confirmation code, and the number of an accepted filing. |
| **Furnished vs filed** | Items 2.02 and 7.01 are furnished rather than filed (not subject to certain liabilities); modelled as extra details and notes, not as a legal effect. |
| **TR-1, DTR 5** | Major-holdings notification. Not modelled. |
| **iXBRL** | Inline XBRL, structured financial data in a filing. Not modelled. |
