import { roleLabel } from '../labels';
import { useSession } from '../session';
import { Banner, Chip, PageHead } from '../ui';

/** Read-only: roles come from the identity provider (or the demo seed) and the rules from the jurisdiction modules. */
export function Workspace() {
  const s = useSession();
  const config = s.config!;
  const me = s.me!;
  const oidc = config.auth.mode === 'oidc';
  const profiles = Object.entries(s.issuer?.profiles ?? {});

  return (
    <>
      <PageHead title="Workspace" sub={`${s.issuer?.name ?? me.issuerId}: people, identifiers and the rules in force.`} />
      <Banner tone="info">
        This page is read-only. {oidc ? 'People and roles are managed in your identity provider (group membership maps to roles).' : 'In demo mode the people and roles come from the seed data.'}
      </Banner>

      <div className="grid two">
        <section className="card flush" aria-labelledby="people-h">
          <div className="card-head" style={{ padding: '16px 20px 0' }}>
            <h3 id="people-h">People and roles</h3>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Roles</th>
                </tr>
              </thead>
              <tbody>
                {(s.users.length ? s.users.filter((u) => u.issuerId === me.issuerId) : [me]).map((u) => (
                  <tr key={u.id}>
                    <td>
                      <strong>{u.name}</strong>
                      {u.id === me.id && <span className="muted"> (you)</span>}
                    </td>
                    <td>
                      <div className="row wrap" style={{ gap: 6 }}>
                        {u.roles.map((r) => (
                          <Chip key={r}>{roleLabel(r)}</Chip>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card" aria-labelledby="ids-h">
          <h3 id="ids-h">Issuer identifiers</h3>
          <p className="muted small">Public identifiers only. Credentials never live here.</p>
          {profiles.length === 0 ? (
            <p className="muted">None on file.</p>
          ) : (
            profiles.map(([code, ids]) => (
              <div key={code} style={{ marginTop: 12 }}>
                <h4>{config.jurisdictions.find((j) => j.code === code)?.name ?? code}</h4>
                <dl className="kv" style={{ marginTop: 6 }}>
                  {Object.entries(ids).map(([k, v]) => (
                    <div key={k} style={{ display: 'contents' }}>
                      <dt>{k}</dt>
                      <dd>{v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))
          )}
        </section>
      </div>

      <section className="card" aria-labelledby="mods-h">
        <h3 id="mods-h">Jurisdiction modules</h3>
        <p className="muted small">Each jurisdiction is a self-contained rule module: categories, validation, approval policy and the channel adapter.</p>
        <div className="grid two" style={{ marginTop: 12 }}>
          {config.jurisdictions.map((j) => (
            <div key={j.code} className="doc">
              <h3>{j.name}</h3>
              <dl className="kv" style={{ marginTop: 8 }}>
                <dt>Channel</dt>
                <dd>{j.channel.name} (mock)</dd>
                <dt>Time zone</dt>
                <dd>{j.timezone}</dd>
                <dt>Open</dt>
                <dd>
                  {j.window.open} to {j.window.close}
                </dd>
                <dt>Categories</dt>
                <dd>{j.categories.map((c) => c.label).join(', ')}</dd>
              </dl>
            </div>
          ))}
        </div>
      </section>

      <section className="card" aria-labelledby="rt-h">
        <h3 id="rt-h">Runtime</h3>
        <dl className="kv" style={{ marginTop: 8 }}>
          <dt>Sign-in</dt>
          <dd>{oidc ? 'OpenID Connect (Authorization Code + PKCE)' : 'Demo personas'}</dd>
          <dt>Database</dt>
          <dd>{config.database}</dd>
          <dt>Queue</dt>
          <dd>{config.queue}</dd>
          <dt>Process role</dt>
          <dd>{config.role}</dd>
          <dt>Channel windows</dt>
          <dd>{config.enforceWindows ? 'Enforced: releases are held while a channel is closed' : 'Not enforced in this run'}</dd>
          <dt>AI pre-check</dt>
          <dd>{config.ai ? `On (${config.ai.provider}), advisory only` : 'Off'}</dd>
          <dt>Publishing</dt>
          <dd>{config.demo ? 'Demo / Mock: nothing is submitted to a regulator' : 'Live adapters'}</dd>
        </dl>
      </section>
    </>
  );
}
