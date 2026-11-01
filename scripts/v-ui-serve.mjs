// Reopens the retained isolated V sample. No seed, reset, or fixture transport.
import { readFileSync, mkdirSync, createWriteStream, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
const f = JSON.parse(readFileSync('.local/v-test-last.json', 'utf8'));
if (!new URL(f.env.API_DATABASE_URL).pathname.startsWith('/zutrade_v_test_'))
  throw new Error('Retained V isolated database required');
const env = { ...f.env, NODE_ENV: 'development' };
for (const port of [env.WEB_PORT, env.API_PORT, env.WORKER_PORT]) {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', () =>
      reject(new Error('V port ' + port + ' occupied; refusing to reuse unknown process')),
    );
    probe.listen(Number(port), '127.0.0.1', () => probe.close(resolve));
  });
}
mkdirSync('.local/logs', { recursive: true });
const log = createWriteStream('.local/logs/v-ui.log', { flags: 'a', mode: 0o600 }),
  children = [];
let stopping = false;
writeFileSync(
  '.local/v-ui-current.json',
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
    if (!stopping) {
      process.exitCode = 1;
      stop();
    }
  });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
console.log(
  'V isolated UI http://127.0.0.1:5673 ; accounts only in .local/v-test-last.json. Simulation only; real D1/D2 research-chain verification remains deferred.',
);
