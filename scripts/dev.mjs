import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createWriteStream, mkdirSync, existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

if (!existsSync('.env')) throw new Error('Missing .env. Run ./scripts/zu setup.');
loadEnvFile('.env');
const ports = [
  process.env.API_PORT ?? '3001',
  process.env.WORKER_PORT ?? '3002',
  process.env.WEB_PORT ?? '5173',
];
for (const port of ports) {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', () =>
      reject(new Error(`Port ${port} is occupied. Stop the existing process, then retry.`)),
    );
    probe.listen(Number(port), '127.0.0.1', () => probe.close(resolve));
  }).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
mkdirSync('.local/logs', { recursive: true, mode: 0o700 });
const definitions = {
  api: ['--watch', 'apps/api/dist/main.js'],
  worker: ['--watch', 'apps/worker/dist/main.js'],
  web: [
    'apps/web/node_modules/vite/bin/vite.js',
    '--config',
    'apps/web/vite.config.ts',
    'apps/web',
  ],
};
const children = [];
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
}
for (const [name, args] of Object.entries(definitions)) {
  const file = createWriteStream(`.local/logs/${name}.log`, { flags: 'a', mode: 0o600 });
  const child = spawn(process.execPath, args, {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      file.write(chunk);
      process.stdout.write(`[${name}] ${chunk}`);
    });
  }
  child.on('error', (error) => {
    console.error(`${name} failed: ${error.message}`);
    process.exitCode = 1;
    stop();
  });
  child.on('exit', (code) => {
    file.end();
    if (!stopping) {
      console.error(`${name} exited (${code}); stopping the application.`);
      process.exitCode = code || 1;
      stop();
    }
  });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
console.log(`ZuTrade: http://127.0.0.1:${ports[2]} · API ${ports[0]} · worker ${ports[1]}`);
