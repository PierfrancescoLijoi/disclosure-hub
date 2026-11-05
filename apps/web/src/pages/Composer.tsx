import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, errorText, type Issue, type Preview, type View } from '../api';
import { channelLabel } from '../labels';
import { SchemaForm } from '../SchemaForm';
import { useSession } from '../session';
import { Banner, Chip, Confirm, Icon, PageHead, Skeleton, useToast } from '../ui';
import { missingRequired } from '../work';

interface Draft {
  jurisdiction: string;
  category: string;
  headline: string;
  body: string;
  metadata: Record<string, any>;
}
interface Validation {
  ok: boolean;
  issues: Issue[];
}

const STEPS = ['Details', 'Content', 'Validate', 'Preview'];
const clamp = (n: number) => (Number.isFinite(n) ? Math.min(4, Math.max(1, Math.round(n))) : 1);

export function Composer() {
  const { id } = useParams();
  const s = useSession();
  const nav = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const step = clamp(Number(params.get('step') ?? 1));
  const setStep = useCallback((n: number) => setParams({ step: String(n) }, { replace: true }), [setParams]);

  const jurisdictions = s.config!.jurisdictions;
  const [draft, setDraft] = useState<Draft>(() => ({
    jurisdiction: jurisdictions[0]!.code,
    category: jurisdictions[0]!.categories[0]!.key,
    headline: '',
    body: '',
    metadata: {},
  }));
  const [loaded, setLoaded] = useState(!id);
  const [problem, setProblem] = useState<string | null>(null);
  const [version, setVersion] = useState<number | undefined>();
  const [revision, setRevision] = useState<number | null>(null);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingSwitch, setPendingSwitch] = useState<{ jurisdiction: string; category: string } | null>(null);
  // The draft exists on the server before React state settles, so persist() reads the id from a ref.
  const draftId = useRef<string | null>(null);

  // Editing loads the saved revision; a first save navigates here, so this also restores state after that.
  useEffect(() => {
    if (!id) return;
    let live = true;
    api<View>('GET', `/announcements/${id}`)
      .then(({ data: v }) => {
        if (!live) return;
        if (!v.actions.includes('edit')) return void setProblem('This announcement can no longer be edited in its current state.');
        setDraft({ jurisdiction: v.announcement.jurisdiction, category: v.announcement.category, headline: v.revision.headline, body: v.revision.body, metadata: v.revision.metadata });
        setVersion(v.announcement.version);
        setRevision(v.revision.number);
        if (v.announcement.status === 'validated' && v.validation) setValidation({ ok: v.validation.ok, issues: v.validation.issues });
        setLoaded(true);
      })
      .catch((e) => live && setProblem(errorText(e)));
    return () => {
      live = false;
    };
  }, [id]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const jurisdiction = jurisdictions.find((j) => j.code === draft.jurisdiction) ?? jurisdictions[0]!;
  const category = jurisdiction.categories.find((c) => c.key === draft.category) ?? jurisdiction.categories[0]!;
  const example = category.example;
  const missing = useMemo(() => missingRequired(category.jsonSchema, draft.metadata), [category, draft.metadata]);
  const hasContent = !!draft.headline || !!draft.body || Object.keys(draft.metadata).length > 0;

  const edit = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
    setValidation(null);
    setPreview(null);
  };

  const requestSwitch = (next: { jurisdiction: string; category: string }) => {
    const changesJurisdiction = next.jurisdiction !== draft.jurisdiction;
    if (hasContent && (changesJurisdiction || Object.keys(draft.metadata).length > 0)) setPendingSwitch(next);
    else edit({ ...next, metadata: {} });
  };

  /** Saves what is on screen; a first save creates the draft, later saves add a revision. Returns the id. */
  async function persist(): Promise<string> {
    if (!id && !draftId.current) {
      const { data } = await api<View>('POST', '/announcements', draft);
      draftId.current = data.announcement.id;
      setVersion(data.announcement.version);
      setRevision(data.revision.number);
      setDirty(false);
      return data.announcement.id;
    }
    const target = (id ?? draftId.current)!;
    if (!dirty) return target;
    const { data } = await api<{ view: View }>('PUT', `/announcements/${target}/revision`, {
      headline: draft.headline,
      body: draft.body,
      metadata: draft.metadata,
      expectedVersion: version,
    });
    setVersion(data.view.announcement.version);
    setRevision(data.view.revision.number);
    setDirty(false);
    return target;
  }
  async function run<T>(work: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setProblem(null);
    try {
      return await work();
    } catch (e) {
      setProblem(errorText(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  const goEdit = (target: string, to: number) => nav(`/app/announcements/${target}/edit?step=${to}`, { replace: true });

  const saveDraft = () =>
    run(async () => {
      const target = await persist();
      await s.refresh();
      toast('Draft saved');
      if (!id) goEdit(target, step);
    });

  const saveAndValidate = () =>
    run(async () => {
      const target = await persist();
      const { data } = await api<{ view: View }>('POST', `/announcements/${target}/validate`);
      const v = data.view.validation;
      setValidation(v ? { ok: v.ok, issues: v.issues } : { ok: false, issues: [] });
      await s.refresh();
      if (!id) goEdit(target, 3);
    });

  const loadPreview = () =>
    run(async () => {
      const target = (id ?? draftId.current)!;
      setPreview((await api<Preview>('GET', `/announcements/${target}/preview`)).data);
    });

  useEffect(() => {
    if (step === 4 && loaded && !preview && validation?.ok && (id ?? draftId.current)) void loadPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, loaded, validation?.ok]);

  const submit = () =>
    run(async () => {
      const target = await persist();
      const res = await api<{ ok: boolean; view: View }>('POST', `/announcements/${target}/submit`);
      await s.refresh();
      if (res.status === 422) {
        const v = res.data.view.validation;
        setValidation(v ? { ok: v.ok, issues: v.issues } : null);
        toast('Submit stopped: validation found problems', 'bad');
        if (!id) return goEdit(target, 3);
        return setStep(3);
      }
      toast('Submitted for review');
      nav(`/app/announcements/${target}`);
    });

  if (problem && !loaded) {
    return (
      <>
        <PageHead title="Edit announcement" />
        <Banner tone="bad">{problem}</Banner>
        <p>
          <Link to={id ? `/app/announcements/${id}` : '/app/announcements'}>← Back</Link>
        </p>
      </>
    );
  }
  if (!loaded) return <Skeleton rows={4} />;

  const saved = !!(id ?? draftId.current);
  const checklist = [
    { done: !!draft.headline.trim(), text: 'Headline written' },
    { done: !!draft.body.trim(), text: 'Body written' },
    { done: missing.length === 0, text: missing.length ? `Required details missing: ${missing.join(', ')}` : `${jurisdiction.name} details complete` },
    { done: saved && !dirty, text: dirty ? 'Unsaved changes' : saved ? `Saved${revision ? ` as revision ${revision}` : ''}` : 'Not saved yet' },
    { done: !!validation?.ok && !dirty, text: validation ? (validation.ok ? 'Validation passed' : 'Validation found problems') : 'Not validated yet' },
  ];
  const ready = checklist.every((c) => c.done);

  return (
    <>
      <PageHead
        crumbs={<Link to="/app/announcements">Announcements</Link>}
        title={id ? 'Edit announcement' : 'New announcement'}
        sub={`${jurisdiction.name} · ${category.label}`}
      />

      <nav aria-label="Steps" className="card">
        <ol className="stage" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {STEPS.map((label, k) => {
            const n = k + 1;
            const locked = n === 4 && !validation?.ok;
            return (
              <li key={label} className="row" style={{ flex: n < 4 ? 1 : undefined }}>
                <button
                  type="button"
                  className={`node btn ghost ${step === n ? 'on' : step > n ? 'done' : ''}`}
                  style={{ background: 'none' }}
                  disabled={locked}
                  aria-current={step === n ? 'step' : undefined}
                  title={locked ? 'Validate the draft first' : undefined}
                  onClick={() => setStep(n)}
                >
                  <b>{step > n ? '✓' : n}</b> {label}
                </button>
                {n < 4 && <span className="bar" />}
              </li>
            );
          })}
        </ol>
      </nav>

      {problem && <Banner tone="bad">{problem}</Banner>}

      <div className="grid split">
        <section className="card" aria-live="polite">
          {step === 1 && (
            <div className="stack">
              <h2>Where is this going?</h2>
              <label className="field">
                <span>Jurisdiction</span>
                <select
                  value={draft.jurisdiction}
                  disabled={!!id}
                  onChange={(e) => {
                    const j = jurisdictions.find((x) => x.code === e.target.value)!;
                    requestSwitch({ jurisdiction: j.code, category: j.categories[0]!.key });
                  }}
                >
                  {jurisdictions.map((j) => (
                    <option key={j.code} value={j.code}>
                      {j.name} ({channelLabel(j)})
                    </option>
                  ))}
                </select>
                {id && <span className="hint">Fixed after the first save: it is part of what reviewers approve.</span>}
              </label>
              <label className="field">
                <span>Category</span>
                <select value={draft.category} disabled={!!id} onChange={(e) => requestSwitch({ jurisdiction: draft.jurisdiction, category: e.target.value })}>
                  {jurisdiction.categories.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="row end">
                <button type="button" className="btn" onClick={() => setStep(2)}>
                  Continue
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="stack">
              <div className="row between wrap">
                <h2>Write the announcement</h2>
                {example && !id && (
                  <button type="button" className="btn secondary small" onClick={() => edit(example)}>
                    Fill with example content
                  </button>
                )}
              </div>
              <label className="field">
                <span>Headline</span>
                <input value={draft.headline} maxLength={500} onChange={(e) => edit({ headline: e.target.value })} />
              </label>
              <label className="field">
                <span>Body</span>
                <textarea rows={10} value={draft.body} onChange={(e) => edit({ body: e.target.value })} />
              </label>
              <h4>{jurisdiction.name} details</h4>
              <SchemaForm schema={category.jsonSchema} value={draft.metadata} onChange={(metadata) => edit({ metadata })} />
              <div className="row between">
                <button type="button" className="btn secondary" onClick={() => setStep(1)}>
                  Back
                </button>
                <button type="button" className="btn" onClick={() => setStep(3)}>
                  Continue
                </button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="stack">
              <h2>Check it against the rules</h2>
              <p className="muted">
                Saving stores a revision; validation runs the {jurisdiction.name} rules on exactly that text. Fix anything listed, then validate again.
              </p>
              {validation?.ok && !dirty && <Banner tone="ok">Validation passed. You can preview how it will be sent.</Banner>}
              {validation && validation.issues.length > 0 && (
                <ul className="issues" aria-label="Validation results">
                  {validation.issues.map((i, k) => (
                    <li key={k} className={i.severity}>
                      <strong>{i.severity === 'error' ? 'Error' : 'Warning'} · {i.code}</strong> {i.message}
                      {i.path && <span className="muted"> · {i.path}</span>}
                    </li>
                  ))}
                </ul>
              )}
              <div className="row between wrap">
                <button type="button" className="btn secondary" onClick={() => setStep(2)}>
                  Back to content
                </button>
                <div className="row wrap">
                  <button type="button" className="btn secondary" disabled={busy} onClick={saveAndValidate}>
                    {busy ? 'Working…' : validation ? 'Save and validate again' : 'Save and validate'}
                  </button>
                  <button type="button" className="btn" disabled={!validation?.ok || dirty} onClick={() => setStep(4)}>
                    Continue to preview
                  </button>
                </div>
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="stack">
              <h2>Preview</h2>
              {!preview ? (
                <Skeleton rows={3} />
              ) : preview.problem || !preview.payload ? (
                <Banner tone="bad">The channel could not build this announcement: {preview.problem ?? 'unknown problem'}</Banner>
              ) : (
                <>
                  <p className="muted">This is what the {preview.channel.name} mock receives. Nothing is sent until a publisher publishes it.</p>
                  <article className="doc preview">
                    <div className="masthead">{preview.channel.name.toUpperCase()} · DEMONSTRATION</div>
                    <h3>{preview.payload.headline}</h3>
                    <div className="text">{preview.payload.content}</div>
                  </article>
                  <dl className="kv">
                    {Object.entries(preview.payload.attributes).map(([k, v]) => (
                      <div key={k} style={{ display: 'contents' }}>
                        <dt>{k}</dt>
                        <dd>{Array.isArray(v) ? v.join(', ') : String(v)}</dd>
                      </div>
                    ))}
                    {preview.payload.attachments.map((a) => (
                      <div key={a.name} style={{ display: 'contents' }}>
                        <dt>Attachment</dt>
                        <dd>{a.name} ({a.type})</dd>
                      </div>
                    ))}
                  </dl>
                </>
              )}
              <div className="row between wrap">
                <button type="button" className="btn secondary" onClick={() => setStep(3)}>
                  Back
                </button>
                <button type="button" className="btn" disabled={busy || !preview?.payload || dirty} onClick={submit}>
                  {busy ? 'Submitting…' : 'Submit for review'}
                </button>
              </div>
            </div>
          )}
        </section>

        <aside className="stack sticky" aria-label="Readiness">
          <section className="card">
            <div className="card-head">
              <h3>Readiness</h3>
              {ready ? <Chip tone="ok" icon="✓">Ready to submit</Chip> : <Chip tone="warn" icon="!">Not ready</Chip>}
            </div>
            <ul className="checklist">
              {checklist.map((c) => (
                <li key={c.text} className={c.done ? 'done' : 'todo'}>
                  <span className="mark" aria-hidden="true">{c.done ? '✓' : '•'}</span>
                  <span>
                    <span className="sr-only">{c.done ? 'Done: ' : 'To do: '}</span>
                    {c.text}
                  </span>
                </li>
              ))}
            </ul>
            <div className="row" style={{ marginTop: 14 }}>
              <button type="button" className="btn secondary wide" disabled={busy || (saved && !dirty)} onClick={saveDraft}>
                <Icon name="check" size={16} /> {saved && !dirty ? 'Saved' : 'Save draft'}
              </button>
            </div>
          </section>
          <section className="card">
            <h4>Destination</h4>
            <p style={{ marginTop: 8 }}>
              <strong>{jurisdiction.channel.name}</strong>
              <br />
              <span className="muted small">
                {category.label} · {jurisdiction.timezone}
              </span>
            </p>
          </section>
        </aside>
      </div>

      <Confirm
        open={!!pendingSwitch}
        title="Change what you are writing?"
        confirmLabel="Change and clear details"
        danger
        onClose={() => setPendingSwitch(null)}
        onConfirm={() => {
          if (pendingSwitch) edit({ ...pendingSwitch, metadata: {} });
          setPendingSwitch(null);
        }}
      >
        <p>
          The jurisdiction-specific details you entered do not carry over to a different jurisdiction or category, so they will be cleared. Your headline and body are kept.
        </p>
      </Confirm>
    </>
  );
}
