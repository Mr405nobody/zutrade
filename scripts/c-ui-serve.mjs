// Reopen existing C samples only. Does not seed, overwrite history or reset data.
import { readFileSync, mkdirSync, createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
const f = JSON.parse(readFileSync('.local/c-ui-fixture.json', 'utf8'));
if (!new URL(f.env.API_DATABASE_URL).pathname.startsWith('/zutrade_c_test_'))
  throw new Error('Only retained C isolated database is allowed');
mkdirSync('.local/logs', { recursive: true });
const log = createWriteStream('.local/logs/c-ui.log', { flags: 'a', mode: 0o600 }),
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
  const c = spawn(process.execPath, args, { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(c);
  for (const stream of [c.stdout, c.stderr]) stream.on('data', (b) => log.write(b));
  c.on('exit', () => {
    if (!stopping) stop();
  });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
console.log(
  'C independent samples: http://127.0.0.1:5273 ; local accounts: .local/c-ui-accounts.json. No seed performed.',
);
