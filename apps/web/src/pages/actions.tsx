import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorText, type Issue, type View } from '../api';
import { isApprover } from '../labels';
import { useSession } from '../session';
import { Banner, Confirm, useToast } from '../ui';

type Dialog = 'approve' | 'request_changes' | 'publish' | 'retry' | 'reopen' | 'withdraw' | null;

const DONE_TEXT: Record<string, string> = {
  validate: 'Validated',
  submit: 'Submitted for review',
  approve: 'Approved',
  request_changes: 'Changes requested',
  publish: 'Publication requested',
  retry: 'Retry requested',
  reopen: 'Reopened as draft',
  withdraw: 'Withdrawn',
};

interface Props {
  view: View;
  /** Called after every successful action so the page reloads. */
  onChanged: () => Promise<void> | void;
  /** Validation problems from a stopped submit or a validate run. */
  onIssues?: (issues: Issue[] | null) => void;
  /** The review room lays out approve / request changes itself, so it can hide the rest. */
  only?: string[];
}

/** Every workflow action for one announcement, each behind the confirmation its consequences deserve. */
export function ActionBar({ view, onChanged, onIssues, only }: Props) {
  const s = useSession();
  const toast = useToast();
  const me = s.me!;
  const a = view.announcement;
  const channel = s.config?.jurisdictions.find((j) => j.code === a.jurisdiction)?.channel.name ?? 'provider';
  const [dialog, setDialog] = useState<Dialog>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A second approval from the same person adds nothing, so the enabled button is replaced by the explained, disabled one.
  const approvedAlready =
    a.status === 'in_review' && view.approvals.some((x) => x.approverId === me.id && x.decision === 'approve' && !x.voidedAt && x.revision === a.currentRevision);
  const allowed = (x: string) => view.actions.includes(x) && (!only || only.includes(x)) && !(x === 'approve' && approvedAlready);

  async function run(action: string, withComment = false) {
    setBusy(true);
    setError(null);
    try {
      const res = await api('POST', `/announcements/${a.id}/${action.replace('_', '-')}`, {
        comment: withComment ? comment.trim() : '',
        revision: a.currentRevision,
      });
      if (action === 'validate' || action === 'submit') {
        const v = res.data?.view?.validation;
        onIssues?.(v ? v.issues : null);
      }
      if (res.status === 422) {
        toast('Submit stopped: validation found problems', 'bad');
      } else {
        toast(DONE_TEXT[action] ?? 'Done');
      }
      setDialog(null);
      setComment('');
      await onChanged();
      await s.refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const close = () => {
    setDialog(null);
    setComment('');
    setError(null);
  };

  // Maker-checker: say why Approve is unavailable instead of silently hiding it.
  const own = a.status === 'in_review' && isApprover(me.roles) && !view.actions.includes('approve') && (view.revision.authorId === me.id || a.createdBy === me.id);
  const approveBlocked = own ? 'You wrote this revision, so you cannot approve it. Another approver must.' : approvedAlready ? 'You have already approved this revision.' : null;

  const btn = (action: string, label: string, kind: 'primary' | 'secondary' | 'danger', open?: Dialog) =>
    allowed(action) && (
      <button
        key={action}
        type="button"
        className={`btn ${kind === 'primary' ? '' : kind}`}
        disabled={busy}
        onClick={() => (open ? setDialog(open) : void run(action))}
      >
        {label}
      </button>
    );

  const nothing = view.actions.length === 0 && !approveBlocked;

  return (
    <div className="stack">
      <div className="row wrap">
        {allowed('edit') && (
          <Link className="btn secondary" to={`/app/announcements/${a.id}/edit`}>
            Edit
          </Link>
        )}
        {btn('validate', 'Validate', 'secondary')}
        {btn('submit', 'Submit for review', 'primary')}
        {btn('approve', 'Approve…', 'primary', 'approve')}
        {approveBlocked && (!only || only.includes('approve')) && (
          <button type="button" className="btn" disabled aria-describedby="approve-why">
            Approve…
          </button>
        )}
        {btn('request_changes', 'Request changes…', 'secondary', 'request_changes')}
        {btn('publish', 'Publish…', 'primary', 'publish')}
        {btn('retry', 'Retry publication…', 'primary', 'retry')}
        {btn('reopen', 'Reopen as draft…', 'secondary', 'reopen')}
        {btn('withdraw', 'Withdraw…', 'danger', 'withdraw')}
        {nothing && <span className="muted">Nothing for {me.name} to do in this state.</span>}
      </div>
      {approveBlocked && (
        <p id="approve-why" className="muted small">
          {approveBlocked}
        </p>
      )}
      {error && !dialog && <Banner tone="bad">{error}</Banner>}

      <Confirm open={dialog === 'approve'} title="Approve this revision?" confirmLabel="Approve" busy={busy} onClose={close} onConfirm={() => run('approve', true)}>
        <p>
          Your approval is recorded against revision {a.currentRevision} exactly as it reads now. If the author edits it, your approval no longer counts.
        </p>
        <label className="field">
          <span>Comment (optional)</span>
          <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
        </label>
        {error && <Banner tone="bad">{error}</Banner>}
      </Confirm>

      <Confirm
        open={dialog === 'request_changes'}
        title="Request changes"
        confirmLabel="Send back to the author"
        busy={busy}
        canConfirm={comment.trim().length > 0}
        onClose={close}
        onConfirm={() => run('request_changes', true)}
      >
        <p>The announcement goes back to draft with your reason attached. Existing approvals are voided.</p>
        <label className="field">
          <span>What needs to change? (required)</span>
          <textarea rows={4} value={comment} onChange={(e) => setComment(e.target.value)} required aria-required="true" />
        </label>
        {error && <Banner tone="bad">{error}</Banner>}
      </Confirm>

      <Confirm open={dialog === 'publish'} title="Publish this announcement?" confirmLabel="Publish" busy={busy} onClose={close} onConfirm={() => run('publish')}>
        <p>
          This sends revision {a.currentRevision} to the <strong>mock {channel}</strong>. It does <strong>not</strong> submit anything to a regulator. If the first attempt fails, delivery is
          retried automatically and never duplicated.
        </p>
        {error && <Banner tone="bad">{error}</Banner>}
      </Confirm>

      <Confirm open={dialog === 'retry'} title="Retry publication?" confirmLabel="Retry" busy={busy} onClose={close} onConfirm={() => run('retry')}>
        <p>
          Retry will <strong>first check whether the provider already accepted it</strong>. Only if it did not, the announcement is sent again, so a lost acknowledgement cannot cause a double publication.
        </p>
        {a.failureReason && <Banner tone="warn">Last failure: {a.failureReason}</Banner>}
        {error && <Banner tone="bad">{error}</Banner>}
      </Confirm>

      <Confirm open={dialog === 'reopen'} title="Reopen as draft?" confirmLabel="Reopen" busy={busy} onClose={close} onConfirm={() => run('reopen', true)}>
        <p>The announcement returns to draft so it can be edited. Approvals so far are voided.</p>
        <label className="field">
          <span>Reason (optional)</span>
          <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
        </label>
        {error && <Banner tone="bad">{error}</Banner>}
      </Confirm>

      <Confirm
        open={dialog === 'withdraw'}
        title="Withdraw this announcement?"
        confirmLabel="Withdraw"
        danger
        busy={busy}
        canConfirm={comment.trim().length > 0}
        onClose={close}
        onConfirm={() => run('withdraw', true)}
      >
        <p>It leaves the workflow and cannot be published. The record and its audit trail are kept.</p>
        <label className="field">
          <span>Reason (required)</span>
          <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} required aria-required="true" />
        </label>
        {error && <Banner tone="bad">{error}</Banner>}
      </Confirm>
    </div>
  );
}
