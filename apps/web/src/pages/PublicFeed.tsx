import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { errorText, publicApi, type PublicIssuer, type PublicItem, type PublicOptions } from '../api';
import { when } from '../labels';
import { useSession } from '../session';
import { Banner, Chip, EmptyState, Skeleton } from '../ui';
import { FollowPanel } from './PublicFollow';
import { PublicFrame } from './PublicFrame';

const SEARCH_DEBOUNCE_MS = 300;
const FILTER_KEYS = ['issuer', 'jurisdiction', 'category', 'from', 'to', 'q'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

interface FeedPage {
  items: PublicItem[];
  nextCursor: string | null;
}

/** The archive: every published announcement, filterable by company, topic, date and text, with a way to follow what is filtered. */
export function PublicFeed() {
  const { config } = useSession();
  const [params, setParams] = useSearchParams();
  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ''])) as Record<FilterKey, string>;
  const { issuer, jurisdiction, category, from, to, q } = filters;
  const [typed, setTyped] = useState(q);
  const [items, setItems] = useState<PublicItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [issuers, setIssuers] = useState<PublicIssuer[]>([]);
  const [options, setOptions] = useState<PublicOptions | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    publicApi<{ items: PublicIssuer[] }>('/issuers').then((r) => setIssuers(r.items)).catch(() => undefined);
    publicApi<PublicOptions>('/options').then(setOptions).catch(() => undefined);
  }, []);

  const fetchPage = useCallback(
    async (after: string | null) => {
      const query = new URLSearchParams({ limit: '10' });
      for (const [k, v] of Object.entries({ issuer, jurisdiction, category, from, to, q })) if (v) query.set(k, v);
      if (after) query.set('cursor', after);
      return publicApi<FeedPage>(`/announcements?${query}`);
    },
    [issuer, jurisdiction, category, from, to, q],
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

  const change = useCallback(
    (changes: Partial<Record<FilterKey, string>>) => {
      const next = new URLSearchParams(params);
      for (const [k, v] of Object.entries(changes)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  // The search box types freely; the URL (and the request) follow after a pause.
  useEffect(() => {
    if (typed.trim() === q) return;
    const t = setTimeout(() => change({ q: typed.trim() }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [typed, q, change]);

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

  const jurisdictions = config?.jurisdictions ?? [];
  const categories = jurisdictions.find((j) => j.code === jurisdiction)?.categories ?? [];
  const filtered = FILTER_KEYS.some((k) => filters[k]);
  const describe =
    [issuers.find((i) => i.id === issuer)?.name, jurisdiction, categories.find((c) => c.key === category)?.label].filter(Boolean).join(' · ') || 'all announcements';

  return (
    <PublicFrame>
      <div>
        <h1>Announcements</h1>
        <p className="muted">Published announcements, newest first. Drafts and anything not yet published never appear here.</p>
      </div>
      <div className="filters">
        <div className="seg" role="group" aria-label="Jurisdiction">
          {[{ code: '', name: 'All' }, ...jurisdictions].map(({ code, name }) => (
            <button key={code} type="button" aria-pressed={jurisdiction === code} onClick={() => change({ jurisdiction: code, category: '' })}>
              {name}
            </button>
          ))}
        </div>
        <select aria-label="Company" value={issuer} onChange={(e) => change({ issuer: e.target.value })}>
          <option value="">All companies</option>
          {issuers.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
        <select aria-label="Category" value={category} disabled={!jurisdiction} title={jurisdiction ? undefined : 'Choose a jurisdiction first'} onChange={(e) => change({ category: e.target.value })}>
          <option value="">{jurisdiction ? 'All categories' : 'Category (pick a jurisdiction)'}</option>
          {categories.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
        <label className="inline-date">
          From <input type="date" value={from} max={to || undefined} onChange={(e) => change({ from: e.target.value })} />
        </label>
        <label className="inline-date">
          To <input type="date" value={to} min={from || undefined} onChange={(e) => change({ to: e.target.value })} />
        </label>
        <input type="search" aria-label="Search announcements" placeholder="Search text or company" value={typed} onChange={(e) => setTyped(e.target.value)} />
      </div>

      <FollowPanel
        filters={{ issuer: issuer || undefined, jurisdiction: jurisdiction || undefined, category: category || undefined }}
        describe={describe}
        options={options}
        demo={Boolean(options?.mailbox)}
      />

      {error && <Banner tone="bad">{error}</Banner>}
      {!items && !error && <Skeleton rows={3} />}
      {items && items.length === 0 && (
        <EmptyState
          title="No announcements found"
          action={
            filtered && (
              <button type="button" className="btn secondary" onClick={() => { setTyped(''); setParams({}, { replace: true }); }}>
                Clear filters
              </button>
            )
          }
        >
          {filtered ? 'Nothing matches those filters.' : 'Nothing has been published yet.'}
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
              {i.excerpt && <p className="excerpt">{i.excerpt}</p>}
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
