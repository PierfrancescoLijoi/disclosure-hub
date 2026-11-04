import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, errorText, publicApi, type PublicDetail as Detail } from '../api';
import { when } from '../labels';
import { Banner, Chip, CopyButton, EmptyState, Skeleton } from '../ui';
import { PublicFrame } from './PublicFrame';

export { PublicFeed } from './PublicFeed';

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
