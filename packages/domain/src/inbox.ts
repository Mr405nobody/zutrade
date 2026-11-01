import { BoundaryError, requireFactory, requireOwner } from '@zutrade/db';
import type { Context } from '@zutrade/db';
import { z } from 'zod';

export interface ThreadRow {
  id: string;
  workspace_id: string;
  channel_account_id: string;
  primary_contact_point_id: string | null;
  subject: string | null;
  owner_member_id: string | null;
  takeover_member_id: string | null;
  state: string;
  control_mode: 'human' | 'assisted';
  outbound_paused: boolean;
  context_revision: string;
  row_version: string;
}
// The SQL function evaluates the complete link set, independently of factory RLS.
// Every query, command and SSE snapshot uses this same authorization gate.
export async function requireThread(
  context: Pick<Context, 'client' | 'member'>,
  threadId: string,
  lock = false,
): Promise<ThreadRow> {
  const row = (
    await context.client.query<ThreadRow>(
      `SELECT t.* FROM app.threads t WHERE t.workspace_id=$1 AND t.id=$2 AND app.can_read_thread(t.workspace_id,t.id) ${lock ? 'FOR UPDATE OF t' : ''}`,
      [context.member.workspace_id, threadId],
    )
  ).rows[0];
  if (!row) throw new BoundaryError(404, '会话不存在或访问权限已失效');
  if (
    lock &&
    !(
      await context.client.query('SELECT app.can_read_thread($1,$2) AS allowed', [
        context.member.workspace_id,
        threadId,
      ])
    ).rows[0]?.allowed
  )
    throw new BoundaryError(404, '会话访问权限已变化');
  return row;
}
const seq = z.string().regex(/^[1-9][0-9]{0,18}$/);
export const versionInput = z.object({ expectedVersion: seq }).strict();
export const readInput = z.object({ messageId: z.uuid() }).strict();
export const noteInput = z
  .object({ commandId: z.uuid(), body: z.string().trim().min(1).max(4000) })
  .strict();
export const ownerInput = z
  .object({ expectedVersion: seq, memberId: z.uuid().nullable() })
  .strict();
export const assignInput = z.object({ expectedVersion: seq, factoryId: z.uuid() }).strict();
function version(thread: ThreadRow, expected: string) {
  if (thread.row_version !== expected)
    throw new BoundaryError(409, '会话已被另一成员修改，请刷新后重试');
}
async function audit(context: Context, action: string, id: string, details: object) {
  await context.client.query(
    `INSERT INTO app.audit_events(workspace_id,actor_member_id,actor_kind,action,aggregate_type,aggregate_id,details) VALUES($1,$2,'member',$3,'thread',$4,$5)`,
    [context.member.workspace_id, context.member.id, action, id, JSON.stringify(details)],
  );
}
export async function listThreads(context: Context, cursor?: string, exactId?: string) {
  const rows = (
    await context.client.query(
      `SELECT t.id,t.subject,t.owner_member_id,t.takeover_member_id,t.control_mode,t.outbound_paused,t.row_version,t.context_revision,t.last_activity_at,t.updated_at,
    cp.display_value AS channel_identity,c.display_name AS contact_name,b.name AS buyer_name,ou.display_name AS owner_name,tu.display_name AS takeover_name,
    (SELECT body_text FROM app.messages m WHERE m.workspace_id=t.workspace_id AND m.thread_id=t.id ORDER BY ingest_seq DESC LIMIT 1) AS preview,
    COALESCE((SELECT max(ingest_seq)::text FROM app.messages m WHERE m.workspace_id=t.workspace_id AND m.thread_id=t.id),'0') AS latest_ingest_seq,
    (SELECT count(*)::int FROM app.messages m WHERE m.workspace_id=t.workspace_id AND m.thread_id=t.id AND m.direction='inbound' AND m.ingest_seq>COALESCE((SELECT rm.ingest_seq FROM app.thread_reads tr JOIN app.messages rm ON rm.workspace_id=tr.workspace_id AND rm.id=tr.last_read_message_id WHERE tr.workspace_id=t.workspace_id AND tr.thread_id=t.id AND tr.member_id=$2),0)) AS unread_count,
    COALESCE((SELECT jsonb_agg(DISTINCT jsonb_build_object('id',f.id,'name',f.name)) FROM app.opportunity_threads ot JOIN app.opportunities o ON o.workspace_id=ot.workspace_id AND o.id=ot.opportunity_id JOIN app.factories f ON f.workspace_id=o.workspace_id AND f.id=o.factory_id WHERE ot.workspace_id=t.workspace_id AND ot.thread_id=t.id),'[]') AS factories,
    EXISTS(SELECT 1 FROM app.opportunity_threads ot JOIN app.opportunities o ON o.workspace_id=ot.workspace_id AND o.id=ot.opportunity_id WHERE ot.workspace_id=t.workspace_id AND ot.thread_id=t.id AND o.factory_id IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM app.opportunity_threads ot JOIN app.opportunities o ON o.workspace_id=ot.workspace_id AND o.id=ot.opportunity_id WHERE ot.workspace_id=t.workspace_id AND ot.thread_id=t.id AND o.factory_id IS NULL) AS assigned
    FROM app.threads t LEFT JOIN app.contact_points cp ON cp.workspace_id=t.workspace_id AND cp.id=t.primary_contact_point_id
    LEFT JOIN app.contacts c ON c.workspace_id=cp.workspace_id AND c.id=cp.contact_id LEFT JOIN app.buyers b ON b.workspace_id=cp.workspace_id AND b.id=cp.buyer_id
    LEFT JOIN app.workspace_members om ON om.workspace_id=t.workspace_id AND om.id=t.owner_member_id LEFT JOIN app.app_users ou ON ou.id=om.user_id
    LEFT JOIN app.workspace_members tm ON tm.workspace_id=t.workspace_id AND tm.id=t.takeover_member_id LEFT JOIN app.app_users tu ON tu.id=tm.user_id
    WHERE t.workspace_id=$1 AND app.can_read_thread(t.workspace_id,t.id) AND ($3::uuid IS NULL OR t.id>$3::uuid) AND ($4::uuid IS NULL OR t.id=$4::uuid) ORDER BY t.id LIMIT 31`,
      [context.member.workspace_id, context.member.id, cursor ?? null, exactId ?? null],
    )
  ).rows;
  return { items: rows.slice(0, 30), next_cursor: rows.length > 30 ? rows[29]?.id : null };
}
export async function threadDetail(context: Context, threadId: string) {
  await requireThread(context, threadId);
  const all = (await listThreads(context, undefined, threadId)).items[0];
  if (!all) throw new BoundaryError(404, '会话访问权限已失效');
  const notes = (
    await context.client.query(
      `SELECT n.id,n.body,n.created_at,u.display_name AS author_name FROM app.team_notes n JOIN app.workspace_members wm ON wm.workspace_id=n.workspace_id AND wm.id=n.author_member_id JOIN app.app_users u ON u.id=wm.user_id WHERE n.workspace_id=$1 AND n.thread_id=$2 ORDER BY n.created_at DESC,n.id LIMIT 50`,
      [context.member.workspace_id, threadId],
    )
  ).rows;
  const drafts = (
    await context.client.query(
      `SELECT r.id,p.body_text AS body,r.created_at FROM app.outbound_requests r JOIN app.outbound_payload_versions p ON p.workspace_id=r.workspace_id AND p.outbound_request_id=r.id AND p.id=r.current_payload_version_id WHERE r.workspace_id=$1 AND r.thread_id=$2 AND r.state='draft' AND p.channel_payload->>'internalDraft'='true' ORDER BY r.created_at DESC LIMIT 20`,
      [context.member.workspace_id, threadId],
    )
  ).rows;
  const outbound_requests = (
    await context.client.query(
      `SELECT r.id,r.state AS status,p.body_text AS body,r.stop_reason AS error,r.created_at FROM app.outbound_requests r LEFT JOIN app.outbound_payload_versions p ON p.workspace_id=r.workspace_id AND p.id=r.current_payload_version_id WHERE r.workspace_id=$1 AND r.thread_id=$2 AND r.state<>'draft' ORDER BY r.created_at DESC LIMIT 30`,
      [context.member.workspace_id, threadId],
    )
  ).rows;
  const authorized_members = (
    await context.client.query(
      `SELECT m.id,u.display_name FROM app.workspace_members m JOIN app.app_users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.status='active' AND u.status='active' AND (m.role='owner' OR (EXISTS(SELECT 1 FROM app.opportunity_threads ot WHERE ot.workspace_id=$1 AND ot.thread_id=$2) AND NOT EXISTS(SELECT 1 FROM app.opportunity_threads ot JOIN app.opportunities o ON o.workspace_id=ot.workspace_id AND o.id=ot.opportunity_id WHERE ot.workspace_id=$1 AND ot.thread_id=$2 AND (o.factory_id IS NULL OR NOT(m.all_factories OR EXISTS(SELECT 1 FROM app.factory_memberships fm WHERE fm.workspace_id=m.workspace_id AND fm.member_id=m.id AND fm.factory_id=o.factory_id)))))) ORDER BY u.display_name`,
      [context.member.workspace_id, threadId],
    )
  ).rows;
  return { thread: all, notes, drafts, outbound_requests, authorized_members };
}
export async function threadMessages(
  context: Context,
  id: string,
  query: { before?: string; after?: string; limit?: number } = {},
) {
  // Serialize cursor queries with writers: all writers lock this thread before INSERT.
  await requireThread(context, id, true);
  const limit = Math.max(1, Math.min(query.limit ?? 30, 100));
  const rows = (
    await context.client.query(
      `SELECT id,body_text AS body,direction,sender_kind,ingest_seq,occurred_at,created_at,delivery_state AS status FROM app.messages WHERE workspace_id=$1 AND thread_id=$2 AND ($3::bigint IS NULL OR ingest_seq<$3) AND ($4::bigint IS NULL OR ingest_seq>$4) ORDER BY ingest_seq ${query.after ? 'ASC' : 'DESC'} LIMIT $5`,
      [context.member.workspace_id, id, query.before ?? null, query.after ?? null, limit + 1],
    )
  ).rows;
  const items = rows.slice(0, limit);
  if (!query.after) items.reverse();
  return {
    items,
    next_cursor:
      rows.length > limit ? (query.after ? items.at(-1)?.ingest_seq : items[0]?.ingest_seq) : null,
  };
}
export async function markThreadRead(context: Context, id: string, messageId: string) {
  await requireThread(context, id, true);
  const target = (
    await context.client.query(
      `SELECT id,ingest_seq FROM app.messages WHERE workspace_id=$1 AND thread_id=$2 AND id=$3`,
      [context.member.workspace_id, id, messageId],
    )
  ).rows[0];
  if (!target) throw new BoundaryError(400, '已读位置必须属于当前会话');
  await context.client.query(
    `INSERT INTO app.thread_reads(workspace_id,thread_id,member_id,last_read_message_id) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,thread_id,member_id) DO UPDATE SET last_read_message_id=EXCLUDED.last_read_message_id,read_at=now() WHERE (SELECT ingest_seq FROM app.messages WHERE workspace_id=$1 AND id=app.thread_reads.last_read_message_id)<$5 OR app.thread_reads.last_read_message_id IS NULL`,
    [context.member.workspace_id, id, context.member.id, messageId, target.ingest_seq],
  );
  return { read: true, ingest_seq: target.ingest_seq };
}
export async function addTeamNote(context: Context, id: string, input: z.infer<typeof noteInput>) {
  await requireThread(context, id, true);
  const old = (
    await context.client.query(
      `SELECT id,body FROM app.team_notes WHERE workspace_id=$1 AND id=$2 AND thread_id=$3 AND author_member_id=$4`,
      [context.member.workspace_id, input.commandId, id, context.member.id],
    )
  ).rows[0];
  if (old) {
    if (old.body !== input.body) throw new BoundaryError(409, '备注幂等键内容不一致');
    return old;
  }
  const row = (
    await context.client.query(
      `INSERT INTO app.team_notes(id,workspace_id,thread_id,author_member_id,body) VALUES($1,$2,$3,$4,$5) RETURNING id,body,created_at`,
      [input.commandId, context.member.workspace_id, id, context.member.id, input.body],
    )
  ).rows[0];
  await audit(context, 'a2.note-added', id, { noteId: row.id });
  return row;
}
export async function changeThreadControl(
  context: Context,
  id: string,
  action: 'claim' | 'takeover' | 'release',
  expectedVersion: string,
) {
  const thread = await requireThread(context, id, true);
  version(thread, expectedVersion);
  if (
    action === 'release' &&
    thread.takeover_member_id !== context.member.id &&
    context.member.role !== 'owner'
  )
    throw new BoundaryError(403, '只有接管人或 owner 可以释放接管');
  if (action === 'claim')
    await context.client.query(
      `UPDATE app.threads SET owner_member_id=$1 WHERE workspace_id=$2 AND id=$3`,
      [context.member.id, context.member.workspace_id, id],
    );
  else
    await context.client.query(
      `UPDATE app.threads SET control_mode=$1,takeover_member_id=$2,context_revision=context_revision+1 WHERE workspace_id=$3 AND id=$4`,
      [
        action === 'takeover' ? 'human' : 'assisted',
        action === 'takeover' ? context.member.id : null,
        context.member.workspace_id,
        id,
      ],
    );
  if (action === 'takeover') {
    const inFlight = (
      await context.client.query<{ id: string }>(
        `UPDATE app.outbound_requests SET cancel_requested_at=now(),stop_reason='人工接管发生在发送权领取后；停止后续尝试并核对本次结果'
         WHERE workspace_id=$1 AND thread_id=$2 AND state IN ('claimed','dispatching') RETURNING id`,
        [context.member.workspace_id, id],
      )
    ).rows;
    const { approvalEvent } = await import('./approval.js');
    for (const request of inFlight) {
      const approvals = (
        await context.client.query<{ id: string }>(
          `SELECT id FROM app.approvals WHERE workspace_id=$1 AND outbound_request_id=$2 AND state='approved' FOR UPDATE`,
          [context.member.workspace_id, request.id],
        )
      ).rows;
      for (const approval of approvals)
        await approvalEvent(
          context,
          approval.id,
          'revocation_too_late',
          '人工接管时发送权已领取；不能承诺本次已撤回',
        );
    }
  }
  await audit(context, `a2.${action}`, id, {});
  return requireThread(context, id);
}
export async function setThreadOwner(
  context: Context,
  id: string,
  input: z.infer<typeof ownerInput>,
) {
  const thread = await requireThread(context, id, true);
  version(thread, input.expectedVersion);
  if (input.memberId) {
    const members = (await threadDetail(context, id)).authorized_members;
    if (!members.some((m) => m.id === input.memberId))
      throw new BoundaryError(403, '该成员没有完整会话访问权限');
  }
  await context.client.query(
    `UPDATE app.threads SET owner_member_id=$1 WHERE workspace_id=$2 AND id=$3`,
    [input.memberId, context.member.workspace_id, id],
  );
  await audit(context, 'a2.owner-changed', id, { memberId: input.memberId });
  return requireThread(context, id);
}
export async function assignIntake(
  context: Context,
  id: string,
  input: z.infer<typeof assignInput>,
) {
  requireOwner(context);
  const thread = await requireThread(context, id, true);
  version(thread, input.expectedVersion);
  await requireFactory(context, input.factoryId);
  const target = (
    await context.client.query(
      `SELECT o.id FROM app.opportunity_threads ot JOIN app.opportunities o ON o.workspace_id=ot.workspace_id AND o.id=ot.opportunity_id WHERE ot.workspace_id=$1 AND ot.thread_id=$2 AND o.factory_id IS NULL FOR UPDATE OF o`,
      [context.member.workspace_id, id],
    )
  ).rows;
  if (!target.length) throw new BoundaryError(409, '会话没有待分配 intake，请刷新');
  for (const item of target)
    await context.client.query(
      `UPDATE app.opportunities SET factory_id=$1 WHERE workspace_id=$2 AND id=$3`,
      [input.factoryId, context.member.workspace_id, item.id],
    );
  await audit(context, 'a2.intake-assigned', id, { factoryId: input.factoryId });
  return requireThread(context, id);
}
export async function inboxSnapshot(context: Context) {
  // Only authorized UUIDs/revisions leave this transaction. No hidden counts or body hints.
  const rows = (
    await context.client.query(
      `SELECT t.id,t.row_version,t.context_revision,
    (SELECT max(m.ingest_seq)::text FROM app.messages m WHERE m.workspace_id=t.workspace_id AND m.thread_id=t.id) AS message,
    (SELECT max(n.created_at)::text FROM app.team_notes n WHERE n.workspace_id=t.workspace_id AND n.thread_id=t.id) AS note,
    (SELECT string_agg(r.id::text||r.state||r.row_version::text,',' ORDER BY r.id) FROM app.outbound_requests r WHERE r.workspace_id=t.workspace_id AND r.thread_id=t.id) AS requests,
    (SELECT tr.last_read_message_id::text FROM app.thread_reads tr WHERE tr.workspace_id=t.workspace_id AND tr.thread_id=t.id AND tr.member_id=$2) AS read
    FROM app.threads t WHERE t.workspace_id=$1 AND app.can_read_thread(t.workspace_id,t.id) ORDER BY t.id`,
      [context.member.workspace_id, context.member.id],
    )
  ).rows;
  return rows;
}
