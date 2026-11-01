import { loadEnvFile } from 'node:process';
loadEnvFile('.env');
export default {
  dialect: 'postgresql',
  dbCredentials: { url: process.env.MIGRATION_DATABASE_URL },
  schemaFilter: ['app'],
  out: '.local/drizzle-introspection',
};
