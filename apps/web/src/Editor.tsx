import { useState } from 'react';
import type { Jurisdiction } from './api';
import { EXAMPLES } from './examples';
import { SchemaForm } from './SchemaForm';

export interface Draft {
  jurisdiction: string;
  category: string;
  headline: string;
  body: string;
  metadata: Record<string, any>;
}

interface Props {
  jurisdictions: Jurisdiction[];
  initial?: Draft;
  /** In edit mode jurisdiction and category are fixed: they are part of what was approved. */
  locked?: boolean;
  submitLabel: string;
  onSubmit: (d: Draft) => Promise<void>;
  onCancel?: () => void;
}

export function Editor({ jurisdictions, initial, locked, submitLabel, onSubmit, onCancel }: Props) {
  const first = jurisdictions[0]!;
  const [d, setD] = useState<Draft>(initial ?? { jurisdiction: first.code, category: first.categories[0]!.key, headline: '', body: '', metadata: {} });
  const [saving, setSaving] = useState(false);
  const jurisdiction = jurisdictions.find((j) => j.code === d.jurisdiction) ?? first;
  const category = jurisdiction.categories.find((c) => c.key === d.category) ?? jurisdiction.categories[0]!;
  const example = EXAMPLES[`${d.jurisdiction}.${d.category}`];

  return (
    <form
      className="card editor"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        try {
          await onSubmit(d);
        } finally {
          setSaving(false);
        }
      }}
    >
      <div className="row">
        <label className="field">
          <span>Jurisdiction</span>
          <select
            value={d.jurisdiction}
            disabled={locked}
            onChange={(e) => {
              const j = jurisdictions.find((x) => x.code === e.target.value)!;
              setD({ ...d, jurisdiction: j.code, category: j.categories[0]!.key, metadata: {} });
            }}
          >
            {jurisdictions.map((j) => <option key={j.code} value={j.code}>{j.name} ({j.channel.name})</option>)}
          </select>
        </label>
        <label className="field">
          <span>Category</span>
          <select value={d.category} disabled={locked} onChange={(e) => setD({ ...d, category: e.target.value, metadata: {} })}>
            {jurisdiction.categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </label>
      </div>
      {example && !locked && (
        <button type="button" className="link" onClick={() => setD({ ...d, ...example() })}>Fill with example content</button>
      )}
      <label className="field">
        <span>Headline</span>
        <input value={d.headline} onChange={(e) => setD({ ...d, headline: e.target.value })} />
      </label>
      <label className="field">
        <span>Body</span>
        <textarea rows={8} value={d.body} onChange={(e) => setD({ ...d, body: e.target.value })} />
      </label>
      <h4>{jurisdiction.name} details</h4>
      <SchemaForm schema={category.jsonSchema} value={d.metadata} onChange={(metadata) => setD({ ...d, metadata })} />
      <div className="row end">
        {onCancel && <button type="button" className="secondary" onClick={onCancel}>Cancel</button>}
        <button type="submit" disabled={saving}>{saving ? 'Saving…' : submitLabel}</button>
      </div>
    </form>
  );
}
