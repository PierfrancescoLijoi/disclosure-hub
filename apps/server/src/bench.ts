/**
 * Throughput check against a running server, through the REST API only.
 *   npm run bench                                   (N=300 announcements, 20 in flight)
 *   BASE_URL=http://localhost:8080 N=600 CONCURRENCY=40 npm run bench
 * Reports the API phase (create to publish request) and the end-to-end phase (until every
 * announcement is published by the workers). The mock newswire answers instantly unless
 * GATEWAY_LATENCY_MS is set, so by default this measures the platform, not a vendor.
 */
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const N = Number(process.env.N ?? 300);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 20);
const LATENCY = Number(process.env.GATEWAY_LATENCY_MS ?? 0);

async function call(as: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-user-id': as },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const data = (await res.json()) as any;
  if (!res.ok) throw new Error(`${method} ${path} as ${as}: ${res.status} ${data?.error?.code}`);
  return data;
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;

async function one(i: number): Promise<{ id: string; ms: number }> {
  const t0 = performance.now();
  const body = `Northwind Energy plc announces routine update number ${i} for shareholders and the wider market.\nEnquiries: Investor Relations, ir@northwind.example.`;
  const { announcement } = await call('alice', 'POST', '/announcements', { jurisdiction: 'UK', category: 'general', headline: `Bench notice ${i}`, body, metadata: {} });
  await call('alice', 'POST', `/announcements/${announcement.id}/validate`);
  await call('alice', 'POST', `/announcements/${announcement.id}/submit`);
  await call('bob', 'POST', `/announcements/${announcement.id}/approve`);
  await call('erin', 'POST', `/announcements/${announcement.id}/publish`);
  return { id: announcement.id, ms: performance.now() - t0 };
}

async function main() {
  if (LATENCY) await call('erin', 'PUT', '/dev/gateways/rns', { mode: 'ok', latencyMs: LATENCY });
  const ids: string[] = [];
  const lat: number[] = [];
  let next = 0;
  const start = performance.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const i = next++;
        if (i >= N) return;
        const r = await one(i);
        ids.push(r.id);
        lat.push(r.ms);
      }
    }),
  );
  const apiMs = performance.now() - start;

  let pending = ids.length;
  while (pending > 0) {
    const { items } = await call('erin', 'GET', '/announcements?limit=100&status=publishing');
    pending = items.length;
    if (pending) await new Promise((r) => setTimeout(r, 100));
  }
  const totalMs = performance.now() - start;

  console.log(`announcements        ${N} (concurrency ${CONCURRENCY}, gateway latency ${LATENCY} ms)`);
  console.log(`API phase            ${(apiMs / 1000).toFixed(1)} s  ->  ${(N / (apiMs / 1000)).toFixed(0)} drafts-to-publish-request/s`);
  console.log(`per-announcement     p50 ${pct(lat, 0.5).toFixed(0)} ms  p95 ${pct(lat, 0.95).toFixed(0)} ms  (5 API calls each)`);
  console.log(`end to end           ${(totalMs / 1000).toFixed(1)} s  ->  ${(N / (totalMs / 1000)).toFixed(0)} published/s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
