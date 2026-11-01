import { loadEnvFile } from 'node:process';
import { pg } from '@zutrade/db';
loadEnvFile('.env');
const url = new URL(process.env.DATABASE_URL);
url.username = process.env.POSTGRES_USER;
url.password = process.env.POSTGRES_PASSWORD;
const pool = new pg.Pool({ connectionString: url.href });
const ident = (value) => '"' + value.replaceAll('"', '""') + '"';
const literal = (value) => "'" + value.replaceAll("'", "''") + "'";
try {
  const roles = Object.entries({
    MIGRATION_DATABASE_URL: 'zutrade_migrator',
    API_DATABASE_URL: 'zutrade_api',
    WORKER_DATABASE_URL: 'zutrade_worker',
    AUTH_DATABASE_URL: 'zutrade_auth',
    SIMULATION_DATABASE_URL: 'zutrade_simulation',
  });
  for (const [key, expected] of roles) {
    const roleUrl = new URL(process.env[key]);
    if (
      roleUrl.username !== expected ||
      roleUrl.hostname !== '127.0.0.1' ||
      roleUrl.port !== '55432'
    )
      throw new Error('Unexpected A1 role endpoint');
    const exists = (await pool.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [expected]))
      .rowCount;
    if (!exists)
      await pool.query(
        `CREATE ROLE ${ident(expected)} LOGIN PASSWORD ${literal(decodeURIComponent(roleUrl.password))} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`,
      );
    const actual = (
      await pool.query(
        'SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=$1',
        [expected],
      )
    ).rows[0];
    if (Object.values(actual).some(Boolean))
      throw new Error('Existing role has elevated privileges; refusing to silently alter it');
    await pool.query(
      `GRANT CONNECT ON DATABASE ${ident(process.env.POSTGRES_DB)} TO ${ident(expected)}`,
    );
  }
  await pool.query(
    `GRANT CREATE ON DATABASE ${ident(process.env.POSTGRES_DB)} TO zutrade_migrator`,
  );
  await pool.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await pool.query('CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION zutrade_migrator');
  console.log(
    'Five named restricted identities provisioned; no business DML performed by administrator.',
  );
} finally {
  await pool.end();
}
