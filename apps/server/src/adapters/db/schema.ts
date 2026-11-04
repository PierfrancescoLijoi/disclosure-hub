/**
 * Table shapes shared by SQLite and PostgreSQL. Portable on purpose: text ids, ISO-8601 UTC
 * text timestamps (they sort correctly as strings), JSON as text, no booleans.
 */
export interface DB {
  users: { id: string; issuer_id: string; name: string; roles: string };
  issuers: { id: string; name: string; profiles: string };
  announcements: {
    id: string;
    issuer_id: string;
    jurisdiction: string;
    category: string;
    status: string;
    current_revision: number;
    version: number;
    created_by: string;
    created_at: string;
    updated_at: string;
    idempotency_key: string | null;
    approval_requirement: string | null;
    failure_reason: string | null;
  };
  revisions: {
    announcement_id: string;
    number: number;
    headline: string;
    body: string;
    metadata: string;
    content_hash: string;
    author_id: string;
    created_at: string;
  };
  validations: { announcement_id: string; revision: number; ok: number; issues: string; at: string };
  approvals: {
    id: string;
    announcement_id: string;
    revision: number;
    content_hash: string;
    approver_id: string;
    roles: string;
    decision: string;
    comment: string;
    at: string;
    voided_at: string | null;
  };
  publications: {
    id: string;
    announcement_id: string;
    issuer_id: string;
    revision: number;
    idempotency_key: string;
    status: string;
    attempts: number;
    max_attempts: number;
    next_attempt_at: string;
    lease_until: string | null;
    lease_token: string | null;
    last_error: string | null;
    external_ref: string | null;
    ack: string | null;
    created_at: string;
    updated_at: string;
  };
  audit_events: {
    id: string;
    announcement_id: string;
    issuer_id: string;
    seq: number;
    type: string;
    actor_id: string;
    at: string;
    data: string;
    prev_hash: string;
    hash: string;
  };
  ai_reports: {
    id: string;
    announcement_id: string;
    revision: number;
    provider: string;
    report: string;
    at: string;
    /** Which agent wrote it; 'precheck' for rows made by the on-demand button. */
    agent: string;
    /** The event that triggered the agent: makes a redelivered event write one report. */
    event_id: string | null;
  };
  domain_events: { id: string; type: string; issuer_id: string; aggregate_id: string; payload: string; created_at: string };
  event_deliveries: {
    id: string;
    event_id: string;
    consumer: string;
    status: string;
    attempts: number;
    next_attempt_at: string;
    lease_until: string | null;
    lease_token: string | null;
    last_error: string | null;
    updated_at: string;
  };
  subscriptions: {
    id: string;
    kind: string;
    target: string;
    issuer_id: string | null;
    jurisdiction: string | null;
    category: string | null;
    status: string;
    created_at: string;
    confirmed_at: string | null;
  };
  notifications: { subscription_id: string; announcement_id: string; status: string; attempts: number; last_error: string | null; at: string };
  settings: { key: string; value: string };
  /** The mock newswires' own books: what each "external system" has accepted. */
  ext_receipts: {
    channel: string;
    seq: number;
    idempotency_key: string;
    external_ref: string;
    accepted_at: string;
    filing_date: string | null;
    detail: string;
  };
}
