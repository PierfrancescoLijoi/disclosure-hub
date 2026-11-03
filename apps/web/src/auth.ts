import { UserManager, WebStorageStateStore, type User } from 'oidc-client-ts';

export interface OidcSettings {
  authority: string;
  clientId: string;
  scope: string;
}

let manager: UserManager | undefined;

/** Authorization Code + PKCE against whatever the server says is the identity provider (Entra ID, Keycloak, ...). */
export function startAuth(s: OidcSettings): UserManager {
  manager ??= new UserManager({
    authority: s.authority,
    client_id: s.clientId,
    redirect_uri: `${window.location.origin}/`,
    post_logout_redirect_uri: `${window.location.origin}/`,
    response_type: 'code',
    scope: s.scope,
    // The token lives in this tab only; closing it signs out locally.
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
    automaticSilentRenew: true,
  });
  return manager;
}

let restoring: Promise<User | null> | undefined;

/** One restore at a time: React's dev double-mount must not consume the one-time code twice. */
export const restoreSession = (s: OidcSettings): Promise<User | null> => (restoring ??= restore(s));

/** Completes a redirect sign-in or restores the session. Never redirects: the login page decides when. */
async function restore(s: OidcSettings): Promise<User | null> {
  const m = startAuth(s);
  const params = new URLSearchParams(window.location.search);
  if (params.has('code') && params.has('state')) {
    const user = await m.signinRedirectCallback();
    window.history.replaceState({}, document.title, window.location.pathname);
    return user;
  }
  const existing = await m.getUser();
  return existing && !existing.expired ? existing : null;
}

/** Leaves for the identity provider's sign-in page. */
export const beginSignIn = (s: OidcSettings) => startAuth(s).signinRedirect();

export async function accessToken(): Promise<string | null> {
  const user = await manager?.getUser();
  return user && !user.expired ? user.access_token : null;
}

export const signOut = () => manager?.signoutRedirect();
