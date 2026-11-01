// Isolated dedicated process; application source has no test transport.
import { createQueue, pg } from '@zutrade/db';
import { consumeDeliveryJob, consumeFollowupJob } from '@zutrade/domain';
if (
  process.env.NODE_ENV !== 'test' ||
  !new URL(process.env.WORKER_DATABASE_URL).pathname.startsWith('/zutrade_d2_test_')
)
  throw new Error('Dedicated D2 test database required');
const queue = createQueue(process.env.WORKER_DATABASE_URL),
  pool = new pg.Pool({ connectionString: process.env.WORKER_DATABASE_URL });
await queue.start();
if (process.env.D2_JOB_ID) {
  const id = process.env.D2_JOB_ID,
    data = JSON.parse(process.env.D2_JOB_DATA);
  async function point(name) {
    process.send?.({ point: name, pid: process.pid, jobId: id, at: new Date().toISOString() });
    if (process.env.D2_PAUSE === name) await new Promise((r) => process.once('message', r));
  }
  try {
    let acquired;
    if (process.env.D2_REPLAY !== 'true') {
      const deadline = Date.now() + 15000;
      while (!acquired && Date.now() < deadline) {
        acquired = (await queue.fetch('a2.delivery', { batchSize: 100 })).find((j) => j.id === id);
        if (!acquired) await new Promise((r) => setTimeout(r, 30));
      }
      if (!acquired) throw new Error('Actual pg-boss fetch required');
    }
    await consumeDeliveryJob(pool, data, id, {
      queue,
      beforeClaim: () => point('beforeClaim'),
      afterClaim: () => point('claimed'),
      afterAccepted: () => point('accepted'),
    });
    if (acquired) await queue.complete('a2.delivery', acquired);
    await point('done');
  } finally {
    await queue.stop();
    await pool.end();
    process.disconnect?.();
  }
} else {
  for (const name of ['a2.delivery', 'd2.followup'])
    await queue.work(name, { pollingIntervalSeconds: 0.5, localConcurrency: 2 }, async (jobs) => {
      for (const job of jobs) {
        if (name === 'a2.delivery') await consumeDeliveryJob(pool, job.data, job.id, { queue });
        else await consumeFollowupJob(pool, job.data, job.id);
      }
    });
  process.send?.({ point: 'working', pid: process.pid, at: new Date().toISOString() });
  async function stop() {
    await queue.stop();
    await pool.end();
    process.disconnect?.();
  }
  process.once('SIGTERM', () => void stop());
}
