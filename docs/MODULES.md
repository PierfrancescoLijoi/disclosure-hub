# Modules and extension points

How to add to the platform without touching what already works, and why the seams are where they are.
The reader side (feeds, subscriptions, notifications) and the agents were built on these seams, so they are
also the worked example.

## The one seam: domain events through an outbox

Everything that happens *because* of a workflow step, and is not part of it, is a **consumer** of a **domain
event**. The workflow never calls a consumer; it writes an event in the same transaction as the change:

| Event | Written when | In the same transaction as |
|---|---|---|
| `announcement.submitted` | a revision is submitted for review | the status change |
| `announcement.published` | the newswire acknowledged | the publication ack |
| `agent.report.created` | an agent stored a report | the report row |

Writing an event inserts one row in `domain_events` and one row per interested consumer in `event_deliveries`
(`pending`, `in_flight`, `done`, `dead`). Which consumers are interested is decided at write time from the
registry (`ConsumerRegistry.idsFor(type)`). The **reactor** claims due deliveries with a lease
(compare-and-set, like publications), calls `consumer.handle(event)`, and completes or backs off with jitter.
After `REACTOR_MAX_ATTEMPTS` a delivery is `dead` and waits for a person.

What this buys, and what it costs:

- **No lost work.** A crash between "published" and "readers told" cannot happen: both rows commit or neither does. A crash after the claim only costs a lease timeout.
- **At-least-once.** A consumer can see an event twice (lease expiry while it was still working). Every consumer must be idempotent; the notifier keeps a per-reader ledger (`notifications`), agents a unique `(agent, event)` report.
- **Isolation.** A failing or slow consumer retries on its own row. It never blocks publishing or another consumer, and the workflow does not know it exists.
- **One database, no broker.** Fine for hundreds of events a minute. Past that, or for a consumer outside this system, swap the outbox relay for Service Bus or similar; consumers stay as they are (they only see `handle(event)`).
- **A batch runs in parallel, each handler under the batch's lease.** The timeout (half the lease) aborts the handler's `signal`; a looping consumer (the notifier) checks it and stops, so the retry never runs beside it. A delivery that keeps outliving its lease (a handler that kills the process) is parked as `dead` once its attempts pass the limit.
- **Ordering is per delivery, not global.** A consumer that needs order reads the aggregate's current state, not the event payload alone (the notifier reads the published item).

Processes choose their consumers: every process builds the full registry (so write-time routing is complete), and
`REACTOR_CONSUMERS` limits which ones *this* process runs. `ROLE=events` is a process that only runs the reactor.
Locally that is the `notifier` and `agents` services in `docker-compose.yml`; on Azure it is one Container App per
entry of `consumer_sets` in `infra/azure`.

## Add a consumer

```ts
// apps/server/src/application/<name>.ts
export function auditExportConsumer(deps: { store: Store; log: Logger }): Consumer {
  return {
    id: 'audit-export',
    handles: [EVENT.published],
    async handle(event) {
      // read what you need from the store by event.aggregateId; be idempotent; throw to retry
    },
  };
}
```

Register it in `runtime.ts` (`consumers.register(...)`), or pass it as `createRuntime({ consumers: [...] })` in a
test. Give it its own process by adding it to `REACTOR_CONSUMERS` of a new Compose service and a new entry in
`consumer_sets`. No migration, no change to the workflow. The tests to copy are in `test/events.test.ts`
(delivery once, retry, dead, lease takeover, consumer filter).

## Add an agent (multi-agent architectures)

An **agent** is a consumer with guardrails. It implements `AdvisoryAgent` (`application/agents.ts`): it declares
the events it reacts to and returns a validated report; `agentConsumer` wraps it.

What the wrapper enforces, so an agent author cannot get it wrong:

- **Advisory only.** An agent reads a copy of the announcement (`AgentView`) and writes to `ai_reports`. It has no handle on the workflow: it cannot approve, edit, submit or publish. Human approval stays the only way forward.
- **Validated output.** The report is parsed with its schema (and checked against the policy's vocabulary) before storage; invalid output is dropped and logged, never stored.
- **Once per event.** Unique `(agent, event_id)`: a redelivery cannot store a second report.
- **A failing agent fails alone.** Its delivery retries; publishing and other agents are unaffected (test: `failing agent doesn't block workflow`).
- **Chaining with a bound.** An agent may react to `agent.report.created`, so one agent can feed another (a classifier, then a redactor, then a risk reviewer). Each hop carries `depth`; past `MAX_AGENT_CHAIN` (5) the wrapper refuses, so two agents that trigger each other cannot loop (test: ping-pong is bounded).
- **Cost control.** Agents run on their own only if listed in `AGENTS`. With a real provider the default is none, because every submit would cost money; the on-demand pre-check endpoint still works.

To add one: implement `AdvisoryAgent`, register `agentConsumer(agent, policies, deps)` (or pass it in `createRuntime({ agents })`),
add `agent:<id>` to a consumer set. Deploying a new agent changes no existing process.

What is deliberately not there yet: agents that *act* (propose edits for the author to accept, draft the first
version), shared memory between agents, tool use. The seam supports them (an agent could write a *proposed
revision* that a human accepts), but each needs its own guardrail and its own decision record.

## Add a notification channel

A channel implements `NotificationChannel` (`ports/readers.ts`): `kind`, and `send(message)` that throws
`ChannelError('transient' | 'permanent', ...)`. Transient means retry the event; permanent means record the
failure for that reader and carry on. Built-in: email (log, SMTP, Azure Communication Services) and webhook
(HMAC-signed, https only, SSRF-guarded). Register in `runtime.ts` by configuration; the subscription form offers
what `GET /api/public/options` reports.

Hard rules for any channel that calls out to an address a stranger typed:

- **Prove control first.** Nothing is sent until the owner confirms (double opt-in); the confirmation message is the only thing sent to an unconfirmed address.
- **Say the same thing every time.** The form answers 202 whether or not the address was known, over its limit, or invalid-looking, so it cannot be used to find out who is subscribed.
- **Always a way out.** Every message carries a one-click unsubscribe (RFC 8058 `List-Unsubscribe` + `List-Unsubscribe-Post`), and leaving erases the address.
- **Give the receiver its key.** The signing secret is in the confirmation request body (`signingSecret`), the one message the endpoint is sure to get; without it nobody could verify `x-hub-signature`.
- **Say nothing about why.** A failed confirmation answers one generic message; the reason (an internal name that resolves, a status code) goes to the log, because the route is anonymous and would otherwise be an oracle.
- **Bare addresses only.** `Name <a@b>` or `a@b, c@d` would pass a loose pattern and reach other recipients, and a varied prefix would dodge the per-address cap.
- **Never call internal addresses.** Webhooks resolve DNS at connect time and refuse loopback, private, link-local and metadata ranges, including literal IPs (Node does not run the lookup for those, which a test caught). Redirects are not followed.
- **Bounded.** Idle and total (15 s) timeouts, capped response size, 10 subscriptions per address (unconfirmed ones count only for the 48 h their link works, then they are purged, so nobody can fill an address's quota for good), 5 form posts per hour per client, at most 5 search words.

## Add a jurisdiction

Unchanged and independent of the above: a policy (declarative categories and rules) plus a gateway adapter. See
ARCHITECTURE.md §2.1 and [BRIEF-RESPONSE.md](BRIEF-RESPONSE.md#3-without-duplicating-effort-extending-to-more-jurisdictions).

1. Write the policy in `apps/server/src/jurisdictions/<code>.ts` with `definePolicy` (copy `dk.ts`; where the law is the same as another regime's, build on the shared rules in `mar.ts`).
2. Write a gateway implementing `PublishGateway` (`find`, `submit`; `GatewayError` `transient` or `permanent`).
3. Register the policy in `jurisdictions/index.ts` and the gateway in `runtime.ts` (`GatewayRegistry`).
4. Give each issuer the profile the policy asks for (`SEED_ISSUERS_JSON` or the seed).

A new jurisdiction automatically appears in the composer menus, the detail form, the archive and activity filters, the
publishing console and the follow form: they read the registered policies from the server. Optional, cosmetic:
sample text for the "Fill with example content" button in `apps/web/src/examples.ts`, and the word "filing" for a new
channel in `apps/web/src/labels.ts` (`SEND_NOUN`). Proof that no workflow file changes: `operations.test.ts`, "adding a
jurisdiction" (Denmark as the only registered one).

## Where things live

| Concern | Files |
|---|---|
| Event types | `domain/events.ts` |
| Consumer, store and bus contracts | `ports/events.ts`, `ports/readers.ts` |
| Outbox storage | `adapters/db/event-store.ts` (claim, complete, fail), migration `003_events_and_readers` |
| Emit and drain | `application/reactor.ts` (`EventBus`, `Reactor`) |
| Agents | `application/agents.ts` |
| Readers | `application/readers/` (subscriptions, tokens, notifier, feed, webhook URL parsing), `adapters/channels/`, `http/public.ts` |
| Wiring | `runtime.ts`; configuration in `config.ts` |
| Cloud | `infra/azure/events.tf` (consumer sets), `readers.tf` (mail), `edge.tf` (cache and WAF) |

The architecture test still applies: `application` never imports an adapter, so a channel or store can be swapped
without the application noticing.

## Decisions

1. **Outbox, not an in-process event emitter.** An emitter loses events on a crash between commit and handler; the outbox cannot, and it gives retry, back-off, a dead state and a metric for free. Cost: a poll (1 s default) instead of instant delivery, and a table that must be pruned eventually.
2. **Deliveries are created at write time, one per consumer.** A consumer added later does not see old events (no accidental replay of a year of announcements to a new notifier); a removed consumer's pending rows are simply never claimed.
3. **Consumers by process, not by code path.** The same image runs every role; `REACTOR_CONSUMERS` and `ROLE=events` choose. A new consumer can start in the same process in dev and move to its own app in production without a code change.
4. **Agents advisory by construction.** Not a convention: the agent's context has no workflow methods. The risk of an agent is wrong advice, never a wrong state.
5. **Readers read through the same query path as everyone.** Public routes use the tenant-agnostic published view (`published` status only), return no people, approvals or unpublished text, and are cacheable. Search runs over headline, body and company with every word required.
6. **Tokens are derived, not stored.** Confirmation, unsubscribe and webhook-signing secrets are HMACs of the subscription id from one key (`READER_TOKEN_KEY`), so there is nothing per reader to leak and unsubscribe links never expire. Cost: rotating the key breaks links already sent.
7. **Mail through the cloud's identity, SMTP only locally.** Azure sends with the managed identity, so no SMTP password exists. The built-in role is broader than sending (documented limitation, tightening listed in `infra/azure/README.md`).
8. **Edge caching is the API's decision.** Public reads say `Cache-Control: public, max-age=30` (feed 60); nginx locally and Front Door in Azure just honour it. POSTs are never cached.
