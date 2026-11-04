# Discovery ledger

Domain: `fintech` (primary), `saas-b2b` + `ai-llm` (secondary). Client: Board Intelligence interview panel (homework).

| Id | Item | State | Impact | Owner / next step |
|---|---|---|---|---|
| L-1 | Domain = fintech primary, saas-b2b + ai-llm secondary | Confirmed (user) | Sets compliance/audit/idempotency lens | - |
| L-2 | Product = enterprise B2B IR + regulated-disclosure platform | Confirmed (user) | Multi-tenant (issuer = tenant) | - |
| L-3 | Jurisdictions = UK (RNS/UK MAR) + US (EDGAR/Form 8-K/Reg FD) | Confirmed (task) | Two policies + two gateways | - |
| L-4 | Stack = TypeScript end-to-end, Fastify + Zod REST, modular monolith | Confirmed (user) | No microservices, no Python | - |
| L-5 | Frontend = React (Vite SPA, not Next.js) | Assumed | `npm start` stays one process; UI only needs REST | Swap later if SSR needed |
| L-6 | Two run modes: local (SQLite + in-process queue) and Compose (Postgres + Redis/BullMQ + api + worker + web) | Confirmed (user) | Only infra adapters differ | - |
| L-7 | Workflow Draft -> Validate -> Review -> Approve -> Publish -> Published, with revisions, retries, idempotency, audit | Confirmed (user) | Core state machine | - |
| L-8 | AI pre-check: advisory only, mock deterministic default, optional LLM, system fully works with AI off | Confirmed (user) | Port + report table, never a guard | Cut first if time is short |
| L-9 | Priority order if time-boxed: AI first, then accessories; never e2e workflow, test quality, publish reliability | Confirmed (user) | Build order | - |
| L-10 | Regulatory rules are simplified models, not legal advice; windows/holidays configurable | Assumed | Credibility with domain experts | Validate with compliance SME |
| L-11 | Auth = OIDC bearer tokens (Entra ID, Keycloak); the persona picker exists only in demo mode | Superseded (was: personas only) | Maker-checker enforced server-side in both | SCIM provisioning and per-role step-up for publish remain open |
| L-12 | Newswires/filing systems are mocks that behave like real ones (ack, suspense, dedupe key, outages) | Assumed | Reliability code is real, gateway is fake | Real: vendor APIs |
| L-13 | Scale shape = spiky (earnings season, 07:00 UK / 16:05 ET clusters), low steady rate; external gateway limits are the ceiling | Assumed | Per-gateway concurrency cap, DB as source of truth | Validate with real volumes |
| L-14 | Out of scope: scheduling/embargo timers, attachments, iXBRL, translations, billing (real OIDC is now built) | Assumed | Listed in write-up as cuts | - |
| L-15 | Which third jurisdiction would the business want first (EU/Nasdaq Copenhagen likely)? | Open-nonblocking | Roadmap only | Ask panel (questions.md) |
| L-16 | Scale = one listed group or a small IR agency, not a market operator (replaces the 5,000-issuer figure) | Assumed | Sizing, cost, Azure SKUs | Validate with real volumes (docs/SIZING.md) |
| L-17 | Azure deployment is written and validated offline, never applied; Compose is the local twin | Confirmed (user) | "Verified" vs "designed" split in README and ARCHITECTURE | First deploy to a test subscription |
| L-18 | UI follows the SignalFlow IR product spec at P0, adapted to this backend; product name is Disclosure Hub | Confirmed (user) | No admin role, no Company Pulse; deviations in docs/UI.md | P1/P2 later |
| L-19 | PDMR clock starts at the transaction (MAR Art. 19(3)); earlier drafts used the notification date | Corrected 03/11 | Deadline and warning rules, BR-2 | - |
| L-20 | 8-K deadline depends on the items: 7.01/8.01 voluntary (none), 1.05 from materiality determination, others from the event | Corrected 03/11 | Deadline logic, a required field for 1.05, BR-4 | Add further items on demand |
| L-21 | Filer status (domestic or foreign private issuer) is part of the US issuer profile and gates 8-K vs 6-K | Added 03/11 | Profile schema, new 6-K category, BR-9 | Confirm with a securities lawyer |
| L-22 | Inside information is released even when the channel window is closed; routine categories are held | Added 03/11 | Runner window logic, BR-10 | Confirm the RIS out-of-hours procedure |
| L-23 | Real RIS/EDGAR have no idempotency-key lookup; the mock models one | Known limit | Reconciliation design must change against a real provider | Needs vendor access |
| L-24 | EDGAR Next credential model and per-form cut-offs | Open, to verify | Issuer profile fields (CCC may be legacy) | Check current SEC guidance before a real filing |
| L-25 | Not modelled: scheduled release, corrections after publication, dual-listing links, insider lists, closed periods, 20,000 euro threshold, TR-1, 10-Q/10-K | Known limits | See the end of spec.md | Roadmap |
| L-26 | Readers are the public: an archive and follow-by-email or webhook are in scope; investors need no account | Added 03/11 (user: expand the reader side) | FR-15 to FR-17, ASR-19 | Preference centre, digests, Slack |
| L-27 | Future agents and consumers must be addable without changing the workflow; cloud mirrors the local split | Added 03/11 (user) | Outbox and consumer sets, ASR-16 to ASR-18 | Agents that act; a broker at scale |
| L-28 | Azure mail through Communication Services with an Azure-managed domain; built-in role is broader than send; endpoint format, hop counts and cache behaviour unproven | Designed, not applied | infra/azure/README.md items 9 to 15 | First deploy |
