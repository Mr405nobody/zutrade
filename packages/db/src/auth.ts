import pg from 'pg';
import { betterAuth } from 'better-auth';
export { toNodeHandler, fromNodeHeaders } from 'better-auth/node';

export function createAuth(
  pool: pg.Pool,
  secret: string,
  webPort = 5173,
  apiPort = 3001,
  controlledInitialization = false,
) {
  return betterAuth({
    appName: 'ZuTrade',
    baseURL: `http://127.0.0.1:${apiPort}`,
    basePath: '/api/auth',
    secret,
    database: pool,
    trustedOrigins: [`http://127.0.0.1:${webPort}`, `http://127.0.0.1:${apiPort}`],
    emailAndPassword: {
      enabled: true,
      disableSignUp: !controlledInitialization,
      autoSignIn: false,
      minPasswordLength: 16,
    },
    session: { expiresIn: 60 * 60 * 12, cookieCache: { enabled: false } },
    advanced: {
      cookiePrefix: 'zutrade',
      useSecureCookies: false,
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
    },
    telemetry: { enabled: false },
  });
}
export function createAuthPool(connectionString: string) {
  const pool = new pg.Pool({
    connectionString,
    max: 3,
    options: '-c search_path=auth,pg_catalog',
    application_name: 'zutrade-auth',
    connectionTimeoutMillis: 3000,
  });
  pool.on('error', () =>
    console.error(JSON.stringify({ event: 'auth_database_idle_connection_lost' })),
  );
  return pool;
}
export type Auth = ReturnType<typeof createAuth>;
