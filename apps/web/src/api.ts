export interface Issue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  path?: string;
}

export interface Category {
  key: string;
  label: string;
  jsonSchema: Schema;
}
export interface Jurisdiction {
  code: string;
  name: string;
  channel: { id: string; name: string };
  timezone: string;
  window: { open: string; close: string };
  categories: Category[];
}
export interface Config {
  role: string;
  demo: boolean;
  queue: string;
  database: string;
  enforceWindows: boolean;
  ai: { provider: string } | null;
  jurisdictions: Jurisdiction[];
}
export interface User {
  id: string;
  name: string;
  issuerId: string;
  roles: string[];
}

export interface Announcement {
  id: string;
  jurisdiction: string;
  category: string;
  status: string;
  currentRevision: number;
  version: number;
  approvalRequirement: { min: number; mustInclude: string[] } | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
  headline?: string;
}
export interface View {
  announcement: Announcement;
  revision: { number: number; headline: string; body: string; metadata: Record<string, any>; contentHash: string; authorId: string };
  validation: { ok: boolean; issues: Issue[]; at: string } | null;
  approvals: { id: string; approverId: string; roles: string[]; decision: string; comment: string; at: string; voidedAt: string | null }[];
  publication: { status: string; attempts: number; maxAttempts: number; externalRef: string | null; ack: Record<string, any> | null; lastError: string | null; nextAttemptAt: string } | null;
  timing: { deadline: { at: string | null; basis: string } | null; overdue: boolean; window: { open: boolean; nextOpenAt: string | null } } | null;
  actions: string[];
  obligations: string[];
}
export interface AuditEvent {
  seq: number;
  type: string;
  actorId: string;
  at: string;
  data: Record<string, any>;
}
export interface PreCheck {
  provider: string;
  at: string;
  categoryMatchesDraft: boolean;
  report: {
    classification: { suggestedCategory: string; confidence: number; rationale: string };
    missingInformation: { field: string; why: string }[];
    risks: { regime: string; code: string; severity: string; evidence: string; explanation: string; suggestedAction: string }[];
    disclaimer: string;
  };
}

export interface Schema {
  type?: string;
  title?: string;
  format?: string;
  enum?: string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  minimum?: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let userId = localStorage.getItem('hub.user') ?? 'alice';
export const currentUser = () => userId;
export const setCurrentUser = (id: string) => {
  userId = id;
  localStorage.setItem('hub.user', id);
};

/** Returns the body even for 422 (a failed submit carries its report); throws for other errors. */
export async function api<T = any>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-user-id': userId },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok && res.status !== 422) {
    throw new ApiError(res.status, data?.error?.code ?? 'ERROR', data?.error?.message ?? `Request failed (${res.status})`);
  }
  return { status: res.status, data };
}
