import { loadEnvFile } from 'node:process';
import { createAuth, createAuthPool } from '@zutrade/db';
loadEnvFile('.env');
// Official Kysely SQL generator targets the isolated auth search_path.
export const auth = createAuth(
  createAuthPool(process.env.AUTH_GENERATE_DATABASE_URL ?? process.env.MIGRATION_DATABASE_URL),
  process.env.BETTER_AUTH_SECRET,
);
