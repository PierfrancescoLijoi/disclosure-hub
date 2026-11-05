import type { Jurisdiction } from './api';

export type Tone = 'neutral' | 'brand' | 'warn' | 'ok' | 'info' | 'bad';
export interface StateView {
  label: string;
  tone: Tone;
  /** Shown beside the text, so state is never conveyed by colour alone. */
  icon: string;
}

/** Announcement state as the person sees it. "Published" always carries the demo qualifier. */
export function announcementState(a: { status: string; changesRequested?: boolean }): StateView {
  switch (a.status) {
    case 'draft':
      return a.changesRequested ? { label: 'Changes requested', tone: 'warn', icon: '✎' } : { label: 'Draft', tone: 'neutral', icon: '○' };
    case 'validated':
      return { label: 'Validated', tone: 'info', icon: '✓' };
    case 'in_review':
      return { label: 'In review', tone: 'brand', icon: '◐' };
    case 'approved':
      return { label: 'Approved', tone: 'ok', icon: '✓' };
    case 'publishing':
      return { label: 'Publishing', tone: 'info', icon: '↻' };
    case 'published':
      return { label: 'Published · Demo', tone: 'ok', icon: '✔' };
    case 'failed':
      return { label: 'Failed', tone: 'bad', icon: '!' };
    case 'withdrawn':
      return { label: 'Withdrawn', tone: 'neutral', icon: '–' };
    default:
      return { label: a.status, tone: 'neutral', icon: '•' };
  }
}

export function publicationState(status: string): StateView {
  switch (status) {
    case 'pending':
      return { label: 'Queued', tone: 'info', icon: '◔' };
    case 'in_flight':
      return { label: 'Processing', tone: 'info', icon: '↻' };
    case 'retry':
      return { label: 'Retrying', tone: 'warn', icon: '↺' };
    case 'acked':
      return { label: 'Published · Demo', tone: 'ok', icon: '✔' };
    case 'rejected':
      return { label: 'Rejected', tone: 'bad', icon: '!' };
    case 'exhausted':
      return { label: 'Failed', tone: 'bad', icon: '!' };
    default:
      return { label: status, tone: 'neutral', icon: '•' };
  }
}

export const ROLE_LABEL: Record<string, string> = {
  author: 'Editor',
  company_secretary: 'Company secretary',
  legal: 'Legal',
  cfo: 'CFO',
  publisher: 'Publisher',
};
export const roleLabel = (r: string) => ROLE_LABEL[r] ?? r.replaceAll('_', ' ');

export const APPROVER_ROLES = ['company_secretary', 'legal', 'cfo'];
export const isApprover = (roles: string[]) => roles.some((r) => APPROVER_ROLES.includes(r));
export const isAuthor = (roles: string[]) => roles.includes('author');
export const isPublisher = (roles: string[]) => roles.includes('publisher');

/** What a channel calls the act of sending comes from its policy; the rest of the UI is the same for every jurisdiction. */
export const channelLabel = (j: Pick<Jurisdiction, 'channel'>) => `${j.channel.name} · mock ${j.channel.sendNoun ?? 'distribution'}`;
export const platformBadge = (j: Pick<Jurisdiction, 'code' | 'channel'>) => `${j.code} · ${j.channel.id.toUpperCase()} mock`;

/** The next step for an announcement, in the words of the person who has to take it. */
export function nextAction(a: { status: string; changesRequested?: boolean }): string {
  switch (a.status) {
    case 'draft':
      return a.changesRequested ? 'Address the review comments' : 'Edit and validate';
    case 'validated':
      return 'Submit for review';
    case 'in_review':
      return 'Awaiting approval';
    case 'approved':
      return 'Ready to publish';
    case 'publishing':
      return 'Delivery in progress';
    case 'failed':
      return 'Check the provider and retry';
    case 'published':
      return 'Receipt on file';
    default:
      return '';
  }
}

const AUDIT_TEXT: Record<string, string> = {
  created: 'Created the draft',
  revision_saved: 'Saved a new revision',
  validated: 'Validated',
  submit_rejected: 'Submit stopped: validation found problems',
  submitted: 'Requested review',
  approved: 'Approved the revision',
  changes_requested: 'Requested changes',
  publish_requested: 'Requested publication',
  publish_retry_requested: 'Asked for a retry',
  publish_attempt_failed: 'Delivery attempt failed',
  publish_deferred: 'Delivery postponed (channel closed)',
  publish_failed: 'Publication failed',
  published: 'Mock provider accepted · Published · Demo',
  reopened: 'Reopened as draft',
  withdrawn: 'Withdrawn',
  precheck_completed: 'Ran the advisory pre-check',
};
export const auditText = (type: string) => AUDIT_TEXT[type] ?? type.replaceAll('_', ' ');

export const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}
