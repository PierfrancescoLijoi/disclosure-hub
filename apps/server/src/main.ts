import { buildApp } from './http/app.js';
import { loadConfig } from './config.js';
import { createRuntime } from './runtime.js';

const config = loadConfig();
const rt = await createRuntime(config);
await rt.start();

// A worker-only process has no HTTP surface; the queue and the sweeper are its whole job.
const app = config.ROLE === 'worker' ? undefined : await buildApp(rt);
if (app) await app.listen({ host: config.HOST, port: config.PORT });

rt.log.info(
  { role: config.ROLE, port: app ? config.PORT : undefined, db: config.DATABASE_URL.startsWith('postgres') ? 'postgres' : 'sqlite', queue: config.QUEUE_URL === 'inproc' ? 'in-process' : 'redis', ai: rt.preCheck?.providerName ?? 'off' },
  'disclosure-hub started',
);
if (app && config.DEMO) rt.log.info(`open http://localhost:${config.PORT}`);

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  rt.log.info({ signal }, 'shutting down');
  await app?.close();
  await rt.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
