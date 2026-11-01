import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgBoss } from 'pg-boss';
import type { Probe } from '@zutrade/contracts';

export const queueCompatibility = {
  name: PgBoss.name,
  version: '12.38.0',
  initialized: false,
};

export function createDatabase(connectionString: string, applicationName: string) {
  const pool = new pg.Pool({
    connectionString,
    application_name: applicationName,
    max: 3,
    connectionTimeoutMillis: 1500,
    idleTimeoutMillis: 10000,
    query_timeout: 1500,
    statement_timeout: 1500,
    allowExitOnIdle: true,
  });
  // A stopped database emits errors for idle clients as well as active queries.
  pool.on('error', () => {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        service: applicationName,
        event: 'database_idle_connection_lost',
      }),
    );
  });
  return { pool, orm: drizzle(pool) };
}

export async function checkDatabase(pool: pg.Pool): Promise<Probe> {
  const started = performance.now();
  try {
    const result = await pool.query<{
      version: string;
      version_number: string;
      role: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(`SELECT current_setting('server_version') AS version,
      current_setting('server_version_num') AS version_number,
      current_user AS role, rolsuper, rolbypassrls
      FROM pg_roles WHERE rolname = current_user`);
    const row = result.rows[0];
    if (!row) throw new Error('Unexpected database response');
    const major = Math.floor(Number(row.version_number) / 10000);
    const usable = major === 18 && !row.rolsuper && !row.rolbypassrls;
    return {
      status: usable ? 'ok' : 'error',
      checkedAt: new Date().toISOString(),
      latencyMs: Math.round(performance.now() - started),
      detail: usable
        ? `PostgreSQL ${row.version} · ${row.role}（受限角色）`
        : '需要 PostgreSQL 18 及非 superuser、无 BYPASSRLS 的运行角色',
      version: row.version,
    };
  } catch (error) {
    const rawCode =
      error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : 'CONNECTION_FAILED';
    const code = /^[A-Z0-9_]{1,40}$/.test(rawCode) ? rawCode : 'CONNECTION_FAILED';
    return {
      status: 'error',
      checkedAt: new Date().toISOString(),
      latencyMs: Math.round(performance.now() - started),
      detail: `PostgreSQL 连接不可用（${code}）`,
      version: null,
    };
  }
}

export { default as pg } from 'pg';
export { drizzle } from 'drizzle-orm/node-postgres';
export { migrate } from 'drizzle-orm/node-postgres/migrator';
export * from './auth.js';
export * from './identity.js';
export * from './queue.js';
export * as businessSchema from './schema.js';

export async function assertRuntimeRole(pool: pg.Pool) {
  const row = (
    await pool.query(`SELECT r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,
    EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='app'::regnamespace AND c.relowner=r.oid) AS owns_business,
    has_schema_privilege(current_user,'app','CREATE') AS app_ddl,
    has_schema_privilege(current_user,'pgboss','CREATE') AS queue_ddl
    FROM pg_roles r WHERE r.rolname=current_user`)
  ).rows[0];
  if (!row || Object.values(row).some(Boolean))
    throw new Error('Refusing an elevated business runtime role. Check A1 database provisioning.');
}
export { getTableConfig } from 'drizzle-orm/pg-core';
