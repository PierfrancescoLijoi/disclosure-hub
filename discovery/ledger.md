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
| L-11 | Auth = seeded personas + role headers (no OIDC) | Assumed | Maker-checker still enforced server-side | Real: OIDC + SCIM |
| L-12 | Newswires/filing systems are mocks that behave like real ones (ack, suspense, dedupe key, outages) | Assumed | Reliability code is real, gateway is fake | Real: vendor APIs |
| L-13 | Scale shape = spiky (earnings season, 07:00 UK / 16:05 ET clusters), low steady rate; external gateway limits are the ceiling | Assumed | Per-gateway concurrency cap, DB as source of truth | Validate with real volumes |
| L-14 | Out of scope: scheduling/embargo timers, attachments, iXBRL, translations, real OIDC, billing | Assumed | Listed in write-up as cuts | - |
| L-15 | Which third jurisdiction would the business want first (EU/Nasdaq Copenhagen likely)? | Open-nonblocking | Roadmap only | Ask panel (questions.md) |
