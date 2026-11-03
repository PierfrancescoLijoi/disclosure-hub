import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, errorText, publicApi, type PublicDetail as Detail, type PublicItem } from '../api';
import { when } from '../labels';
import { useSession } from '../session';
import { Banner, Chip, CopyButton, EmptyState, Logo, Skeleton } from '../ui';

const DISCLAIMER = 'Demonstration announcement — not submitted to a regulator.';
const SEARCH_DEBOUNCE_MS = 300;

function PublicFrame({ children }: { children: ReactNode }) {
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

interface FeedPage {
  items: PublicItem[];
  nextCursor: string | null;
}

export function PublicFeed() {
  const { config } = useSession();
  const [params, setParams] = useSearchParams();
  const jurisdiction = params.get('jurisdiction') ?? '';
  const q = params.get('q') ?? '';
  const [typed, setTyped] = useState(q);
  const [items, setItems] = useState<PublicItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const generation = useRef(0);

  const fetchPage = useCallback(
    async (after: string | null) => {
      const query = new URLSearchParams({ limit: '10' });
      if (jurisdiction) query.set('jurisdiction', jurisdiction);
      if (q) query.set('q', q);
      if (after) query.set('cursor', after);
      return publicApi<FeedPage>(`/announcements?${query}`);
    },
    [jurisdiction, q],
  );

  useEffect(() => {
    const mine = ++generation.current;
    setItems(null);
    setError(null);
    fetchPage(null)
      .then((p) => {
        if (mine !== generation.current) return;
        setItems(p.items);
        setCursor(p.nextCursor);
      })
      .catch((e) => mine === generation.current && setError(errorText(e)));
  }, [fetchPage]);

  // The search box types freely; the URL (and the request) follow after a pause.
  useEffect(() => {
    if (typed === q) return;
    const t = setTimeout(() => {
      const next = new URLSearchParams(params);
      if (typed.trim()) next.set('q', typed.trim());
      else next.delete('q');
      setParams(next, { replace: true });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [typed, q, params, setParams]);

  async function loadMore() {
    if (!cursor) return;
    setMore(true);
    try {
      const p = await fetchPage(cursor);
      setItems((cur) => [...(cur ?? []), ...p.items]);
      setCursor(p.nextCursor);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setMore(false);
    }
  }

  const setJurisdiction = (code: string) => {
    const next = new URLSearchParams(params);
    if (code) next.set('jurisdiction', code);
    else next.delete('jurisdiction');
    setParams(next, { replace: true });
  };

  return (
    <PublicFrame>
      <div>
        <h1>Announcements</h1>
        <p className="muted">Published announcements, newest first. Drafts and anything not yet published never appear here.</p>
      </div>
      <div className="filters">
        <div className="seg" role="group" aria-label="Jurisdiction">
          {[{ code: '', name: 'All' }, ...(config?.jurisdictions ?? [])].map(({ code, name }) => (
            <button key={code} type="button" aria-pressed={jurisdiction === code} onClick={() => setJurisdiction(code)}>
              {name}
            </button>
          ))}
        </div>
        <input type="search" aria-label="Search announcements" placeholder="Search headline or company" value={typed} onChange={(e) => setTyped(e.target.value)} />
      </div>

      {error && <Banner tone="bad">{error}</Banner>}
      {!items && !error && <Skeleton rows={3} />}
      {items && items.length === 0 && (
        <EmptyState
          title="No announcements found"
          action={
            (jurisdiction || q) && (
              <button type="button" className="btn secondary" onClick={() => { setTyped(''); setParams({}, { replace: true }); }}>
                Clear filters
              </button>
            )
          }
        >
          {jurisdiction || q ? 'Nothing matches those filters.' : 'Nothing has been published yet.'}
        </EmptyState>
      )}
      {items && items.length > 0 && (
        <div className="feed">
          {items.map((i) => (
            <article key={i.id} className="card">
              <div className="row wrap" style={{ gap: 8 }}>
                <span className="avatar sq" aria-hidden="true">{i.issuerName.slice(0, 1)}</span>
                <strong>{i.issuerName}</strong>
                <Chip>{i.jurisdiction}</Chip>
                <Chip>{i.categoryLabel}</Chip>
                <Chip tone="ok" icon="✔">Published · Demo</Chip>
              </div>
              <h2 style={{ marginTop: 10 }}>
                <Link to={`/public/announcements/${i.id}`}>{i.headline}</Link>
              </h2>
              <p className="muted small" style={{ marginTop: 6 }}>
                <time dateTime={i.publishedAt}>{when(i.publishedAt)}</time> · {i.channelName} · receipt <span className="num">{i.receipt}</span>
              </p>
            </article>
          ))}
          {cursor && (
            <button type="button" className="btn secondary" disabled={more} onClick={loadMore}>
              {more ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      )}
    </PublicFrame>
  );
}

export function PublicDetail() {
  const { id = '' } = useParams();
  const [item, setItem] = useState<Detail | null>(null);
  const [error, setError] = useState<{ missing: boolean; text: string } | null>(null);

  useEffect(() => {
    setItem(null);
    setError(null);
    publicApi<Detail>(`/announcements/${id}`)
      .then(setItem)
      .catch((e) => setError({ missing: e instanceof ApiError && e.status === 404, text: errorText(e) }));
  }, [id]);

  return (
    <PublicFrame>
      <p>
        <Link to="/public/announcements">← All announcements</Link>
      </p>
      {error?.missing && <EmptyState title="Announcement not found">It does not exist, or it has not been published.</EmptyState>}
      {error && !error.missing && <Banner tone="bad">{error.text}</Banner>}
      {!item && !error && <Skeleton rows={3} />}
      {item && (
        <article className="reading card">
          <div className="row wrap" style={{ gap: 8 }}>
            <strong>{item.issuerName}</strong>
            <Chip>{item.jurisdiction}</Chip>
            <Chip>{item.categoryLabel}</Chip>
            <Chip tone="ok" icon="✔">Published · Demo</Chip>
          </div>
          <h1 style={{ margin: '12px 0' }}>{item.headline}</h1>
          <p className="muted small">
            <time dateTime={item.publishedAt}>{when(item.publishedAt)}</time> · {item.channelName}
            {item.filingDate && <> · filing date {item.filingDate}</>}
          </p>
          <div className="text" style={{ marginTop: 16 }}>{item.body}</div>
          <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '20px 0' }} />
          <div className="row between wrap">
            <span className="small">
              Receipt <strong className="num">{item.receipt}</strong> <span className="muted">(mock {item.channelName})</span>
            </span>
            <CopyButton text={item.receipt} label="Copy receipt" />
          </div>
        </article>
      )}
    </PublicFrame>
  );
}
