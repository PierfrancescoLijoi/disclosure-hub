import { forbidden } from './errors.js';
import { canTransition, type TransitionEvent } from './state-machine.js';
import type { Actor, ApprovalRequirement, Approval, Role, Status } from './types.js';

export const APPROVER_ROLES: readonly Role[] = ['company_secretary', 'legal', 'cfo'];

export type Capability = 'author' | 'approver' | 'publisher';

export function hasCapability(actor: Actor, capability: Capability): boolean {
  if (capability === 'author') return actor.roles.includes('author');
  if (capability === 'publisher') return actor.roles.includes('publisher');
  return actor.roles.some((r) => APPROVER_ROLES.includes(r));
}

export function assertCapability(actor: Actor, ...anyOf: Capability[]): void {
  if (!anyOf.some((c) => hasCapability(actor, c))) {
    throw forbidden('MISSING_ROLE', `${actor.name} needs one of: ${anyOf.join(', ')}`);
  }
}

/**
 * Each mustInclude role needs a distinct approver, and the total number of distinct
 * approvers must reach min. Small enough for brute-force assignment.
 */
export function requirementSatisfied(req: ApprovalRequirement, approvals: Approval[]): boolean {
  const active = approvals.filter((a) => a.decision === 'approve' && !a.voidedAt);
  const byApprover = new Map<string, Role[]>();
  for (const a of active) byApprover.set(a.approverId, a.roles);
  if (byApprover.size < req.min) return false;
  const holders = [...byApprover.values()];
  const assign = (i: number, used: Set<number>): boolean => {
    const role = req.mustInclude[i];
    if (role === undefined) return true;
    for (let h = 0; h < holders.length; h++) {
      if (!used.has(h) && holders[h]!.includes(role) && assign(i + 1, new Set(used).add(h))) return true;
    }
    return false;
  };
  return assign(0, new Set());
}

export type ActionName =
  | 'edit'
  | 'validate'
  | 'submit'
  | 'approve'
  | 'request_changes'
  | 'publish'
  | 'retry'
  | 'reopen'
  | 'withdraw';

const ACTIONS: Record<ActionName, { event: TransitionEvent; allow: Capability[] }> = {
  edit: { event: 'edit', allow: ['author'] },
  validate: { event: 'validation_passed', allow: ['author'] },
  submit: { event: 'submit', allow: ['author'] },
  approve: { event: 'approvals_complete', allow: ['approver'] },
  request_changes: { event: 'request_changes', allow: ['approver'] },
  publish: { event: 'publish', allow: ['publisher'] },
  retry: { event: 'retry', allow: ['publisher'] },
  reopen: { event: 'reopen', allow: ['approver', 'publisher'] },
  withdraw: { event: 'withdraw', allow: ['author'] },
};

/** Single source of truth for which buttons the UI shows. */
export function availableActions(status: Status, actor: Actor): ActionName[] {
  return (Object.keys(ACTIONS) as ActionName[]).filter((name) => {
    const a = ACTIONS[name];
    return canTransition(status, a.event) && a.allow.some((c) => hasCapability(actor, c));
  });
}
