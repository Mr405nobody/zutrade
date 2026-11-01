// Read-only catalog and source-boundary inspection; no network discovery or business DML.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pg, assertRuntimeRole } from '@zutrade/db';
const f = JSON.parse(readFileSync('.local/v-test-last.json'));
const m = new pg.Pool({
  connectionString: f.env.MIGRATION_DATABASE_URL,
  options: '-c default_transaction_read_only=on',
});
const hash = (b) => createHash('sha256').update(b).digest('hex');
try {
  const roles = [];
  for (const key of ['API_DATABASE_URL', 'WORKER_DATABASE_URL']) {
    const p = new pg.Pool({ connectionString: f.env[key] });
    try {
      await assertRuntimeRole(p);
      roles.push((await p.query('SELECT current_user AS role')).rows[0]);
    } finally {
      await p.end();
    }
  }
  const tables = (
    await m.query(
      `SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relkind='r' ORDER BY c.relname`,
    )
  ).rows;
  assert.equal(tables.length, 45);
  assert.ok(
    tables.every(
      (t) => t.relrowsecurity && t.relforcerowsecurity && t.owner === 'zutrade_migrator',
    ),
  );
  const migrationRows = (
    await m.query('SELECT hash,created_at FROM infra.business_migrations ORDER BY created_at')
  ).rows;
  const journal = JSON.parse(readFileSync('packages/db/migrations/business/meta/_journal.json'));
  assert.equal(journal.entries.length, migrationRows.length);
  for (const [i, e] of journal.entries.entries()) {
    assert.equal(
      hash(readFileSync(`packages/db/migrations/business/${e.tag}.sql`)),
      migrationRows[i].hash,
    );
    assert.equal(String(e.when), migrationRows[i].created_at);
  }
  const sql = readFileSync('zutrade-build-kit/references/zutrade-schema-v1.sql');
  assert.equal(hash(sql), 'b7f72b68adce6ad161eedf66b65389cd35461ec20446a9e97fa560550c21a1fe');
  for (const path of [
    '.env',
    '.local/v-test-last.json',
    '.local/v-recovery-last.json',
    'data/private/probe',
  ])
    execFileSync('git', ['check-ignore', '-q', path]);
  const audits = (
    await m.query(
      'SELECT action,count(*)::int count FROM app.audit_events GROUP BY action ORDER BY action',
    )
  ).rows;
  assert.ok(audits.length > 0);
  const mixedModes = (
    await m.query(
      `SELECT (SELECT count(*) FROM app.outbound_requests WHERE transport_mode<>'simulation')::int nonSimulationRequests,(SELECT count(*) FROM app.contact_permissions WHERE channel_kind<>'simulation')::int realContactPermissions,(SELECT count(*) FROM app.ai_runs WHERE provider<>'zutrade-mock' OR execution_mode<>'preset')::int realAIRuns`,
    )
  ).rows[0];
  assert.ok(Object.values(mixedModes).every((n) => n === 0));
  const publicPaths = execFileSync('rg', ['--files', 'apps/web'], { encoding: 'utf8' })
    .split('\n')
    .filter((p) => p.includes('/public/'));
  const network = readFileSync('packages/prospecting/src/network.ts', 'utf8');
  assert.ok(network.includes('SSRF_DNS_REJECTED') && network.includes('AbortController'));
  const output = {
    observedAt: new Date().toISOString(),
    runtimeRoles: roles,
    tables,
    migrations: migrationRows,
    originalSql: { bytes: sql.length, sha256: hash(sql) },
    ignoredCredentialsAndBackups: true,
    webPublicPaths: publicPaths,
    audits,
    mixedModes,
    ssrf: 'Production source unchanged; negative unit and D1 integration evidence referenced by V_MATRIX.md; no real public discovery in V',
    sse: 'Fresh desktop/mobile HTTP revocation and session checks in browser evidence',
  };
  writeFileSync(
    'docs/build/evidence/v/security-audit.json',
    JSON.stringify(output, null, 2) + '\n',
  );
  console.log(
    'PASS restricted roles, all 45 FORCE RLS tables, migration checksums, ignored private materials and audit history; simulation modes only',
  );
} finally {
  await m.end();
}
