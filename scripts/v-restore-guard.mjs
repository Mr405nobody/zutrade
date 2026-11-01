// After byte-for-byte recovery verification, exercise a pending restored job under revoked authority.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { pg } from '@zutrade/db';
import { consumeFollowupJob } from '@zutrade/domain';
const f = JSON.parse(readFileSync('.local/v-test-last.json'));
const r = JSON.parse(readFileSync('.local/v-recovery-last.json'));
if (!/^zutrade_v_restore_[a-f0-9]{32}$/.test(r.restoredDatabase) || r.source !== f.name)
  throw new Error('Matching V restore required');
const m = new pg.Pool({ connectionString: r.env.MIGRATION_DATABASE_URL });
const worker = new pg.Pool({ connectionString: r.env.WORKER_DATABASE_URL });
const original = new pg.Pool({
  connectionString: f.env.MIGRATION_DATABASE_URL,
  options: '-c default_transaction_read_only=on',
});
try {
  const id = f.ids.flow.recoveryFollowupId;
  const source = (
    await original.query('SELECT to_jsonb(f) row FROM app.followups f WHERE id=$1', [id])
  ).rows[0].row;
  const e = (
    await m.query(
      "SELECT * FROM app.outbox_events WHERE aggregate_id=$1 AND handler_key='d2.followup' ORDER BY created_at DESC LIMIT 1",
      [id],
    )
  ).rows[0];
  const data = { eventId: e.id, workspaceId: e.workspace_id, userId: e.payload.userId };
  const count = async () =>
    Number((await m.query('SELECT count(*) n FROM simulation.invocations')).rows[0].n);
  const before = await count();
  await consumeFollowupJob(worker, data, e.pg_boss_job_id);
  assert.equal(
    (await m.query('SELECT state FROM app.followups WHERE id=$1', [id])).rows[0].state,
    'scheduled',
  );
  await m.query("UPDATE app.workspace_members SET status='disabled' WHERE id=$1", [
    f.users.sales.memberId,
  ]);
  await consumeFollowupJob(worker, data, e.pg_boss_job_id);
  const stopped = (await m.query('SELECT state,stop_reason FROM app.followups WHERE id=$1', [id]))
    .rows[0];
  assert.equal(stopped.state, 'cancelled');
  assert.match(stopped.stop_reason, /AUTHORIZED|PERMISSION/);
  assert.equal(await count(), before);
  assert.deepEqual(
    (await original.query('SELECT to_jsonb(f) row FROM app.followups f WHERE id=$1', [id])).rows[0]
      .row,
    source,
  );
  writeFileSync(
    'docs/build/evidence/v/restore-job-guard.json',
    JSON.stringify(
      {
        observedAt: new Date().toISOString(),
        database: r.restoredDatabase,
        jobId: e.pg_boss_job_id,
        followupId: id,
        beforeDue: 'scheduled, not executed',
        afterRevocation: stopped,
        providerInvocationCountBefore: before,
        providerInvocationCountAfter: await count(),
        sourceUnchanged: true,
        successful: true,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS restored future job remains scheduled before due; current revocation cancels it with no provider call; original data unchanged',
  );
} finally {
  await m.query("UPDATE app.workspace_members SET status='active' WHERE id=$1", [
    f.users.sales.memberId,
  ]);
  await Promise.all([m.end(), worker.end(), original.end()]);
}
