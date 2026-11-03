import { z } from 'zod';
import { unprocessable } from './errors.js';
import { windowStatus, type Calendar, type OpeningWindow, type WindowStatus } from './calendar.js';
import type {
  ApprovalRequirement,
  DistributionPayload,
  Issue,
  Issuer,
  JurisdictionCode,
} from './types.js';

/** What every rule, deadline and renderer sees. `meta` is the parsed category metadata. */
export interface RuleContext<M = any> {
  announcementId: string;
  jurisdiction: JurisdictionCode;
  category: string;
  issuer: Issuer;
  headline: string;
  body: string;
  meta: M;
  now: Date;
}

export type Rule<M = any> = (ctx: RuleContext<M>) => Issue[];

export interface Deadline {
  /** null means "as soon as possible": no fixed instant, only a duty. */
  at: Date | null;
  basis: string;
}

export interface CategoryDefinition<M = any> {
  label: string;
  schema: z.ZodType<M>;
  rules?: Rule<M>[];
  approval: ApprovalRequirement | ((ctx: RuleContext<M>) => ApprovalRequirement);
  deadline?: (ctx: RuleContext<M>) => Deadline | null;
}

export interface Timing {
  deadline: Deadline | null;
  overdue: boolean;
  window: WindowStatus;
}

export interface JurisdictionInfo {
  code: JurisdictionCode;
  name: string;
  channel: { id: string; name: string };
  timezone: string;
  window: OpeningWindow;
  categories: { key: string; label: string; jsonSchema: unknown }[];
}

/** The contract a jurisdiction fulfils. The workflow only ever talks to this. */
export interface JurisdictionPolicy {
  readonly code: JurisdictionCode;
  readonly name: string;
  readonly channel: { id: string; name: string };
  readonly timezone: string;
  /** Issues from issuer profile, shared rules, schema and category rules. */
  validate(input: ValidateInput): Issue[];
  approvalRequirement(ctx: RuleContext): ApprovalRequirement;
  timing(ctx: RuleContext): Timing;
  render(ctx: RuleContext): DistributionPayload;
  postPublication(ctx: RuleContext): string[];
  describe(): JurisdictionInfo;
  hasCategory(key: string): boolean;
  /** Parses category metadata; the rule context needs the parsed form. */
  parseMetadata(category: string, metadata: unknown): { success: true; data: unknown } | { success: false };
}

export interface ValidateInput {
  announcementId: string;
  category: string;
  issuer: Issuer;
  headline: string;
  body: string;
  metadata: unknown;
  now: Date;
}

export interface PolicyConfig {
  code: JurisdictionCode;
  name: string;
  timezone: string;
  channel: { id: string; name: string };
  /** Shape of issuer.profiles[code]: the identifiers the channel needs. */
  issuerProfile: z.ZodType<Record<string, string>>;
  headlineMax: number;
  calendar: Calendar;
  window: OpeningWindow;
  categories: Record<string, CategoryDefinition>;
  render(ctx: RuleContext): DistributionPayload;
  postPublication(ctx: RuleContext): string[];
}

const PLACEHOLDER = /\[(?:●|\*|TBC|TBD|X{2,}|INSERT[^\]]*)\]|\bTBC\b|\bTBD\b|lorem ipsum/i;

const err = (code: string, message: string, path?: string): Issue => ({ code, severity: 'error', message, path });

function zodIssues(prefix: string, e: z.ZodError): Issue[] {
  return e.issues.map((i) =>
    err('SCHEMA_INVALID', i.message, [prefix, ...i.path].filter((p) => p !== '').join('.')),
  );
}

/**
 * Builds a policy from declarative parts. Shared checks (headline, body, placeholders,
 * identifiers, schema, deadline) live here once; a jurisdiction only supplies what differs.
 */
export function definePolicy(cfg: PolicyConfig): JurisdictionPolicy {
  const category = (key: string) => {
    const def = cfg.categories[key];
    if (!def) throw unprocessable('UNKNOWN_CATEGORY', `${cfg.name} has no category "${key}"`);
    return def;
  };

  const timing = (ctx: RuleContext): Timing => {
    const deadline = category(ctx.category).deadline?.(ctx) ?? null;
    return {
      deadline,
      overdue: !!deadline?.at && ctx.now > deadline.at,
      window: windowStatus(ctx.now, cfg.timezone, cfg.window, cfg.calendar),
    };
  };

  return {
    code: cfg.code,
    name: cfg.name,
    channel: cfg.channel,
    timezone: cfg.timezone,
    hasCategory: (key) => key in cfg.categories,
    parseMetadata: (key, metadata) => category(key).schema.safeParse(metadata),

    validate(input) {
      const def = category(input.category);
      const issues: Issue[] = [];

      const profile = cfg.issuerProfile.safeParse(input.issuer.profiles[cfg.code] ?? {});
      if (!profile.success) {
        issues.push(
          ...zodIssues('issuer', profile.error).map((i) => ({
            ...i,
            code: 'ISSUER_PROFILE_INCOMPLETE',
            message: `${input.issuer.name} ${cfg.name} profile: ${i.message}`,
          })),
        );
      }

      const headline = input.headline.trim();
      if (!headline) issues.push(err('HEADLINE_REQUIRED', 'Headline is required', 'headline'));
      else if (headline.length > cfg.headlineMax) {
        issues.push(err('HEADLINE_TOO_LONG', `Headline exceeds ${cfg.headlineMax} characters`, 'headline'));
      }
      if (!input.body.trim()) issues.push(err('BODY_REQUIRED', 'Body is required', 'body'));
      if (PLACEHOLDER.test(`${input.headline}\n${input.body}`)) {
        issues.push(err('PLACEHOLDER_LEFT', 'Draft placeholder text (TBC, [●], lorem ipsum) is still present', 'body'));
      }

      const meta = def.schema.safeParse(input.metadata);
      if (!meta.success) return [...issues, ...zodIssues('metadata', meta.error)];

      const ctx: RuleContext = {
        announcementId: input.announcementId,
        jurisdiction: cfg.code,
        category: input.category,
        issuer: input.issuer,
        headline: input.headline,
        body: input.body,
        meta: meta.data,
        now: input.now,
      };
      for (const rule of def.rules ?? []) issues.push(...rule(ctx));

      const t = timing(ctx);
      if (t.overdue && t.deadline?.at) {
        issues.push({
          code: 'DEADLINE_PASSED',
          severity: 'warning',
          message: `Deadline passed (${t.deadline.basis}, ${t.deadline.at.toISOString()}). Record the reason for lateness.`,
        });
      }
      return issues;
    },

    approvalRequirement(ctx) {
      const a = category(ctx.category).approval;
      return typeof a === 'function' ? a(ctx) : a;
    },
    timing,
    render: (ctx) => cfg.render(ctx),
    postPublication: (ctx) => cfg.postPublication(ctx),

    describe() {
      return {
        code: cfg.code,
        name: cfg.name,
        channel: cfg.channel,
        timezone: cfg.timezone,
        window: cfg.window,
        categories: Object.entries(cfg.categories).map(([key, def]) => ({
          key,
          label: def.label,
          jsonSchema: z.toJSONSchema(def.schema, { unrepresentable: 'any' }),
        })),
      };
    },
  };
}

export class PolicyRegistry {
  private readonly policies = new Map<JurisdictionCode, JurisdictionPolicy>();

  register(policy: JurisdictionPolicy): this {
    this.policies.set(policy.code, policy);
    return this;
  }

  get(code: JurisdictionCode): JurisdictionPolicy {
    const p = this.policies.get(code);
    if (!p) throw unprocessable('UNKNOWN_JURISDICTION', `No policy registered for "${code}"`);
    return p;
  }

  list(): JurisdictionPolicy[] {
    return [...this.policies.values()];
  }
}
