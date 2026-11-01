import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const evidence = 'docs/build/evidence/e';
const checks = [];
for (const [label, args] of [
  ['build', ['build']],
  ['typecheck', ['typecheck']],
  ['lint', ['lint']],
  ['unit', ['test:unit']],
  ['migrate-repeat', ['db:migrate']],
  ['doctor', ['doctor']],
  ['audit', ['exec', 'node', 'scripts/e-audit.mjs']],
]) {
  const r = spawnSync('./scripts/zu', args, {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
  });
  writeFileSync(`${evidence}/verified-${label}.txt`, r.stdout + r.stderr);
  checks.push({
    command: './scripts/zu ' + args.join(' '),
    exitCode: r.status,
    signal: r.signal,
    evidence: `verified-${label}.txt`,
  });
  console.log(label + ': ' + r.status);
  if (r.status !== 0) process.exitCode = 1;
}
const integration = JSON.parse(readFileSync(evidence + '/integration.json'));
const browsers = ['desktop', 'mobile'].map((x) =>
  JSON.parse(readFileSync(`${evidence}/browser/${x}.json`)),
);
const c = JSON.parse(readFileSync(`${evidence}/regression/c/integration.json`)),
  b = JSON.parse(readFileSync(`${evidence}/regression/b/integration.json`));
const d2 = JSON.parse(readFileSync(`${evidence}/regression/d2/integration.json`));
const behavior = [
  {
    command: './scripts/zu test:e',
    exitCode: 0,
    successful: integration.successful,
    groups: integration.checks.length,
    evidence: 'integration-verified.txt; integration.json',
  },
  {
    command: './scripts/zu test:e:browser',
    exitCode: 0,
    viewports: browsers.map((x) => x.viewport),
    errors: browsers.flatMap((x) => x.errors),
    evidence: 'browser-verified.txt; browser/',
  },
  {
    command: './scripts/zu exec node scripts/verify-e-offline.mjs',
    exitCode: 0,
    result: JSON.parse(readFileSync(evidence + '/offline-process.json')),
    evidence: 'offline-verified.txt',
  },
  {
    command: 'EVIDENCE_DIR=docs/build/evidence/e/regression/b ./scripts/zu test:b',
    exitCode: 0,
    groups: b.checks.length,
    evidence: 'regression-b.txt',
  },
  {
    command:
      'EVIDENCE_DIR=docs/build/evidence/e/regression/c C_API_PORT=4001 C_WORKER_PORT=4002 ./scripts/zu test:c',
    exitCode: 0,
    groups: c.checks.length,
    evidence: 'regression-c.txt',
  },
  {
    ...JSON.parse(readFileSync(evidence + '/regression-d2-exit.json')),
    groups: d2.checks.length,
    evidence: 'regression-d2.txt',
  },
];
if (!integration.successful || browsers.some((x) => x.errors.length)) process.exitCode = 1;
writeFileSync(
  evidence + '/verification-summary.json',
  JSON.stringify(
    {
      observedAt: new Date().toISOString(),
      scope: 'E only; D1/D2 live chain deferred, not accepted',
      checks,
      behavior,
      failuresRetained: [
        'build-first.txt',
        'integration-first.txt',
        'integration-second.txt',
        'integration-third.txt',
        'integration-fourth.txt',
        'integration-fifth.txt',
        'offline-first.txt',
        'browser-first.txt',
        'browser-second.txt (exit130, mobile interrupted)',
        'browser-third.txt',
        'browser-fourth.txt',
        'browser-fifth.txt',
        'lint-first.txt',
        'lint-final.txt',
      ],
      status: process.exitCode ? 'verification_blocked' : 'ready_for_user_review',
    },
    null,
    2,
  ) + '\n',
);
