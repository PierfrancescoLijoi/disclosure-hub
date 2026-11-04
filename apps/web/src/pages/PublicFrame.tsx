import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Logo } from '../ui';

const DISCLAIMER = 'Demonstration announcement — not submitted to a regulator.';

export function PublicFrame({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="public-top">
        <Logo />
        <strong>Disclosure Hub</strong>
        <span style={{ flex: 1 }} />
        <Link to="/login">Staff sign-in</Link>
      </header>
      <main className="public-wrap">
        {children}
        <p className="muted small" role="note">
          {DISCLAIMER}
        </p>
      </main>
    </>
  );
}
