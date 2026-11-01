// Dedicated process only. Never used by the interactive application.
import { loadEnvFile } from 'node:process';
import { createQueue, pg } from '@zutrade/db';
import { consumeDeliveryJob } from '@zutrade/domain';
loadEnvFile('.env');
const queue = createQueue(process.env.WORKER_DATABASE_URL);
const pool = new pg.Pool({
  connectionString: process.env.WORKER_DATABASE_URL,
  application_name: 'zutrade-c-dedicated-worker',
});
const data = JSON.parse(process.env.C_JOB_DATA),
  id = process.env.C_JOB_ID;
await queue.start();
let observedRetryCount = 0,
  fetchedJob = { id, retryCount: 0 };
async function point(name) {
  process.send?.({
    point: name,
    pid: process.pid,
    at: new Date().toISOString(),
    retryCount: observedRetryCount,
  });
  if (process.env.C_PAUSE === name)
    await new Promise((resolve) => process.once('message', resolve));
}
try {
  if (process.env.C_REPLAY !== 'true') {
    let fetched = false;
    const deadline = Date.now() + 20000;
    while (!fetched && Date.now() < deadline) {
      const jobs = await queue.fetch('a2.delivery', { batchSize: 100 });
      const target = jobs.find((j) => j.id === id);
      fetched = Boolean(target);
      if (target) {
        fetchedJob = target;
        observedRetryCount = target.retryCount;
      }
      if (!fetched) await new Promise((r) => setTimeout(r, 50));
    }
    if (!fetched) throw new Error('Target must be acquired by real pg-boss fetch');
  }
  await point(process.env.C_REPLAY === 'true' ? 'replayed-existing-job' : 'fetched');
  await consumeDeliveryJob(pool, data, id, {
    simulationUrl: process.env.SIMULATION_DATABASE_URL,

    beforeClaim: () => point('beforeClaim'),
    afterClaim: () => point('afterClaim'),
    beforeFinalCheck: () => point('beforeFinalCheck'),
    afterFinalCheck: () => point('afterFinalCheck'),
    afterAccepted: () => point('afterAccepted'),
  });
  await queue.complete('a2.delivery', fetchedJob);
  await point('done');
} finally {
  await queue.stop();
  await pool.end();
  process.disconnect?.();
}
