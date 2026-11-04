import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { EVENT, type DomainEvent } from '../domain/events.js';
import type { PolicyRegistry } from '../domain/policy.js';
import type { AiReportRecord, Clock, Consumer, Logger, PreCheckProvider, Store } from '../ports/index.js';
import { PreCheckReportSchema } from './precheck.js';
import type { EventBus } from './reactor.js';

/** Hard stop for agents that trigger agents: a chain deeper than this is a loop, not a workflow. */
export const MAX_AGENT_CHAIN = 5;

/** The only thing an agent may read about an announcement: a copy, never a handle on the store. */
export interface AgentView {
  announcementId: string;
  revision: number;
  jurisdiction: string;
  category: string;
  categories: string[];
  issuerName: string;
  headline: string;
  body: string;
  metadata: Record<string, unknown>;
}

export interface AgentContext {
  event: DomainEvent;
  view: AgentView;
  /** Reports other agents already wrote for this revision: how agents build on each other. */
  reports: AiReportRecord[];
}

/**
 * An advisory agent: reacts to events, reads a copy of the announcement, returns a report.
 * It cannot approve, block, publish or edit: the framework validates its output against `output`
 * and stores it beside the announcement, and nothing in the workflow reads it. A new agent is a
 * new object passed to the runtime; no other file changes.
 */
export interface AdvisoryAgent {
  readonly id: string;
  /** Shown beside the report: model or ruleset version. */
  readonly version: string;
  /** Event types that wake it, including `agent.report.created` to follow another agent. */
  readonly triggers: readonly string[];
  /** The agent's output is untrusted, whatever produced it: shape and vocabulary are enforced here. */
  readonly output: z.ZodType;
  run(ctx: AgentContext): Promise<unknown>;
  /** Vocabulary checks the schema cannot express (for example a category that exists). */
  accept?(output: unknown, ctx: AgentContext): boolean;
}

interface Deps {
  store: Store;
  events: EventBus;
  clock: Clock;
  log: Logger;
}

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; message?: string };
  return err.code === '23505' || (typeof err.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT')) || /UNIQUE constraint failed/i.test(err.message ?? '');
}

/** Wraps an agent as an event consumer with the guardrails that make it safe to add one. */
export function agentConsumer(agent: AdvisoryAgent, policies: PolicyRegistry, d: Deps): Consumer {
  return {
    id: `agent:${agent.id}`,
    handles: agent.triggers,
    async handle(event) {
      const depth = Number(event.payload.depth ?? 0);
      if (depth >= MAX_AGENT_CHAIN) return;
      if (event.type === EVENT.agentReport && event.payload.agent === agent.id) return;
      if (await d.store.read.aiReports.forEvent(agent.id, event.id)) return; // redelivered after success

      const a = await d.store.read.announcements.get(event.issuerId, event.aggregateId);
      const issuer = a && (await d.store.read.issuers.get(a.issuerId));
      const rev = a && (await d.store.read.revisions.get(a.id, Number(event.payload.revision ?? a.currentRevision)));
      if (!a || !issuer || !rev) return;
      const ctx: AgentContext = {
        event,
        view: {
          announcementId: a.id,
          revision: rev.number,
          jurisdiction: a.jurisdiction,
          category: a.category,
          categories: policies.get(a.jurisdiction).describe().categories.map((c) => c.key),
          issuerName: issuer.name,
          headline: rev.headline,
          body: rev.body,
          metadata: structuredClone(rev.metadata),
        },
        reports: await d.store.read.aiReports.forRevision(a.id, rev.number),
      };

      const raw = await agent.run(ctx); // a throw is a retry
      const parsed = agent.output.safeParse(raw);
      const at = d.clock.now().toISOString();
      if (!parsed.success || (agent.accept && !agent.accept(parsed.data, ctx))) {
        // Garbage in does not get better on retry: record that it was discarded and move on.
        d.log.warn({ agent: agent.id, announcementId: a.id }, 'agent output rejected');
        await d.store.tx((tx) =>
          tx.audit.append({ announcementId: a.id, issuerId: a.issuerId, type: 'agent_output_rejected', actorId: `agent:${agent.id}`, data: { revision: rev.number, eventId: event.id } }, at),
        );
        return;
      }

      const record: AiReportRecord = { id: randomUUID(), announcementId: a.id, revision: rev.number, provider: agent.version, report: parsed.data, at, agent: agent.id, eventId: event.id };
      try {
        await d.store.tx(async (tx) => {
          await tx.aiReports.insert(record);
          await tx.audit.append(
            { announcementId: a.id, issuerId: a.issuerId, type: 'agent_report', actorId: `agent:${agent.id}`, data: { agent: agent.id, version: agent.version, revision: rev.number, reportId: record.id } },
            at,
          );
          await d.events.emit(tx, { type: EVENT.agentReport, issuerId: a.issuerId, aggregateId: a.id, payload: { agent: agent.id, reportId: record.id, revision: rev.number, depth: depth + 1 } }, at);
        });
      } catch (err) {
        // Swallow only when the report really exists (another instance wrote it first); any other constraint failure is a retry.
        if (!isUniqueViolation(err) || !(await d.store.read.aiReports.forEvent(agent.id, event.id))) throw err;
      }
    },
  };
}

/** The pre-check as an agent: runs when an announcement is submitted, so reviewers find it ready. */
export function preCheckAgent(provider: PreCheckProvider): AdvisoryAgent {
  return {
    id: 'precheck',
    version: provider.name,
    triggers: [EVENT.submitted],
    output: PreCheckReportSchema,
    run: ({ view }) =>
      provider.analyze({
        jurisdiction: view.jurisdiction,
        category: view.category,
        categories: view.categories,
        issuerName: view.issuerName,
        headline: view.headline,
        body: view.body,
        metadata: view.metadata,
      }),
    accept: (out, { view }) => view.categories.includes((out as z.infer<typeof PreCheckReportSchema>).classification.suggestedCategory),
  };
}
