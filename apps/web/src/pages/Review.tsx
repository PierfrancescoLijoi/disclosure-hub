import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type Revision, type View } from '../api';
import { diffWords } from '../diff';
import { ago, channelLabel, isApprover } from '../labels';
import { useSession } from '../session';
import { reviewable } from '../shell';
import { useAnnouncement } from '../useAnnouncement';
import { AnnouncementChip, Banner, Chip, EmptyState, PageHead, Skeleton } from '../ui';
import { ActionBar } from './actions';
import { ApprovalsCard, IssueList } from './blocks';

const NotForYou = () => (
  <>
    <PageHead title="Review" />
    <Banner tone="warn">Only company secretary, legal and CFO roles review announcements. Your role cannot approve.</Banner>
  </>
);

function Side({ title, revision, mode, other }: { title: string; revision: Revision | null; mode: 'before' | 'after'; other: Revision | null }) {
  const pieces = useMemo(() => {
    if (!revision) return [];
    if (!other) return [{ kind: 'same' as const, text: `${revision.headline}\n\n${revision.body}` }];
    const a = mode === 'before' ? revision : other;
    const b = mode === 'before' ? other : revision;
    const all = diffWords(`${a.headline}\n\n${a.body}`, `${b.headline}\n\n${b.body}`);
    return all.filter((p) => (mode === 'before' ? p.kind !== 'add' : p.kind !== 'del'));
  }, [revision, other, mode]);
  return (
    <section className="card" aria-label={title}>
      <h4>{title}</h4>
      {!revision ? (
        <p className="muted" style={{ marginTop: 10 }}>This is the first revision: there is nothing earlier to compare with.</p>
      ) : (
        <div className="doc diff" style={{ marginTop: 10 }}>
          {pieces.map((p, k) =>
            p.kind === 'add' ? <ins key={k}>{p.text}</ins> : p.kind === 'del' ? <del key={k}>{p.text}</del> : <span key={k}>{p.text}</span>,
          )}
        </div>
      )}
    </section>
  );
}

export function ReviewRoom() {
  const { id = '' } = useParams();
  const s = useSession();
  const { view, revisions, error, reload } = useAnnouncement(id);

  if (!isApprover(s.me!.roles)) return <NotForYou />;
  if (!view) {
    return error ? (
      <>
        <PageHead title="Review" />
        <Banner tone="bad">{error}</Banner>
      </>
    ) : (
      <Skeleton rows={5} />
    );
  }

  const a = view.announcement;
  const current = revisions.find((r) => r.number === a.currentRevision) ?? view.revision;
  const previous = revisions.find((r) => r.number === a.currentRevision - 1) ?? null;
  const j = s.config!.jurisdictions.find((x) => x.code === a.jurisdiction)!;

  return (
    <>
      <PageHead
        crumbs={
          <>
            <Link to="/app/review">Review inbox</Link> / <Link to={`/app/announcements/${a.id}`}>Announcement</Link>
          </>
        }
        title={`Review: ${current.headline}`}
        sub={
          <span className="row wrap" style={{ gap: 8 }}>
            <AnnouncementChip a={a} />
            <Chip>{channelLabel(j)}</Chip>
            <span className="muted small">
              revision {current.number} by {s.name(current.authorId)}
            </span>
          </span>
        }
      />

      {a.status !== 'in_review' && <Banner tone="info">This announcement is no longer waiting for review (it is {a.status.replace('_', ' ')}).</Banner>}

      <div className="grid two">
        <Side title={previous ? `Revision ${previous.number} (previous)` : 'Previous revision'} revision={previous} mode="before" other={previous ? current : null} />
        <Side title={`Revision ${current.number} (under review)`} revision={current} mode="after" other={previous} />
      </div>

      <div className="grid split">
        <div className="stack">
          {Object.keys(current.metadata).length > 0 && (
            <section className="card">
              <h3>{j.name} details</h3>
              <pre style={{ marginTop: 10 }}>{JSON.stringify(current.metadata, null, 2)}</pre>
            </section>
          )}
          {view.validation && <IssueList issues={view.validation.issues} title={view.validation.ok ? 'Validation (passed, with notes)' : 'Validation'} />}
          {view.validation?.ok && view.validation.issues.length === 0 && <Banner tone="ok">Validation passed for this revision.</Banner>}
        </div>
        <div className="stack sticky">
          <section className="card">
            <h3 style={{ marginBottom: 10 }}>Your decision</h3>
            <ActionBar view={view} onChanged={reload} only={['approve', 'request_changes']} />
          </section>
          <ApprovalsCard view={view} />
        </div>
      </div>
    </>
  );
}

interface Row {
  item: ReturnType<typeof reviewable>[number];
  view: View;
  mine: boolean;
}

export function ReviewInbox() {
  const s = useSession();
  const me = s.me!;
  const [rows, setRows] = useState<Row[] | null>(null);
  const [tab, setTab] = useState<'waiting' | 'decided'>('waiting');
  const candidates = reviewable(s.items, me).slice(0, 30);
  const key = candidates.map((c) => `${c.id}:${c.version}`).join(',');

  useEffect(() => {
    let live = true;
    if (!s.items) return;
    Promise.all(
      candidates.map(async (item) => {
        const view = (await api<View>('GET', `/announcements/${item.id}`)).data;
        const mine = view.approvals.some((x) => x.approverId === me.id && x.decision === 'approve' && !x.voidedAt && x.revision === view.announcement.currentRevision);
        return { item, view, mine };
      }),
    )
      .then((r) => live && setRows(r))
      .catch(() => live && setRows([]));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, me.id, !!s.items]);

  if (!isApprover(me.roles)) return <NotForYou />;
  const waiting = rows?.filter((r) => !r.mine) ?? [];
  const decided = rows?.filter((r) => r.mine) ?? [];
  const shown = tab === 'waiting' ? waiting : decided;

  return (
    <>
      <PageHead title="Review inbox" sub="Announcements submitted for approval by someone else." />
      <div className="filters">
        <div className="seg" role="group" aria-label="Inbox view">
          <button type="button" aria-pressed={tab === 'waiting'} onClick={() => setTab('waiting')}>
            Waiting for you <span className="muted">{rows ? waiting.length : ''}</span>
          </button>
          <button type="button" aria-pressed={tab === 'decided'} onClick={() => setTab('decided')}>
            You approved <span className="muted">{rows ? decided.length : ''}</span>
          </button>
        </div>
      </div>
      <section className="card flush">
        {!rows ? (
          <Skeleton rows={3} />
        ) : shown.length === 0 ? (
          <EmptyState title={tab === 'waiting' ? 'Nothing is waiting for your review' : 'You have not approved anything that is still in review'}>
            Submitted announcements appear here.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Announcement</th>
                  <th>Submitted by</th>
                  <th>Approvals</th>
                  <th>Updated</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map(({ item, view }) => {
                  const need = view.announcement.approvalRequirement;
                  const have = view.approvals.filter((x) => x.decision === 'approve' && !x.voidedAt && x.revision === view.announcement.currentRevision).length;
                  return (
                    <tr key={item.id}>
                      <td className="title">
                        <Link to={`/app/announcements/${item.id}`}>{item.headline}</Link>
                        <div className="muted small">{item.jurisdiction}</div>
                      </td>
                      <td>{s.name(item.createdBy)}</td>
                      <td className="num">{need ? `${have} of ${need.min}` : have}</td>
                      <td className="muted nowrap">{ago(item.updatedAt)}</td>
                      <td>
                        <Link className="btn small" to={`/app/announcements/${item.id}/review`}>
                          Open review room
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
