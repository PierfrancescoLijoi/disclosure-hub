import { connect, migrateToLatest } from './adapters/db/connect.js';
import { loadConfig } from './config.js';
import { seedDemo } from './seed.js';

/** One-shot job for Compose: migrate (and seed in demo mode), then exit. */
const config = loadConfig();
const { db } = connect(config.DATABASE_URL);
const applied = await migrateToLatest(db);
console.log(JSON.stringify({ msg: 'migrations', applied }));
if (config.DEMO) {
  await seedDemo(db);
  console.log(JSON.stringify({ msg: 'demo data seeded' }));
}
await db.destroy();
