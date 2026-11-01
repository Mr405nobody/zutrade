import { createHash, randomUUID } from 'node:crypto';
import { MockAdapter } from '@zutrade/channels';
import {
  BoundaryError,
  requireFactory,
  requireOwner,
  transaction,
  type Context,
  type pg,
} from '@zutrade/db';
import type { PgBoss } from 'pg-boss';
import { z } from 'zod';

export const INBOUND_QUEUE = 'a2.inbound';
const inputSchema = z
  .object({
    eventId: z.string().trim().min(1).max(160),
    providerMessageId: z.string().trim().min(1).max(160),
    identity: z.string().trim().min(1).max(160).nullable(),
    displayName: z.string().trim().min(1).max(80),
    body: z.string().min(1).max(10000),
    occurredAt: z.iso.datetime({ offset: true }),
    factoryId: z.uuid().nullable().optional(),
  })
  .strict();
export type SimulationInput = z.infer<typeof inputSchema>;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Must run inside the caller's authenticated workspace transaction. */
export async function injectSimulation(context: Context, boss: PgBoss, value: unknown) {
  requireOwner(context);
  const input = inputSchema.parse(value);
  const { client, member } = context;
  if (input.factoryId) await requireFactory(context, input.factoryId);
  const ws = member.workspace_id;
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `${ws}:a2-simulation-account`,
  ]);
  await client.query(
    `INSERT INTO app.channel_accounts(workspace_id,channel_kind,transport_mode,provider,external_account_key,display_name,state,configuration)
    VALUES($1,'simulation','simulation','zutrade-mock','a2-inbox','模拟消息专用账号','active','{"simulation":true,"version":"a2"}')
    ON CONFLICT(workspace_id,provider,external_account_key,transport_mode) DO NOTHING`,
    [ws],
  );
  // The same row lock is the receipt/dispatch barrier; delivery must take it first.
  const account = (
    await client.query<{ id: string; state: string }>(
      `SELECT id,state FROM app.channel_accounts
    WHERE workspace_id=$1 AND provider='zutrade-mock' AND external_account_key='a2-inbox' AND channel_kind='simulation' AND transport_mode='simulation' FOR UPDATE`,
      [ws],
    )
  ).rows[0];
  if (!account || account.state !== 'active')
    throw new BoundaryError(409, '模拟账号未启用或已暂停');
  const normalized = new MockAdapter().normalize(
    { ...input, factoryId: input.factoryId ?? null },
    account.id,
  );
  const payload = { ...normalized, factoryId: input.factoryId ?? null };
  const sha = digest(payload);
  const previous = (
    await client.query<{
      id: string;
      payload_sha256: string;
      state: string;
      normalized_thread_id: string | null;
    }>(
      `SELECT id,payload_sha256,state,normalized_thread_id FROM app.inbound_events
    WHERE workspace_id=$1 AND channel_account_id=$2 AND event_key=$3`,
      [ws, account.id, normalized.eventKey],
    )
  ).rows[0];
  if (previous) {
    if (previous.payload_sha256 !== sha) throw new BoundaryError(409, '相同入站事件 ID 的内容不同');
    return {
      receiptId: previous.id,
      state: previous.state,
      threadId: previous.normalized_thread_id,
      duplicate: true,
    };
  }
  const receiptId = randomUUID();
  const eventId = randomUUID();
  await client.query(
    `INSERT INTO app.inbound_events(id,workspace_id,channel_account_id,event_key,event_kind,provider_message_id,payload,payload_sha256,occurred_at,requested_factory_id,initiated_by_member_id)
    VALUES($1,$2,$3,$4,'simulation.message',$5,$6,$7,$8,$9,$10)`,
    [
      receiptId,
      ws,
      account.id,
      normalized.eventKey,
      normalized.providerMessageId,
      JSON.stringify(payload),
      sha,
      normalized.occurredAt,
      input.factoryId ?? null,
      member.id,
    ],
  );
  await client.query(
    `INSERT INTO app.outbox_events(id,workspace_id,event_type,aggregate_type,aggregate_id,handler_key,idempotency_key,payload)
    VALUES($1,$2,'a2.inbound-received','inbound_event',$3,$4,$5,$6)`,
    [
      eventId,
      ws,
      receiptId,
      INBOUND_QUEUE,
      `inbound:${account.id}:${normalized.eventKey}`,
      JSON.stringify({ inboundEventId: receiptId, channelAccountId: account.id }),
    ],
  );
  const jobId = await boss.send(
    INBOUND_QUEUE,
    { eventId, workspaceId: ws },
    {
      id: eventId,
      retryLimit: 3,
      retryDelay: 2,
      db: { executeSql: (text, values) => client.query(text, values) },
    },
  );
  if (!jobId) throw new Error('Inbound queue rejected event');
  await client.query(
    'UPDATE app.outbox_events SET pg_boss_job_id=$1,enqueued_at=now() WHERE id=$2',
    [jobId, eventId],
  );
  await client.query(
    `INSERT INTO app.audit_events(workspace_id,actor_member_id,actor_kind,action,aggregate_type,aggregate_id,correlation_id,details)
    VALUES($1,$2,'member','a2.simulation-injected','inbound_event',$3,$4,$5)`,
    [
      ws,
      member.id,
      receiptId,
      eventId,
      JSON.stringify({ simulation: true, channelAccountId: account.id }),
    ],
  );
  return { receiptId, state: 'pending', threadId: null, duplicate: false };
}

const jobSchema = z.object({ eventId: z.uuid(), workspaceId: z.uuid() }).strict();
const payloadSchema = z
  .object({
    eventKey: z.string(),
    providerMessageId: z.string(),
    identity: z
      .object({
        namespace: z.literal('zutrade-simulation'),
        scopeKey: z.uuid(),
        value: z.string().min(1),
      })
      .strict()
      .nullable(),
    displayName: z.string(),
    body: z.string(),
    occurredAt: z.iso.datetime(),
    simulation: z.literal(true),
    factoryId: z.uuid().nullable(),
  })
  .strict();

/** System task scope is granted only for a persisted receipt/job on the trusted account. */
export async function consumeInboundJob(pool: pg.Pool, data: unknown, jobId: string) {
  const hint = jobSchema.parse(data);
  try {
    return await transaction(pool, async (client) => {
      await client.query('SELECT app.begin_inbound_task($1,$2)', [hint.eventId, jobId]);
      await client.query('SELECT app.c_lock_workspace($1)', [hint.workspaceId]);
      const event = (
        await client.query<{
          id: string;
          workspace_id: string;
          channel_account_id: string;
          payload: unknown;
          payload_sha256: string;
          processed_at: string | null;
          initiated_by_member_id: string;
          requested_factory_id: string | null;
        }>(
          `SELECT e.* FROM app.inbound_events e JOIN app.outbox_events x ON x.workspace_id=e.workspace_id AND x.aggregate_id=e.id
      WHERE x.id=$1 AND x.pg_boss_job_id=$2 AND x.handler_key=$3 AND e.workspace_id=$4`,
          [hint.eventId, jobId, INBOUND_QUEUE, hint.workspaceId],
        )
      ).rows[0];
      if (!event) throw new BoundaryError(403, '入站任务身份不匹配');
      await client.query(
        'SELECT id FROM app.channel_accounts WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
        [event.workspace_id, event.channel_account_id],
      );
      const receipt = (
        await client.query<{ processed_at: string | null }>(
          'SELECT processed_at FROM app.inbound_events WHERE id=$1 FOR UPDATE',
          [event.id],
        )
      ).rows[0];
      if (receipt?.processed_at) return;
      const payload = payloadSchema.parse(event.payload);
      if (
        digest(payload) !== event.payload_sha256 ||
        payload.factoryId !== event.requested_factory_id
      )
        throw new BoundaryError(403, '入站内容摘要不匹配');
      if (!payload.identity) {
        // A completed queue job does not release this unresolved account barrier.
        await client.query(
          "UPDATE app.inbound_events SET state='dead',attempt_count=attempt_count+1,last_error='身份待确认：缺少可靠渠道身份' WHERE id=$1",
          [event.id],
        );
        await systemAudit(
          client,
          event.workspace_id,
          event.id,
          hint.eventId,
          'a2.inbound-needs-identity',
          { simulation: true },
          'inbound_event',
        );
        return;
      }
      if (payload.identity.scopeKey !== event.channel_account_id)
        throw new BoundaryError(403, '渠道身份作用域不匹配');
      // Provider message deduplication also covers replay under a different event key.
      const existingMessage = (
        await client.query<{ id: string; thread_id: string; content_sha256: string }>(
          `SELECT id,thread_id,content_sha256 FROM app.messages WHERE workspace_id=$1 AND channel_account_id=$2 AND provider_message_id=$3`,
          [event.workspace_id, event.channel_account_id, payload.providerMessageId],
        )
      ).rows[0];
      if (existingMessage) {
        if (
          existingMessage.content_sha256 !==
          digest({ body: payload.body, identity: payload.identity })
        ) {
          await client.query(
            "UPDATE app.inbound_events SET state='dead',attempt_count=attempt_count+1,last_error='服务方消息 ID 内容冲突，待人工确认' WHERE id=$1",
            [event.id],
          );
          await systemAudit(
            client,
            event.workspace_id,
            event.id,
            hint.eventId,
            'a2.inbound-conflict',
            { simulation: true },
            'inbound_event',
          );
          return;
        }
        await finish(client, event.id, existingMessage.thread_id, existingMessage.id);
        return;
      }
      let point = (
        await client.query<{ id: string; contact_id: string; buyer_id: string }>(
          `SELECT id,contact_id,buyer_id FROM app.contact_points WHERE workspace_id=$1 AND namespace=$2 AND scope_key=$3 AND normalized_value=$4`,
          [
            event.workspace_id,
            payload.identity.namespace,
            payload.identity.scopeKey,
            payload.identity.value,
          ],
        )
      ).rows[0];
      if (!point) {
        const buyerId = randomUUID();
        const contactId = randomUUID();
        const pointId = randomUUID();
        await client.query('INSERT INTO app.buyers(id,workspace_id,name) VALUES($1,$2,$3)', [
          buyerId,
          event.workspace_id,
          `${payload.displayName}（模拟买家）`,
        ]);
        await client.query(
          'INSERT INTO app.contacts(id,workspace_id,buyer_id,display_name) VALUES($1,$2,$3,$4)',
          [contactId, event.workspace_id, buyerId, payload.displayName],
        );
        await client.query(
          `INSERT INTO app.contact_points(id,workspace_id,contact_id,buyer_id,kind,namespace,scope_key,normalized_value,display_value)
        VALUES($1,$2,$3,$4,'provider_identity',$5,$6,$7,$7)`,
          [
            pointId,
            event.workspace_id,
            contactId,
            buyerId,
            payload.identity.namespace,
            payload.identity.scopeKey,
            payload.identity.value,
          ],
        );
        await client.query(
          `INSERT INTO app.contact_permissions(workspace_id,contact_point_id,channel_kind,purpose,status,evidence,valid_from)
        VALUES($1,$2,'simulation','service','allowed','{"source":"simulation-inbound","simulation":true}',now())`,
          [event.workspace_id, pointId],
        );
        point = { id: pointId, contact_id: contactId, buyer_id: buyerId };
      }
      if (!point.buyer_id || !point.contact_id) throw new BoundaryError(409, '渠道身份待人工确认');
      const threadKey = `simulation:${point.id}`;
      let thread = (
        await client.query<{ id: string }>(
          'SELECT id FROM app.threads WHERE workspace_id=$1 AND channel_account_id=$2 AND provider_thread_key=$3 FOR UPDATE',
          [event.workspace_id, event.channel_account_id, threadKey],
        )
      ).rows[0];
      if (!thread) {
        const threadId = randomUUID();
        const opportunityId = randomUUID();
        await client.query(
          `INSERT INTO app.threads(id,workspace_id,channel_account_id,primary_contact_point_id,provider_thread_key,subject,control_mode)
        VALUES($1,$2,$3,$4,$5,$6,'assisted')`,
          [
            threadId,
            event.workspace_id,
            event.channel_account_id,
            point.id,
            threadKey,
            `${payload.displayName} · 模拟询盘`,
          ],
        );
        await client.query(
          `INSERT INTO app.opportunities(id,workspace_id,factory_id,buyer_id,primary_contact_id,owner_member_id,title,requirements)
        VALUES($1,$2,$3,$4,$5,$6,$7,'{"source":"a2-intake","simulation":true}')`,
          [
            opportunityId,
            event.workspace_id,
            event.requested_factory_id,
            point.buyer_id,
            point.contact_id,
            event.initiated_by_member_id,
            `${payload.displayName} · 待澄清询盘`,
          ],
        );
        await client.query(
          'INSERT INTO app.opportunity_threads(workspace_id,opportunity_id,thread_id) VALUES($1,$2,$3)',
          [event.workspace_id, opportunityId, threadId],
        );
        thread = { id: threadId };
      }
      // Explicitly lock before INSERT; ingest_seq allocation is now serialized per thread.
      await client.query('SELECT id FROM app.threads WHERE id=$1 FOR UPDATE', [thread.id]);
      const messageId = randomUUID();
      await client.query(
        `INSERT INTO app.messages(id,workspace_id,channel_account_id,thread_id,transport_mode,direction,sender_kind,provider_message_id,body_text,content_sha256,delivery_state,occurred_at)
      VALUES($1,$2,$3,$4,'simulation','inbound','buyer',$5,$6,$7,'received',$8)`,
        [
          messageId,
          event.workspace_id,
          event.channel_account_id,
          thread.id,
          payload.providerMessageId,
          payload.body,
          digest({ body: payload.body, identity: payload.identity }),
          payload.occurredAt,
        ],
      );
      await client.query(
        `UPDATE app.threads SET context_revision=context_revision+1,last_inbound_at=GREATEST(COALESCE(last_inbound_at,$1::timestamptz),$1::timestamptz),last_activity_at=now() WHERE id=$2`,
        [payload.occurredAt, thread.id],
      );
      await finish(client, event.id, thread.id, messageId);
      await systemAudit(
        client,
        event.workspace_id,
        thread.id,
        hint.eventId,
        'a2.inbound-normalized',
        {
          simulation: true,
          inboundEventId: event.id,
          messageId,
          channelAccountId: event.channel_account_id,
        },
      );
    });
  } catch (error) {
    // A failed normalization must remain an account barrier. This is only an
    // error projection, never another retry scheduler or a new event identity.
    try {
      await transaction(pool, async (client) => {
        await client.query('SELECT app.begin_inbound_task($1,$2)', [hint.eventId, jobId]);
        await client.query('SELECT app.c_lock_workspace($1)', [hint.workspaceId]);
        const receipt = (
          await client.query<{ id: string; channel_account_id: string }>(
            `SELECT e.id,e.channel_account_id FROM app.inbound_events e JOIN app.outbox_events x ON x.workspace_id=e.workspace_id AND x.aggregate_id=e.id
           WHERE x.id=$1 AND x.pg_boss_job_id=$2 AND x.handler_key=$3 AND e.workspace_id=$4 AND e.processed_at IS NULL`,
            [hint.eventId, jobId, INBOUND_QUEUE, hint.workspaceId],
          )
        ).rows[0];
        if (!receipt) return;
        await client.query(
          'SELECT id FROM app.channel_accounts WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
          [hint.workspaceId, receipt.channel_account_id],
        );
        await client.query(
          `UPDATE app.inbound_events SET attempt_count=attempt_count+1,
          state=CASE WHEN attempt_count+1>=4 THEN 'dead' ELSE 'retry' END,
          last_error='标准化失败，入站屏障保留；请检查任务并重试'
          WHERE workspace_id=$1 AND id=$2 AND processed_at IS NULL`,
          [hint.workspaceId, receipt.id],
        );
        await systemAudit(
          client,
          hint.workspaceId,
          receipt.id,
          hint.eventId,
          'a2.inbound-normalization-failed',
          { simulation: true, barrierRetained: true },
          'inbound_event',
        );
      });
    } catch {
      // Invalid task/account identity or an unavailable database cannot be
      // granted a fallback context. The real pg-boss job retains the failure.
      console.error(JSON.stringify({ event: 'inbound_failure_projection_unavailable' }));
    }
    throw error;
  }
}
async function finish(client: pg.PoolClient, eventId: string, threadId: string, messageId: string) {
  await client.query(
    `UPDATE app.inbound_events SET state='processed',processed_at=now(),attempt_count=attempt_count+1,last_error=NULL,normalized_thread_id=$1,normalized_message_id=$2 WHERE id=$3`,
    [threadId, messageId, eventId],
  );
}
async function systemAudit(
  client: pg.PoolClient,
  workspaceId: string,
  aggregateId: string,
  correlationId: string,
  action: string,
  details: object,
  aggregateType = 'thread',
) {
  await client.query(
    `INSERT INTO app.audit_events(workspace_id,actor_kind,action,aggregate_type,aggregate_id,correlation_id,details)
    VALUES($1,'system',$2,$6,$3,$4,$5)`,
    [workspaceId, action, aggregateId, correlationId, JSON.stringify(details), aggregateType],
  );
}
