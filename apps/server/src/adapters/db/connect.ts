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
}

/** `postgres://...` selects PostgreSQL; anything else is a SQLite file (or `:memory:`). */
export function connect(url: string): Connection {
  if (/^postgres(ql)?:\/\//.test(url)) {
    const pool = new pg.Pool({ connectionString: url, max: Number(process.env.PG_POOL_MAX ?? 10) });
    return { db: new Kysely<DB>({ dialect: new PostgresDialect({ pool }) }), dialect: 'postgres' };
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
