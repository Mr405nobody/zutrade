import { PgBoss } from 'pg-boss';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BoundaryError, establishWorkspace, requireFactory, transaction } from './identity.js';
import type { Context } from './identity.js';

export const IDENTITY_QUEUE = 'a1.identity-probe';
export function createQueue(connectionString: string, initialize = false) {
  const boss = new PgBoss({
    connectionString,
    schema: 'pgboss',
    migrate: initialize,
    createSchema: initialize,
    supervise: false,
    schedule: false,
    registerInstance: false,
    reindex: false,
    monitorVacuum: false,
    application_name: initialize ? 'zutrade-queue-migration' : 'zutrade-queue-runtime',
    max: 3,
  });
  boss.on('error', () =>
    console.error(
      JSON.stringify({
        event: 'queue_error',
        detail: 'Queue operation failed; inspect availability and migration state.',
      }),
    ),
  );
  return boss;
}
export type FailurePoint = 'business' | 'outbox' | 'enqueue' | 'queue';
// Failure injection is available only to integration tests, never parsed from HTTP input.
export async function renameFactoryAndEnqueue(
  context: Context,
  boss: PgBoss,
  factoryId: string,
  name: string,
  commandId: string,
  failure?: FailurePoint,
) {
  const { client, member, user } = context;
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `${member.workspace_id}:${commandId}`,
  ]);
  await requireFactory(context, factoryId, true);
  const previous = (
    await client.query<{
      id: string;
      aggregate_id: string;
      payload: { name: string; memberId: string };
      pg_boss_job_id: string;
    }>(
      'SELECT id,aggregate_id,payload,pg_boss_job_id FROM app.outbox_events WHERE workspace_id=$1 AND handler_key=$2 AND idempotency_key=$3',
      [member.workspace_id, IDENTITY_QUEUE, commandId],
    )
  ).rows[0];
  if (previous) {
    if (
      previous.aggregate_id !== factoryId ||
      previous.payload.name !== name ||
      previous.payload.memberId !== member.id
    )
      throw new BoundaryError(409, '重复命令的内容不一致');
    return { eventId: previous.id, jobId: previous.pg_boss_job_id };
  }
  await client.query('UPDATE app.factories SET name=$1 WHERE workspace_id=$2 AND id=$3', [
    name,
    member.workspace_id,
    factoryId,
  ]);
  if (failure === 'business') throw new Error('Injected after business write');
  const eventId = randomUUID();
  const payload = { factoryId, memberId: member.id, userId: user.id, name };
  await client.query(
    `INSERT INTO app.outbox_events(id,workspace_id,event_type,aggregate_type,aggregate_id,handler_key,idempotency_key,payload)
    VALUES($1,$2,'a1.factory-renamed','factory',$3,$4,$5,$6)`,
    [eventId, member.workspace_id, factoryId, IDENTITY_QUEUE, commandId, JSON.stringify(payload)],
  );
  if (failure === 'outbox') throw new Error('Injected after outbox write');
  const jobId = await boss.send(
    failure === 'queue' ? 'a1.not-initialized' : IDENTITY_QUEUE,
    { eventId, workspaceId: member.workspace_id, userId: user.id },
    {
      id: eventId,
      retryLimit: 3,
      retryDelay: 2,
      db: { executeSql: (text, values) => client.query(text, values) },
    },
  );
  if (!jobId) throw new Error('Queue rejected event');
  if (failure === 'enqueue') throw new Error('Injected after enqueue');
  await client.query(
    'UPDATE app.outbox_events SET pg_boss_job_id=$1,enqueued_at=now() WHERE id=$2',
    [jobId, eventId],
  );
  await client.query(
    `INSERT INTO app.audit_events(workspace_id,actor_member_id,actor_kind,action,aggregate_type,aggregate_id,correlation_id,details)
    VALUES($1,$2,'member','a1.factory-renamed','factory',$3,$4,$5)`,
    [member.workspace_id, member.id, factoryId, eventId, JSON.stringify({ name, jobId })],
  );
  return { eventId, jobId };
}
const jobSchema = z.object({ eventId: z.uuid(), workspaceId: z.uuid(), userId: z.uuid() }).strict();
const eventPayload = z
  .object({ factoryId: z.uuid(), memberId: z.uuid(), userId: z.uuid(), name: z.string() })
  .strict();
export async function consumeIdentityJob(pool: pg.Pool, data: unknown, jobId: string) {
  const hint = jobSchema.parse(data);
  await transaction(pool, async (client) => {
    await client.query(`SELECT set_config('app.user_id',$1,true)`, [hint.userId]);
    const member = await establishWorkspace(client, hint.userId, hint.workspaceId);
    const activeUser = await client.query(
      "SELECT id FROM app.app_users WHERE id=$1 AND status='active'",
      [hint.userId],
    );
    if (!activeUser.rowCount) throw new BoundaryError(403, 'Task account disabled');
    const event = (
      await client.query<{ aggregate_id: string; payload: unknown; pg_boss_job_id: string }>(
        `SELECT aggregate_id,payload,pg_boss_job_id FROM app.outbox_events WHERE id=$1 AND workspace_id=$2 AND handler_key=$3 AND event_type='a1.factory-renamed'`,
        [hint.eventId, hint.workspaceId, IDENTITY_QUEUE],
      )
    ).rows[0];
    if (!event || event.pg_boss_job_id !== jobId)
      throw new BoundaryError(403, 'Task event identity mismatch');
    const payload = eventPayload.parse(event.payload);
    if (
      payload.userId !== hint.userId ||
      payload.memberId !== member.id ||
      payload.factoryId !== event.aggregate_id
    )
      throw new BoundaryError(403, 'Task actor mismatch');
    await requireFactory({ client, member }, payload.factoryId);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [hint.eventId]);
    const done = await client.query(
      `SELECT id FROM app.audit_events WHERE workspace_id=$1 AND correlation_id=$2 AND action='a1.probe-consumed'`,
      [hint.workspaceId, hint.eventId],
    );
    if (done.rowCount) return;
    await client.query(
      `INSERT INTO app.audit_events(workspace_id,actor_member_id,actor_kind,action,aggregate_type,aggregate_id,correlation_id,details)
      VALUES($1,$2,'member','a1.probe-consumed','factory',$3,$4,$5)`,
      [
        hint.workspaceId,
        member.id,
        payload.factoryId,
        hint.eventId,
        JSON.stringify({
          jobId,
          workerRole: (await client.query('SELECT current_user AS role')).rows[0].role,
        }),
      ],
    );
  });
}
