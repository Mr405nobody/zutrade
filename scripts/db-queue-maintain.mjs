import { loadEnvFile } from 'node:process';
import { createQueue, IDENTITY_QUEUE } from '@zutrade/db';
loadEnvFile('.env');
// Explicit pg-boss maintenance; retry preserves each original job/business identity.
const boss = createQueue(process.env.MIGRATION_DATABASE_URL);
try {
  await boss.start();
  for (const queue of [IDENTITY_QUEUE, 'a2.inbound', 'a2.delivery']) {
    await boss.supervise(queue);
    let retried = 0;
    const retryRequested =
      queue === IDENTITY_QUEUE
        ? process.argv.includes('--retry-failed-probes')
        : process.argv.includes('--retry-failed-inbox');
    if (retryRequested) {
      // pg-boss 12.38 findJobs has no state filter: inspect returned metadata.
      // Bound maintenance to 1,000 inspected / 100 retried jobs per queue.
      let after;
      for (let page = 0; page < 10 && retried < 100; page++) {
        const jobs = await boss.findJobs(queue, { limit: 100, ...(after ? { after } : {}) });
        for (const job of jobs) {
          if (job.state !== 'failed' || retried >= 100) continue;
          await boss.retry(queue, job.id);
          retried++;
        }
        if (jobs.length < 100) break;
        after = jobs.at(-1).id;
      }
    }
    console.log(JSON.stringify({ queue, maintained: true, retried }));
  }
} finally {
  await boss.stop();
}
