# Handoff: architecture-driving decisions, MVP slice, risks

## ASR list
| Id | Decision | Requirements | Options left open |
|---|---|---|---|
| ASR-1 | Modular monolith, hexagonal: pure `domain`, `ports`, `adapters`; one image, role `api|worker|all` | G4, NFR-8 | Split worker into its own service when needed |
| ASR-2 | A jurisdiction = a policy (declarative categories + rules) + a gateway adapter, registered in a registry | G1, FR-3 | Policies from DB/config for non-engineers |
| ASR-3 | DB row is the source of truth for publication; queue only wakes workers; claim by compare-and-set lease; sweeper recovers | NFR-4, FR-8 | Transactional outbox + CDC at larger scale |
| ASR-4 | Idempotency key = announcement:revision; `find` at the gateway before resubmit | FR-7, NFR-5 | Vendor-native idempotency headers |
| ASR-5 | Immutable revisions with content hash; approvals bound to hash | FR-2, FR-6, BR-8 | - |
| ASR-6 | Audit events hash-chained per announcement (not global, to avoid a serialisation point) | FR-9, NFR-6 | Anchor chain heads to external WORM storage |
| ASR-7 | Tenant filter (`issuer_id`) inside every query; composite keys | FR-10 | Postgres RLS, schema per large tenant |
| ASR-8 | AI behind a port, advisory report stored apart, never a guard | FR-11 | Evals gate before enabling real LLM |
| ASR-9 | Kysely over SQLite/Postgres, same migrations, ISO-text timestamps, JSON as text | G4 | JSONB on Postgres for querying |
| ASR-10 | OIDC bearer tokens verified against a JWKS; roles and company from claims; persona picker only when DEMO is on | L-11 | Per-role step-up, SCIM |
| ASR-11 | Queue behind a port: in-process, PostgreSQL LISTEN/NOTIFY, BullMQ; the DB row stays the truth | ASR-3 | Transactional outbox |
| ASR-12 | A category declares whether a closed channel window holds it (inside information does not) | BR-10 | Per-channel out-of-hours procedures |
| ASR-13 | Deadlines are computed from category metadata, may be absent (voluntary items) or per item (Item 1.05) | BR-2, BR-4 | Obligation tracking beyond one deadline |
| ASR-14 | Issuer profile per jurisdiction carries the identifiers and the status the form depends on (US filer status) | BR-9 | Profiles from an admin UI |
| ASR-15 | Azure Terraform twin of the Compose stack, validated offline, never applied | L-17 | First deploy checklist in infra/azure/README.md |
| ASR-16 | Domain events through a transactional outbox: one row per event, one delivery per interested consumer, lease-based claim, at-least-once, dead state | FR-12, NFR-10 | Message broker (Service Bus) behind the same consumer port |
| ASR-17 | Consumers selected per process (`ROLE=events`, `REACTOR_CONSUMERS`); one Container App per consumer set in Azure | FR-13 | Autoscale on outbox lag (needs a metric scaler that works with managed identity) |
| ASR-18 | Agents are guarded consumers: advisory, validated, once per event, bounded chaining, failure isolated | FR-14 | Agents that propose edits for a human to accept |
| ASR-19 | Public reads are a separate, cacheable, people-free view; subscriptions use derived tokens, double opt-in, one-click exit, erased on leaving, SSRF-guarded webhooks | FR-15, FR-16, FR-17, NFR-9 | Customer mail domain, preference centre, digest mode |
| ASR-20 | Mail through the cloud identity (Azure Communication Services, managed identity), SMTP only locally; edge cache and WAF rule at Front Door | NFR-9 | WAF managed rules (Premium), private origin |

## MVP slice
Both jurisdictions end to end with tests, then UI, then Compose, then AI. Cut order: AI, UI polish, extra categories.

## Risks and assumptions
Rules are simplified (L-10) and corrected where a domain review found errors (L-19 to L-22); the remaining known limits are in L-23 to L-25 and at the end of spec.md. Compose is verified on Docker; Azure is not (L-17). Mock gateways are in-process models of vendor behaviour, not vendor contracts, and the idempotency lookup they offer may not exist at a real provider (L-23).

## Next move
Build per `docs/ARCHITECTURE.md` in the repo.
