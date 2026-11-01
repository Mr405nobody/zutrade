import {
  expectedBusinessTableNames,
  baselineBusinessTableCount,
} from './business-table-expectations.mjs';
import { loadEnvFile } from 'node:process';
import { readFileSync, writeFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pg } from '@zutrade/db';
loadEnvFile('.env');
const pool = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
try {
  const tables = (
    await pool.query(
      "SELECT schemaname,count(*)::int AS count FROM pg_tables WHERE schemaname IN('app','auth','pgboss','infra') GROUP BY schemaname ORDER BY schemaname",
    )
  ).rows;
  const roles = (
    await pool.query(
      "SELECT rolname,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname IN('zutrade_migrator','zutrade_api','zutrade_worker','zutrade_auth') ORDER BY rolname",
    )
  ).rows;
  const owners = (
    await pool.query(
      "SELECT n.nspname AS schema,pg_get_userbyid(c.relowner) AS owner,count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('app','auth','pgboss') AND c.relkind IN('r','p') GROUP BY 1,2 ORDER BY 1,2",
    )
  ).rows;
  const migrations = {
    business: (
      await pool.query('SELECT hash,created_at FROM infra.business_migrations ORDER BY created_at')
    ).rows,
    auth: (
      await pool.query('SELECT hash,created_at FROM infra.auth_migrations ORDER BY created_at')
    ).rows,
    pgboss: (await pool.query('SELECT version FROM pgboss.version')).rows,
  };
  const queues = (
    await pool.query(
      'SELECT name,state,count(*)::int AS count FROM pgboss.job GROUP BY name,state ORDER BY name,state',
    )
  ).rows;
  const original = readFileSync('zutrade-build-kit/references/zutrade-schema-v1.sql');
  const files = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    encoding: 'utf8',
  })
    .stdout.split('\0')
    .filter(Boolean);
  const sensitive = ['.env', '.local', 'data'];
  const ignored = Object.fromEntries(
    sensitive.map((p) => [
      p,
      spawnSync('git', ['check-ignore', p], { encoding: 'utf8' }).status === 0,
    ]),
  );
  const accounts = JSON.parse(readFileSync('.local/a1-accounts.json', 'utf8'));
  const a2Accounts = existsSync('.local/a2-browser-accounts.json')
    ? JSON.parse(readFileSync('.local/a2-browser-accounts.json', 'utf8'))
    : null;
  const secrets = [
    process.env.POSTGRES_PASSWORD,
    process.env.RUNTIME_DB_PASSWORD,
    process.env.BETTER_AUTH_SECRET,
    ...[
      'MIGRATION_DATABASE_URL',
      'API_DATABASE_URL',
      'WORKER_DATABASE_URL',
      'AUTH_DATABASE_URL',
    ].map((k) => decodeURIComponent(new URL(process.env[k]).password)),
    accounts.owner.password,
    accounts.sales.password,
    a2Accounts?.owner.password,
    a2Accounts?.sales.password,
  ].filter(Boolean);
  const paths = [
    ...files,
    ...readdirSync('.local/logs')
      .filter((f) => f.endsWith('.log'))
      .map((f) => '.local/logs/' + f),
  ];
  const secretMatches = [];
  for (const path of new Set(paths)) {
    if (!statSync(path).isFile()) continue;
    const bytes = readFileSync(path);
    if (secrets.some((s) => bytes.includes(Buffer.from(s)))) secretMatches.push(path);
  }
  const evidence = {
    businessTableExpectation: {
      baseline: baselineBusinessTableCount,
      current: expectedBusinessTableNames.length,
      names: expectedBusinessTableNames,
    },
    checkedAt: new Date().toISOString(),
    tables,
    roles,
    owners,
    migrations,
    queues,
    originalSql: {
      bytes: original.length,
      sha256: createHash('sha256').update(original).digest('hex'),
    },
    ignored,
    privatePermissions: Object.fromEntries(
      ['.env', '.local/a1-accounts.json', 'data/private'].map((p) => [
        p,
        (statSync(p).mode & 0o777).toString(8),
      ]),
    ),
    secretScan: { files: paths.length, matches: secretMatches },
  };
  writeFileSync(
    process.env.AUDIT_EVIDENCE_PATH ?? 'docs/build/evidence/a1/repository-database-audit.json',
    JSON.stringify(evidence, null, 2) + '\n',
  );
  if (secretMatches.length)
    throw new Error(
      'Credential text found in candidate files or logs; inspect audit paths without printing secrets',
    );
  console.log('Schema/role/migration inventory, SQL checksum and ignored-secret audit passed.');
} finally {
  await pool.end();
}
