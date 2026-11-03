import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Activity } from '../api';
import { ago, announcementState, auditText, isAuthor } from '../labels';
import { useSession } from '../session';
import { AnnouncementChip, Chip, EmptyState, Kpi, PageHead, Skeleton } from '../ui';
import { attention, countBy, PIPELINE } from '../work';

const STAGE_LABEL: Record<string, string> = {
  draft: 'Draft',
  validated: 'Validated',
  in_review: 'In review',
  approved: 'Approved',
  publishing: 'Publishing',
  published: 'Published · Demo',
};

export function Overview() {
  const s = useSession();
  const me = s.me!;
  const [events, setEvents] = useState<Activity[] | null>(null);

  useEffect(() => {
    let live = true;
    api<{ events: Activity[] }>('GET', '/activity?limit=8')
      .then((r) => live && setEvents(r.data.events))
      .catch(() => live && setEvents([]));
    return () => {
      live = false;
    };
  }, [me.id, s.items?.length]);

  if (!s.items) {
    return (
      <>
        <PageHead title={`Welcome, ${me.name.split(' ')[0]}`} />
        <Skeleton rows={4} />
      </>
    );
  }

  const items = s.items;
  const byStatus = countBy(items, (i) => i.status);
  const queue = items.map((i) => ({ i, todo: attention(i, me) })).filter((x) => x.todo);
  const byJurisdiction = countBy(items, (i) => i.jurisdiction);
  const peak = Math.max(1, ...Object.values(byJurisdiction));
  const total = items.length;

  return (
    <>
      <PageHead title={`Welcome, ${me.name.split(' ')[0]}`} sub={`${s.issuer?.name ?? ''} · ${me.roles.join(', ').replaceAll('_', ' ')}`}>
        {isAuthor(me.roles) && (
          <Link className="btn" to="/app/announcements/new">
            New announcement
          </Link>
        )}
      </PageHead>

      <div className="grid kpis">
        <Kpi value={queue.length} label="Waiting on you" tone={queue.length ? 'warn' : undefined} />
        <Kpi value={(byStatus.in_review ?? 0) + (byStatus.approved ?? 0)} label="In review or approved" />
        <Kpi value={(byStatus.publishing ?? 0)} label="Publishing now" />
        <Kpi value={byStatus.failed ?? 0} label="Failed" tone={byStatus.failed ? 'bad' : undefined} />
        <Kpi value={byStatus.published ?? 0} label="Published · Demo" tone="ok" />
      </div>

      <div className="grid split">
        <div className="stack">
          <section className="card flush" aria-labelledby="queue-h">
            <div className="card-head" style={{ padding: '16px 20px 0' }}>
              <h3 id="queue-h">Needs your attention</h3>
              <Link to="/app/announcements">All announcements →</Link>
            </div>
            {queue.length === 0 ? (
              <EmptyState title="Nothing is waiting on you">
                {total === 0 ? 'There are no announcements yet.' : 'New work will show up here as soon as it needs your decision.'}
              </EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Announcement</th>
                      <th>State</th>
                      <th>Your next step</th>
                    </tr>
                  </thead>
                  <tbody>
                    {queue.slice(0, 8).map(({ i, todo }) => (
                      <tr key={i.id}>
                        <td className="title">
                          <Link to={`/app/announcements/${i.id}`}>{i.headline || 'Untitled draft'}</Link>
                          <div className="muted small">{i.jurisdiction} · updated {ago(i.updatedAt)}</div>
                        </td>
                        <td>
                          <AnnouncementChip a={i} />
                        </td>
                        <td>{todo}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card" aria-labelledby="pipe-h">
            <h3 id="pipe-h">Pipeline</h3>
            {total === 0 ? (
              <p className="muted">Nothing in the pipeline yet.</p>
            ) : (
              <>
                <div className="stacked" role="img" aria-label={PIPELINE.map((p) => `${STAGE_LABEL[p]} ${byStatus[p] ?? 0}`).join(', ')}>
                  {PIPELINE.map((p, k) => (
                    <span key={p} style={{ width: `${((byStatus[p] ?? 0) / total) * 100}%`, background: STAGE_COLORS[k] }} />
                  ))}
                </div>
                <div className="legend">
                  {PIPELINE.map((p, k) => (
                    <span key={p}>
                      <i style={{ background: STAGE_COLORS[k] }} />
                      {STAGE_LABEL[p]} <b className="num">{byStatus[p] ?? 0}</b>
                    </span>
                  ))}
                </div>
              </>
            )}
          </section>
        </div>

        <div className="stack">
          <section className="card" aria-labelledby="act-h">
            <div className="card-head">
              <h3 id="act-h">Recent activity</h3>
              <Link to="/app/activity">See all →</Link>
            </div>
            {!events ? (
              <Skeleton rows={3} />
            ) : events.length === 0 ? (
              <p className="muted">No activity yet.</p>
            ) : (
              <ul className="timeline">
                {events.map((e, k) => (
                  <li key={`${e.announcementId}-${k}`}>
                    <div className="what">{auditText(e.type)}</div>
                    <div className="muted small">
                      <Link to={`/app/announcements/${e.announcementId}`}>{e.headline || e.announcementId}</Link> · {s.name(e.actorId)} · {ago(e.at)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card" aria-labelledby="jur-h">
            <h3 id="jur-h">By jurisdiction</h3>
            {total === 0 ? (
              <p className="muted">—</p>
            ) : (
              <div className="bars">
                {Object.entries(byJurisdiction).map(([code, n]) => (
                  <div key={code} className="bar-row">
                    <span>{code}</span>
                    <span className="track">
                      <span className="fill" style={{ width: `${(n / peak) * 100}%` }} />
                    </span>
                    <b className="num">{n}</b>
                  </div>
                ))}
              </div>
            )}
            <div className="row wrap" style={{ marginTop: 12 }}>
              <Chip tone="warn">Demo / Mock publishing</Chip>
              <span className="muted small">{announcementState({ status: 'published' }).label} means the mock provider accepted it.</span>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

const STAGE_COLORS = ['#b9c0d4', '#7fa7d9', '#5665ec', '#3f9d86', '#e0a63a', '#087f64'];
