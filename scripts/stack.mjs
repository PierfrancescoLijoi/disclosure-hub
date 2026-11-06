// Starts the container stack and prints every address with what it is for.
// Usage: npm run stack | stack.cmd (Windows, double-click). Needs Docker Desktop running.
// Quiet by default: Docker's build output is shown only if something fails. Add --verbose to see it.
import { spawnSync } from 'node:child_process';

const APP = 'http://localhost:8080';
const WAIT_SECONDS = 180;
const verbose = process.argv.includes('--verbose');

if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
  console.error('Docker is not running. Start Docker Desktop, wait until it says it is running, then run this again.');
  process.exit(1);
}

console.log('Building and starting the containers (the first time takes a few minutes)...');
const up = spawnSync('docker', ['compose', 'up', '--build', '-d'], verbose ? { stdio: 'inherit' } : { encoding: 'utf8' });
if (up.status !== 0) {
  if (!verbose) console.error(`${up.stdout ?? ''}${up.stderr ?? ''}`);
  console.error('\ndocker compose failed. Are ports 3000, 8080, 8081 and 8025 free? (stop any "npm start" still running)');
  process.exit(up.status ?? 1);
}

process.stdout.write('Waiting for the app');
const deadline = Date.now() + WAIT_SECONDS * 1000;
let ready = false;
while (Date.now() < deadline && !ready) {
  try {
    ready = (await fetch('http://127.0.0.1:3000/readyz', { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    // not up yet
  }
  if (!ready) {
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 2000));
  }
}
console.log(ready ? ' ready.\n' : ` not answering after ${WAIT_SECONDS}s. Check: docker compose logs api\n`);

console.log(`Open these in your browser:

  ${APP}
      THE APP. Sign in with Keycloak, password for every user: hub-dev-only
        alice  author      create, fill, validate, submit for review
        bob    secretary   approve
        carol  counsel     approve
        dan    CFO         approve
        erin   publisher   publish
      Sign out and in again at each step.

  ${APP}/public/announcements
      WHAT READERS SEE. Published announcements, no sign-in. Follow one to get e-mail.

  http://localhost:8025
      MAILPIT. The inbox for every e-mail the system sends (follow confirmations, announcement mail).

  http://localhost:8081
      KEYCLOAK ADMIN. The identity provider behind the sign-in (user admin, password hub-dev-only).

Stop everything:   npm run stack:down     (add -- -v to also delete the data)
Logs of one part:  docker compose logs -f api   (or worker, notifier, agents)
`);
