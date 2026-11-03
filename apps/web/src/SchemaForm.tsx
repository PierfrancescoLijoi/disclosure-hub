import type { Schema } from './api';

type Json = Record<string, any>;

const toLocalInput = (iso: unknown) => {
  if (typeof iso !== 'string') return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

interface FieldProps {
  name: string;
  schema: Schema;
  value: any;
  required: boolean;
  onChange: (v: any) => void;
  disabled?: boolean;
}

function Field({ name, schema, value, required, onChange, disabled }: FieldProps) {
  const label = schema.title ?? name;

  if (schema.type === 'object') {
    const open = value !== undefined;
    return (
      <fieldset className="group">
        <legend>
          {!required && (
            <input
              type="checkbox"
              checked={open}
              disabled={disabled}
              onChange={(e) => onChange(e.target.checked ? {} : undefined)}
              aria-label={`Include ${label}`}
            />
          )}{' '}
          {label}
        </legend>
        {open && <Fields schema={schema} value={value} onChange={onChange} disabled={disabled} />}
      </fieldset>
    );
  }

  if (schema.type === 'boolean') {
    return (
      <label className="check">
        <input type="checkbox" checked={!!value} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /> {label}
      </label>
    );
  }

  if (schema.type === 'array' && schema.items?.enum) {
    const chosen: string[] = Array.isArray(value) ? value : [];
    return (
      <div className="field">
        <span>{label}{required && ' *'}</span>
        <div className="chips">
          {schema.items.enum.map((opt) => (
            <label key={opt} className="check">
              <input
                type="checkbox"
                disabled={disabled}
                checked={chosen.includes(opt)}
                onChange={(e) => onChange(e.target.checked ? [...chosen, opt] : chosen.filter((x) => x !== opt))}
              />{' '}
              {opt}
            </label>
          ))}
        </div>
      </div>
    );
  }

  let input;
  if (schema.enum) {
    input = (
      <select value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">Select…</option>
        {schema.enum.map((o) => <option key={o}>{o}</option>)}
      </select>
    );
  } else if (schema.type === 'number' || schema.type === 'integer') {
    input = (
      <input type="number" step="any" value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />
    );
  } else if (schema.format === 'date-time') {
    input = (
      <input type="datetime-local" value={toLocalInput(value)} disabled={disabled} onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : undefined)} />
    );
  } else if (schema.format === 'date') {
    input = <input type="date" value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || undefined)} />;
  } else {
    input = <input type="text" value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || undefined)} />;
  }
  return (
    <label className="field">
      <span>{label}{required && ' *'}</span>
      {input}
    </label>
  );
}

function Fields({ schema, value, onChange, disabled }: { schema: Schema; value: Json; onChange: (v: Json) => void; disabled?: boolean }) {
  const required = new Set(schema.required ?? []);
  return (
    <>
      {Object.entries(schema.properties ?? {}).map(([key, child]) => (
        <Field
          key={key}
          name={key}
          schema={child}
          value={value?.[key]}
          required={required.has(key)}
          disabled={disabled}
          onChange={(v) => {
            const next = { ...value };
            if (v === undefined) delete next[key];
            else next[key] = v;
            onChange(next);
          }}
        />
      ))}
    </>
  );
}

/** Builds the metadata form straight from the category's JSON Schema (generated from the Zod schema). */
export function SchemaForm({ schema, value, onChange, disabled }: { schema: Schema; value: Json; onChange: (v: Json) => void; disabled?: boolean }) {
  if (!Object.keys(schema.properties ?? {}).length) return <p className="muted">No extra fields for this category.</p>;
  return (
    <div className="schema-form">
      <Fields schema={schema} value={value} onChange={onChange} disabled={disabled} />
    </div>
  );
}
