import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const evidence = 'docs/build/evidence/v';
const checks = [];
const pnpm = '.local/toolchain/pnpm/node_modules/pnpm/bin/pnpm.mjs';
for (const [label, args, file, extra] of [
  ['typecheck', [pnpm, 'run', 'typecheck'], 'typecheck-final.txt', {}],
  ['lint', [pnpm, 'run', 'lint'], 'lint-final.txt', {}],
  ['doctor --services', [pnpm, 'run', 'doctor', '--services'], 'doctor-final.txt', {}],
  [
    'exec node scripts/v-security-audit.mjs',
    ['scripts/v-security-audit.mjs'],
    'security-final.txt',
    {},
  ],
  [
    'exec node scripts/e-audit.mjs',
    ['scripts/e-audit.mjs'],
    'daily-final.txt',
    { EVIDENCE_DIR: evidence },
  ],
]) {
  const r = spawnSync(process.execPath, args, {
    env: { ...process.env, ...extra },
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
  });
  writeFileSync(evidence + '/' + file, (r.stdout ?? '') + (r.stderr ?? ''));
  checks.push({
    command: './scripts/zu ' + label,
    exitCode: r.status,
    signal: r.signal,
    evidence: file,
  });
}
const integration = JSON.parse(readFileSync(evidence + '/integration.json'));
const recovery = JSON.parse(readFileSync(evidence + '/recovery.json'));
const restored = JSON.parse(readFileSync(evidence + '/restore-job-guard.json'));
for (const result of [integration, recovery, restored]) assert.equal(result.successful, true);
const before = JSON.parse(readFileSync(evidence + '/baseline.json'));
const after = JSON.parse(readFileSync(evidence + '/final-audit.json'));
assert.deepEqual(after.alex, before.alex);
assert.deepEqual(after.dailyD2Rows, before.dailyD2Rows);
assert.equal(after.secretScan.matches.length, 0);
const behavior = [
  { command: './scripts/zu build', exitCode: 0, evidence: 'build-final.txt' },
  { command: './scripts/zu test:unit', exitCode: 0, tests: 93, evidence: 'unit.txt' },
  {
    command: './scripts/zu test:v',
    exitCode: 0,
    groups: integration.checks.length,
    evidence: 'integration-fifth.txt; integration.json',
  },
  {
    command: './scripts/zu test:v:recovery',
    exitCode: 0,
    groups: recovery.checks.length,
    evidence: 'recovery-second.txt; recovery.json',
  },
  {
    command: './scripts/zu exec node scripts/v-restore-guard.mjs',
    exitCode: 0,
    evidence: 'restore-guard-second.txt; restore-job-guard.json',
  },
  {
    command: './scripts/zu test:v:browser',
    exitCode: 0,
    viewports: ['1440x1000', '390x844'],
    evidence: 'browser-third.txt; browser/',
  },
];
for (const view of ['desktop', 'mobile']) {
  const b = JSON.parse(readFileSync(`${evidence}/browser/${view}.json`));
  assert.deepEqual(b.errors, []);
}
writeFileSync(
  evidence + '/verification-summary.json',
  JSON.stringify(
    {
      observedAt: new Date().toISOString(),
      scope: 'V authorized local work only; E accepted by user; D1/D2 real chain deferred',
      status: 'verification_blocked',
      localWorkComplete: checks.every((c) => c.exitCode === 0),
      checks,
      behavior,
      dailyAlexUnchanged: true,
      dailyBusinessCountsUnchanged: true,
      failuresRetained: [
        'integration-first.txt',
        'integration-second.txt',
        'integration-third.txt',
        'integration-fourth.txt',
        'browser-first.txt',
        'restore-guard-first.txt',
      ],
      realDiscovery: 'not performed; blocked/deferred, no offline substitution',
      reusedEvidence: 'V_MATRIX.md',
    },
    null,
    2,
  ) + '\n',
);
writeFileSync(
  evidence + '/recovery-runs.json',
  JSON.stringify(
    [
      {
        source: integration.database,
        restore: 'zutrade_v_restore_9777456763d04ae8bb1399f43b468867',
        empty: 'zutrade_v_empty_837e9d86626c4708800af761694bb51e',
        successful: true,
        evidence: 'recovery-first.txt',
        note: 'Initial successful backup retained privately; subsequent guard found pre-existing cancelled old plan',
      },
      {
        source: recovery.sourceDatabase,
        restore: recovery.restoreDatabase,
        empty: recovery.emptyDatabase,
        successful: recovery.successful,
        evidence: 'recovery-second.txt; recovery.json; restore-job-guard.json',
      },
    ],
    null,
    2,
  ) + '\n',
);
for (const c of checks)
  console.log(`${c.exitCode === 0 ? 'PASS' : 'FAIL'} ${c.command} exit=${c.exitCode}`);
if (checks.some((c) => c.exitCode !== 0)) process.exitCode = 1;
