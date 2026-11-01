// Reopens retained isolated verification data; new tasks use real network only.
import { readFileSync, mkdirSync, createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
const f = JSON.parse(readFileSync('.local/outbound-test-last.json'));
if (!new URL(f.env.API_DATABASE_URL).pathname.startsWith('/zutrade_outbound_test_'))
  throw new Error('Only isolated Outbound database');
const env = { ...f.env, NODE_ENV: 'development' };
mkdirSync('.local/logs', { recursive: true });
const log = createWriteStream('.local/logs/outbound-ui.log', { flags: 'a', mode: 0o600 }),
  children = [];
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill('SIGTERM');
}
for (const args of [
  ['apps/api/dist/main.js'],
  ['apps/worker/dist/main.js'],
  ['apps/web/node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.config.ts', 'apps/web'],
]) {
  const c = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(c);
  for (const stream of [c.stdout, c.stderr]) stream.on('data', (b) => log.write(b));
  c.on('exit', () => {
    if (!stopping) stop();
  });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
console.log(
  'Outbound isolated OFFLINE evidence UI: http://127.0.0.1:5773/outbound ; accounts in .local/outbound-test-last.json. New tasks use real network.',
);
