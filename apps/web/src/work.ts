import type { Item, User } from './api';
import { isApprover, isAuthor, isPublisher } from './labels';

/**
 * What this person is expected to do next with an announcement, from the list row alone, or null.
 * It is a pointer for the queue; the detail page asks the server which actions are really allowed.
 */
export function attention(i: Pick<Item, 'status' | 'changesRequested' | 'createdBy'>, me: Pick<User, 'id' | 'roles'>): string | null {
  switch (i.status) {
    case 'draft':
      return isAuthor(me.roles) ? (i.changesRequested ? 'Address the review comments' : 'Finish and validate') : null;
    case 'validated':
      return isAuthor(me.roles) ? 'Submit for review' : null;
    case 'in_review':
      return isApprover(me.roles) && i.createdBy !== me.id ? 'Review and decide' : null;
    case 'approved':
      return isPublisher(me.roles) ? 'Publish' : null;
    case 'failed':
      return isPublisher(me.roles) ? 'Check the provider, then retry' : null;
    default:
      return null;
  }
}

export const PIPELINE = ['draft', 'validated', 'in_review', 'approved', 'publishing', 'published'] as const;

export function countBy<T>(rows: T[], key: (r: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[key(r)] = (out[key(r)] ?? 0) + 1;
  return out;
}

/** Fields the composer needs before Validate can pass, from the category's JSON Schema. */
export function missingRequired(schema: { required?: string[]; properties?: Record<string, { title?: string; type?: string; properties?: any; required?: string[] }> } | undefined, value: Record<string, any>, prefix = ''): string[] {
  if (!schema) return [];
  const out: string[] = [];
  for (const key of schema.required ?? []) {
    const child = schema.properties?.[key];
    const label = `${prefix}${child?.title ?? key}`;
    const v = value?.[key];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) out.push(label);
    else if (child?.type === 'object') out.push(...missingRequired(child as any, v, `${label} → `));
  }
  return out;
}
