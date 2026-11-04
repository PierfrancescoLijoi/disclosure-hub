/**
 * Domain events: facts the workflow has committed. They are the one extension seam: a new
 * capability (reader notifications, an AI agent, an export) is a consumer of events, never a
 * change to the workflow. Types are open strings so a module can add its own.
 */
export const EVENT = {
  submitted: 'announcement.submitted',
  published: 'announcement.published',
  agentReport: 'agent.report.created',
  /** The notifier asking itself to carry on with the next chunk of followers. */
  notifyContinue: 'reader.notify.continue',
} as const;

export interface DomainEvent {
  id: string;
  type: string;
  /** Owning company; consumers that touch tenant data filter on it. */
  issuerId: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  at: string;
}

export type NewEvent = Omit<DomainEvent, 'id' | 'at'>;
