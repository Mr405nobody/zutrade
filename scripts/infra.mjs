import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
if (!existsSync('.env')) {
  console.error('Missing .env. Run ./scripts/zu setup.');
  process.exit(1);
}
const composePlugin = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' });
const executable = composePlugin.status === 0 ? 'docker' : 'docker-compose';
const args = composePlugin.status === 0 ? ['compose'] : [];
const action = process.argv[2];
const actions = {
  up: ['up', '-d', '--wait', '--wait-timeout', '120'],
  stop: ['stop', 'postgres'],
  start: ['start', '--wait', '--wait-timeout', '120', 'postgres'],
  status: ['ps'],
  logs: ['logs', '--tail', '80', 'postgres'],
};
if (!(action in actions)) throw new Error('Unknown infrastructure command.');
const result = spawnSync(
  executable,
  [...args, '--env-file', '.env', '-f', 'infra/compose.yaml', ...actions[action]],
  { stdio: 'inherit' },
);
if (result.error) console.error('Docker / Compose missing. See docs/build/HANDOFF.md.');
process.exit(result.status ?? 1);
