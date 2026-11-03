import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { Item } from '../api';
import { ago, isAuthor, nextAction } from '../labels';
import { useSession } from '../session';
import { AnnouncementChip, Chip, EmptyState, PageHead, Skeleton } from '../ui';

const FILTERS: { key: string; label: string; match: (i: Item) => boolean }[] = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'draft', label: 'Drafts', match: (i) => i.status === 'draft' || i.status === 'validated' },
  { key: 'review', label: 'In review', match: (i) => i.status === 'in_review' },
  { key: 'approved', label: 'Approved', match: (i) => i.status === 'approved' },
  { key: 'publishing', label: 'Publishing', match: (i) => i.status === 'publishing' },
  { key: 'published', label: 'Published', match: (i) => i.status === 'published' },
  { key: 'failed', label: 'Failed', match: (i) => i.status === 'failed' },
];

export function Announcements() {
  const s = useSession();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const filter = params.get('status') ?? 'all';
  const jurisdiction = params.get('jurisdiction') ?? '';
  const q = params.get('q') ?? '';

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value && value !== 'all') next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const rows = useMemo(() => {
    const f = FILTERS.find((x) => x.key === filter) ?? FILTERS[0]!;
    const needle = q.trim().toLowerCase();
    return (s.items ?? []).filter(
      (i) => f.match(i) && (!jurisdiction || i.jurisdiction === jurisdiction) && (!needle || i.headline.toLowerCase().includes(needle) || i.id.toLowerCase().startsWith(needle)),
    );
  }, [s.items, filter, jurisdiction, q]);

  const categoryLabel = (i: Item) => s.config?.jurisdictions.find((j) => j.code === i.jurisdiction)?.categories.find((c) => c.key === i.category)?.label ?? i.category;
  const counts = (key: string) => (s.items ?? []).filter((FILTERS.find((x) => x.key === key) ?? FILTERS[0]!).match).length;
  const filtered = filter !== 'all' || !!jurisdiction || !!q;

  return (
    <>
      <PageHead title="Announcements" sub="Everything your company has drafted, in review or published.">
        {isAuthor(s.me!.roles) && (
          <Link className="btn" to="/app/announcements/new">
            New announcement
          </Link>
        )}
      </PageHead>

      <div className="filters">
        <div className="seg" role="group" aria-label="Filter by state">
          {FILTERS.map((f) => (
            <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => set('status', f.key)}>
              {f.label}
              {s.items && <span className="muted"> {counts(f.key)}</span>}
            </button>
          ))}
        </div>
        <select aria-label="Jurisdiction" value={jurisdiction} onChange={(e) => set('jurisdiction', e.target.value)}>
          <option value="">All jurisdictions</option>
          {s.config?.jurisdictions.map((j) => (
            <option key={j.code} value={j.code}>
              {j.name}
            </option>
          ))}
        </select>
        <input type="search" aria-label="Search headline" placeholder="Search headline" value={q} onChange={(e) => set('q', e.target.value)} />
        {filtered && (
          <button type="button" className="btn ghost small" onClick={() => setParams({}, { replace: true })}>
            Clear filters
          </button>
        )}
      </div>

      <section className="card flush">
        {!s.items ? (
          <Skeleton rows={5} />
        ) : rows.length === 0 ? (
          filtered ? (
            <EmptyState title="No announcements match">Try a different state, jurisdiction or search.</EmptyState>
          ) : (
            <EmptyState
              title="No announcements yet"
              action={
                isAuthor(s.me!.roles) ? (
                  <Link className="btn" to="/app/announcements/new">
                    Create the first draft
                  </Link>
                ) : undefined
              }
            >
              {isAuthor(s.me!.roles) ? 'Start a draft; it appears here as soon as it is saved.' : 'Editors create drafts; they appear here once they exist.'}
            </EmptyState>
          )
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Headline</th>
                  <th>Jurisdiction</th>
                  <th>State</th>
                  <th>Next step</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((i) => (
                  <tr key={i.id} className="row-link" onClick={(e) => !(e.target as HTMLElement).closest('a') && nav(`/app/announcements/${i.id}`)}>
                    <td className="title">
                      <Link to={`/app/announcements/${i.id}`}>{i.headline || 'Untitled draft'}</Link>
                      <div className="muted small">{categoryLabel(i)}</div>
                    </td>
                    <td>
                      <Chip>{i.jurisdiction}</Chip>
                    </td>
                    <td>
                      <AnnouncementChip a={i} />
                    </td>
                    <td>{nextAction(i)}</td>
                    <td className="nowrap muted" title={new Date(i.updatedAt).toLocaleString()}>
                      {ago(i.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {s.items && s.items.length >= 100 && <p className="muted small">Showing the latest 100 announcements.</p>}
    </>
  );
}
