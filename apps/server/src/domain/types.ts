export type JurisdictionCode = string;

export const STATUSES = [
  'draft',
  'validated',
  'in_review',
  'approved',
  'publishing',
  'published',
  'failed',
  'withdrawn',
] as const;
export type Status = (typeof STATUSES)[number];

export type Role = 'author' | 'company_secretary' | 'legal' | 'cfo' | 'publisher';

export interface Actor {
  id: string;
  name: string;
  issuerId: string;
  roles: Role[];
}

/** Identifiers per jurisdiction, e.g. { UK: { tidm, lei }, US: { cik, ccc, ticker } }. */
export interface Issuer {
  id: string;
  name: string;
  profiles: Record<JurisdictionCode, Record<string, string>>;
}

export interface Announcement {
  id: string;
  issuerId: string;
  jurisdiction: JurisdictionCode;
  category: string;
  status: Status;
  currentRevision: number;
  /** Optimistic-lock counter, bumped by every mutation. */
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  approvalRequirement: ApprovalRequirement | null;
  failureReason: string | null;
}

export interface Revision {
  announcementId: string;
  number: number;
  headline: string;
  body: string;
  metadata: Record<string, unknown>;
  contentHash: string;
  authorId: string;
  createdAt: string;
}

export type Severity = 'error' | 'warning';
export interface Issue {
  code: string;
  severity: Severity;
  message: string;
  path?: string;
}

export interface ValidationReport {
  announcementId: string;
  revision: number;
  ok: boolean;
  issues: Issue[];
  at: string;
}

export interface ApprovalRequirement {
  /** Distinct approvers needed. */
  min: number;
  /** Roles that must each be held by a distinct approver. */
  mustInclude: Role[];
}

export interface Approval {
  id: string;
  announcementId: string;
  revision: number;
  contentHash: string;
  approverId: string;
  roles: Role[];
  decision: 'approve' | 'request_changes';
  comment: string;
  at: string;
  voidedAt: string | null;
}

export type PublicationStatus = 'pending' | 'in_flight' | 'retry' | 'acked' | 'rejected' | 'exhausted';

export interface Publication {
  id: string;
  announcementId: string;
  issuerId: string;
  revision: number;
  idempotencyKey: string;
  status: PublicationStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  leaseUntil: string | null;
  leaseToken: string | null;
  lastError: string | null;
  externalRef: string | null;
  ack: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEvent {
  id: string;
  announcementId: string;
  issuerId: string;
  seq: number;
  type: string;
  actorId: string;
  at: string;
  data: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

/** What a jurisdiction policy hands to a gateway: channel-neutral, fully rendered. */
export interface DistributionPayload {
  channel: string;
  headline: string;
  content: string;
  attributes: Record<string, string | string[]>;
  attachments: { type: string; name: string; content: string }[];
}
