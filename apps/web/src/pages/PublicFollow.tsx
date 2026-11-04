import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError, errorText, publicPost, type ConfirmedFollowing, type Following, type PublicOptions } from '../api';
import { Banner, Chip, EmptyState, Skeleton } from '../ui';
import { PublicFrame } from './PublicFrame';

const feedUrl = (f: Following) => {
  const q = new URLSearchParams();
  if (f.issuer) q.set('issuer', f.issuer);
  if (f.jurisdiction) q.set('jurisdiction', f.jurisdiction);
  if (f.category) q.set('category', f.category);
  return `/api/public/feed.atom${q.size ? `?${q}` : ''}`;
};

/** What the reader is following, in words: the same filters as the archive above it. */
export function FollowPanel({ filters, describe, options, demo }: { filters: Following; describe: string; options: PublicOptions | null; demo: boolean }) {
  const [kind, setKind] = useState<'email' | 'webhook'>('email');
  const [target, setTarget] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setState('sending');
    setError(null);
    try {
      await publicPost('/subscriptions', { kind, target: target.trim(), ...filters });
      setState('sent');
    } catch (err) {
      setError(errorText(err));
      setState('idle');
    }
  }

  if (!options) return null;
  const channels = [options.email && 'email', options.webhook && 'webhook'].filter(Boolean) as ('email' | 'webhook')[];
  return (
    <section className="card follow" aria-labelledby="follow-title">
      <h2 id="follow-title">Follow {describe}</h2>
      <p className="muted small">New announcements, as they are published. Nothing is sent until you confirm, and every message has a one-click way out.</p>
      <div className="row wrap" style={{ gap: 8, margin: '10px 0' }}>
        <a className="btn secondary" href={feedUrl(filters)}>
          Atom feed
        </a>
        {demo && (
          <Link className="btn secondary" to="/public/mailbox">
            Demo mailbox
          </Link>
        )}
      </div>
      {channels.length > 0 && state !== 'sent' && (
        <form onSubmit={submit}>
          {channels.length > 1 && (
            <div className="seg" role="group" aria-label="How to be told" style={{ marginBottom: 10 }}>
              {channels.map((c) => (
                <button key={c} type="button" aria-pressed={kind === c} onClick={() => { setKind(c); setTarget(''); }}>
                  {c === 'email' ? 'Email' : 'Webhook'}
                </button>
              ))}
            </div>
          )}
          <label className="field">
            <span>{kind === 'email' ? 'Email address' : 'Webhook URL (https)'}</span>
            <input
              type={kind === 'email' ? 'email' : 'url'}
              required
              autoComplete={kind === 'email' ? 'email' : 'off'}
              placeholder={kind === 'email' ? 'you@example.com' : 'https://example.com/hooks/announcements'}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
          </label>
          {error && <Banner tone="bad">{error}</Banner>}
          <button type="submit" className="btn" disabled={state === 'sending'}>
            {state === 'sending' ? 'Sending…' : 'Follow'}
          </button>
        </form>
      )}
      {state === 'sent' && (
        <Banner tone="ok">
          {kind === 'email' ? 'If the address is valid, a confirmation is on its way. Open the link in it to start.' : 'We posted a confirmation to your endpoint. Its payload carries the link; open it to start.'}
        </Banner>
      )}
    </section>
  );
}

function useToken(): string {
  return useSearchParams()[0].get('token') ?? '';
}

function describeFilters({ filters: f, issuerName }: ConfirmedFollowing) {
  const parts = [issuerName, f.jurisdiction, f.category?.replace(/_/g, ' ')].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'all announcements';
}

/** A person opens the link; only their click on the button changes anything, so mail scanners that prefetch links do nothing. */
export function PublicConfirm() {
  const token = useToken();
  const [done, setDone] = useState<ConfirmedFollowing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    try {
      setDone(await publicPost<ConfirmedFollowing>('/subscriptions/confirm', { token }));
    } catch (e) {
      setError(e instanceof ApiError && e.status === 410 ? 'This subscription was cancelled. Subscribe again from the announcements page.' : errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PublicFrame>
      <h1>Confirm your subscription</h1>
      {!token && <Banner tone="bad">This link is incomplete. Open it from the message we sent.</Banner>}
      {error && <Banner tone="bad">{error}</Banner>}
      {done ? (
        <Banner tone="ok">
          You are subscribed to {describeFilters(done)}. Every message has a link to leave.
        </Banner>
      ) : (
        token &&
        !error && (
          <>
            <p className="muted">Start receiving regulatory announcements at the address that received the message.</p>
            <button type="button" className="btn" disabled={busy} onClick={confirm}>
              {busy ? 'Confirming…' : 'Confirm subscription'}
            </button>
          </>
        )
      )}
      <p>
        <Link to="/public/announcements">← All announcements</Link>
      </p>
    </PublicFrame>
  );
}

export function PublicUnsubscribe() {
  const token = useToken();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function leave() {
    setBusy(true);
    try {
      await publicPost('/subscriptions/unsubscribe', { token });
      setDone(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PublicFrame>
      <h1>Stop receiving announcements</h1>
      {!token && <Banner tone="bad">This link is incomplete. Open it from the message we sent.</Banner>}
      {error && <Banner tone="bad">{error}</Banner>}
      {done ? (
        <Banner tone="ok">Done. Nothing more will be sent, and the address has been erased from our records.</Banner>
      ) : (
        token && (
          <>
            <p className="muted">This ends this subscription only and erases the address you used for it.</p>
            <button type="button" className="btn" disabled={busy} onClick={leave}>
              {busy ? 'Working…' : 'Unsubscribe'}
            </button>
          </>
        )
      )}
      <p>
        <Link to="/public/announcements">← All announcements</Link>
      </p>
    </PublicFrame>
  );
}

interface Mail {
  to: string;
  subject: string;
  text: string;
}
const APP_LINK = /https?:\/\/[^\s/]+(\/public\/(?:confirm|unsubscribe)\?token=[^\s]+)/g;

/** Demo only: the server writes mail to a log instead of sending it, so this is where it lands. */
export function PublicMailbox() {
  const [mails, setMails] = useState<Mail[] | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    const load = () =>
      fetch('/api/dev/mailbox')
        .then((r) => (r.ok ? r.json() : Promise.reject(new ApiError(r.status, 'ERROR', 'no mailbox'))))
        .then((d: { messages: Mail[] }) => setMails(d.messages))
        .catch(() => setMissing(true));
    void load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);

  return (
    <PublicFrame>
      <h1>Demo mailbox</h1>
      <p className="muted">Messages this demo would have emailed. Confirmation and unsubscribe links open in this app.</p>
      {missing && <EmptyState title="No demo mailbox here">Mail is sent for real in this deployment.</EmptyState>}
      {!mails && !missing && <Skeleton rows={2} />}
      {mails && mails.length === 0 && <EmptyState title="Nothing sent yet">Follow something, and the confirmation arrives here.</EmptyState>}
      {mails?.map((m, i) => (
        <article key={i} className="card">
          <div className="row wrap" style={{ gap: 8 }}>
            <Chip>to {m.to}</Chip>
            <strong>{m.subject}</strong>
          </div>
          <pre className="mail">{m.text}</pre>
          <div className="row wrap" style={{ gap: 8 }}>
            {[...m.text.matchAll(APP_LINK)].map((l) => (
              <Link key={l[1]} className="btn secondary" to={l[1]!}>
                {l[1]!.includes('confirm') ? 'Open confirmation' : 'Open unsubscribe'}
              </Link>
            ))}
          </div>
        </article>
      ))}
    </PublicFrame>
  );
}
