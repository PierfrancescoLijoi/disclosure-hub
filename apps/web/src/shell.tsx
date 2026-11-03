import { useEffect, useState, type FormEvent } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import type { Item, User } from './api';
import { isApprover, isAuthor, isPublisher, roleLabel } from './labels';
import { useSession } from './session';
import { Banner, Icon, Logo, Skeleton } from './ui';

/** Announcements an approver could be asked about: in review and not their own. The review inbox narrows it by approvals. */
export const reviewable = (items: Item[] | null, me: User | null) => (items ?? []).filter((i) => i.status === 'in_review' && i.createdBy !== me?.id);

/** Everything under /app needs a session; without one the person goes to the sign-in page. */
export function RequireSession() {
  const s = useSession();
  const loc = useLocation();
  if (s.phase === 'loading') {
    return (
      <div className="page" style={{ maxWidth: 720, marginTop: 64 }}>
        <Skeleton rows={3} />
      </div>
    );
  }
  if (s.phase === 'error') {
    return (
      <div className="page" style={{ maxWidth: 720, marginTop: 64 }}>
        <Banner tone="bad">Cannot reach the API: {s.error}</Banner>
        <button type="button" className="btn secondary" onClick={() => window.location.reload()}>
          Try again
        </button>
      </div>
    );
  }
  if (s.phase === 'anonymous') return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  return <AppShell />;
}

interface NavEntry {
  to: string;
  label: string;
  icon: string;
  show: boolean;
  count?: number;
  end?: boolean;
}

function AppShell() {
  const s = useSession();
  const nav = useNavigate();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const me = s.me!;
  const config = s.config!;
  const oidc = config.auth.mode === 'oidc';

  // The drawer closes on navigation and on Escape.
  useEffect(() => setOpen(false), [loc.pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const author = isAuthor(me.roles);
  const approver = isApprover(me.roles);
  const publisher = isPublisher(me.roles);
  const inbox = reviewable(s.items, me).length;
  const failed = (s.items ?? []).filter((i) => i.status === 'failed').length;

  const work: NavEntry[] = [
    { to: '/app/overview', label: 'Overview', icon: 'home', show: true },
    { to: '/app/announcements', label: 'Announcements', icon: 'doc', show: true, end: true },
    { to: '/app/review', label: 'Review inbox', icon: 'inbox', show: approver, count: inbox },
    { to: '/app/publishing', label: 'Publishing', icon: 'send', show: publisher, count: failed },
    { to: '/app/activity', label: 'Activity', icon: 'activity', show: true },
  ];
  const admin: NavEntry[] = [{ to: '/app/workspace', label: 'Workspace', icon: 'users', show: true }];

  const link = (n: NavEntry) =>
    n.show && (
      <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? 'active' : '')}>
        <Icon name={n.icon} />
        {n.label}
        {!!n.count && <span className="count" aria-label={`${n.count} waiting`}>{n.count}</span>}
      </NavLink>
    );

  const search = (e: FormEvent) => {
    e.preventDefault();
    nav(`/app/announcements${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`);
  };
  const initials = me.name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div className={`shell ${open ? 'nav-open' : ''}`}>
      <a className="skip" href="#content">Skip to content</a>
      <aside className="sidebar" aria-label="Primary">
        <div className="brand">
          <Logo />
          <span>
            Disclosure Hub
            <small>Regulatory announcements</small>
          </span>
        </div>
        <div className="company">
          <small>Company</small>
          <strong>{s.issuer?.name ?? me.issuerId}</strong>
        </div>
        <nav className="nav">
          <h6>WORK</h6>
          {work.map(link)}
          <h6>ADMIN</h6>
          {admin.map(link)}
          <h6>PUBLIC</h6>
          <Link to="/public/announcements" target="_blank" rel="noopener">
            <Icon name="globe" /> Public feed <Icon name="external" size={13} />
          </Link>
        </nav>
        <div className="foot">
          <div className="pill">
            {config.database} · {config.queue} queue · {config.role}
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button type="button" className="btn ghost menu-btn" aria-label="Open menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <Icon name="menu" />
          </button>
          <form className="search" role="search" onSubmit={search}>
            <Icon name="search" size={16} />
            <input type="search" aria-label="Search announcements" placeholder="Search announcements" value={q} onChange={(e) => setQ(e.target.value)} />
          </form>
          <span className="grow" />
          {author && (
            <Link className="btn small" to="/app/announcements/new">
              <Icon name="plus" size={16} /> New announcement
            </Link>
          )}
          {!oidc && (
            <label className="row hide-sm">
              <span className="sr-only">Acting as</span>
              <select
                value={me.id}
                onChange={(e) => {
                  s.signInAs(e.target.value);
                  nav('/app/overview');
                }}
              >
                {s.users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} · {u.roles.map(roleLabel).join(', ')}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="who">
            <span className="avatar" aria-hidden="true">{initials}</span>
            <span className="hide-sm">
              <strong>{me.name}</strong>
              <br />
              <span className="muted small">{me.roles.map(roleLabel).join(', ')}</span>
            </span>
            <button type="button" className="btn ghost small" onClick={() => { s.signOut(); }} aria-label="Sign out">
              <Icon name="signout" />
            </button>
          </div>
        </header>
        {config.demo && (
          <div className="demo-banner" role="note">
            <strong>Demo / Mock publishing</strong>
            <span>
              {config.jurisdictions.map((j) => j.code).join(' · ')} newswires are simulated: nothing here is submitted to a regulator.
            </span>
          </div>
        )}
        <main id="content" className="page" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
