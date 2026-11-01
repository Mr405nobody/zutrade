// Opens retained isolated D1 test data; no seed, transport injection or reset.
import { readFileSync, mkdirSync, createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
const f = JSON.parse(readFileSync('.local/d1-test-last.json'));
if (!new URL(f.env.API_DATABASE_URL).pathname.startsWith('/zutrade_d1_test_'))
  throw new Error('Only retained isolated D1 database');
const env = { ...f.env, NODE_ENV: 'development' };
mkdirSync('.local/logs', { recursive: true });
const log = createWriteStream('.local/logs/d1-ui.log', { flags: 'a', mode: 0o600 }),
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
  'D1 isolated offline evidence UI: http://127.0.0.1:5373 ; credentials only in .local/d1-test-last.json. New research still uses real network.',
);
