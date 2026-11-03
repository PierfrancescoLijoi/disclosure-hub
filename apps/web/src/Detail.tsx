import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type AuditEvent, type Config, type Issue, type PreCheck, type User, type View } from './api';
import { Editor } from './Editor';

const ACTION_LABEL: Record<string, string> = {
  edit: 'Edit',
  validate: 'Validate',
  submit: 'Submit for review',
  approve: 'Approve',
  request_changes: 'Request changes',
  publish: 'Publish',
  retry: 'Retry publication',
  reopen: 'Reopen as draft',
  withdraw: 'Withdraw',
};
const PRIMARY = new Set(['validate', 'submit', 'approve', 'publish', 'retry']);
const when = (iso: string) => new Date(iso).toLocaleString();

interface Props {
  id: string;
  config: Config;
  me: User;
  userNames: Record<string, string>;
  onChanged: () => void;
}

export function Detail({ id, config, me, userNames, onChanged }: Props) {
  const [view, setView] = useState<View | null>(null);
  const [audit, setAudit] = useState<{ events: AuditEvent[]; chain: { ok: boolean; brokenAtSeq?: number } } | null>(null);
  const [pre, setPre] = useState<PreCheck | null>(null);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setView((await api<View>('GET', `/announcements/${id}`)).data);
      setAudit((await api('GET', `/announcements/${id}/audit`)).data);
      if (config.ai) setPre((await api('GET', `/announcements/${id}/precheck`)).data.result);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }, [id, config.ai]);

  useEffect(() => {
    setView(null); setIssues(null); setError(null); setEditing(false); setPre(null);
    void reload();
  }, [reload, me.id]);

  const status = view?.announcement.status;
  useEffect(() => {
    if (status !== 'publishing') return;
    const t = setInterval(() => { void reload(); onChanged(); }, 700);
    return () => clearInterval(t);
  }, [status, reload, onChanged]);

  async function act(action: string) {
    setBusy(true); setError(null);
    try {
      const res = await api('POST', `/announcements/${id}/${action.replace('_', '-')}`, { comment, revision: view?.announcement.currentRevision });
      const report = res.data?.report ?? res.data?.view?.validation;
      setIssues(action === 'validate' || action === 'submit' ? report?.issues ?? [] : null);
      if (res.status === 422) setError('Submit stopped: validation found new problems.');
      setComment('');
      await reload();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? `${e.message} (${e.code})` : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function runPreCheck() {
    setBusy(true); setError(null);
    try {
      setPre((await api<PreCheck>('POST', `/announcements/${id}/precheck`)).data);
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!view) return <div className="card">{error ?? 'Loading…'}</div>;
  const { announcement: a, revision: r, publication: p, timing } = view;
  const j = config.jurisdictions.find((x) => x.code === a.jurisdiction)!;
  const shownIssues = issues ?? view.validation?.issues ?? [];
  const needsComment = view.actions.some((x) => ['request_changes', 'reopen', 'withdraw'].includes(x));

  if (editing) {
    return (
      <Editor
        jurisdictions={config.jurisdictions}
        locked
        initial={{ jurisdiction: a.jurisdiction, category: a.category, headline: r.headline, body: r.body, metadata: r.metadata }}
        submitLabel="Save as new revision"
        onCancel={() => setEditing(false)}
        onSubmit={async (d) => {
          try {
            await api('PUT', `/announcements/${id}/revision`, { headline: d.headline, body: d.body, metadata: d.metadata, expectedVersion: a.version });
            setEditing(false); setIssues(null);
            await reload(); onChanged();
          } catch (e) {
            setError(e instanceof ApiError ? e.message : String(e));
          }
        }}
      />
    );
  }

  return (
    <div className="detail">
      <section className="card">
        <div className="row between">
          <div>
            <span className={`chip st-${a.status}`}>{a.status.replace('_', ' ')}</span>{' '}
            <span className="chip">{a.jurisdiction} · {j.channel.name}</span>{' '}
            <span className="chip">{j.categories.find((c) => c.key === a.category)?.label}</span>
          </div>
          <span className="muted">revision {r.number} · <code title={r.contentHash}>{r.contentHash.slice(0, 10)}</code></span>
        </div>
        <h2>{r.headline}</h2>
        <pre className="body">{r.body}</pre>
        {Object.keys(r.metadata).length > 0 && <details><summary>Jurisdiction details</summary><pre>{JSON.stringify(r.metadata, null, 2)}</pre></details>}
        {a.failureReason && <p className="banner bad"><strong>Publication failed:</strong> {a.failureReason}</p>}
        {timing && (
          <p className="muted">
            {timing.deadline && (timing.deadline.at
              ? <>Deadline: <strong className={timing.overdue ? 'bad-text' : ''}>{when(timing.deadline.at)}</strong> ({timing.deadline.basis}). </>
              : <>Deadline: <strong>{timing.deadline.basis}</strong>. </>)}
            {j.channel.name} is {timing.window.open ? 'open' : `closed until ${timing.window.nextOpenAt ? when(timing.window.nextOpenAt) : '?'}`}
            {config.enforceWindows ? ' (releases are held while closed).' : ' (window not enforced in this run).'}
          </p>
        )}
      </section>

      <section className="card">
        <h4>Actions <span className="muted">as {me.name}</span></h4>
        {needsComment && <input className="comment" placeholder="Comment (required for request changes)" value={comment} onChange={(e) => setComment(e.target.value)} />}
        <div className="row wrap">
          {view.actions.length === 0 && <span className="muted">No actions available to {me.name} in this state.</span>}
          {view.actions.map((act_) => act_ === 'edit'
            ? <button key={act_} className="secondary" onClick={() => setEditing(true)}>{ACTION_LABEL.edit}</button>
            : <button key={act_} disabled={busy} className={PRIMARY.has(act_) ? '' : 'secondary'} onClick={() => act(act_)}>{ACTION_LABEL[act_]}</button>)}
        </div>
        {error && <p className="banner bad">{error}</p>}
      </section>

      {shownIssues.length > 0 && (
        <section className="card">
          <h4>Validation</h4>
          <ul className="issues">
            {shownIssues.map((i, k) => (
              <li key={k} className={i.severity}><strong>{i.code}</strong> {i.message}{i.path && <span className="muted"> · {i.path}</span>}</li>
            ))}
          </ul>
        </section>
      )}
      {view.validation?.ok && shownIssues.length === 0 && <p className="banner ok">Validation passed.</p>}

      {a.approvalRequirement && (
        <section className="card">
          <h4>Approvals</h4>
          <p>Requires <strong>{a.approvalRequirement.min}</strong> distinct approver(s){a.approvalRequirement.mustInclude.length > 0 && <>, including {a.approvalRequirement.mustInclude.map((x) => <span key={x} className="chip">{x.replace('_', ' ')}</span>)}</>}. The author cannot approve.</p>
          <ul>
            {view.approvals.filter((x) => !x.voidedAt || x.decision === 'request_changes').map((x) => (
              <li key={x.id}>{x.decision === 'approve' ? '✓' : '✎'} {userNames[x.approverId] ?? x.approverId} <span className="muted">({x.roles.join(', ')}) {when(x.at)} {x.comment && `· ${x.comment}`}</span></li>
            ))}
            {view.approvals.length === 0 && <li className="muted">No approvals yet.</li>}
          </ul>
        </section>
      )}

      {p && (
        <section className="card">
          <h4>Publication</h4>
          <p>
            <span className={`chip pub-${p.status}`}>{p.status}</span> attempt {p.attempts}/{p.maxAttempts}
            {p.status === 'retry' && <> · next try {when(p.nextAttemptAt)}</>}
          </p>
          {p.externalRef && (
            <p className="banner ok">
              Acknowledged by {j.channel.name}: <strong>{p.externalRef}</strong>
              {p.ack?.filingDate && <> · filing date {p.ack.filingDate}</>}
            </p>
          )}
          {p.lastError && <p className="muted">Last error: {p.lastError}</p>}
          {view.obligations.length > 0 && (<><h5>Follow-up duties</h5><ul>{view.obligations.map((o) => <li key={o}>{o}</li>)}</ul></>)}
        </section>
      )}

      {config.ai && (
        <section className="card">
          <div className="row between">
            <h4>AI pre-check <span className="muted">advisory only · {config.ai.provider}</span></h4>
            <button className="secondary small" disabled={busy} onClick={runPreCheck}>Run pre-check</button>
          </div>
          {pre ? <PreCheckView pre={pre} draftCategory={a.category} /> : <p className="muted">Not run yet. The pre-check never approves, blocks or publishes anything.</p>}
        </section>
      )}

      <section className="card">
        <div className="row between">
          <h4>Audit trail</h4>
          {audit && <span className={`chip ${audit.chain.ok ? 'ok' : 'bad'}`}>{audit.chain.ok ? 'hash chain verified' : `chain broken at #${audit.chain.brokenAtSeq}`}</span>}
        </div>
        <table className="audit">
          <tbody>
            {audit?.events.map((e) => (
              <tr key={e.seq}>
                <td className="muted">#{e.seq}</td>
                <td><strong>{e.type.replaceAll('_', ' ')}</strong></td>
                <td>{e.actorId === 'system' ? 'system' : userNames[e.actorId] ?? e.actorId}</td>
                <td className="muted">{when(e.at)}</td>
                <td><details><summary>data</summary><pre>{JSON.stringify(e.data, null, 2)}</pre></details></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function PreCheckView({ pre, draftCategory }: { pre: PreCheck; draftCategory: string }) {
  const { classification: c, missingInformation: missing, risks } = pre.report;
  return (
    <>
      <p>
        Suggested category <strong>{c.suggestedCategory}</strong> ({Math.round(c.confidence * 100)}% confidence){' '}
        {!pre.categoryMatchesDraft && <span className="chip warn">differs from draft ({draftCategory})</span>}
        <br /><span className="muted">{c.rationale}</span>
      </p>
      {risks.length > 0 && (
        <ul className="issues">
          {risks.map((r) => (
            <li key={r.code} className={r.severity === 'high' ? 'error' : 'warning'}>
              <strong>{r.regime.replace('_', ' ')} · {r.code}</strong> ({r.severity})<br />{r.explanation}
              {r.evidence && <><br /><em>“{r.evidence}”</em></>}<br /><span className="muted">Suggested: {r.suggestedAction}</span>
            </li>
          ))}
        </ul>
      )}
      {missing.length > 0 && <><h5>Possibly missing</h5><ul>{missing.map((m) => <li key={m.field}><strong>{m.field}</strong>: {m.why}</li>)}</ul></>}
      {risks.length === 0 && missing.length === 0 && <p className="muted">Nothing flagged.</p>}
      <p className="muted small-print">{pre.report.disclaimer}</p>
    </>
  );
}
