import { conflict } from './errors.js';
import type { Status } from './types.js';

interface Transition {
  from: readonly Status[];
  to: Status;
}

/**
 * The only place that says which status moves are legal. Jurisdictions never touch it:
 * they change what is checked at a step, not the steps themselves.
 */
export const TRANSITIONS = {
  edit: { from: ['draft', 'validated'], to: 'draft' },
  validation_passed: { from: ['draft', 'validated'], to: 'validated' },
  validation_failed: { from: ['draft', 'validated'], to: 'draft' },
  submit: { from: ['validated'], to: 'in_review' },
  approvals_complete: { from: ['in_review'], to: 'approved' },
  request_changes: { from: ['in_review'], to: 'draft' },
  publish: { from: ['approved'], to: 'publishing' },
  published: { from: ['publishing'], to: 'published' },
  publish_failed: { from: ['publishing'], to: 'failed' },
  retry: { from: ['failed'], to: 'publishing' },
  reopen: { from: ['approved', 'failed'], to: 'draft' },
  withdraw: { from: ['draft', 'validated', 'in_review', 'approved'], to: 'withdrawn' },
} as const satisfies Record<string, Transition>;

export type TransitionEvent = keyof typeof TRANSITIONS;

export const TERMINAL_STATUSES: readonly Status[] = ['published', 'withdrawn'];

export function nextStatus(from: Status, event: TransitionEvent): Status {
  const t: Transition = TRANSITIONS[event];
  if (!t.from.includes(from)) {
    throw conflict('INVALID_TRANSITION', `Cannot ${event.replaceAll('_', ' ')} while ${from}`, { from, event });
  }
  return t.to;
}

export function canTransition(from: Status, event: TransitionEvent): boolean {
  return (TRANSITIONS[event] as Transition).from.includes(from);
}
