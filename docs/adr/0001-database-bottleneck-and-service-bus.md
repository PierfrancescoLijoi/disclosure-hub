# ADR 0001: the database is queue, outbox, search and subscriptions, and when that stops being enough

Status: accepted, 2026-11-04. Revisit when a trigger below fires.

## Context

One PostgreSQL server holds the announcements, the publication queue (`LISTEN/NOTIFY`), the domain-event outbox,
the reader subscriptions, and the archive search. That is a deliberate simplicity choice: one transaction writes an
announcement and its event, there is one thing to back up, fail over and secure, and nothing needs a second system's
consistency story. The cost is that every one of those loads shares one server's CPU, connections and I/O.

An Azure architect's first question is "when do you move the queue to Service Bus?". The answer has to be a number,
not a feeling, so this records the loads, what was measured, what was done, and the triggers.

## What was measured (local PostgreSQL 16, 1 vCPU / 1 GiB, `npm run bench:readers`; not Azure)

| Load | Result | Reading |
|---|---|---|
| Outbox claim and complete, one process | about 110 deliveries a second | Each claim is a round trip. The expected load is hundreds of events a day. Headroom is about four orders of magnitude |
| Outbox, four claimers | about 180 a second | Parallel consumers help, with diminishing returns: they share the same table |
| Reader fan-out, 20 ms per send, 10 at a time | about 275 followers a second (ceiling 500) | 10,000 followers take about 40 seconds, 100,000 about 6 minutes. The send rate of one consumer process is the limit, not the database |
| Archive listing, 100,000 published announcements | 506 ms before the index, 2 ms after (migration 004) | Found by measuring; fixed |
| Archive search by word, 10,000 / 100,000 announcements | 70-140 ms / 0.9-2 s | A scan of every body. Fine at the sized load; the cache absorbs repeated queries, the word cap bounds the amplification |

## Decision

Keep the database as the single store, and put a ceiling and an exit on each load instead of building a broker now.

1. **Outbox growth**: delivered events are deleted after `OUTBOX_RETENTION_DAYS` (14) by the events processes, in
   batches; dead and waiting deliveries are kept for a person.
2. **Fan-out**: a notification delivery handles at most `NOTIFY_CHUNK` (1000) followers and then writes a continuation
   event with the last id it reached. A delivery stays inside its lease however large the audience, and a crash
   resumes from the per-reader ledger, so nobody is told twice or left out.
3. **Public reads**: `READ_DATABASE_URL` sends the archive, the feed and search to a read replica
   (`read_replica = true`). Those reads are cached at the edge for 30 to 60 seconds, so replica lag of seconds is
   invisible and the primary keeps its capacity for writes.
4. **Archive order**: the partial index of migration 004.
5. **Signals**: CPU above 60 % for six hours (severity 3, early warning), above 80 % for 15 minutes (existing),
   connections above 70 % of the replica ceiling's need (existing), outbox lag above five minutes, dead deliveries,
   replica lag above five minutes when a second region exists.

## Triggers to move the event queue to Service Bus

Move when any of these holds after the cheaper steps (SKU, read replica, pruning) have been tried:

- sustained event rate above about 100 a second, or the outbox claim query shows up in the slow-statement log;
- a consumer outside this system (another company's service) needs the events, so they must leave the database;
- fan-out audiences above about 100,000 followers per announcement, where one consumer's send rate stops being
  acceptable and the audience has to be split over several queue consumers;
- publication workers above the documented ceiling of six (every worker listens to every notification).

The move is an adapter and an outbox relay, not a rewrite: consumers sit behind the `Consumer` port and read the same
`DomainEvent`; the relay copies committed outbox rows to a topic, and the Container Apps consumer sets scale on queue
length (KEDA `azure-servicebus` scaler) instead of polling. The transactional write stays in the database, so the
guarantee that an event exists if and only if its state change committed is kept.

## Triggers to move search out of the database

Search p95 above 500 ms at the origin (`MODE=origin` in `infra/azure/loadtest/public-read.mjs`), or above about 50,000
published announcements. First step: a `pg_trgm` index on the lowercased headline and body (a PostgreSQL-only migration,
the extension allow-listed in `azure.extensions`); then Azure AI Search fed from the same outbox.

## Consequences

- The platform is honest about one shared server: a runaway consumer or an expensive search can still slow publishing.
  Consumer sets are separate processes with their own scaling, which limits the compute side of that, not the
  database side. The alerts above are what tell a person in time.
- No broker to patch, pay for or learn at today's size.
- Measurements are local until `infra/azure/loadtest` and the smoke test have run against `test`; `docs/SIZING.md`
  has a table to fill in with the real figures.
