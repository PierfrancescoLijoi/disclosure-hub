import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { Kysely, Migrator, PostgresDialect, SqliteDialect, type Migration } from 'kysely';
import pg from 'pg';
import type { DB } from './schema.js';
import { migrations } from './migrations.js';

export type Dialect = 'sqlite' | 'postgres';

export interface Connection {
  db: Kysely<DB>;
  dialect: Dialect;
  /** The PostgreSQL pool, for the LISTEN/NOTIFY queue. Absent on SQLite. */
  pool?: pg.Pool;
}

export type DatabaseAuth = 'password' | 'azure-managed-identity';

const ENTRA_POSTGRES_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default';
let azureCredential: { getToken(scope: string): Promise<{ token: string } | null> } | undefined;

/** Entra token used as the password: no credential is stored anywhere. Loaded only when asked for. */
async function entraPostgresToken(): Promise<string> {
  if (!azureCredential) {
    const { DefaultAzureCredential } = await import('@azure/identity');
    azureCredential = new DefaultAzureCredential(); // AZURE_CLIENT_ID picks a user-assigned identity
  }
  const t = await azureCredential.getToken(ENTRA_POSTGRES_SCOPE);
  if (!t) throw new Error('Could not get an Entra token for PostgreSQL');
  return t.token;
}

/** `postgres://...` selects PostgreSQL; anything else is a SQLite file (or `:memory:`). */
export function connect(url: string, auth: DatabaseAuth = 'password'): Connection {
  if (/^postgres(ql)?:\/\//.test(url)) {
    const pool = new pg.Pool({
      connectionString: url,
      max: Number(process.env.PG_POOL_MAX ?? 10),
      // Managed PostgreSQL refuses plain connections; PG_SSL=require turns on certificate-verified TLS.
      ssl: process.env.PG_SSL === 'require' ? { rejectUnauthorized: true } : undefined,
      connectionTimeoutMillis: 10_000,
      // Entra tokens last about an hour: recycle connections well inside that so a new one gets a fresh token.
      maxLifetimeSeconds: auth === 'azure-managed-identity' ? 1800 : undefined,
      password: auth === 'azure-managed-identity' ? entraPostgresToken : undefined,
    });
    // An idle connection dropped by the server must not take the process down.
    pool.on('error', (err) => console.error(JSON.stringify({ level: 'error', msg: 'idle database connection failed', err: err.message })));
    return { db: new Kysely<DB>({ dialect: new PostgresDialect({ pool }) }), dialect: 'postgres', pool };
  }
  const path = url.replace(/^sqlite:/, '');
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = ON');
  return { db: new Kysely<DB>({ dialect: new SqliteDialect({ database: sqlite }) }), dialect: 'sqlite' };
}

export async function migrateToLatest(db: Kysely<DB>): Promise<string[]> {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: async (): Promise<Record<string, Migration>> => migrations },
  });
  const { error, results } = await migrator.migrateToLatest();
  if (error) throw error;
  return (results ?? []).map((r) => `${r.migrationName}:${r.status}`);
}
