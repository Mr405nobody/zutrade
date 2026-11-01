import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { MockAIProvider } from '@zutrade/ai';
if (process.argv.includes('--child')) {
  const { input, expected } = JSON.parse(readFileSync('.local/e-offline-input.json'));
  const denied = await new Promise((resolve) => {
    const socket = createConnection({ host: '1.1.1.1', port: 443 });
    socket.setTimeout(1500);
    socket.once('error', (e) => resolve(e.code));
    socket.once('connect', () => {
      socket.destroy();
      resolve('CONNECTED');
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve('TIMEOUT');
    });
  });
  assert.ok(['EPERM', 'EACCES'].includes(denied), 'Expected OS denial, got ' + denied);
  const a = await new MockAIProvider().generate(input),
    b = await new MockAIProvider().generate(input);
  assert.deepEqual(a, b);
  assert.deepEqual(a, expected);
  console.log(
    JSON.stringify({
      networkPolicy: 'OS deny network-outbound',
      probe: '1.1.1.1:443',
      denied,
      provider: 'zutrade-mock',
      scenarioId: a.scenarioId,
      replayEqual: true,
      outputMatchesDatabaseRun: true,
    }),
  );
} else {
  const r = spawnSync(
    '/usr/bin/sandbox-exec',
    [
      '-p',
      '(version 1)(allow default)(deny network-outbound)',
      process.execPath,
      'scripts/verify-e-offline.mjs',
      '--child',
    ],
    { encoding: 'utf8', timeout: 20000 },
  );
  writeFileSync('docs/build/evidence/e/offline-process.txt', r.stdout + r.stderr);
  assert.equal(r.status, 0, r.stderr);
  writeFileSync('docs/build/evidence/e/offline-process.json', r.stdout);
  console.log(
    'OS blocks all outbound network in provider process; preset replay matches PostgreSQL run.',
  );
}
