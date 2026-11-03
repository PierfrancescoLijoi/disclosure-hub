import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { announcementState, publicationState, type StateView, type Tone } from './labels';

// ------------------------------------------------------------------ icons
const PATHS: Record<string, string> = {
  home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
  doc: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7',
  plus: 'M12 5v14M5 12h14',
  inbox: 'M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5',
  send: 'M21 3L10 14M21 3l-7 18-4-7-7-4z',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  users: 'M16 20v-2a4 4 0 00-4-4H7a4 4 0 00-4 4v2M9.5 10a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM21 20v-2a4 4 0 00-3-3.9M16 3.1a3.5 3.5 0 010 6.8',
  globe: 'M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-5-5',
  menu: 'M4 6h16M4 12h16M4 18h16',
  check: 'M5 12l5 5 9-10',
  alert: 'M12 3l10 18H2zM12 10v5M12 18h.01',
  close: 'M6 6l12 12M18 6L6 18',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  copy: 'M9 9h11v11H9zM5 15V4h11',
  signout: 'M9 21H4V3h5M16 17l5-5-5-5M21 12H9',
  refresh: 'M20 11a8 8 0 00-14-4L4 9M4 4v5h5M4 13a8 8 0 0014 4l2-2M20 20v-5h-5',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z',
};
export function Icon({ name, size = 18 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={PATHS[name] ?? PATHS.doc} />
    </svg>
  );
}

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="#5665ec" />
      <path d="M7 21c4 0 5-10 9-10s5 10 9 10" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="16" cy="11" r="2.2" fill="#fff" />
    </svg>
  );
}

// ------------------------------------------------------------------ chips
const toneClass = (t: Tone) => (t === 'neutral' ? '' : `tone-${t}`);

export function Chip({ tone = 'neutral', icon, children, title }: { tone?: Tone; icon?: string; children: ReactNode; title?: string }) {
  return (
    <span className={`chip ${toneClass(tone)}`} title={title}>
      {icon && <i aria-hidden="true">{icon}</i>}
      {children}
    </span>
  );
}

/** Icon plus text: state is never carried by colour alone. */
export const StateChip = ({ state }: { state: StateView }) => (
  <Chip tone={state.tone} icon={state.icon}>
    {state.label}
  </Chip>
);
export const AnnouncementChip = ({ a }: { a: { status: string; changesRequested?: boolean } }) => <StateChip state={announcementState(a)} />;
export const PublicationChip = ({ status }: { status: string }) => <StateChip state={publicationState(status)} />;

// ------------------------------------------------------------------ feedback
export function Banner({ tone, children }: { tone: 'ok' | 'bad' | 'warn' | 'info'; children: ReactNode }) {
  return (
    <div className={`banner ${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton row-sk" />
      ))}
    </div>
  );
}

export function Kpi({ value, label, tone }: { value: ReactNode; label: string; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className={`card kpi ${tone ? `tone-${tone}` : ''}`}>
      <div className="value">{value}</div>
      <div className="label">{label}</div>
    </div>
  );
}

export function PageHead({ title, sub, crumbs, children }: { title: ReactNode; sub?: ReactNode; crumbs?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        {crumbs && <div className="crumbs">{crumbs}</div>}
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {children && <div className="row wrap">{children}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ dialog and drawer (native <dialog>: focus trap and Esc for free)
interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  drawer?: boolean;
  children: ReactNode;
}
export function Modal({ open, onClose, title, drawer, children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={drawer ? 'drawer' : ''}
      aria-label={title}
      onClose={onClose}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog element itself.
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className="dlg">
          <div className="row between">
            <h2>{title}</h2>
            <button type="button" className="btn ghost small" onClick={onClose} aria-label="Close">
              <Icon name="close" />
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}

interface ConfirmProps {
  open: boolean;
  title: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  /** Confirm stays disabled until this is true (e.g. a required reason). */
  canConfirm?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children: ReactNode;
}
export function Confirm({ open, title, confirmLabel, danger, busy, canConfirm = true, onConfirm, onClose, children }: ConfirmProps) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      {children}
      <div className="row end">
        <button type="button" className="btn secondary" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className={`btn ${danger ? 'danger' : ''}`} disabled={busy || !canConfirm} onClick={onConfirm}>
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ toast
interface ToastItem {
  id: number;
  text: string;
  tone: 'ok' | 'bad';
}
const ToastCtx = createContext<(text: string, tone?: 'ok' | 'bad') => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const push = useCallback((text: string, tone: 'ok' | 'bad' = 'ok') => {
    const id = ++seq.current;
    setList((l) => [...l, { id, text, tone }]);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), tone === 'bad' ? 8000 : 4500);
  }, []);
  const value = useMemo(() => push, [push]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        {list.map((t) => (
          <div key={t.id} className={`toast ${t.tone === 'bad' ? 'bad' : ''}`} role={t.tone === 'bad' ? 'alert' : 'status'}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** Copies text and tells the person, because a silent copy button looks broken. */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const toast = useToast();
  return (
    <button
      type="button"
      className="btn ghost small"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => toast('Copied to clipboard'),
          () => toast('Could not copy: select the text and copy it', 'bad'),
        );
      }}
    >
      <Icon name="copy" size={14} /> {label}
    </button>
  );
}
