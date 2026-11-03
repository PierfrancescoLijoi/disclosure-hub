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
  auth: { mode: 'demo' } | { mode: 'oidc'; authority: string; clientId: string | null; scope: string };
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
export interface Issuer {
  id: string;
  name: string;
  profiles: Record<string, Record<string, string>>;
}

export interface Announcement {
  id: string;
  issuerId: string;
  jurisdiction: string;
  category: string;
  status: string;
  currentRevision: number;
  version: number;
  createdBy: string;
  approvalRequirement: { min: number; mustInclude: string[] } | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface Item extends Announcement {
  headline: string;
  changesRequested: boolean;
}
export interface Revision {
  number: number;
  headline: string;
  body: string;
  metadata: Record<string, any>;
  contentHash: string;
  authorId: string;
  createdAt: string;
}
export interface PublicationView {
  status: string;
  attempts: number;
  maxAttempts: number;
  externalRef: string | null;
  ack: Record<string, any> | null;
  lastError: string | null;
  nextAttemptAt: string;
}
export interface Approval {
  id: string;
  approverId: string;
  roles: string[];
  decision: string;
  comment: string;
  at: string;
  revision: number;
  voidedAt: string | null;
}
export interface View {
  announcement: Announcement;
  revision: Revision;
  validation: { ok: boolean; issues: Issue[]; at: string } | null;
  approvals: Approval[];
  publication: PublicationView | null;
  timing: { deadline: { at: string | null; basis: string } | null; overdue: boolean; holdWhenClosed: boolean; window: { open: boolean; nextOpenAt: string | null } } | null;
  actions: string[];
  obligations: string[];
}
export interface AuditEvent {
  seq: number;
  type: string;
  actorId: string;
  at: string;
  hash: string;
  data: Record<string, any>;
}
export interface Job {
  id: string;
  announcementId: string;
  jurisdiction: string;
  headline: string;
  revision: number;
  status: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  externalRef: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface Activity {
  announcementId: string;
  headline: string;
  jurisdiction: string;
  type: string;
  actorId: string;
  at: string;
  revision: number | null;
}
export interface PublicItem {
  id: string;
  jurisdiction: string;
  category: string;
  categoryLabel: string;
  channelName: string;
  headline: string;
  issuerName: string;
  receipt: string;
  filingDate: string | null;
  publishedAt: string;
}
export type PublicDetail = PublicItem & { body: string };
export interface Preview {
  channel: { id: string; name: string };
  payload: { channel: string; headline: string; content: string; attributes: Record<string, string | string[]>; attachments: { type: string; name: string }[] } | null;
  problem: string | null;
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

/** Set once the browser has signed in; until then (and in demo mode) the persona header is used. */
let tokenProvider: (() => Promise<string | null>) | undefined;
export const useBearerTokens = (provider: () => Promise<string | null>) => {
  tokenProvider = provider;
};

const USER_KEY = 'hub.user';
let userId: string | null = localStorage.getItem(USER_KEY);
export const currentUser = () => userId;
export const setCurrentUser = (id: string | null) => {
  userId = id;
  if (id) localStorage.setItem(USER_KEY, id);
  else localStorage.removeItem(USER_KEY);
};

type Method = 'GET' | 'POST' | 'PUT';

async function request<T>(method: Method, path: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; data: T }> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => null);
  // A failed submit (422) carries its report, so it is returned; everything else that fails throws.
  if (!res.ok && res.status !== 422) {
    throw new ApiError(res.status, data?.error?.code ?? 'ERROR', data?.error?.message ?? `Request failed (${res.status})`);
  }
  return { status: res.status, data };
}

export async function api<T = any>(method: Method, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const token = tokenProvider ? await tokenProvider() : null;
  const auth: Record<string, string> = tokenProvider ? { authorization: `Bearer ${token ?? ''}` } : userId ? { 'x-user-id': userId } : {};
  return request<T>(method, path, body, auth);
}

/** Public reading: no identity is sent, none is needed. */
export const publicApi = <T = any>(path: string) => request<T>('GET', `/public${path}`, undefined, {}).then((r) => r.data);

export const errorText = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
