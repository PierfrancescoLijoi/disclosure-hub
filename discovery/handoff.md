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

## MVP slice
Both jurisdictions end to end with tests, then UI, then Compose, then AI. Cut order: AI, UI polish, extra categories.

## Risks and assumptions
Rules are simplified (L-10). Compose path is only as verified as the Docker daemon allowed on the build machine (see README). Mock gateways are in-process models of vendor behaviour, not vendor contracts.

## Next move
Build per `docs/ARCHITECTURE.md` in the repo.
