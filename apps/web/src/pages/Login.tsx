import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { errorText } from '../api';
import { roleLabel } from '../labels';
import { useSession } from '../session';
import { Banner, Logo, Skeleton } from '../ui';

const POINTS = [
  'One governed path from draft to published, for the UK (RNS) and the US (EDGAR).',
  'Maker-checker approval bound to the exact text that was approved.',
  'Publishing that survives a dropped acknowledgement: no duplicates, a full audit trail.',
];

/** Where the OIDC redirect lands (`/`): wait for the session, then go to the app or to sign-in. */
export function Landing() {
  const s = useSession();
  if (s.phase === 'ready') return <Navigate to="/app/overview" replace />;
  if (s.phase === 'anonymous') return <Navigate to="/login" replace />;
  if (s.phase === 'error') return <Navigate to="/login" replace />;
  return (
    <div className="page" style={{ maxWidth: 520, marginTop: 80 }}>
      <Skeleton rows={2} />
    </div>
  );
}

export function Login() {
  const s = useSession();
  const nav = useNavigate();
  const loc = useLocation();
  const [problem, setProblem] = useState<string | null>(null);
  const from = (loc.state as { from?: string } | null)?.from ?? '/app/overview';

  if (s.phase === 'ready') return <Navigate to={from} replace />;
  const oidc = s.config?.auth.mode === 'oidc';

  return (
    <div className="login">
      <section className="hero">
        <div className="row" style={{ color: '#fff', fontWeight: 700, gap: 12 }}>
          <Logo size={36} /> SignalFlow IR
        </div>
        <h1>Regulatory announcements, from draft to published.</h1>
        <ul style={{ color: '#b8c3de', paddingLeft: 18, display: 'grid', gap: 8, maxWidth: '34em' }}>
          {POINTS.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
        <p className="small">
          <Link to="/public/announcements" style={{ color: '#cbd2ff' }}>
            Read the public announcements feed →
          </Link>
        </p>
      </section>

      <section className="panel">
        <div className="box">
          <h1>Sign in</h1>
          {s.phase === 'loading' && <Skeleton rows={3} />}
          {s.phase === 'error' && <Banner tone="bad">Cannot reach the API: {s.error}</Banner>}
          {problem && <Banner tone="bad">{problem}</Banner>}

          {s.phase === 'anonymous' && oidc && (
            <>
              <p className="muted">Use your company account. Your roles come from the identity provider.</p>
              <button
                type="button"
                className="btn wide"
                onClick={() => s.signInWithProvider().catch((e) => setProblem(errorText(e)))}
              >
                Continue with your company account
              </button>
            </>
          )}

          {s.phase === 'anonymous' && !oidc && (
            <>
              <Banner tone="warn">
                <strong>Demo mode.</strong> Pick a seeded persona. Production deployments sign in through the identity provider instead.
              </Banner>
              <ul className="persona">
                {s.users.map((u) => (
                  <li key={u.id}>
                  <button
                    type="button"
                    className="persona-btn"
                    onClick={() => {
                      s.signInAs(u.id);
                      nav(from, { replace: true });
                    }}
                  >
                    <span className="avatar" aria-hidden="true">
                      {u.name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('')}
                    </span>
                    <span>
                      <strong>{u.name}</strong>
                      <br />
                      <span className="muted small">{u.roles.map(roleLabel).join(', ')}</span>
                    </span>
                  </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
