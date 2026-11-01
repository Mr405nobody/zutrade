import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { APP_VERSION } from '@zutrade/contracts';
import type { Probe, WorkerHealth } from '@zutrade/contracts';
import {
  createDatabase,
  checkDatabase,
  queueCompatibility,
  assertRuntimeRole,
  createQueue,
  consumeIdentityJob,
  IDENTITY_QUEUE,
} from '@zutrade/db';
import { loadConfig, log } from '@zutrade/config';
import {
  runtimeModes,
  AI_QUEUE,
  consumeAIJob,
  INBOUND_QUEUE,
  DELIVERY_QUEUE,
  consumeInboundJob,
  consumeDeliveryJob,
  consumeResearchJob,
  RESEARCH_QUEUE,
  FOLLOWUP_QUEUE,
  consumeFollowupJob,
} from '@zutrade/domain';

const config = loadConfig();
const database = createDatabase(config.WORKER_DATABASE_URL, 'zutrade-worker');
const queue = createQueue(config.WORKER_DATABASE_URL);
await assertRuntimeRole(database.pool);
await queue.start();
await queue.work(
  FOLLOWUP_QUEUE,
  { pollingIntervalSeconds: 1, localConcurrency: 2 },
  async (jobs) => {
    for (const job of jobs) await consumeFollowupJob(database.pool, job.data, job.id);
  },
);
await queue.work(AI_QUEUE, { pollingIntervalSeconds: 1, localConcurrency: 2 }, async (jobs) => {
  for (const job of jobs) await consumeAIJob(database.pool, queue, job.data, job.id);
});
queueCompatibility.initialized = true;
await queue.work(
  RESEARCH_QUEUE,
  { pollingIntervalSeconds: 1, localConcurrency: 2 },
  async (jobs) => {
    for (const job of jobs)
      await consumeResearchJob(database.pool, job.data, job.id, {
        ...(config.BRAVE_SEARCH_API_KEY ? { key: config.BRAVE_SEARCH_API_KEY } : {}),
        storageRights: config.BRAVE_SEARCH_STORAGE_RIGHTS === 'confirmed',
        ...(config.BRAVE_SEARCH_RIGHTS_REFERENCE
          ? { rightsReference: config.BRAVE_SEARCH_RIGHTS_REFERENCE }
          : {}),
      });
  },
);
await queue.work(
  IDENTITY_QUEUE,
  { pollingIntervalSeconds: 1, localConcurrency: 2 },
  async (jobs) => {
    for (const job of jobs) await consumeIdentityJob(database.pool, job.data, job.id);
  },
);
for (const [name, consume] of [
  [INBOUND_QUEUE, consumeInboundJob],
  [DELIVERY_QUEUE, consumeDeliveryJob],
] as const) {
  await queue.work(name, { pollingIntervalSeconds: 1, localConcurrency: 2 }, async (jobs) => {
    for (const job of jobs) {
      if (name === DELIVERY_QUEUE)
        await consumeDeliveryJob(database.pool, job.data, job.id, { queue });
      else await consume(database.pool, job.data, job.id);
    }
  });
}
const instanceId = randomUUID();
const startedAt = new Date().toISOString();
let heartbeatAt: string | null = null;
let lastProbe: Probe = {
  status: 'unknown',
  checkedAt: startedAt,
  latencyMs: 0,
  detail: '等待首次数据库检查',
  version: null,
};
let stopping = false;
let pending: Promise<void> | undefined;

function sample(): Promise<void> {
  return (async () => {
    lastProbe = await checkDatabase(database.pool);
    heartbeatAt = new Date().toISOString();
    log('worker', 'heartbeat', {
      instanceId,
      database: lastProbe.status,
      detail: lastProbe.detail,
      queueInitialized: queueCompatibility.initialized,
    });
  })();
}

const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'GET' || !['/health/live', '/health/ready'].includes(request.url ?? '')) {
    response.writeHead(404).end(JSON.stringify({ error: 'Not found' }));
    return;
  }
  const age = heartbeatAt ? Date.now() - Date.parse(heartbeatAt) : Infinity;
  const ready =
    !stopping && lastProbe.status === 'ok' && age >= -1000 && age < config.WORKER_STALE_MS;
  const health: WorkerHealth = {
    service: 'worker',
    status: ready ? 'ready' : 'not_ready',
    version: APP_VERSION,
    nodeVersion: process.version,
    checkedAt: new Date().toISOString(),
    startedAt,
    instanceId,
    heartbeatAt,
    database: lastProbe,
    modes: runtimeModes(config),
  };
  response
    .writeHead(request.url === '/health/live' || ready ? 200 : 503)
    .end(JSON.stringify(health));
});
server.on('error', () => {
  log('worker', 'startup_failed', { detail: 'Cannot bind WORKER_PORT. Check port conflicts.' });
  process.exit(1);
});
server.listen(config.WORKER_PORT, '127.0.0.1', () => {
  log('worker', 'listening', {
    address: `http://127.0.0.1:${config.WORKER_PORT}`,
    instanceId,
    version: APP_VERSION,
  });
});
pending = sample();
const timer = setInterval(() => {
  if (!stopping) pending = sample();
}, config.WORKER_HEARTBEAT_MS);

async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  server.close();
  await pending;
  await queue.stop();
  await database.pool.end();
  log('worker', 'stopped', { instanceId });
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void shutdown();
  });
