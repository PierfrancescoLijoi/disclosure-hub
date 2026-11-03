import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errorText, type Issue, type PreCheck } from '../api';
import { announcementState, channelLabel, isApprover, when } from '../labels';
import { useSession } from '../session';
import { useAnnouncement } from '../useAnnouncement';
import { AnnouncementChip, Banner, Chip, EmptyState, PageHead, Skeleton, useToast } from '../ui';
import { ActionBar } from './actions';
import { ApprovalsCard, IssueList, PreCheckView, PublicationCard, RevisionHistory, Timeline } from './blocks';

export function Detail() {
  const { id = '' } = useParams();
  const s = useSession();
  const toast = useToast();
  const { view, audit, revisions, pre, setPre, error, reload } = useAnnouncement(id);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [busy, setBusy] = useState(false);

  if (!view) {
    return error ? (
      <>
        <PageHead title="Announcement" />
        <Banner tone="bad">{error}</Banner>
        <p>
          <Link to="/app/announcements">← All announcements</Link>
        </p>
      </>
    ) : (
      <Skeleton rows={5} />
    );
  }

  const { announcement: a, revision: r, timing } = view;
  const j = s.config!.jurisdictions.find((x) => x.code === a.jurisdiction)!;
  const category = j.categories.find((c) => c.key === a.category)?.label ?? a.category;
  const shown = issues ?? view.validation?.issues ?? [];
  const state = announcementState({ status: a.status, changesRequested: changesRequested(view, audit?.events) });
  const canReview = isApprover(s.me!.roles) && a.status === 'in_review';

  async function runPreCheck() {
    setBusy(true);
    try {
      setPre((await api<PreCheck>('POST', `/announcements/${id}/precheck`)).data);
      await reload();
    } catch (e) {
      toast(errorText(e), 'bad');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHead
        crumbs={<Link to="/app/announcements">Announcements</Link>}
        title={r.headline || 'Untitled draft'}
        sub={
          <span className="row wrap" style={{ gap: 8 }}>
            <AnnouncementChip a={{ status: a.status, changesRequested: state.label === 'Changes requested' }} />
            <Chip>{channelLabel(j)}</Chip>
            <Chip>{category}</Chip>
            <span className="muted small">
              revision {r.number} · <code title={r.contentHash}>{r.contentHash.slice(0, 10)}</code> · by {s.name(r.authorId)}
            </span>
          </span>
        }
      >
        {canReview && (
          <Link className="btn secondary" to={`/app/announcements/${a.id}/review`}>
            Open review room
          </Link>
        )}
        {a.status === 'published' && (
          <Link className="btn secondary" to={`/public/announcements/${a.id}`} target="_blank" rel="noopener">
            View public page
          </Link>
        )}
      </PageHead>

      {a.status === 'failed' && (
        <Banner tone="bad">
          <strong>Failed.</strong> {a.failureReason ?? 'The provider did not accept it.'} Retry will first check whether the provider already accepted it.
        </Banner>
      )}
      {state.label === 'Changes requested' && <Banner tone="warn">A reviewer sent this back. Read the comment in the timeline, edit, then validate and submit again.</Banner>}

      <section className="card" aria-labelledby="act-h">
        <h3 id="act-h" style={{ marginBottom: 10 }}>Actions</h3>
        <ActionBar view={view} onChanged={reload} onIssues={setIssues} />
      </section>

      <div className="grid split">
        <div className="stack">
          <section className="card" aria-labelledby="content-h">
            <h3 id="content-h" className="sr-only">Content</h3>
            <article className="doc">
              <h3>{r.headline}</h3>
              <div className="text">{r.body}</div>
            </article>
            {Object.keys(r.metadata).length > 0 && (
              <details style={{ marginTop: 12 }}>
                <summary>{j.name} details</summary>
                <pre>{JSON.stringify(r.metadata, null, 2)}</pre>
              </details>
            )}
            {timing && (
              <p className="muted small" style={{ marginTop: 12 }}>
                {timing.deadline &&
                  (timing.deadline.at ? (
                    <>
                      Deadline <strong>{when(timing.deadline.at)}</strong> ({timing.deadline.basis}){timing.overdue && <strong> · overdue</strong>}.{' '}
                    </>
                  ) : (
                    <>Deadline: {timing.deadline.basis}. </>
                  ))}
                {j.channel.name} is {timing.window.open ? 'open' : `closed until ${timing.window.nextOpenAt ? when(timing.window.nextOpenAt) : 'further notice'}`}
                {s.config!.enforceWindows ? ' (releases are held while closed).' : ' (window not enforced in this run).'}
              </p>
            )}
          </section>

          <IssueList issues={shown} />
          {view.validation?.ok && shown.length === 0 && <Banner tone="ok">Validation passed for revision {r.number}.</Banner>}

          <RevisionHistory revisions={revisions} current={a.currentRevision} />

          {s.config!.ai && (
            <section className="card" aria-labelledby="ai-h">
              <div className="card-head">
                <h3 id="ai-h">
                  AI pre-check <span className="muted small">advisory only · {s.config!.ai.provider}</span>
                </h3>
                <button type="button" className="btn secondary small" disabled={busy} onClick={runPreCheck}>
                  Run pre-check
                </button>
              </div>
              {pre ? <PreCheckView pre={pre} draftCategory={a.category} /> : <p className="muted">Not run yet. The pre-check never approves, blocks or publishes anything.</p>}
            </section>
          )}
        </div>

        <div className="stack">
          <ApprovalsCard view={view} />
          <PublicationCard view={view} />
          {!view.publication && view.approvals.length === 0 && !a.approvalRequirement && (
            <section className="card">
              <EmptyState title="Not submitted yet">Approvals and publication details appear here once the announcement is submitted.</EmptyState>
            </section>
          )}
          <Timeline audit={audit} />
        </div>
      </div>
    </>
  );
}

/** A draft that a reviewer sent back: the most recent decision is a change request and the status is draft again. */
function changesRequested(view: { announcement: { status: string }; approvals: { decision: string; at: string }[] }, events?: { type: string; seq: number }[]) {
  if (view.announcement.status !== 'draft') return false;
  if (!events) return view.approvals.some((x) => x.decision === 'request_changes');
  return events.filter((e) => ['submitted', 'changes_requested'].includes(e.type)).at(-1)?.type === 'changes_requested';
}
