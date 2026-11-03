import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, currentUser, setCurrentUser, type Announcement, type Config, type User } from './api';
import { Detail } from './Detail';
import { Editor } from './Editor';
import { WireControls } from './WireControls';

type Item = Announcement & { headline: string };

export function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [uid, setUid] = useState(currentUser());
  const [items, setItems] = useState<Item[]>([]);
  const [selected, setSelected] = useState<string | 'new' | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  useEffect(() => {
    api<Config>('GET', '/config').then((r) => setConfig(r.data)).catch((e) => setFatal(String(e)));
    api<{ users: User[] }>('GET', '/users').then((r) => setUsers(r.data.users)).catch(() => undefined);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setItems((await api<{ items: Item[] }>('GET', '/announcements?limit=100')).data.items);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setItems([]);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh, uid]);

  const me = users.find((u) => u.id === uid);
  const userNames = useMemo(() => Object.fromEntries(users.map((u) => [u.id, u.name])), [users]);

  if (fatal) return <div className="card">Cannot reach the API: {fatal}</div>;
  if (!config) return <div className="card">Loading…</div>;

  return (
    <div className="app">
      <header>
        <div>
          <strong>Disclosure Hub</strong>
          <span className="muted"> regulatory announcements · {config.jurisdictions.map((j) => j.code).join(' + ')}</span>
        </div>
        <div className="row">
          <span className="chip" title="Infrastructure adapters in use">{config.database} · {config.queue} queue · {config.role}</span>
          <label className="who">
            Acting as{' '}
            <select value={uid} onChange={(e) => { setCurrentUser(e.target.value); setUid(e.target.value); setSelected(null); }}>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </label>
        </div>
      </header>

      <main>
        <aside>
          <button className="wide" onClick={() => setSelected('new')} disabled={!me?.roles.includes('author')} title={me?.roles.includes('author') ? '' : 'Only authors can draft'}>
            + New announcement
          </button>
          <ul className="list">
            {items.map((i) => (
              <li key={i.id} className={selected === i.id ? 'on' : ''} onClick={() => setSelected(i.id)}>
                <span className={`chip st-${i.status}`}>{i.status.replace('_', ' ')}</span>
                <span className="chip">{i.jurisdiction}</span>
                <div className="title">{i.headline}</div>
                <div className="muted small-print">{new Date(i.updatedAt).toLocaleString()}</div>
              </li>
            ))}
            {items.length === 0 && <li className="muted empty">Nothing yet for {me?.name ?? 'this user'}'s company.</li>}
          </ul>
        </aside>

        <section className="pane">
          {selected === 'new' && me && (
            <Editor
              jurisdictions={config.jurisdictions}
              submitLabel="Create draft"
              onCancel={() => setSelected(null)}
              onSubmit={async (d) => {
                const res = await api<{ announcement: { id: string } }>('POST', '/announcements', d);
                await refresh();
                setSelected(res.data.announcement.id);
              }}
            />
          )}
          {selected && selected !== 'new' && me && <Detail key={selected} id={selected} config={config} me={me} userNames={userNames} onChanged={refresh} />}
          {!selected && (
            <div className="card intro">
              <h2>From draft to published, in each jurisdiction</h2>
              <ol>
                <li><strong>Alice</strong> drafts (try the UK and US examples), validates and submits.</li>
                <li>The approvers named by the jurisdiction's policy approve (Bob, Carol, Dan).</li>
                <li><strong>Erin</strong> publishes. The worker sends it to the mock RNS or EDGAR and stores the acknowledgement.</li>
              </ol>
              <p className="muted">Switch persona in the top bar. Use the mock-wire controls below to break a newswire and watch retries.</p>
            </div>
          )}
          {config.demo && <WireControls jurisdictions={config.jurisdictions} />}
        </section>
      </main>
    </div>
  );
}
