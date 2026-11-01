import { loadEnvFile } from 'node:process';
import { createQueue, pg } from '@zutrade/db';
import { consumeResearchJob } from '@zutrade/domain';
import { fixtureHooks } from './d1-fixture.mjs';
loadEnvFile('.env');
if (process.env.NODE_ENV !== 'test') throw new Error('Dedicated test process only');
const queue = createQueue(process.env.WORKER_DATABASE_URL),
  pool = new pg.Pool({ connectionString: process.env.WORKER_DATABASE_URL });
await queue.start();
const id = process.env.D1_JOB_ID,
  data = JSON.parse(process.env.D1_JOB_DATA);
async function point(name, extra = {}) {
  process.send?.({ point: name, pid: process.pid, at: new Date().toISOString(), ...extra });
  if (process.env.D1_PAUSE === name) await new Promise((r) => process.once('message', r));
}
try {
  let job;
  if (process.env.D1_REPLAY !== 'true') {
    const until = Date.now() + 15000;
    while (!job && Date.now() < until) {
      job = (await queue.fetch('d1.research', { batchSize: 50 })).find((j) => j.id === id);
      if (!job) await new Promise((r) => setTimeout(r, 50));
    }
    if (!job) throw new Error('Real pg-boss fetch did not acquire target');
    await point('fetched', { retryCount: job.retryCount });
  }
  await consumeResearchJob(
    pool,
    data,
    id,
    { storageRights: false },
    {
      ...fixtureHooks(),
      afterClaim: (details) => point('claimed', details),
      afterCheckpoint: (cp) =>
        cp.cursor === 1
          ? point('checkpoint', { cursor: cp.cursor, candidates: cp.snapshot.candidates.length })
          : Promise.resolve(),
    },
  );
  if (job) await queue.complete('d1.research', job);
  await point('done');
} finally {
  await queue.stop();
  await pool.end();
  process.disconnect?.();
}
