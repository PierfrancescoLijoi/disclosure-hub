import { useCallback, useEffect, useState } from 'react';
import { api, errorText, type AuditEvent, type PreCheck, type Revision, type View } from './api';
import { useSession } from './session';

const PUBLISHING_POLL_MS = 1500;

export interface AuditTrail {
  events: AuditEvent[];
  chain: { ok: boolean; brokenAtSeq?: number };
}

/** One announcement with its history, kept fresh while a publication is in flight. */
export function useAnnouncement(id: string) {
  const s = useSession();
  const [view, setView] = useState<View | null>(null);
  const [audit, setAudit] = useState<AuditTrail | null>(null);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [pre, setPre] = useState<PreCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const aiOn = !!s.config?.ai;

  const reload = useCallback(async () => {
    try {
      const [v, a, r] = await Promise.all([
        api<View>('GET', `/announcements/${id}`),
        api<AuditTrail>('GET', `/announcements/${id}/audit`),
        api<{ revisions: Revision[] }>('GET', `/announcements/${id}/revisions`),
      ]);
      setView(v.data);
      setAudit(a.data);
      setRevisions(r.data.revisions);
      if (aiOn) setPre((await api<{ result: PreCheck | null }>('GET', `/announcements/${id}/precheck`)).data.result);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [id, aiOn]);

  useEffect(() => {
    setView(null);
    setAudit(null);
    setPre(null);
    setError(null);
    void reload();
  }, [reload, s.me?.id]);

  const status = view?.announcement.status;
  useEffect(() => {
    if (status !== 'publishing') return;
    const t = setInterval(() => {
      void reload();
      void s.refresh();
    }, PUBLISHING_POLL_MS);
    return () => clearInterval(t);
  }, [status, reload, s]);

  return { view, audit, revisions, pre, setPre, error, reload };
}
