// Bounded local upgrade verification. Never resets, seeds, restores or removes a volume.
import assert from 'node:assert/strict';
import { loadEnvFile } from 'node:process';
import { mkdirSync, openSync, closeSync, cpSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createConnection } from 'node:net';
import { spawnSync } from 'node:child_process';
import { pg } from '@zutrade/db';
loadEnvFile('.env');
for (const port of [process.env.API_PORT ?? 3001, process.env.WORKER_PORT ?? 3002]) {
  const open = await new Promise((r) => {
    const s = createConnection({ host: '127.0.0.1', port: Number(port) });
    s.setTimeout(500);
    s.once('connect', () => {
      s.destroy();
      r(true);
    });
    s.once('error', () => r(false));
    s.once('timeout', () => {
      s.destroy();
      r(false);
    });
  });
  if (open)
    throw new Error('Stop daily API and worker before this local backup/upgrade verification');
}
const backup = resolve(
  '.local/outbound-upgrade-backups/' + new Date().toISOString().replace(/[:.]/g, '-'),
);
mkdirSync(backup, { recursive: true, mode: 0o700 });
const db = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
async function snapshot() {
  const rows = (
    await db.query("SELECT tablename FROM pg_tables WHERE schemaname='app' ORDER BY tablename")
  ).rows;
  const result = {};
  for (const { tablename } of rows) {
    if (!/^[a-z_]+$/.test(tablename)) throw new Error('Unexpected table name');
    result[tablename] = (
      await db.query(
        `SELECT count(*)::int AS rows,md5(COALESCE(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),'')) AS digest FROM app.${tablename} t`,
      )
    ).rows[0];
  }
  return result;
}
try {
  const before = await snapshot();
  const fd = openSync(backup + '/database.dump', 'wx', 0o600);
  try {
    const r = spawnSync(
      'docker',
      [
        'exec',
        'zutrade-postgres-1',
        'pg_dump',
        '--username',
        process.env.POSTGRES_USER,
        '--dbname',
        process.env.POSTGRES_DB,
        '--format=custom',
      ],
      { stdio: ['ignore', fd, 'pipe'], timeout: 60000 },
    );
    if (r.status !== 0) throw new Error('Local backup failed; no upgrade performed');
  } finally {
    closeSync(fd);
  }
  const privatePath = resolve(process.env.PRIVATE_DATA_DIR ?? 'data/private');
  if (existsSync(privatePath))
    cpSync(privatePath, backup + '/private', { recursive: true, errorOnExist: true, force: false });
  writeFileSync(backup + '/before.json', JSON.stringify(before, null, 2) + '\n', { mode: 0o600 });
  const migration = spawnSync(process.execPath, ['scripts/db-migrate.mjs'], {
    env: process.env,
    encoding: 'utf8',
    timeout: 60000,
  });
  if (migration.status !== 0)
    throw new Error('Migration failed; private backup retained at ' + backup);
  const after = await snapshot();
  for (const [table, value] of Object.entries(before))
    assert.deepEqual(after[table], value, table + ' changed');
  assert(after.outbound_companies);
  if (!before.outbound_companies) assert.equal(after.outbound_companies.rows, 0);
  const report = {
    at: new Date().toISOString(),
    backupCreated: true,
    existingTablesPreserved: Object.keys(before).length,
    before,
    after,
    oldRowsAndDigestsUnchanged: true,
    migrationExitCode: migration.status,
    restoreTested: false,
  };
  writeFileSync(
    'docs/build/evidence/outbound/daily-upgrade.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  writeFileSync('.local/outbound-upgrade-last.json', JSON.stringify({ backup }, null, 2) + '\n', {
    mode: 0o600,
  });
  console.log(
    'Private local backup created; incremental migration passed; all existing table row counts and digests unchanged. No seed/reset. Backup path only in .local/outbound-upgrade-last.json.',
  );
} finally {
  await db.end();
}
