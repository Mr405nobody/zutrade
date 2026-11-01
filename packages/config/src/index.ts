import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { z } from 'zod';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const envFile = resolve(projectRoot, '.env');
if (existsSync(envFile)) loadEnvFile(envFile);

const port = z.coerce.number().int().min(1024).max(65535);
const runtimeUrl = (role: string) =>
  z.url().refine((value) => {
    const url = new URL(value);
    return (
      ['postgres:', 'postgresql:'].includes(url.protocol) &&
      url.hostname === '127.0.0.1' &&
      url.port === '55432' &&
      url.username === role
    );
  }, 'Use the designated local restricted database role.');
const schema = z.object({
  DATABASE_URL: z.url().refine((value) => {
    const url = new URL(value);
    return ['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname === '127.0.0.1';
  }, 'Use the local Docker PostgreSQL URL (127.0.0.1).'),
  API_DATABASE_URL: runtimeUrl('zutrade_api'),
  WORKER_DATABASE_URL: runtimeUrl('zutrade_worker'),
  AUTH_DATABASE_URL: runtimeUrl('zutrade_auth'),
  SIMULATION_DATABASE_URL: runtimeUrl('zutrade_simulation').optional(),
  BETTER_AUTH_SECRET: z.string().min(32),
  API_PORT: port.default(3001),
  WEB_PORT: port.default(5173),
  WORKER_PORT: port.default(3002),
  WORKER_HEARTBEAT_MS: z.coerce.number().int().min(1000).max(10000).default(5000),
  WORKER_STALE_MS: z.coerce.number().int().min(5000).max(60000).default(15000),
  PRIVATE_DATA_DIR: z.string().default('./data/private'),
  CHANNEL_MODE: z.literal('simulation').default('simulation'),
  AI_MODE: z.enum(['mock', 'preset']).default('mock'),
  PROSPECTING_MODE: z
    .enum(['live_public_directory', 'live_search_api'])
    .default('live_public_directory'),
  WORKSPACE_TIMEZONE: z.literal('Asia/Shanghai').default('Asia/Shanghai'),
  BRAVE_SEARCH_API_KEY: z.string().min(1).optional(),
  BRAVE_SEARCH_STORAGE_RIGHTS: z.enum(['confirmed', 'unconfirmed']).default('unconfirmed'),
  BRAVE_SEARCH_RIGHTS_REFERENCE: z.string().min(1).optional(),
});

export function loadConfig() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // Never render Zod input values: DATABASE_URL contains a secret.
    throw new Error(
      `Invalid configuration: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}. Run ./scripts/zu setup.`,
    );
  }
  if (new Set([parsed.data.API_PORT, parsed.data.WEB_PORT, parsed.data.WORKER_PORT]).size !== 3) {
    throw new Error('API_PORT, WEB_PORT and WORKER_PORT must differ.');
  }
  if (parsed.data.WORKER_STALE_MS < parsed.data.WORKER_HEARTBEAT_MS * 2) {
    throw new Error('WORKER_STALE_MS must be at least twice WORKER_HEARTBEAT_MS.');
  }
  return { ...parsed.data, privateDataDir: resolve(projectRoot, parsed.data.PRIVATE_DATA_DIR) };
}

export function log(service: string, event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), service, event, ...fields }));
}
