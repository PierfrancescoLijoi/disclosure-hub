import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorText, type Item, type Job } from '../api';
import { ago, isPublisher, publicationState, when } from '../labels';
import { useSession } from '../session';
import { Banner, Confirm, CopyButton, EmptyState, Icon, Kpi, Modal, PageHead, PublicationChip, Skeleton, useToast } from '../ui';
import { WireControls } from '../WireControls';

const POLL_MS = 3000;
const IN_PROGRESS = ['pending', 'in_flight', 'retry'];
const FAILED = ['exhausted', 'rejected'];

type Act = { kind: 'publish' | 'retry'; id: string; headline: string; jurisdiction: string } | null;

export function Publishing() {
  const s = useSession();
  const toast = useToast();
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Job | null>(null);
  const [act, setAct] = useState<Act>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setJobs((await api<{ items: Job[] }>('GET', '/publications?limit=100')).data.items);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (!document.hidden) void load();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [load, s.me?.id]);

  if (!isPublisher(s.me!.roles)) {
    return (
      <>
        <PageHead title="Publishing" />
        <Banner tone="warn">Publishing is limited to the publisher role. Approved announcements are published by Erin or another publisher.</Banner>
      </>
    );
  }

  const ready: Item[] = (s.items ?? []).filter((i) => i.status === 'approved');
  const count = (f: (j: Job) => boolean) => (jobs ?? []).filter(f).length;
  const channelOf = (code: string) => s.config?.jurisdictions.find((j) => j.code === code)?.channel.name ?? code;

  async function confirm() {
    if (!act) return;
    setBusy(true);
    try {
      await api('POST', `/announcements/${act.id}/${act.kind}`, {});
      toast(act.kind === 'publish' ? 'Publication requested' : 'Retry requested');
      setAct(null);
      setOpen(null);
      await Promise.all([load(), s.refresh()]);
    } catch (e) {
      toast(errorText(e), 'bad');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHead title="Publishing" sub="Deliveries to the mock newswires. A lost acknowledgement is detected before any resend, so nothing publishes twice.">
        <button type="button" className="btn secondary" onClick={() => void load()}>
          <Icon name="refresh" size={16} /> Refresh
        </button>
      </PageHead>

      <div className="grid kpis" aria-label="Publishing summary">
        <Kpi value={s.items ? ready.length : '–'} label="Ready to publish" />
        <Kpi value={jobs ? count((j) => j.status === 'pending') : '–'} label="Queued" />
        <Kpi value={jobs ? count((j) => j.status === 'in_flight') : '–'} label="Processing" />
        <Kpi value={jobs ? count((j) => j.status === 'retry') : '–'} label="Retrying" tone={count((j) => j.status === 'retry') ? 'warn' : undefined} />
        <Kpi value={jobs ? count((j) => FAILED.includes(j.status)) : '–'} label="Failed" tone={count((j) => FAILED.includes(j.status)) ? 'bad' : undefined} />
        <Kpi value={jobs ? count((j) => j.status === 'acked') : '–'} label="Published · Demo" tone="ok" />
      </div>

      {error && <Banner tone="bad">Could not load deliveries: {error}</Banner>}

      <section className="card flush" aria-labelledby="ready-h">
        <div className="card-head" style={{ padding: '16px 20px 0' }}>
          <h3 id="ready-h">Ready to publish</h3>
        </div>
        {!s.items ? (
          <Skeleton rows={2} />
        ) : ready.length === 0 ? (
          <EmptyState title="Nothing is waiting to be published">Approved announcements appear here.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Announcement</th>
                  <th>Destination</th>
                  <th>Approved</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {ready.map((i) => (
                  <tr key={i.id}>
                    <td className="title">
                      <Link to={`/app/announcements/${i.id}`}>{i.headline}</Link>
                    </td>
                    <td>{channelOf(i.jurisdiction)} (mock)</td>
                    <td className="muted nowrap">{ago(i.updatedAt)}</td>
                    <td className="row end">
                      <button type="button" className="btn small" onClick={() => setAct({ kind: 'publish', id: i.id, headline: i.headline, jurisdiction: i.jurisdiction })}>
                        Publish…
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card flush" aria-labelledby="jobs-h">
        <div className="card-head" style={{ padding: '16px 20px 0' }}>
          <h3 id="jobs-h">Deliveries</h3>
          {jobs?.some((j) => IN_PROGRESS.includes(j.status)) && <span className="muted small">Updating every {POLL_MS / 1000}s</span>}
        </div>
        {!jobs ? (
          <Skeleton rows={4} />
        ) : jobs.length === 0 ? (
          <EmptyState title="No deliveries yet">When an announcement is published it shows up here with its receipt.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Announcement</th>
                  <th>Status</th>
                  <th>Attempts</th>
                  <th>Receipt</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id} className="row-link" tabIndex={0} onClick={() => setOpen(j)} onKeyDown={(e) => e.key === 'Enter' && setOpen(j)}>
                    <td className="title">
                      <span style={{ fontWeight: 600 }}>{j.headline}</span>
                      <div className="muted small">
                        {j.jurisdiction} · revision {j.revision}
                      </div>
                    </td>
                    <td>
                      <PublicationChip status={j.status} />
                    </td>
                    <td className="num">
                      {j.attempts} / {j.maxAttempts}
                    </td>
                    <td className="num">{j.externalRef ?? '—'}</td>
                    <td className="muted nowrap">{ago(j.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {s.config?.demo && <WireControls jurisdictions={s.config.jurisdictions} />}

      <Modal open={!!open} onClose={() => setOpen(null)} title="Delivery details" drawer>
        {open && (
          <>
            <div className="row wrap">
              <PublicationChip status={open.status} />
              <span className="muted small">{publicationState(open.status).label === 'Failed' ? 'Gave up after the allowed attempts' : ''}</span>
            </div>
            <h3>{open.headline}</h3>
            <dl className="kv">
              <dt>Destination</dt>
              <dd>{channelOf(open.jurisdiction)} (mock)</dd>
              <dt>Revision</dt>
              <dd>{open.revision}</dd>
              <dt>Attempts</dt>
              <dd>
                {open.attempts} of {open.maxAttempts}
              </dd>
              {open.status === 'retry' && (
                <>
                  <dt>Next attempt</dt>
                  <dd>{when(open.nextAttemptAt)}</dd>
                </>
              )}
              <dt>Receipt</dt>
              <dd>
                {open.externalRef ? (
                  <span className="row">
                    <strong className="num">{open.externalRef}</strong> <CopyButton text={open.externalRef} />
                  </span>
                ) : (
                  'Not issued'
                )}
              </dd>
              <dt>Last error</dt>
              <dd>{open.lastError ?? 'None'}</dd>
              <dt>Created</dt>
              <dd>{when(open.createdAt)}</dd>
              <dt>Updated</dt>
              <dd>{when(open.updatedAt)}</dd>
            </dl>
            {IN_PROGRESS.includes(open.status) && (
              <Banner tone="info">
                {open.status === 'retry' ? 'Delivery is being retried automatically with a growing delay.' : 'Delivery is in progress.'} Before every attempt the worker asks the provider whether it already has this
                announcement.
              </Banner>
            )}
            <div className="row wrap">
              <Link className="btn secondary" to={`/app/announcements/${open.announcementId}`}>
                Open announcement
              </Link>
              {IN_PROGRESS.includes(open.status) && (
                <button type="button" className="btn secondary" onClick={() => void load()}>
                  Check status
                </button>
              )}
              {FAILED.includes(open.status) && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => setAct({ kind: 'retry', id: open.announcementId, headline: open.headline, jurisdiction: open.jurisdiction })}
                >
                  Retry…
                </button>
              )}
            </div>
          </>
        )}
      </Modal>

      <Confirm
        open={!!act}
        title={act?.kind === 'retry' ? 'Retry publication?' : 'Publish this announcement?'}
        confirmLabel={act?.kind === 'retry' ? 'Retry' : 'Publish'}
        busy={busy}
        onClose={() => setAct(null)}
        onConfirm={confirm}
      >
        {act?.kind === 'retry' ? (
          <p>
            Retry will <strong>first check whether the provider already accepted it</strong>. Only if it did not is “{act.headline}” sent again.
          </p>
        ) : (
          <p>
            This sends “{act?.headline}” to the <strong>mock {act ? channelOf(act.jurisdiction) : ''}</strong>. It does <strong>not</strong> submit anything to a regulator.
          </p>
        )}
      </Confirm>
    </>
  );
}
