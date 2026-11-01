import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { loadEnvFile } from 'node:process';

loadEnvFile('.env');
const apiPort = Number(process.env.API_PORT ?? 3001);
const workerPort = Number(process.env.WORKER_PORT ?? 3002);
const apiURL = `http://127.0.0.1:${apiPort}`;
const workerURL = `http://127.0.0.1:${workerPort}`;
const results = [];
mkdirSync('docs/build/evidence', { recursive: true });
mkdirSync('.local/logs', { recursive: true });
const record = (name, detail) => {
  const entry = { name, status: 'passed', timestamp: new Date().toISOString(), detail };
  results.push(entry);
  console.log(JSON.stringify(entry));
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function command(executable, args) {
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const timer = setTimeout(() => child.kill('SIGTERM'), 150000);
  const [code] = await once(child, 'exit');
  clearTimeout(timer);
  assert.equal(code, 0, `${executable} ${args.join(' ')} failed: ${output}`);
  return output.trim();
}
async function request(base, path) {
  const response = await fetch(`${base}${path}`, {
    signal: AbortSignal.timeout(5000),
    cache: 'no-store',
  });
  return { status: response.status, body: await response.json() };
}
async function waitFor(base, expected, seconds = 35) {
  const deadline = Date.now() + seconds * 1000;
  let result;
  while (Date.now() < deadline) {
    try {
      result = await request(base, '/health/ready');
      if (result.status === expected) return result;
    } catch {
      /* Wait for bound server / heartbeat. */
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${base} status ${expected}: ${JSON.stringify(result)}`);
}
async function free(port) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', () =>
      reject(new Error(`Stop existing application on port ${port} before verify:runtime.`)),
    );
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
function start(name) {
  const file = createWriteStream(`.local/logs/verification-${name}.log`, {
    flags: 'a',
    mode: 0o600,
  });
  const child = spawn(process.execPath, [`apps/${name}/dist/main.js`], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(file, { end: false });
  child.stderr.pipe(file, { end: false });
  child.once('exit', () => file.end());
  return child;
}
async function stop(child) {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
}
const sql = (query) =>
  command('docker', [
    'exec',
    'zutrade-postgres-1',
    'psql',
    '-U',
    process.env.POSTGRES_USER,
    '-d',
    process.env.POSTGRES_DB,
    '-At',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    query,
  ]);
let api;
let worker;
let databaseStopped = false;
try {
  await free(apiPort);
  await free(workerPort);
  await command(process.execPath, ['scripts/infra.mjs', 'up']);
  const identityBefore = await sql('SELECT system_identifier::text FROM pg_control_system()');
  const schemaCount = await sql(
    "SELECT count(*) FROM pg_namespace WHERE nspname IN ('app', 'auth', 'pgboss')",
  );
  assert.equal(schemaCount, '0');
  record('stage_boundary', { installedBusinessAuthQueueSchemas: 0 });
  api = start('api');
  worker = start('worker');
  const healthy = await waitFor(apiURL, 200);
  assert.equal(healthy.body.database.status, 'ok');
  assert.equal(healthy.body.worker.status, 'ok');
  record('api_worker_database_ready', healthy);
  const firstWorker = (await request(workerURL, '/health/ready')).body.instanceId;
  await stop(worker);
  const noWorker = await waitFor(apiURL, 503);
  assert.equal(noWorker.body.database.status, 'ok');
  assert.equal(noWorker.body.worker.status, 'error');
  assert.equal((await request(apiURL, '/health/live')).status, 200);
  record('worker_stopped_api_stays_alive', noWorker);
  worker = start('worker');
  await waitFor(apiURL, 200);
  assert.notEqual((await request(workerURL, '/health/ready')).body.instanceId, firstWorker);
  record('worker_restarted', { status: 200, newInstance: true });
  await command(process.execPath, ['scripts/infra.mjs', 'stop']);
  databaseStopped = true;
  const noDatabase = await waitFor(apiURL, 503);
  assert.equal(noDatabase.body.database.status, 'error');
  const failedWorker = await waitFor(workerURL, 503);
  assert.equal(failedWorker.body.database.status, 'error');
  assert.equal((await request(apiURL, '/health/live')).status, 200);
  record('database_stopped_readiness_fails', {
    api: noDatabase,
    worker: failedWorker,
    liveStatus: 200,
  });
  await command(process.execPath, ['scripts/infra.mjs', 'start']);
  databaseStopped = false;
  await waitFor(apiURL, 200);
  const identityAfter = await sql('SELECT system_identifier::text FROM pg_control_system()');
  assert.equal(identityAfter, identityBefore);
  record('database_restart_volume_preserved', {
    systemIdentifierBefore: identityBefore,
    systemIdentifierAfter: identityAfter,
    readiness: 200,
  });
  await command(process.execPath, ['scripts/infra.mjs', 'up']);
  assert.equal(
    await sql('SELECT system_identifier::text FROM pg_control_system()'),
    identityBefore,
  );
  record('repeat_infra_up_is_safe', { readiness: (await waitFor(apiURL, 200)).status });
  await stop(api);
  await stop(worker);
  api = start('api');
  worker = start('worker');
  record('application_process_restart', { readiness: (await waitFor(apiURL, 200)).status });
  writeFileSync(
    'docs/build/evidence/runtime.json',
    JSON.stringify({ checkedAt: new Date().toISOString(), exitCode: 0, results }, null, 2) + '\n',
  );
} catch (error) {
  writeFileSync(
    'docs/build/evidence/runtime.json',
    JSON.stringify(
      { checkedAt: new Date().toISOString(), exitCode: 1, error: String(error), results },
      null,
      2,
    ) + '\n',
  );
  throw error;
} finally {
  if (databaseStopped) await command(process.execPath, ['scripts/infra.mjs', 'start']);
  await stop(api);
  await stop(worker);
}
