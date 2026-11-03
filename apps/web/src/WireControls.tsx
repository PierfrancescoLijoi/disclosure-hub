import { useEffect, useState } from 'react';
import { api, type Jurisdiction } from './api';

type Chaos = { mode: string; failuresRemaining?: number };

const PRESETS: { label: string; body: Chaos }[] = [
  { label: 'Healthy', body: { mode: 'ok' } },
  { label: 'Fail next 2 (503)', body: { mode: 'transient', failuresRemaining: 2 } },
  { label: 'Lose next ack', body: { mode: 'ack_lost', failuresRemaining: 1 } },
  { label: 'Reject (permanent)', body: { mode: 'permanent' } },
];

/** Demo-only: steers the mock newswires so retries, reconciliation and failures can be shown live. */
export function WireControls({ jurisdictions }: { jurisdictions: Jurisdiction[] }) {
  const [state, setState] = useState<Record<string, Chaos>>({});
  const load = () => api<Record<string, Chaos>>('GET', '/dev/gateways').then((r) => setState(r.data)).catch(() => undefined);
  useEffect(() => { void load(); }, []);

  return (
    <section className="card">
      <h4>Mock newswires (demo)</h4>
      <p className="muted">Break a wire, then publish, to watch retry, ack reconciliation and failure handling.</p>
      {jurisdictions.map((j) => (
        <div key={j.channel.id} className="wire">
          <strong>{j.channel.name}</strong>
          <span className={`chip ${state[j.channel.id]?.mode === 'ok' ? 'ok' : 'warn'}`}>
            {state[j.channel.id]?.mode ?? 'ok'}
            {state[j.channel.id]?.failuresRemaining ? ` ×${state[j.channel.id]!.failuresRemaining}` : ''}
          </span>
          <span className="spacer" />
          {PRESETS.map((p) => (
            <button key={p.label} className="secondary small" onClick={async () => { await api('PUT', `/dev/gateways/${j.channel.id}`, p.body); await load(); }}>
              {p.label}
            </button>
          ))}
        </div>
      ))}
    </section>
  );
}
