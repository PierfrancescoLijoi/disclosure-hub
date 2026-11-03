import { connect, migrateToLatest } from './adapters/db/connect.js';
import { loadConfig } from './config.js';
import { seedDemo, seedIssuers } from './seed.js';

/** One-shot job for Compose: migrate (and seed in demo mode), then exit. */
const config = loadConfig();
const { db } = connect(config.DATABASE_URL, config.DATABASE_AUTH);
const applied = await migrateToLatest(db);
console.log(JSON.stringify({ msg: 'migrations', applied }));
if (config.DEMO) {
  await seedDemo(db);
  console.log(JSON.stringify({ msg: 'demo data seeded' }));
}
if (config.SEED_ISSUERS_JSON) {
  console.log(JSON.stringify({ msg: 'issuers seeded', count: await seedIssuers(db, config.SEED_ISSUERS_JSON) }));
}
await db.destroy();
