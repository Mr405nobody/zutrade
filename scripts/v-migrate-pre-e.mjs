import { loadEnvFile } from 'node:process';
import { readFileSync, writeFileSync, mkdtempSync, cpSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pg, drizzle, migrate, createQueue, IDENTITY_QUEUE } from '@zutrade/db';
loadEnvFile('.env');
if (!/^\/zutrade_v_test_[a-f0-9]{32}$/.test(new URL(process.env.MIGRATION_DATABASE_URL).pathname))
  throw new Error('V isolated database required');
const stage = mkdtempSync('.local/v-pre-e-');
cpSync('packages/db/migrations/business', stage, { recursive: true });
const j = JSON.parse(readFileSync(stage + '/meta/_journal.json'));
j.entries = j.entries.filter((e) => e.idx <= 18);
writeFileSync(stage + '/meta/_journal.json', JSON.stringify(j));
const pool = new pg.Pool({
  connectionString: process.env.MIGRATION_DATABASE_URL,
  application_name: 'zutrade-migration',
});
const client = await pool.connect();
let boss;
try {
  await client.query('SELECT pg_advisory_lock(20261028,1)');
  for (const area of ['business', 'auth']) {
    const folder = area === 'business' ? stage : 'packages/db/migrations/auth';
    const journal = JSON.parse(readFileSync(`${folder}/meta/_journal.json`));
    const table = `${area}_migrations`;
    const exists = await client.query('SELECT to_regclass($1) AS name', [`infra.${table}`]);
    if (exists.rows[0].name) {
      const applied = (
        await client.query(`SELECT hash,created_at FROM infra.${table} ORDER BY created_at`)
      ).rows;
      for (const row of applied) {
        const entry = journal.entries.find((e) => String(e.when) === row.created_at);
        if (
          !entry ||
          createHash('sha256')
            .update(readFileSync(`${folder}/${entry.tag}.sql`))
            .digest('hex') !== row.hash
        )
          throw new Error('Applied migration checksum mismatch');
      }
    }
    if (area === 'auth') await client.query('SET search_path=auth,pg_catalog');
    await migrate(drizzle(client), {
      migrationsFolder: folder,
      migrationsSchema: 'infra',
      migrationsTable: table,
    });
  }
  boss = createQueue(process.env.MIGRATION_DATABASE_URL, true);
  await boss.start();
  await boss.createQueue(IDENTITY_QUEUE, {
    retryLimit: 3,
    retryDelay: 2,
    retentionSeconds: 604800,
  });
  for (const name of ['a2.inbound', 'a2.delivery']) {
    await boss.createQueue(name, { retryLimit: 3, retryDelay: 2, retentionSeconds: 604800 });
  }
  await boss.createQueue('d1.research', {
    retryLimit: 2,
    retryDelay: 1,
    expireInSeconds: 200,
    heartbeatSeconds: 20,
    retentionSeconds: 604800,
  });
  await boss.createQueue('e.ai', { retryLimit: 2, retryDelay: 1, retentionSeconds: 604800 });
  await boss.createQueue('d2.followup', { retryLimit: 3, retryDelay: 2, retentionSeconds: 604800 });
  // No runtime DDL. Functions are SECURITY INVOKER in the official installation.
  await client.query(`REVOKE ALL ON SCHEMA auth,pgboss,infra FROM PUBLIC;
    REVOKE ALL ON ALL TABLES IN SCHEMA auth,pgboss,infra FROM PUBLIC;
    REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss FROM PUBLIC;
    GRANT USAGE ON SCHEMA auth TO zutrade_auth;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA auth TO zutrade_auth;
    GRANT USAGE ON SCHEMA pgboss TO zutrade_api,zutrade_worker;
    GRANT SELECT ON ALL TABLES IN SCHEMA pgboss TO zutrade_api,zutrade_worker;
    GRANT INSERT ON pgboss.job,pgboss.job_common TO zutrade_api;
    REVOKE INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA pgboss FROM zutrade_worker;
    GRANT INSERT,UPDATE,DELETE ON pgboss.job,pgboss.job_common TO zutrade_worker;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO zutrade_api,zutrade_worker;`);
  console.log(
    'Business/auth migrations and official pg-boss initialization completed; existing rows retained.',
  );
} finally {
  if (boss) await boss.stop();
  await client.query('SELECT pg_advisory_unlock(20261028,1)');
  client.release();
  await pool.end();
}
