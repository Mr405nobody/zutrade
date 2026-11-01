import { randomBytes } from 'node:crypto';
import { readFileSync, appendFileSync, chmodSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
loadEnvFile('.env');
const additions = {};
for (const [key, role] of Object.entries({
  MIGRATION_DATABASE_URL: 'zutrade_migrator',
  API_DATABASE_URL: 'zutrade_api',
  WORKER_DATABASE_URL: 'zutrade_worker',
  AUTH_DATABASE_URL: 'zutrade_auth',
  SIMULATION_DATABASE_URL: 'zutrade_simulation',
})) {
  if (!process.env[key]) {
    const url = new URL(process.env.DATABASE_URL);
    url.username = role;
    url.password = randomBytes(32).toString('hex');
    additions[key] = url.href;
  }
}
if (!process.env.BETTER_AUTH_SECRET) additions.BETTER_AUTH_SECRET = randomBytes(48).toString('hex');
const original = readFileSync('.env', 'utf8');
if (Object.keys(additions).length)
  appendFileSync(
    '.env',
    `${original.endsWith('\n') ? '' : '\n'}# A1 independent credentials; existing entries preserved\n${Object.entries(
      additions,
    )
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')}\n`,
  );
chmodSync('.env', 0o600);
console.log('A1 local credentials prepared; existing values preserved. No credentials printed.');
