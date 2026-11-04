// Load test of the part of the platform a crowd actually hits: the public archive through Front Door. No
// dependencies, no sign-in (public reads need none). Run it against a test environment, never production.
//
//   EDGE_URL=https://fde-xxxx.z01.azurefd.net node infra/azure/loadtest/public-read.mjs
//   EDGE_URL=... MODE=origin CONCURRENCY=20 DURATION_S=120 node infra/azure/loadtest/public-read.mjs
//
// MODE=cached (default): the same few addresses, so after the first request per cache lifetime Front Door answers.
//   Measures the edge, and the hit ratio (a ratio far below ~95 % means the cache key or Cache-Control is wrong,
//   README item 12). Thresholds: error rate < 0.1 %, p95 < 300 ms.
// MODE=origin: a different search word on every request, so every request reaches the API and the database
//   (what a crowd of varied searches, or an attacker defeating the cache, costs). Thresholds: error rate < 1 %,
//   p95 < 1500 ms. The WAF may start refusing (429/403): those are counted separately, not as errors.
//
// What to record from a run (docs/SIZING.md, "Measured on Azure"): the date, the region, the SKU, the mode, requests
// per second, p50/p95/p99, hit ratio, and the database CPU during it (Azure Monitor).
const EDGE = (process.env.EDGE_URL ?? '').replace(/\/$/, '');
if (!EDGE) {
  console.error('EDGE_URL is required (terraform output app_url)');
  process.exit(2);
}
const MODE = process.env.MODE === 'origin' ? 'origin' : 'cached';
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 50);
const DURATION_MS = Number(process.env.DURATION_S ?? 60) * 1000;
const LIMITS = MODE === 'cached' ? { errors: 0.001, p95: 300 } : { errors: 0.01, p95: 1500 };

const STABLE = ['/api/public/announcements?limit=20', '/api/public/announcements?limit=20&jurisdiction=UK', '/api/public/issuers', '/api/public/options', '/api/public/feed.atom'];
const target = (i) => (MODE === 'cached' ? STABLE[i % STABLE.length] : `/api/public/announcements?limit=20&q=load${Date.now()}x${i}`);

const latencies = [];
const counts = { ok: 0, hit: 0, blocked: 0, errors: 0 };
const deadline = Date.now() + DURATION_MS;
let n = 0;

async function worker() {
  while (Date.now() < deadline) {
    const t0 = performance.now();
    try {
      const res = await fetch(EDGE + target(n++), { signal: AbortSignal.timeout(20_000) });
      await res.arrayBuffer();
      latencies.push(performance.now() - t0);
      if (res.status === 429 || res.status === 403) counts.blocked++;
      else if (res.status >= 200 && res.status < 400) {
        counts.ok++;
        if (/HIT/i.test(res.headers.get('x-cache') ?? '')) counts.hit++;
      } else counts.errors++;
    } catch {
      counts.errors++;
    }
  }
}

const started = performance.now();
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const seconds = (performance.now() - started) / 1000;

const sorted = [...latencies].sort((a, b) => a - b);
const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : NaN);
const total = counts.ok + counts.blocked + counts.errors;
const errorRate = total ? counts.errors / total : 1;
const p95 = pct(0.95);

console.log(`mode ${MODE}, ${CONCURRENCY} at a time, ${seconds.toFixed(0)} s, ${total} requests, ${(total / seconds).toFixed(0)} per second`);
console.log(`latency  p50 ${pct(0.5).toFixed(0)} ms   p95 ${p95.toFixed(0)} ms   p99 ${pct(0.99).toFixed(0)} ms`);
console.log(`ok ${counts.ok}  (edge hits ${counts.hit}, ${counts.ok ? ((100 * counts.hit) / counts.ok).toFixed(0) : 0} %)   refused by the WAF ${counts.blocked}   errors ${counts.errors} (${(100 * errorRate).toFixed(2)} %)`);

const failures = [];
if (errorRate > LIMITS.errors) failures.push(`error rate ${(100 * errorRate).toFixed(2)} % is above ${100 * LIMITS.errors} %`);
if (!(p95 <= LIMITS.p95)) failures.push(`p95 ${p95.toFixed(0)} ms is above ${LIMITS.p95} ms`);
if (MODE === 'cached' && counts.ok && counts.hit / counts.ok < 0.9) failures.push(`edge hit ratio ${((100 * counts.hit) / counts.ok).toFixed(0)} % is below 90 %: check x-cache and Cache-Control (README item 12)`);
if (failures.length) {
  console.error('FAILED: ' + failures.join('; '));
  process.exit(1);
}
console.log('within limits');
