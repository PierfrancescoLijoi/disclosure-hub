import { contentHash } from './hash.js';
import { requirementSatisfied } from './permissions.js';
import type { Announcement, Approval, Revision } from './types.js';

/**
 * Called when publication is requested and again by the worker right before the gateway call.
 * Returns why the release must not go out, or null when the approved content is intact.
 */
export function approvedContentProblem(a: Announcement, rev: Revision, approvals: Approval[]): string | null {
  const recomputed = contentHash({
    jurisdiction: a.jurisdiction,
    category: a.category,
    headline: rev.headline,
    body: rev.body,
    metadata: rev.metadata,
  });
  if (recomputed !== rev.contentHash) return 'Stored revision does not match its recorded content hash';
  const forThisContent = approvals.filter((x) => x.contentHash === rev.contentHash);
  if (!a.approvalRequirement || !requirementSatisfied(a.approvalRequirement, forThisContent)) {
    return 'Approvals do not satisfy the requirement for this exact content';
  }
  return null;
}
