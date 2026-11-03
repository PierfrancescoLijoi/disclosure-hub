import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, currentUser, errorText, setCurrentUser, useBearerTokens, type Config, type Issuer, type Item, type User } from './api';
import { accessToken, beginSignIn, restoreSession, signOut as oidcSignOut, type OidcSettings } from './auth';

const POLL_MS = 4000;

export type Phase = 'loading' | 'anonymous' | 'ready' | 'error';

interface Session {
  phase: Phase;
  error: string | null;
  config: Config | null;
  /** Everyone the sign-in page can offer (demo personas) or that the company directory knows (OIDC). */
  users: User[];
  me: User | null;
  issuer: Issuer | null;
  /** null until the first load finishes, so screens can show a skeleton instead of "nothing yet". */
  items: Item[] | null;
  refresh: () => Promise<void>;
  name: (id: string) => string;
  signInAs: (userId: string) => void;
  signInWithProvider: () => Promise<void>;
  signOut: () => void;
}

const Ctx = createContext<Session | null>(null);
export const useSession = (): Session => {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
};

const settingsOf = (cfg: Config): OidcSettings => {
  if (cfg.auth.mode !== 'oidc') throw new Error('Not an OIDC deployment');
  if (!cfg.auth.clientId) throw new Error('The server has no browser client id configured (OIDC_SPA_CLIENT_ID)');
  return { authority: cfg.auth.authority, clientId: cfg.auth.clientId, scope: cfg.auth.scope };
};

export function SessionProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [me, setMe] = useState<User | null>(null);
  const [issuer, setIssuer] = useState<Issuer | null>(null);
  const [items, setItems] = useState<Item[] | null>(null);
  const [epoch, setEpoch] = useState(0);
  const settings = useRef<OidcSettings | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const cfg = (await api<Config>('GET', '/config')).data;
      if (!live) return;
      setConfig(cfg);

      if (cfg.auth.mode === 'oidc') {
        settings.current = settingsOf(cfg);
        useBearerTokens(accessToken);
        const user = await restoreSession(settings.current);
        if (!live) return;
        if (!user) return void setPhase('anonymous');
        const mine = (await api<{ actor: User; issuer: Issuer | null }>('GET', '/me')).data;
        const directory = (await api<{ users: User[] }>('GET', '/users').catch(() => null))?.data.users ?? [];
        if (!live) return;
        setMe(mine.actor);
        setIssuer(mine.issuer);
        setUsers(directory);
        return void setPhase('ready');
      }

      const personas = (await api<{ users: User[] }>('GET', '/users')).data.users;
      if (!live) return;
      setUsers(personas);
      const chosen = personas.find((u) => u.id === currentUser());
      if (!chosen) {
        setMe(null);
        return void setPhase('anonymous');
      }
      const mine = (await api<{ actor: User; issuer: Issuer | null }>('GET', '/me')).data;
      if (!live) return;
      setMe(mine.actor);
      setIssuer(mine.issuer);
      setPhase('ready');
    })().catch((e) => {
      if (!live) return;
      // A persona that no longer exists (database reset) is a sign-out, not a failure.
      if (e instanceof ApiError && e.status === 401) {
        setCurrentUser(null);
        setMe(null);
        return void setPhase('anonymous');
      }
      setError(errorText(e));
      setPhase('error');
    });
    return () => {
      live = false;
    };
  }, [epoch]);

  const refresh = useCallback(async () => {
    try {
      setItems((await api<{ items: Item[] }>('GET', '/announcements?limit=100')).data.items);
    } catch (e) {
      // Keep what is on screen; a 401 is handled by the next sign-in check.
      if (e instanceof ApiError && e.status === 401) setItems([]);
    }
  }, []);

  useEffect(() => {
    if (phase !== 'ready') return;
    setItems(null);
    void refresh();
    const t = setInterval(() => {
      if (!document.hidden) void refresh();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [phase, me?.id, refresh]);

  const value = useMemo<Session>(() => {
    const names = Object.fromEntries(users.map((u) => [u.id, u.name]));
    if (me) names[me.id] = me.name;
    return {
      phase,
      error,
      config,
      users,
      me,
      issuer,
      items,
      refresh,
      name: (id) => (id === 'system' ? 'System' : names[id] ?? id),
      signInAs: (id) => {
        setCurrentUser(id);
        setPhase('loading');
        setEpoch((n) => n + 1);
      },
      signInWithProvider: async () => {
        if (!settings.current) throw new Error('Sign-in is not configured');
        await beginSignIn(settings.current);
      },
      signOut: () => {
        if (config?.auth.mode === 'oidc') return void oidcSignOut();
        setCurrentUser(null);
        setMe(null);
        setItems(null);
        setPhase('anonymous');
      },
    };
  }, [phase, error, config, users, me, issuer, items, refresh]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
