// Reopens the retained isolated D2 sample. No seed, reset, or fixture transport.
import { readFileSync, mkdirSync, createWriteStream, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const f = JSON.parse(readFileSync('.local/d2-test-last.json', 'utf8'));
if (!new URL(f.env.API_DATABASE_URL).pathname.startsWith('/zutrade_d2_test_'))
  throw new Error('Retained D2 isolated database required');
const env = { ...f.env, NODE_ENV: 'development' };
mkdirSync('.local/logs', { recursive: true });
const log = createWriteStream('.local/logs/d2-ui.log', { flags: 'a', mode: 0o600 }),
  children = [];
let stopping = false;
writeFileSync(
  '.local/d2-ui-current.json',
  JSON.stringify({ database: f.name, webPort: env.WEB_PORT }) + '\n',
  { mode: 0o600 },
);
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
  'D2 isolated UI http://127.0.0.1:5473 ; accounts only in .local/d2-test-last.json. Offline research samples remain labelled.',
);
