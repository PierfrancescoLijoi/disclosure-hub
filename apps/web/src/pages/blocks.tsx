import { useMemo, useState } from 'react';
import type { Approval, AuditEvent, Issue, PreCheck, PublicationView, Revision, View } from '../api';
import { diffWords, hasChanges } from '../diff';
import { auditText, roleLabel, when } from '../labels';
import { useSession } from '../session';
import { Chip, CopyButton, PublicationChip } from '../ui';
import type { AuditTrail } from '../useAnnouncement';

// ------------------------------------------------------------------ revision diff
export function Diff({ before, after }: { before: string; after: string }) {
  const pieces = useMemo(() => diffWords(before, after), [before, after]);
  if (!hasChanges(pieces)) return <div className="diff muted">No change.</div>;
  return (
    <div className="diff">
      {pieces.map((p, k) =>
        p.kind === 'add' ? (
          <ins key={k} aria-label="added">{p.text}</ins>
        ) : p.kind === 'del' ? (
          <del key={k} aria-label="removed">{p.text}</del>
        ) : (
          <span key={k}>{p.text}</span>
        ),
      )}
    </div>
  );
}

const pretty = (m: Record<string, unknown>) => (Object.keys(m).length ? JSON.stringify(m, null, 2) : '');

/** Compares two revisions: headline, body and jurisdiction details, each as inline word-level changes. */
export function RevisionCompare({ before, after }: { before: Revision; after: Revision }) {
  const s = useSession();
  return (
    <div className="stack">
      <div className="muted small">
        Revision {before.number} by {s.name(before.authorId)} → revision {after.number} by {s.name(after.authorId)}
      </div>
      <section>
        <h4>Headline</h4>
        <Diff before={before.headline} after={after.headline} />
      </section>
      <section>
        <h4>Body</h4>
        <Diff before={before.body} after={after.body} />
      </section>
      {(pretty(before.metadata) || pretty(after.metadata)) && (
        <section>
          <h4>Details</h4>
          <pre>
            <Diff before={pretty(before.metadata)} after={pretty(after.metadata)} />
          </pre>
        </section>
      )}
    </div>
  );
}

/** Revision history with the newest change shown against its predecessor. */
export function RevisionHistory({ revisions, current }: { revisions: Revision[]; current: number }) {
  const [picked, setPicked] = useState<number | null>(null);
  const sorted = [...revisions].sort((a, b) => b.number - a.number);
  const shown = sorted.find((r) => r.number === (picked ?? current)) ?? sorted[0];
  const previous = shown && sorted.find((r) => r.number === shown.number - 1);
  if (!shown) return null;
  return (
    <section className="card" aria-labelledby="rev-h">
      <div className="card-head">
        <h3 id="rev-h">Revision history</h3>
        {sorted.length > 1 && (
          <label className="row small">
            <span className="muted">Compare</span>
            <select value={shown.number} onChange={(e) => setPicked(Number(e.target.value))} aria-label="Revision to compare with its predecessor">
              {sorted.map((r) => (
                <option key={r.number} value={r.number}>
                  Revision {r.number}{r.number === current ? ' (current)' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {previous ? <RevisionCompare before={previous} after={shown} /> : <p className="muted">Revision {shown.number} is the first version: nothing to compare yet.</p>}
    </section>
  );
}

// ------------------------------------------------------------------ approvals
export function ApprovalsCard({ view }: { view: View }) {
  const s = useSession();
  const req = view.announcement.approvalRequirement;
  if (!req && view.approvals.length === 0) return null;
  const live = view.approvals.filter((a) => a.decision === 'approve' && !a.voidedAt && a.revision === view.announcement.currentRevision);
  return (
    <section className="card" aria-labelledby="appr-h">
      <div className="card-head">
        <h3 id="appr-h">Approvals</h3>
        {req && (
          <Chip tone={live.length >= req.min ? 'ok' : 'brand'} icon={live.length >= req.min ? '✓' : '◐'}>
            {live.length} of {req.min}
          </Chip>
        )}
      </div>
      {req && (
        <p className="muted small">
          Needs {req.min} different approver{req.min === 1 ? '' : 's'}
          {req.mustInclude.length > 0 && <>, including {req.mustInclude.map(roleLabel).join(' and ')}</>}. An approval is tied to the exact text of revision{' '}
          {view.announcement.currentRevision}; editing it voids earlier approvals. The author cannot approve their own revision.
        </p>
      )}
      <ul className="checklist">
        {view.approvals.length === 0 && <li className="muted">No decisions yet.</li>}
        {view.approvals.map((a: Approval) => (
          <li key={a.id} className={a.decision === 'approve' && !a.voidedAt ? 'done' : 'todo'}>
            <span className="mark" aria-hidden="true">{a.decision === 'approve' ? '✓' : '✎'}</span>
            <span>
              <strong>{s.name(a.approverId)}</strong>{' '}
              <span className="muted small">
                {a.roles.map(roleLabel).join(', ')} · revision {a.revision} · {when(a.at)}
              </span>
              <br />
              {a.decision === 'approve' ? 'Approved' : 'Requested changes'}
              {a.voidedAt && <span className="muted"> · voided: the text changed afterwards</span>}
              {a.comment && <q style={{ display: 'block' }}>{a.comment}</q>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ------------------------------------------------------------------ publication
export function PublicationCard({ view }: { view: View }) {
  const p: PublicationView | null = view.publication;
  const s = useSession();
  const j = s.config?.jurisdictions.find((x) => x.code === view.announcement.jurisdiction);
  if (!p) return null;
  const published = p.status === 'acked' && p.externalRef;
  return (
    <section className="card" aria-labelledby="pub-h">
      <div className="card-head">
        <h3 id="pub-h">Publication</h3>
        <PublicationChip status={p.status} />
      </div>
      <p className="muted small">
        Attempt {p.attempts} of {p.maxAttempts}
        {p.status === 'retry' && <> · next try {when(p.nextAttemptAt)}</>}
      </p>
      {p.status === 'exhausted' || p.status === 'rejected' ? (
        <p>
          Failed. <strong>Retry will first check whether the provider already accepted it</strong>, so it cannot publish twice.
        </p>
      ) : null}
      {published && (
        <div className="banner ok">
          <div className="row between wrap">
            <span>
              Accepted by the mock {j?.channel.name ?? 'provider'} (Demo)
              <br />
              <strong className="num">{p.externalRef}</strong>
            </span>
            <CopyButton text={p.externalRef!} label="Copy receipt" />
          </div>
          {p.ack?.filingDate && <div className="small">Filing date {String(p.ack.filingDate)}</div>}
        </div>
      )}
      {p.lastError && <p className="muted small">Last error: {p.lastError}</p>}
      {view.obligations.length > 0 && (
        <>
          <h4 style={{ marginTop: 12 }}>Follow-up duties</h4>
          <ul>
            {view.obligations.map((o) => (
              <li key={o}>{o}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ validation
export function IssueList({ issues, title = 'Validation' }: { issues: Issue[]; title?: string }) {
  if (issues.length === 0) return null;
  return (
    <section className="card" aria-labelledby="val-h">
      <h3 id="val-h">{title}</h3>
      <ul className="issues" style={{ marginTop: 10 }}>
        {issues.map((i, k) => (
          <li key={k} className={i.severity}>
            <strong>{i.severity === 'error' ? 'Error' : 'Warning'} · {i.code}</strong> {i.message}
            {i.path && <span className="muted"> · {i.path}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ------------------------------------------------------------------ timeline
const eventTone = (t: string) => (/failed|rejected|changes_requested/.test(t) ? 'tone-bad' : /^published$|approved/.test(t) ? 'tone-ok' : '');

export function Timeline({ audit }: { audit: AuditTrail | null }) {
  const s = useSession();
  if (!audit) return null;
  return (
    <section className="card" aria-labelledby="tl-h">
      <div className="card-head">
        <h3 id="tl-h">Timeline</h3>
        <Chip tone={audit.chain.ok ? 'ok' : 'bad'} icon={audit.chain.ok ? '✓' : '!'}>
          {audit.chain.ok ? 'Audit chain verified' : `Chain broken at #${audit.chain.brokenAtSeq}`}
        </Chip>
      </div>
      <ol className="timeline">
        {[...audit.events].reverse().map((e: AuditEvent) => (
          <li key={e.seq} className={eventTone(e.type)}>
            <div className="what">{auditText(e.type)}</div>
            <div className="muted small">
              {s.name(e.actorId)} · {when(e.at)}
            </div>
            {typeof e.data?.comment === 'string' && e.data.comment && <q style={{ display: 'block' }}>{e.data.comment}</q>}
            <details>
              <summary>Technical details #{e.seq}</summary>
              <pre>{JSON.stringify(e.data, null, 2)}</pre>
              <div className="muted small">hash {e.hash.slice(0, 16)}…</div>
            </details>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ------------------------------------------------------------------ AI pre-check
export function PreCheckView({ pre, draftCategory }: { pre: PreCheck; draftCategory: string }) {
  const { classification: c, missingInformation: missing, risks } = pre.report;
  return (
    <>
      <p>
        Suggested category <strong>{c.suggestedCategory}</strong> ({Math.round(c.confidence * 100)}% confidence){' '}
        {!pre.categoryMatchesDraft && <Chip tone="warn" icon="!">differs from draft ({draftCategory})</Chip>}
        <br />
        <span className="muted">{c.rationale}</span>
      </p>
      {risks.length > 0 && (
        <ul className="issues">
          {risks.map((r) => (
            <li key={r.code} className={r.severity === 'high' ? 'error' : 'warning'}>
              <strong>{r.regime.replace('_', ' ')} · {r.code}</strong> ({r.severity})
              <br />
              {r.explanation}
              {r.evidence && (
                <>
                  <br />
                  <em>“{r.evidence}”</em>
                </>
              )}
              <br />
              <span className="muted">Suggested: {r.suggestedAction}</span>
            </li>
          ))}
        </ul>
      )}
      {missing.length > 0 && (
        <>
          <h4 style={{ marginTop: 12 }}>Possibly missing</h4>
          <ul>
            {missing.map((m) => (
              <li key={m.field}>
                <strong>{m.field}</strong>: {m.why}
              </li>
            ))}
          </ul>
        </>
      )}
      {risks.length === 0 && missing.length === 0 && <p className="muted">Nothing flagged.</p>}
      <p className="muted small">{pre.report.disclaimer}</p>
    </>
  );
}
