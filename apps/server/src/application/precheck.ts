import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { notFound, DomainError } from '../domain/errors.js';
import type { PolicyRegistry } from '../domain/policy.js';
import type { Actor } from '../domain/types.js';
import type { AiReportRecord, Clock, Logger, PreCheckProvider, Store } from '../ports/index.js';

/**
 * Advisory output for the human reviewer. It is stored beside the announcement and shown in
 * the UI; nothing in the workflow reads it, so it can never approve, block or publish.
 */
export const PreCheckReportSchema = z.object({
  classification: z.object({
    suggestedCategory: z.string(),
    confidence: z.number().min(0).max(1),
    rationale: z.string(),
  }),
  missingInformation: z.array(z.object({ field: z.string(), why: z.string() })),
  risks: z.array(
    z.object({
      regime: z.enum(['UK_MAR', 'EU_MAR', 'US_REG_FD', 'GENERAL']),
      code: z.string(),
      severity: z.enum(['low', 'medium', 'high']),
      evidence: z.string(),
      explanation: z.string(),
      suggestedAction: z.string(),
    }),
  ),
  humanReviewRequired: z.literal(true),
  disclaimer: z.string(),
});
export type PreCheckReport = z.infer<typeof PreCheckReportSchema>;

export interface PreCheckResult {
  provider: string;
  revision: number;
  at: string;
  categoryMatchesDraft: boolean;
  report: PreCheckReport;
}

interface Deps {
  store: Store;
  policies: PolicyRegistry;
  clock: Clock;
  provider: PreCheckProvider;
  log: Logger;
}

const toResult = (r: AiReportRecord, draftCategory: string): PreCheckResult => {
  const report = r.report as PreCheckReport;
  return {
    provider: r.provider,
    revision: r.revision,
    at: r.at,
    categoryMatchesDraft: report.classification.suggestedCategory === draftCategory,
    report,
  };
};

export class PreCheckService {
  constructor(private readonly d: Deps) {}

  get providerName(): string {
    return this.d.provider.name;
  }

  async run(actor: Actor, id: string): Promise<PreCheckResult> {
    const { store, policies, clock, provider } = this.d;
    const a = await store.read.announcements.get(actor.issuerId, id);
    const rev = a && (await store.read.revisions.get(a.id, a.currentRevision));
    const issuer = a && (await store.read.issuers.get(a.issuerId));
    if (!a || !rev || !issuer) throw notFound('Announcement');
    const policy = policies.get(a.jurisdiction);
    const categories = policy.describe().categories.map((c) => c.key);

    let raw: unknown;
    try {
      raw = await provider.analyze({
        jurisdiction: a.jurisdiction,
        category: a.category,
        categories,
        issuerName: issuer.name,
        headline: rev.headline,
        body: rev.body,
        metadata: rev.metadata,
      });
    } catch (err) {
      this.d.log.warn({ err, announcementId: id }, 'pre-check provider failed');
      throw new DomainError(502, 'AI_PROVIDER_ERROR', 'The AI provider failed; the workflow is unaffected');
    }
    // The provider is untrusted: shape and vocabulary are enforced here, not by prompt alone.
    const parsed = PreCheckReportSchema.safeParse(raw);
    if (!parsed.success || !categories.includes(parsed.data.classification.suggestedCategory)) {
      this.d.log.warn({ announcementId: id }, 'pre-check output rejected by schema');
      throw new DomainError(502, 'AI_OUTPUT_INVALID', 'The AI output did not match the expected format and was discarded');
    }

    const at = clock.now().toISOString();
    const record: AiReportRecord = { id: randomUUID(), announcementId: a.id, revision: rev.number, provider: provider.name, report: parsed.data, at, agent: 'precheck', eventId: null };
    await store.tx(async (tx) => {
      await tx.aiReports.insert(record);
      await tx.audit.append(
        {
          announcementId: a.id,
          issuerId: a.issuerId,
          type: 'precheck_completed',
          actorId: actor.id,
          data: { provider: provider.name, revision: rev.number, risks: parsed.data.risks.length, highest: highest(parsed.data) },
        },
        at,
      );
    });
    return toResult(record, a.category);
  }

  async latest(actor: Actor, id: string): Promise<PreCheckResult | null> {
    const a = await this.d.store.read.announcements.get(actor.issuerId, id);
    if (!a) throw notFound('Announcement');
    const r = await this.d.store.read.aiReports.latest(a.id);
    return r && toResult(r, a.category);
  }
}

function highest(r: PreCheckReport): string {
  for (const s of ['high', 'medium', 'low'] as const) if (r.risks.some((x) => x.severity === s)) return s;
  return 'none';
}
