import { createHash, randomUUID } from 'node:crypto';
import { BoundaryError } from '@zutrade/db';
import type { Context, pg } from '@zutrade/db';
import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { requireThread } from './inbox.js';

export const DELIVERY_QUEUE = 'a2.delivery';
export const replyTemplates = [
  {
    id: 'quantity',
    version: 1,
    label: '确认采购数量',
    bodyText: 'Could you please confirm the quantity you need?',
  },
  {
    id: 'use',
    version: 1,
    label: '了解产品用途',
    bodyText: 'Could you please tell us how you plan to use the product?',
  },
  {
    id: 'destination',
    version: 1,
    label: '确认目的地',
    bodyText: 'Could you please confirm the destination country and city?',
  },
] as const;
const replyInput = z
  .object({
    commandId: z.uuid(),
    templateId: z.enum(['quantity', 'use', 'destination']),
    contextRevision: z.string().regex(/^[1-9]\d*$/),
  })
  .strict();
const draftInput = z
  .object({ commandId: z.uuid(), body: z.string().trim().min(1).max(10000) })
  .strict();
export function legacyCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(legacyCanonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, legacyCanonical(entry)]),
    );
  return value;
}
export const legacyHash = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(legacyCanonical(value)))
    .digest('hex');

type RequestRow = {
  id: string;
  thread_id: string;
  channel_account_id: string;
  contact_point_id: string;
  command_sha256: string;
  current_payload_version_id: string;
  dispatch_payload_version_id: string | null;
  state: string;
  intent: string;
  authorization_mode: string;
  transport_mode: string;
  created_by_member_id: string;
  provider_idempotency_key: string;
  dispatch_token: string | null;
};
type Channel = {
  id: string;
  state: string;
  channel_kind: string;
  transport_mode: string;
  provider: string;
  external_account_key: string;
  display_name: string;
};
type Contact = {
  id: string;
  namespace: string;
  scope_key: string;
  normalized_value: string;
  disabled_at: string | null;
};
type Payload = {
  id: string;
  thread_context_revision: string;
  policy_version: string;
  language_code: string;
  body_text: string;
  subject: string | null;
  body_html: string | null;
  sender_snapshot: Record<string, unknown>;
  recipients_snapshot: unknown[];
  attachment_manifest: unknown[];
  channel_payload: Record<string, unknown>;
  snapshot_sha256: string | null;
  frozen_at: string | null;
  invalidated_at: string | null;
  quote_version_id: string | null;
  requirements_revision: string | null;
};
export function legacySnapshot(
  p: Pick<
    Payload,
    | 'thread_context_revision'
    | 'policy_version'
    | 'language_code'
    | 'body_text'
    | 'subject'
    | 'body_html'
    | 'sender_snapshot'
    | 'recipients_snapshot'
    | 'attachment_manifest'
    | 'channel_payload'
  >,
) {
  return {
    contextRevision: String(p.thread_context_revision),
    policyVersion: String(p.policy_version),
    language: p.language_code,
    subject: p.subject,
    body: p.body_text,
    html: p.body_html,
    sender: p.sender_snapshot,
    recipients: p.recipients_snapshot,
    attachments: p.attachment_manifest,
    channel: p.channel_payload,
  };
}
export async function lockAccount(client: pg.PoolClient, workspaceId: string, accountId: string) {
  const row = (
    await client.query<Channel>(
      'SELECT * FROM app.channel_accounts WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
      [workspaceId, accountId],
    )
  ).rows[0];
  if (
    !row ||
    row.state !== 'active' ||
    row.transport_mode !== 'simulation' ||
    row.channel_kind !== 'simulation' ||
    row.provider !== 'zutrade-mock'
  )
    throw new BoundaryError(409, '模拟渠道不可用或已暂停');
  return row;
}
export async function eligibleContact(
  client: pg.PoolClient,
  workspaceId: string,
  contactId: string,
) {
  const point = (
    await client.query<Contact>(
      'SELECT * FROM app.contact_points WHERE workspace_id=$1 AND id=$2 FOR SHARE',
      [workspaceId, contactId],
    )
  ).rows[0];
  const permission = (
    await client.query<{ status: string; do_not_contact: boolean; valid: boolean }>(
      `SELECT status,do_not_contact,(valid_from IS NULL OR valid_from<=clock_timestamp()) AND (valid_until IS NULL OR valid_until>clock_timestamp()) AS valid
     FROM app.contact_permissions WHERE workspace_id=$1 AND contact_point_id=$2 AND channel_kind='simulation' AND purpose='service' FOR SHARE`,
      [workspaceId, contactId],
    )
  ).rows[0];
  if (
    !point ||
    point.disabled_at ||
    !permission ||
    permission.status !== 'allowed' ||
    permission.do_not_contact ||
    !permission.valid
  )
    throw new BoundaryError(409, '没有有效的模拟服务联系资格');
  return point;
}
async function previousRequest(
  context: Context,
  commandId: string,
  digest: string,
  threadId: string,
) {
  const { client, member } = context;
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `delivery:${member.workspace_id}:${commandId}`,
  ]);
  const previous = (
    await client.query<RequestRow>(
      'SELECT * FROM app.outbound_requests WHERE workspace_id=$1 AND idempotency_key=$2',
      [member.workspace_id, commandId],
    )
  ).rows[0];
  if (
    previous &&
    (previous.command_sha256 !== digest ||
      previous.thread_id !== threadId ||
      previous.created_by_member_id !== member.id)
  )
    throw new BoundaryError(409, '同一命令 ID 的内容不一致');
  return previous;
}
async function createBase(
  context: Context,
  threadId: string,
  commandId: string,
  digest: string,
  text: string,
  templateId: string | null,
  expectedRevision?: string,
) {
  const { client, member } = context;
  // Read the account identity without taking the thread lock: account -> thread is the
  // shared lock order for inbound normalization and dispatch claim.
  const initial = await requireThread(context, threadId);
  const account = templateId
    ? await lockAccount(client, member.workspace_id, initial.channel_account_id)
    : (
        await client.query<Channel>(
          'SELECT * FROM app.channel_accounts WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
          [member.workspace_id, initial.channel_account_id],
        )
      ).rows[0];
  if (!account) throw new BoundaryError(409, '渠道不存在');
  const thread = await requireThread(context, threadId, true);
  if (expectedRevision !== undefined && String(thread.context_revision) !== expectedRevision)
    throw new BoundaryError(409, '会话上下文已变化，请刷新后重新选择回复');
  if (!thread.primary_contact_point_id) throw new BoundaryError(409, '会话尚未确认收件人');
  const point = templateId
    ? await eligibleContact(client, member.workspace_id, thread.primary_contact_point_id)
    : (
        await client.query<Contact>(
          'SELECT * FROM app.contact_points WHERE workspace_id=$1 AND id=$2',
          [member.workspace_id, thread.primary_contact_point_id],
        )
      ).rows[0];
  if (!point) throw new BoundaryError(409, '会话尚未确认收件人');
  const opportunity = (
    await client.query<{ id: string; factory_id: string | null }>(
      `SELECT o.id,o.factory_id FROM app.opportunity_threads ot JOIN app.opportunities o ON o.workspace_id=ot.workspace_id AND o.id=ot.opportunity_id
     WHERE ot.workspace_id=$1 AND ot.thread_id=$2 ORDER BY o.created_at,o.id LIMIT 1`,
      [member.workspace_id, threadId],
    )
  ).rows[0];
  if (
    templateId &&
    (
      await client.query(
        "SELECT id FROM app.outbound_requests WHERE workspace_id=$1 AND (thread_id=$2 OR (channel_account_id=$3 AND contact_point_id=$4)) AND state IN('claimed','dispatching','unknown') LIMIT 1",
        [member.workspace_id, threadId, account.id, point.id],
      )
    ).rowCount
  )
    throw new BoundaryError(409, '会话仍有在途或未知请求，请先核对');
  const requestId = randomUUID();
  const payloadId = randomUUID();
  await client.query(
    `INSERT INTO app.outbound_requests(id,workspace_id,factory_id,opportunity_id,thread_id,channel_account_id,transport_mode,contact_point_id,intent,authorization_mode,state,idempotency_key,command_sha256,provider_idempotency_key,created_by_member_id)
    VALUES($1,$2,$3,$4,$5,$6,'simulation',$7,'human_reply','member_send',$8,$9,$10,$1::uuid::text,$11)`,
    [
      requestId,
      member.workspace_id,
      opportunity?.factory_id ?? null,
      opportunity?.id ?? null,
      threadId,
      account.id,
      point.id,
      templateId ? 'queued' : 'draft',
      commandId,
      digest,
      member.id,
    ],
  );
  const p = {
    thread_context_revision: String(thread.context_revision),
    policy_version: '1',
    language_code: 'en',
    subject: null,
    body_text: text,
    body_html: null,
    sender_snapshot: {
      accountId: account.id,
      provider: account.provider,
      externalAccountKey: account.external_account_key,
      displayName: account.display_name,
    },
    recipients_snapshot: [
      {
        contactPointId: point.id,
        namespace: point.namespace,
        scopeKey: point.scope_key,
        identity: point.normalized_value,
      },
    ],
    attachment_manifest: [],
    channel_payload: templateId
      ? { templateId, templateVersion: 1, simulation: true }
      : { internalDraft: true },
  };
  await client.query(
    `INSERT INTO app.outbound_payload_versions(id,workspace_id,factory_id,outbound_request_id,version_no,thread_context_revision,policy_version,language_code,body_text,sender_snapshot,recipients_snapshot,channel_payload,snapshot_sha256,frozen_at)
    VALUES($1,$2,$3,$4,1,$5,1,'en',$6,$7,$8,$9,$10,CASE WHEN $11::boolean THEN now() ELSE NULL END)`,
    [
      payloadId,
      member.workspace_id,
      opportunity?.factory_id ?? null,
      requestId,
      p.thread_context_revision,
      text,
      JSON.stringify(p.sender_snapshot),
      JSON.stringify(p.recipients_snapshot),
      JSON.stringify(p.channel_payload),
      templateId ? legacyHash(legacySnapshot(p)) : null,
      Boolean(templateId),
    ],
  );
  await client.query(
    'UPDATE app.outbound_requests SET current_payload_version_id=$1 WHERE workspace_id=$2 AND id=$3',
    [payloadId, member.workspace_id, requestId],
  );
  return { requestId, payloadId };
}
export async function saveInternalDraft(context: Context, threadId: string, input: unknown) {
  const parsed = draftInput.parse(input);
  await requireThread(context, threadId);
  const digest = legacyHash({
    kind: 'internalDraft',
    threadId,
    memberId: context.member.id,
    body: parsed.body,
  });
  const previous = await previousRequest(context, parsed.commandId, digest, threadId);
  if (previous)
    return {
      requestId: previous.id,
      payloadId: previous.current_payload_version_id,
      state: previous.state,
      reused: true,
    };
  const created = await createBase(context, threadId, parsed.commandId, digest, parsed.body, null);
  return { ...created, state: 'draft', reused: false };
}
export async function createReply(
  context: Context,
  boss: PgBoss,
  threadId: string,
  input: unknown,
) {
  const parsed = replyInput.parse(input);
  await requireThread(context, threadId);
  const template = replyTemplates.find((entry) => entry.id === parsed.templateId)!;
  const digest = legacyHash({
    kind: 'templateReply',
    threadId,
    memberId: context.member.id,
    templateId: template.id,
    templateVersion: template.version,
    contextRevision: parsed.contextRevision,
  });
  const previous = await previousRequest(context, parsed.commandId, digest, threadId);
  if (previous) {
    const event = (
      await context.client.query<{ id: string; pg_boss_job_id: string }>(
        `SELECT id,pg_boss_job_id FROM app.outbox_events WHERE workspace_id=$1 AND aggregate_id=$2 AND handler_key=$3`,
        [context.member.workspace_id, previous.id, DELIVERY_QUEUE],
      )
    ).rows[0];
    if (!event) throw new BoundaryError(409, '原请求没有可核验的队列身份');
    return {
      requestId: previous.id,
      payloadId: previous.current_payload_version_id,
      state: previous.state,
      eventId: event.id,
      jobId: event.pg_boss_job_id,
      reused: true,
    };
  }
  const created = await createBase(
    context,
    threadId,
    parsed.commandId,
    digest,
    template.bodyText,
    template.id,
    parsed.contextRevision,
  );
  const eventId = randomUUID();
  const { client, member, user } = context;
  await client.query(
    `INSERT INTO app.outbox_events(id,workspace_id,event_type,aggregate_type,aggregate_id,handler_key,idempotency_key,payload)
    VALUES($1,$2,'a2.reply-created','outbound_request',$3,$4,$5,$6)`,
    [
      eventId,
      member.workspace_id,
      created.requestId,
      DELIVERY_QUEUE,
      parsed.commandId,
      JSON.stringify({
        requestId: created.requestId,
        payloadId: created.payloadId,
        memberId: member.id,
        userId: user.id,
      }),
    ],
  );
  const jobId = await boss.send(
    DELIVERY_QUEUE,
    { eventId, workspaceId: member.workspace_id, userId: user.id },
    {
      id: eventId,
      retryLimit: 3,
      retryDelay: 2,
      db: { executeSql: (sql, values) => client.query(sql, values) },
    },
  );
  if (!jobId) throw new Error('Queue rejected delivery event');
  await client.query(
    'UPDATE app.outbox_events SET pg_boss_job_id=$1,enqueued_at=now() WHERE workspace_id=$2 AND id=$3',
    [jobId, member.workspace_id, eventId],
  );
  return { ...created, state: 'queued', eventId, jobId, reused: false };
}

export { consumeDeliveryJob } from './dispatch.js';
