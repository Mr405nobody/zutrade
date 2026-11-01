import { existsSync, readFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';

let failed = false;
const report = (name, ok, detail) => {
  if (!ok) failed = true;
  console.log(JSON.stringify({ check: name, status: ok ? 'ok' : 'error', detail }));
};
const run = (bin, args) => spawnSync(bin, args, { encoding: 'utf8', timeout: 15000 });
report(
  'project_root',
  existsSync('zutrade-build-kit/MASTER_PROMPT.md') && existsSync('apps'),
  process.cwd(),
);
report(
  'architecture',
  ['arm64', 'x64'].includes(process.arch),
  `${process.platform}/${process.arch}`,
);
report(
  'node',
  process.version === `v${readFileSync('.node-version', 'utf8').trim()}`,
  process.version,
);
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
report(
  'pnpm',
  process.env.npm_config_user_agent?.startsWith(`pnpm/${manifest.packageManager.split('@')[1]} `) ??
    false,
  process.env.npm_config_user_agent?.split(' ')[0] ?? 'Run through ./scripts/zu doctor',
);
const envPresent = existsSync('.env');
report(
  'environment',
  envPresent,
  envPresent ? 'Local .env found (contents withheld)' : 'Run ./scripts/zu setup',
);
if (envPresent) loadEnvFile('.env');
const required = [
  'POSTGRES_DB',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'RUNTIME_DB_USER',
  'RUNTIME_DB_PASSWORD',
  'DATABASE_URL',
  'MIGRATION_DATABASE_URL',
  'API_DATABASE_URL',
  'WORKER_DATABASE_URL',
  'AUTH_DATABASE_URL',
  'SIMULATION_DATABASE_URL',
  'BETTER_AUTH_SECRET',
];
const missing = required.filter(
  (key) => !process.env[key] || process.env[key].includes('replace-with-'),
);
report(
  'environment_values',
  missing.length === 0,
  missing.length
    ? `Missing / placeholder values: ${missing.join(', ')}`
    : 'Required values present (contents withheld)',
);
report('dependencies', existsSync('node_modules/.modules.yaml'), 'pnpm workspace install');
report('git', run('git', ['rev-parse', '--show-toplevel']).status === 0, 'Local repository');
const digest = createHash('sha256')
  .update(readFileSync('zutrade-build-kit/references/zutrade-schema-v1.sql'))
  .digest('hex');
report(
  'original_sql',
  digest === 'b7f72b68adce6ad161eedf66b65389cd35461ec20446a9e97fa560550c21a1fe',
  digest,
);
const docker = run('docker', ['info', '--format', '{{.ServerVersion}}/{{.Architecture}}']);
report(
  'docker_daemon',
  docker.status === 0,
  docker.status === 0
    ? docker.stdout.trim()
    : 'Start Docker Desktop or: colima start --profile zutrade',
);
report(
  'compose',
  run('docker', ['compose', 'version']).status === 0 ||
    run('docker-compose', ['version']).status === 0,
  'Docker Compose plugin or standalone CLI',
);
const tcpOpen = (port) =>
  new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(port) });
    socket.setTimeout(800);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
for (const [name, port] of [
  ['web', process.env.WEB_PORT ?? 5173],
  ['api', process.env.API_PORT ?? 3001],
  ['worker', process.env.WORKER_PORT ?? 3002],
  ['postgres', process.env.POSTGRES_PORT ?? 55432],
]) {
  const occupied = await tcpOpen(port);
  let belongsToProject = false;
  if (occupied) {
    try {
      if (name === 'postgres') {
        const inspection = run('docker', [
          'inspect',
          '--format',
          '{{json .NetworkSettings.Ports}}',
          'zutrade-postgres-1',
        ]);
        belongsToProject =
          inspection.status === 0 && inspection.stdout.includes(`"HostPort":"${port}"`);
      } else {
        const response = await fetch(
          `http://127.0.0.1:${port}/${name === 'web' ? '' : 'health/live'}`,
          { signal: AbortSignal.timeout(1500) },
        );
        belongsToProject =
          name === 'web'
            ? (await response.text()).includes('<title>ZuTrade')
            : (await response.json()).service === name;
      }
    } catch {
      /* Unrelated or unreachable listener. */
    }
  }
  report(
    `port_${name}`,
    !occupied || belongsToProject,
    `${port}: ${occupied ? (belongsToProject ? 'ZuTrade listener' : 'occupied by another service') : 'available'}`,
  );
}
for (const path of ['.env', '.local/logs/probe.log', 'data/private/probe.bin']) {
  report(
    `git_ignore_${path}`,
    run('git', ['check-ignore', '-q', path]).status === 0,
    'Must stay untracked',
  );
}
const example = readFileSync('.env.example', 'utf8');
report('env_example', !/[a-f0-9]{48}/.test(example), 'No generated local secrets');
if (process.argv.includes('--services')) {
  try {
    const response = await fetch(`http://127.0.0.1:${process.env.API_PORT ?? 3001}/health/ready`, {
      signal: AbortSignal.timeout(5000),
    });
    const health = await response.json();
    report('runtime_readiness', response.ok && health.status === 'ready', health.status);
  } catch {
    report('runtime_readiness', false, 'API not reachable');
  }
}
process.exitCode = failed ? 1 : 0;
