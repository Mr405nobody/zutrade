import { OutboundController } from './outbound-controller.js';
import { AIController } from './ai-controller.js';
import { ApprovalController } from './approval-controller.js';
import { OutreachController } from './outreach-controller.js';
import { ProspectingController } from './prospecting-controller.js';
import { SupplyController, QuotingController } from './supply-controller.js';
import 'reflect-metadata';
import { InboxController } from './inbox-controller.js';
import type { Request, Response, NextFunction } from 'express';
import { assertRuntimeRole, toNodeHandler } from '@zutrade/db';
import { IdentityController, business, auth, authPool, queue } from './identity-controller.js';
import { Controller, Get, Module, ServiceUnavailableException } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { NestFactory } from '@nestjs/core';
import { APP_VERSION, workerHealthSchema } from '@zutrade/contracts';
import type { Probe, Readiness } from '@zutrade/contracts';
import { checkDatabase, queueCompatibility } from '@zutrade/db';
import { loadConfig, log } from '@zutrade/config';
import { runtimeModes } from '@zutrade/domain';

const config = loadConfig();
const database = business;
const startedAt = new Date().toISOString();

async function checkWorker(): Promise<Probe> {
  const started = performance.now();
  try {
    const response = await fetch(`http://127.0.0.1:${config.WORKER_PORT}/health/ready`, {
      signal: AbortSignal.timeout(2200),
    });
    const worker = workerHealthSchema.parse(await response.json());
    const age = worker.heartbeatAt ? Date.now() - Date.parse(worker.heartbeatAt) : Infinity;
    const healthy =
      response.ok &&
      worker.status === 'ready' &&
      worker.database.status === 'ok' &&
      age >= -1000 &&
      age < config.WORKER_STALE_MS;
    return {
      status: healthy ? 'ok' : 'error',
      checkedAt: new Date().toISOString(),
      latencyMs: Math.round(performance.now() - started),
      detail: healthy
        ? `独立进程 · 心跳 ${worker.heartbeatAt} · 数据库检查通过`
        : `worker 未就绪：${age >= config.WORKER_STALE_MS ? '心跳已过期' : worker.database.detail}`,
      version: worker.version,
    };
  } catch {
    return {
      status: 'error',
      checkedAt: new Date().toISOString(),
      latencyMs: Math.round(performance.now() - started),
      detail: 'worker 探针不可达或响应无效，请检查独立进程与日志',
      version: null,
    };
  }
}

@Controller('health')
class HealthController {
  @Get('live')
  live() {
    return {
      service: 'api',
      status: 'alive',
      version: APP_VERSION,
      nodeVersion: process.version,
      startedAt,
      checkedAt: new Date().toISOString(),
      queue: queueCompatibility,
    };
  }

  @Get('ready')
  async ready(): Promise<Readiness> {
    const [db, worker] = await Promise.all([checkDatabase(database.pool), checkWorker()]);
    const payload: Readiness = {
      service: 'api',
      status: db.status === 'ok' && worker.status === 'ok' ? 'ready' : 'not_ready',
      version: APP_VERSION,
      nodeVersion: process.version,
      checkedAt: new Date().toISOString(),
      database: db,
      worker,
      modes: runtimeModes(config),
    };
    if (payload.status !== 'ready') throw new ServiceUnavailableException(payload);
    return payload;
  }
}

@Module({
  controllers: [
    AIController,
    OutreachController,
    ApprovalController,
    ProspectingController,
    OutboundController,
    HealthController,
    IdentityController,
    InboxController,
    SupplyController,
    QuotingController,
  ],
})
class AppModule {}

const app = await NestFactory.create<NestExpressApplication>(AppModule, {
  logger: ['error', 'warn'],
  bodyParser: false,
});
app.enableShutdownHooks();
app.getHttpAdapter().getInstance().disable('x-powered-by');
app.use(
  (
    _request: unknown,
    response: { setHeader: (name: string, value: string) => void },
    next: () => void,
  ) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  },
);
await assertRuntimeRole(database.pool);
await queue.start();
queueCompatibility.initialized = true;
app.use((request: Request, response: Response, next: NextFunction) => {
  if (request.path.startsWith('/api/auth/')) {
    const allowed = [
      '/api/auth/sign-in/email',
      '/api/auth/sign-out',
      '/api/auth/get-session',
      '/api/auth/ok',
    ];
    if (!allowed.includes(request.path)) {
      response.status(404).json({ message: '此认证入口未开放' });
      return;
    }
    void toNodeHandler(auth)(request, response);
    return;
  }
  if (request.path.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method)) {
    if (
      ![`http://127.0.0.1:${config.WEB_PORT}`, `http://127.0.0.1:${config.API_PORT}`].includes(
        request.headers.origin ?? '',
      )
    ) {
      response.status(403).json({ message: '请求来源不受信任' });
      return;
    }
  }
  next();
});
app.useBodyParser('json', { limit: '8mb' });
try {
  await app.listen(config.API_PORT, '127.0.0.1');
  log('api', 'listening', {
    address: `http://127.0.0.1:${config.API_PORT}`,
    version: APP_VERSION,
    modes: runtimeModes(config),
  });
} catch {
  log('api', 'startup_failed', { detail: 'Cannot bind API_PORT. Check port conflicts.' });
  await database.pool.end();
  process.exit(1);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void Promise.all([queue.stop(), database.pool.end(), authPool.end()]);
  });
}
