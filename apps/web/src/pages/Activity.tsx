import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorText, type Activity as Event } from '../api';
import { ago, auditText, when } from '../labels';
import { useSession } from '../session';
import { Banner, Chip, EmptyState, PageHead, Skeleton } from '../ui';

const GROUPS: { key: string; label: string; types: RegExp }[] = [
  { key: 'all', label: 'All', types: /./ },
  { key: 'review', label: 'Review', types: /submit|approved|changes_requested|reopened/ },
  { key: 'publishing', label: 'Publishing', types: /publish/ },
  { key: 'drafting', label: 'Drafting', types: /created|revision_saved|validated|precheck|withdrawn/ },
];

export function Activity() {
  const s = useSession();
  const [events, setEvents] = useState<Event[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [group, setGroup] = useState('all');
  const [jurisdiction, setJurisdiction] = useState('');

  useEffect(() => {
    let live = true;
    api<{ events: Event[] }>('GET', '/activity?limit=100')
      .then((r) => live && setEvents(r.data.events))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [s.me?.id]);

  const types = (GROUPS.find((g) => g.key === group) ?? GROUPS[0]!).types;
  const shown = (events ?? []).filter((e) => types.test(e.type) && (!jurisdiction || e.jurisdiction === jurisdiction));

  return (
    <>
      <PageHead title="Activity" sub="What happened across your company’s announcements, newest first." />
      <div className="filters">
        <div className="seg" role="group" aria-label="Kind of activity">
          {GROUPS.map((g) => (
            <button key={g.key} type="button" aria-pressed={group === g.key} onClick={() => setGroup(g.key)}>
              {g.label}
            </button>
          ))}
        </div>
        <select aria-label="Jurisdiction" value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)}>
          <option value="">All jurisdictions</option>
          {s.config?.jurisdictions.map((j) => (
            <option key={j.code} value={j.code}>
              {j.name}
            </option>
          ))}
        </select>
      </div>
      {error && <Banner tone="bad">{error}</Banner>}
      <section className="card">
        {!events && !error ? (
          <Skeleton rows={5} />
        ) : shown.length === 0 ? (
          <EmptyState title="No activity matches">Try another kind of activity or jurisdiction.</EmptyState>
        ) : (
          <ol className="timeline">
            {shown.map((e, k) => (
              <li key={`${e.announcementId}-${e.at}-${k}`} className={/failed|changes_requested/.test(e.type) ? 'tone-bad' : /^published$|approved/.test(e.type) ? 'tone-ok' : ''}>
                <div className="what">{auditText(e.type)}</div>
                <div className="muted small">
                  <Link to={`/app/announcements/${e.announcementId}`}>{e.headline || e.announcementId}</Link> · <Chip>{e.jurisdiction}</Chip> · {s.name(e.actorId)} ·{' '}
                  <span title={when(e.at)}>{ago(e.at)}</span>
                  {e.revision != null && <> · revision {e.revision}</>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}
