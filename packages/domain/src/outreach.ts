import { randomUUID } from 'node:crypto';
import {
  BoundaryError,
  requireFactory,
  requireApprover,
  databaseNow,
  transaction,
  establishWorkspace,
  drizzle,
} from '@zutrade/db';
import type { Context, pg } from '@zutrade/db';
import type { PgBoss } from 'pg-boss';
import {
  demoContactSchema,
  saveBatchSchema,
  freezeBatchSchema,
  batchDecisionSchema,
  followupSchema,
  resolveLocalTime,
} from '@zutrade/contracts';
import type { BatchDraft } from '@zutrade/contracts';
import type { PrivateObjectStore } from '@zutrade/storage';
import { requireThread } from './inbox.js';
import { requireOpportunityThreads, requireQuoteVersion } from './quoting.js';
import {
  command,
  approvalEvent,
  endApproval,
  readOutbound,
  readPayload,
  quoteMail,
  attachmentForQuote,
  enqueueDelivery,
} from './approval.js';
import type { DeliveryRequest, ApprovalFailure } from './approval.js';
import { lockAccount, eligibleContact } from './delivery.js';
import { outboundHash, outboundSnapshot, normalizeOutbound } from './outbound-canonical.js';
import type { OutboundPayload } from './outbound-canonical.js';

export const FOLLOWUP_QUEUE = 'd2.followup';
const ws = (c: Context) => c.member.workspace_id;
async function audit(c: Context, action: string, kind: string, id: string, details: unknown) {
  await c.client.query(
    "INSERT INTO app.audit_events(workspace_id,actor_kind,actor_member_id,action,aggregate_type,aggregate_id,details) VALUES($1,'member',$2,$3,$4,$5,$6)",
    [ws(c), c.member.id, action, kind, id, JSON.stringify(details)],
  );
}
async function lead(c: Context, id: string) {
  const l = (
    await c.client.query(
      'SELECT l.*,b.name FROM app.leads l JOIN app.buyers b ON b.workspace_id=l.workspace_id AND b.id=l.buyer_id WHERE l.workspace_id=$1 AND l.id=$2',
      [ws(c), id],
    )
  ).rows[0];
  if (!l) throw new BoundaryError(404, '线索不存在或未获工厂授权');
  await requireFactory(c, l.factory_id);
  if (
    l.source_kind !== 'research' ||
    !l.research_snapshot.identityConfirmedBy ||
    !l.prospecting_run_id ||
    !l.research_snapshot.candidate
  )
    throw new BoundaryError(409, '仅允许已确认并导入的 D1 研究线索');
  if (['rejected', 'paused', 'do_not_contact'].includes(l.state))
    throw new BoundaryError(409, '线索已暂停、排除或禁止联系');
  const r = (
    await c.client.query(
      'SELECT review_decisions FROM app.prospecting_runs WHERE workspace_id=$1 AND id=$2',
      [ws(c), l.prospecting_run_id],
    )
  ).rows[0];
  if (r?.review_decisions[l.prospecting_candidate_key]?.decision !== 'keep')
    throw new BoundaryError(409, '研究候选已被排除或审核失效');
  return l;
}
export async function createSimulationContact(c: Context, raw: unknown) {
  requireApprover(c);
  const i = demoContactSchema.parse(raw),
    l = await lead(c, i.leadId);
  return command(c, i.commandId, 'd2.demo-contact', i, async () => {
    const a = await lockAccount(c.client, ws(c), i.accountId);
    let point = (
      await c.client.query(
        "SELECT * FROM app.contact_points WHERE workspace_id=$1 AND lead_id=$2 AND namespace='zutrade-simulation' AND scope_key=$3",
        [ws(c), l.id, a.id],
      )
    ).rows[0];
    if (!point) {
      const contact = (
        await c.client.query(
          "INSERT INTO app.contacts(workspace_id,buyer_id,display_name,identity_status) VALUES($1,$2,$3,'unverified') RETURNING id",
          [ws(c), l.buyer_id, '内部演示身份（非真实联系人） · ' + l.name],
        )
      ).rows[0];
      point = (
        await c.client.query(
          "INSERT INTO app.contact_points(workspace_id,buyer_id,kind,namespace,scope_key,normalized_value,display_value,lead_id,source_evidence,contact_id) VALUES($1,$2,'provider_identity','zutrade-simulation',$3,$4,$5,$6,$7,$8) RETURNING *",
          [
            ws(c),
            l.buyer_id,
            a.id,
            'internal-demo:' + l.id,
            '内部演示 · ' + l.name,
            l.id,
            JSON.stringify({
              origin: 'internal_demo',
              leadId: l.id,
              companySource: l.research_snapshot.origin,
              identityStatus: 'unverified',
              authorization: 'simulation_only',
              authorizedBy: c.member.id,
            }),
            contact.id,
          ],
        )
      ).rows[0];
      for (const purpose of ['service', 'outreach'])
        await c.client.query(
          "INSERT INTO app.contact_permissions(workspace_id,contact_point_id,channel_kind,purpose,status,evidence,changed_by_member_id) VALUES($1,$2,'simulation',$3,'allowed',$4,$5)",
          [
            ws(c),
            point.id,
            purpose,
            JSON.stringify({ origin: 'internal_demo', simulationOnly: true, leadId: l.id }),
            c.member.id,
          ],
        );
    }
    let t = (
      await c.client.query(
        'SELECT * FROM app.threads WHERE workspace_id=$1 AND channel_account_id=$2 AND primary_contact_point_id=$3',
        [ws(c), a.id, point.id],
      )
    ).rows[0];
    if (!t) {
      t = (
        await c.client.query(
          "INSERT INTO app.threads(workspace_id,channel_account_id,primary_contact_point_id,provider_thread_key,subject,owner_member_id,control_mode) VALUES($1,$2,$3,$4,$5,$6,'assisted') RETURNING *",
          [
            ws(c),
            a.id,
            point.id,
            'simulation:' + point.id,
            '内部模拟首触达 · ' + l.name,
            c.member.id,
          ],
        )
      ).rows[0];
      const o = (
        await c.client.query(
          'INSERT INTO app.opportunities(workspace_id,factory_id,buyer_id,lead_id,owner_member_id,title,primary_contact_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
          [
            ws(c),
            l.factory_id,
            l.buyer_id,
            l.id,
            c.member.id,
            '内部演示；未收到采购询盘 · ' + l.name,
            point.contact_id,
          ],
        )
      ).rows[0];
      await c.client.query(
        'INSERT INTO app.opportunity_threads(workspace_id,opportunity_id,thread_id) VALUES($1,$2,$3)',
        [ws(c), o.id, t.id],
      );
    }
    await audit(c, 'd2.simulation-authorized', 'lead', l.id, {
      pointId: point.id,
      threadId: t.id,
      realChannelPermissionChanged: false,
    });
    return { pointId: point.id, threadId: t.id };
  });
}
export function initialOutreachTemplate(factoryName: string, companyName: string) {
  return {
    subject: `Introduction from ${factoryName}`,
    body: `Hello ${companyName} team,\n\nWe represent ${factoryName}. May we share further product information if relevant to your work?\n\nThis is an internal simulation. No purchase interest or prior inquiry is assumed.`,
  };
}
async function batch(c: Context, id: string) {
  const b = (
    await c.client.query(
      'SELECT * FROM app.outreach_batches WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
      [ws(c), id],
    )
  ).rows[0];
  if (!b) throw new BoundaryError(404, '批次不存在或未获工厂授权');
  await requireFactory(c, b.factory_id);
  return b;
}
async function stopRequest(c: Context, id: string, reason: string) {
  const r = await readOutbound(c, id, true);
  if (['simulated', 'failed', 'cancelled'].includes(r.state)) return;
  await c.client.query(
    "UPDATE app.outbound_requests SET cancel_requested_at=clock_timestamp(),state=CASE WHEN dispatch_claimed_at IS NULL THEN 'cancelled' ELSE state END,stop_reason=$3 WHERE workspace_id=$1 AND id=$2",
    [ws(c), id, reason],
  );
  const approvals = (
    await c.client.query(
      "SELECT * FROM app.approvals WHERE workspace_id=$1 AND outbound_request_id=$2 AND state IN('pending','approved') FOR UPDATE",
      [ws(c), id],
    )
  ).rows;
  for (const a of approvals) await endApproval(c, a, 'invalidated', reason);
}
export async function saveBatchDraft(c: Context, raw: unknown) {
  const i = saveBatchSchema.parse(raw);
  await requireFactory(c, i.draft.factoryId);
  return command(c, i.commandId, 'd2.batch-draft', i, async () => {
    if (i.batchId) {
      const b = await batch(c, i.batchId);
      if (b.row_version !== i.expectedVersion || b.factory_id !== i.draft.factoryId)
        throw new BoundaryError(409, '批次版本或工厂已变化');
      return (
        await c.client.query(
          'UPDATE app.outreach_batches SET draft=$3,name=$4 WHERE workspace_id=$1 AND id=$2 RETURNING id,row_version',
          [ws(c), b.id, JSON.stringify(i.draft), i.draft.name],
        )
      ).rows[0] as { id: string; row_version: string };
    }
    return (
      await c.client.query(
        'INSERT INTO app.outreach_batches(workspace_id,factory_id,owner_member_id,name,draft) VALUES($1,$2,$3,$4,$5) RETURNING id,row_version',
        [ws(c), i.draft.factoryId, c.member.id, i.draft.name, JSON.stringify(i.draft)],
      )
    ).rows[0] as { id: string; row_version: string };
  });
}
type D2Identity = {
  origin: 'approved_batch' | 'automatic_followup';
  id: string;
  version: string;
  leadId: string | null;
};
function channel(r: DeliveryRequest, d2: D2Identity) {
  return {
    canonicalVersion: 'c-outbound-v1',
    origin: d2.origin,
    threadId: r.thread_id,
    opportunityId: r.opportunity_id,
    factoryId: r.factory_id,
    intent: r.intent,
    authorizationMode: r.authorization_mode,
    templateId: r.intent === 'outreach' ? 'd2.outreach' : 'd2.followup',
    templateVersion: 1,
    parameters: {},
    simulation: true,
    d2,
  };
}
async function createRequest(
  c: Context,
  store: PrivateObjectStore,
  input: {
    threadId: string;
    opportunityId: string;
    factoryId: string;
    quoteVersionId: string | null;
    subject: string;
    body: string;
    scheduledAt: Date;
    timeZone: string;
    d2: D2Identity;
  },
) {
  const t = await requireThread(c, input.threadId, true),
    a = await lockAccount(c.client, ws(c), t.channel_account_id);
  if (!t.primary_contact_point_id) throw new BoundaryError(409, '缺少主收件人');
  const cp = await eligibleContact(c.client, ws(c), t.primary_contact_point_id);
  if (
    (
      await c.client.query(
        "SELECT 1 FROM app.outbound_requests WHERE workspace_id=$1 AND (thread_id=$2 OR (channel_account_id=$3 AND contact_point_id=$4)) AND state IN('claimed','dispatching','unknown')",
        [ws(c), t.id, a.id, cp.id],
      )
    ).rowCount
  )
    throw new BoundaryError(409, '存在在途或 unknown 请求，先核对后再建立动作');
  const identity = (
    await c.client.query(
      'SELECT buyer_id,contact_id FROM app.contact_points WHERE workspace_id=$1 AND id=$2',
      [ws(c), cp.id],
    )
  ).rows[0];
  const o = (
    await c.client.query('SELECT * FROM app.opportunities WHERE workspace_id=$1 AND id=$2', [
      ws(c),
      input.opportunityId,
    ])
  ).rows[0];
  await requireOpportunityThreads(c, input.opportunityId);
  if (!o || o.factory_id !== input.factoryId || o.buyer_id !== identity.buyer_id)
    throw new BoundaryError(409, '商机、工厂或收件人不一致');
  const q = input.quoteVersionId ? await requireQuoteVersion(c, input.quoteVersionId) : null;
  if (
    q &&
    (!q.availability.available ||
      q.opportunity_id !== o.id ||
      q.snapshot.buyer.channelIdentity !== cp.normalized_value)
  )
    throw new BoundaryError(409, '报价已失效或与目标不一致');
  const attachment = q ? await attachmentForQuote(c, q.id, store) : null;
  const mail = q ? quoteMail(q.snapshot) : { subject: input.subject, body: input.body };
  const id = randomUUID();
  const r = (
    await c.client.query<DeliveryRequest>(
      "INSERT INTO app.outbound_requests(id,workspace_id,factory_id,opportunity_id,thread_id,channel_account_id,contact_point_id,transport_mode,intent,authorization_mode,state,idempotency_key,command_sha256,provider_idempotency_key,created_by_member_id,scheduled_at,schedule_time_zone) VALUES($1,$2,$3,$4,$5,$6,$7,'simulation',$8,$9,'awaiting_approval',$1::uuid::text,$10,$1::uuid::text,$11,$12,$13) RETURNING *",
      [
        id,
        ws(c),
        input.factoryId,
        o.id,
        t.id,
        a.id,
        cp.id,
        input.d2.origin === 'approved_batch' ? 'outreach' : 'followup',
        input.d2.origin === 'approved_batch' ? 'batch_approval' : 'human_approval',
        outboundHash({ id }),
        c.member.id,
        input.scheduledAt,
        input.timeZone,
      ],
    )
  ).rows[0]!;
  const p = normalizeOutbound({
    quote_version_id: q?.id ?? null,
    quote_snapshot_sha256: q?.snapshot_sha256 ?? null,
    thread_context_revision: String(t.context_revision),
    requirements_revision: String(o.requirements_revision),
    policy_version: '3',
    language_code: 'en',
    subject: mail.subject,
    body_text: mail.body,
    body_html: null,
    sender_snapshot: {
      accountId: a.id,
      provider: a.provider,
      externalAccountKey: a.external_account_key,
      displayName: a.display_name,
      channelKind: 'simulation',
      transportMode: 'simulation',
    },
    recipients_snapshot: [
      {
        contactPointId: cp.id,
        namespace: cp.namespace,
        scopeKey: cp.scope_key,
        identity: cp.normalized_value,
        buyerId: identity.buyer_id,
        contactId: identity.contact_id,
      },
    ],
    attachment_manifest: attachment ? [attachment.manifest] : [],
    channel_payload: channel(r, input.d2),
  });
  const pid = randomUUID(),
    sha = outboundHash(outboundSnapshot(p));
  await c.client.query(
    "INSERT INTO app.outbound_payload_versions(id,workspace_id,factory_id,outbound_request_id,version_no,quote_version_id,quote_snapshot_sha256,thread_context_revision,requirements_revision,policy_version,language_code,subject,body_text,body_html,sender_snapshot,recipients_snapshot,attachment_manifest,channel_payload) VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,3,'en',$9,$10,NULL,$11,$12,$13,$14)",
    [
      pid,
      ws(c),
      input.factoryId,
      id,
      p.quote_version_id,
      p.quote_snapshot_sha256,
      p.thread_context_revision,
      p.requirements_revision,
      p.subject,
      p.body_text,
      JSON.stringify(p.sender_snapshot),
      JSON.stringify(p.recipients_snapshot),
      JSON.stringify(p.attachment_manifest),
      JSON.stringify(p.channel_payload),
    ],
  );
  if (q)
    await c.client.query(
      'INSERT INTO app.payload_evidence(workspace_id,factory_id,payload_version_id,fact_version_id,usage_key) SELECT workspace_id,factory_id,$3,fact_version_id,usage_key FROM app.quote_evidence WHERE workspace_id=$1 AND quote_version_id=$2',
      [ws(c), q.id, pid],
    );
  await c.client.query(
    'UPDATE app.outbound_payload_versions SET snapshot_sha256=$3,frozen_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',
    [ws(c), pid, sha],
  );
  await c.client.query(
    'UPDATE app.outbound_requests SET current_payload_version_id=$3 WHERE workspace_id=$1 AND id=$2',
    [ws(c), id, pid],
  );
  const expires = new Date(
    Math.min(
      input.scheduledAt.getTime() + 86400000,
      q ? new Date(q.valid_until).getTime() : Infinity,
    ),
  );
  if (expires <= input.scheduledAt) throw new BoundaryError(409, '计划时间晚于报价有效期');
  return { r: { ...r, current_payload_version_id: pid }, pid, sha, expires };
}
async function batchSnapshot(c: Context, versionId: string) {
  const v = (
    await c.client.query(
      'SELECT * FROM app.outreach_batch_versions WHERE workspace_id=$1 AND id=$2',
      [ws(c), versionId],
    )
  ).rows[0];
  if (!v) throw new BoundaryError(404, '批次版本不存在');
  const items = (
    await c.client.query(
      'SELECT id,lead_id,outbound_request_id,payload_version_id,payload_sha256,contact_point_id,position,scheduled_at,schedule_time_zone FROM app.outreach_batch_items WHERE workspace_id=$1 AND batch_version_id=$2 ORDER BY position',
      [ws(c), versionId],
    )
  ).rows;
  return {
    versionId,
    batchId: v.batch_id,
    version: v.version_no,
    rules: v.send_rules,
    validUntil: new Date(v.valid_until).toISOString(),
    items: items.map((x) => ({ ...x, scheduled_at: new Date(x.scheduled_at).toISOString() })),
  };
}
export async function freezeBatch(c: Context, id: string, raw: unknown, store: PrivateObjectStore) {
  const i = freezeBatchSchema.parse(raw);
  await batch(c, id);
  return command(c, i.commandId, 'd2.batch-freeze', { id, ...i }, async () => {
    const b = await batch(c, id);
    if (b.row_version !== i.expectedVersion) throw new BoundaryError(409, '草稿已变化，请重新查看');
    const d = saveBatchSchema.shape.draft.parse(b.draft),
      now = await databaseNow(c.client);
    if (
      new Date(d.deadline) <= now ||
      new Date(d.startAt) >= new Date(d.deadline) ||
      new Date(d.startAt).getTime() + (d.items.length - 1) * d.intervalMs >= Date.parse(d.deadline)
    )
      throw new BoundaryError(409, '执行时间或截止时间不足以安排全部成员');
    const versionNo = (
      await c.client.query(
        'SELECT COALESCE(max(version_no),0)+1 n FROM app.outreach_batch_versions WHERE workspace_id=$1 AND batch_id=$2',
        [ws(c), id],
      )
    ).rows[0].n;
    const vid = randomUUID();
    await c.client.query(
      'INSERT INTO app.outreach_batch_versions(id,workspace_id,factory_id,batch_id,version_no,policy_version,send_rules,valid_until) VALUES($1,$2,$3,$4,$5,3,$6,$7)',
      [vid, ws(c), b.factory_id, id, versionNo, JSON.stringify(d), d.deadline],
    );
    let expires = Date.parse(d.deadline);
    for (const [position, item] of d.items.entries()) {
      const l = await lead(c, item.leadId),
        t = await requireThread(c, item.threadId);
      const cp = (
        await c.client.query(
          'SELECT lead_id FROM app.contact_points WHERE workspace_id=$1 AND id=$2',
          [ws(c), t.primary_contact_point_id],
        )
      ).rows[0];
      if (l.factory_id !== b.factory_id || cp?.lead_id !== l.id)
        throw new BoundaryError(409, '名单必须关联当前工厂的已确认线索及独立模拟身份');
      const o = (
        await c.client.query(
          'SELECT o.id FROM app.opportunities o JOIN app.opportunity_threads ot ON ot.workspace_id=o.workspace_id AND ot.opportunity_id=o.id WHERE o.workspace_id=$1 AND o.lead_id=$2 AND ot.thread_id=$3',
          [ws(c), l.id, t.id],
        )
      ).rows[0];
      if (!o) throw new BoundaryError(409, '缺少线索关联商机');
      const at = new Date(Date.parse(d.startAt) + position * d.intervalMs);
      const request = await createRequest(c, store, {
        ...item,
        opportunityId: o.id,
        factoryId: b.factory_id,
        scheduledAt: at,
        timeZone: d.timeZone,
        d2: { origin: 'approved_batch', id: vid, version: String(versionNo), leadId: l.id },
      });
      expires = Math.min(expires, request.expires.getTime());
      await c.client.query(
        'INSERT INTO app.outreach_batch_items(workspace_id,factory_id,batch_version_id,outbound_request_id,payload_version_id,payload_sha256,contact_point_id,scheduled_at,schedule_time_zone,position,lead_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [
          ws(c),
          b.factory_id,
          vid,
          request.r.id,
          request.pid,
          request.sha,
          request.r.contact_point_id,
          at,
          d.timeZone,
          position,
          l.id,
        ],
      );
    }
    if (b.current_version_id) {
      const old = (
        await c.client.query(
          "SELECT * FROM app.approvals WHERE workspace_id=$1 AND batch_version_id=$2 AND state IN('pending','approved') FOR UPDATE",
          [ws(c), b.current_version_id],
        )
      ).rows;
      for (const a of old) await endApproval(c, a, 'invalidated', '批次已形成新版本；不继承旧批准');
      const oldItems = (
        await c.client.query(
          'SELECT outbound_request_id FROM app.outreach_batch_items WHERE workspace_id=$1 AND batch_version_id=$2',
          [ws(c), b.current_version_id],
        )
      ).rows;
      for (const x of oldItems) await stopRequest(c, x.outbound_request_id, '批次已换版');
      await c.client.query(
        "UPDATE app.outreach_batch_versions SET invalidated_at=clock_timestamp(),invalidation_reason='批次已换版' WHERE workspace_id=$1 AND id=$2",
        [ws(c), b.current_version_id],
      );
    }
    const sha = outboundHash(await batchSnapshot(c, vid));
    await c.client.query(
      'UPDATE app.outreach_batch_versions SET snapshot_sha256=$3,frozen_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',
      [ws(c), vid, sha],
    );
    await c.client.query(
      "UPDATE app.outreach_batches SET current_version_id=$3,state='draft',next_claim_at=NULL WHERE workspace_id=$1 AND id=$2",
      [ws(c), id, vid],
    );
    const a = (
      await c.client.query(
        'INSERT INTO app.approvals(workspace_id,batch_version_id,snapshot_sha256,requested_by_member_id,expires_at) VALUES($1,$2,$3,$4,$5) RETURNING id',
        [ws(c), vid, sha, c.member.id, new Date(expires)],
      )
    ).rows[0];
    await approvalEvent(c, a.id, 'requested', '完整名单、逐人内容和计划已冻结', {
      versionId: vid,
      sha,
    });
    await audit(c, 'd2.batch-frozen', 'outreach_batch', id, { versionId: vid, sha });
    return { id, versionId: vid, approvalId: a.id };
  });
}
async function currentApproval(c: Context, batchVersionId: string, payloadId?: string) {
  const a = (
    await c.client.query(
      "SELECT a.*,m.role,m.status AS member_status,u.status AS user_status,w.approver_member_id FROM app.approvals a JOIN app.workspaces w ON w.id=a.workspace_id LEFT JOIN app.workspace_members m ON m.workspace_id=a.workspace_id AND m.id=a.approved_by_member_id LEFT JOIN app.app_users u ON u.id=m.user_id WHERE a.workspace_id=$1 AND (($2::uuid IS NOT NULL AND a.batch_version_id=$2) OR ($3::uuid IS NOT NULL AND a.payload_version_id=$3)) AND a.state='approved'",
      [ws(c), batchVersionId || null, payloadId ?? null],
    )
  ).rows[0];
  if (
    !a ||
    a.role !== 'owner' ||
    a.member_status !== 'active' ||
    a.user_status !== 'active' ||
    a.approver_member_id !== a.approved_by_member_id ||
    new Date(a.expires_at) <= (await databaseNow(c.client))
  )
    throw new BoundaryError(409, '审批过期、失效或指定 owner 已变化');
  return a;
}
export async function decideBatch(
  c: Context,
  boss: PgBoss,
  id: string,
  raw: unknown,
  store: PrivateObjectStore,
  failure?: ApprovalFailure,
) {
  const i = batchDecisionSchema.parse(raw);
  requireApprover(c);
  await batch(c, id);
  return command(c, i.commandId, 'd2.batch-decision', { id, ...i }, async () => {
    const b = await batch(c, id),
      v = (
        await c.client.query(
          'SELECT * FROM app.outreach_batch_versions WHERE workspace_id=$1 AND id=$2 AND batch_id=$3',
          [ws(c), i.versionId, id],
        )
      ).rows[0];
    const a = (
      await c.client.query(
        "SELECT * FROM app.approvals WHERE workspace_id=$1 AND batch_version_id=$2 AND state IN('pending','approved') FOR UPDATE",
        [ws(c), i.versionId],
      )
    ).rows[0];
    if (
      !v ||
      !a ||
      a.row_version !== i.expectedVersion ||
      b.current_version_id !== v.id ||
      v.snapshot_sha256 !== i.snapshotSha256 ||
      outboundHash(await batchSnapshot(c, v.id)) !== i.snapshotSha256
    )
      throw new BoundaryError(409, '批次内容、名单或审批版本已变化，请重新查看');
    const items = (
      await c.client.query(
        'SELECT * FROM app.outreach_batch_items WHERE workspace_id=$1 AND batch_version_id=$2 ORDER BY position',
        [ws(c), v.id],
      )
    ).rows;
    if (i.decision !== 'approve') {
      if (i.decision === 'revoke') {
        await c.client.query(
          "UPDATE app.approvals SET state='revoked',revoked_by_member_id=$3,revoked_at=clock_timestamp(),reason=$4 WHERE workspace_id=$1 AND id=$2",
          [ws(c), a.id, c.member.id, i.reason || 'owner 撤销批次'],
        );
        await approvalEvent(c, a.id, 'revoked', i.reason || 'owner 撤销批次');
      } else await endApproval(c, a, 'rejected', i.reason || 'owner 拒绝批次');
      let late = false;
      for (const item of items) {
        const r = await readOutbound(c, item.outbound_request_id);
        late ||= Boolean(r.dispatch_claimed_at);
        await stopRequest(c, r.id, i.reason || '批次已撤销/拒绝');
      }
      if (late)
        await approvalEvent(c, a.id, 'revocation_too_late', '已领取项仅记录取消申请，须核对');
      await c.client.query(
        "UPDATE app.outreach_batches SET state='cancelled' WHERE workspace_id=$1 AND id=$2",
        [ws(c), id],
      );
      return { state: late ? 'cancel_requested' : 'cancelled' };
    }
    if (a.state !== 'pending' || new Date(a.expires_at) <= (await databaseNow(c.client)))
      throw new BoundaryError(409, '审批已处理或到期，请重新提交');
    const { validatePayload, readVerifiedAttachments } = await import('./delivery-checks.js');
    for (const item of items) {
      const r = await readOutbound(c, item.outbound_request_id),
        p = await readPayload(c, r);
      await validatePayload(c, r, p, { approval: false });
      await readVerifiedAttachments(store, p.attachment_manifest);
    }
    await c.client.query(
      "UPDATE app.approvals SET state='approved',approved_by_member_id=$3,approved_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",
      [ws(c), a.id, c.member.id],
    );
    await approvalEvent(c, a.id, 'approved', '批准明确版本、实际名单与逐人完整内容', {
      versionId: v.id,
      sha: v.snapshot_sha256,
      count: items.length,
    });
    if (failure === 'approval') throw new Error('D2 injected approval rollback');
    await c.client.query(
      "UPDATE app.outreach_batches SET state='active' WHERE workspace_id=$1 AND id=$2",
      [ws(c), id],
    );
    for (const item of items) {
      const r = await readOutbound(c, item.outbound_request_id);
      await c.client.query(
        "UPDATE app.outbound_requests SET state='queued' WHERE workspace_id=$1 AND id=$2",
        [ws(c), r.id],
      );
      if (failure === 'business') throw new Error('D2 injected business rollback');
      if (failure === 'outbox') {
        await c.client.query(
          "INSERT INTO app.outbox_events(workspace_id,event_type,aggregate_type,aggregate_id,handler_key,idempotency_key,payload) VALUES($1,'test','outreach_batch',$2,'a2.delivery',$3,'{}')",
          [ws(c), id, i.commandId],
        );
        throw new Error('D2 injected outbox rollback');
      }
      await enqueueDelivery(
        c,
        boss,
        r,
        item.payload_version_id,
        i.commandId + ':' + item.id,
        'c.delivery-ready',
        {},
        new Date(item.scheduled_at),
      );
      if (failure === 'enqueue') throw new Error('D2 injected enqueue rollback');
    }
    return { state: 'queued', count: items.length };
  });
}

async function followupReason(c: Context, f: Record<string, unknown>): Promise<string | null> {
  const t = await requireThread(c, String(f.thread_id));
  if (t.outbound_paused) return 'THREAD_PAUSED';
  if (t.state === 'closed') return 'THREAD_CLOSED';
  if (f.execution_mode === 'approved_automatic' && t.control_mode === 'human')
    return 'HUMAN_TAKEOVER';
  if (String(t.context_revision) !== String(f.baseline_thread_revision))
    return t.control_mode === 'human' ? 'HUMAN_TAKEOVER' : 'NEW_REPLY_OR_CONTEXT_CHANGED';
  const o = (
    await c.client.query('SELECT * FROM app.opportunities WHERE workspace_id=$1 AND id=$2', [
      ws(c),
      f.opportunity_id,
    ])
  ).rows[0];
  if (!o || o.stage === 'closed') return 'OPPORTUNITY_CLOSED';
  if (o.stage === 'paused') return 'OPPORTUNITY_PAUSED';
  if (String(o.requirements_revision) !== String(f.baseline_requirements_revision))
    return 'REQUIREMENTS_CHANGED';
  const owner = (
    await c.client.query(
      "SELECT 1 FROM app.workspace_members m JOIN app.app_users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.id=$2 AND m.status='active' AND u.status='active' AND (m.all_factories OR EXISTS(SELECT 1 FROM app.factory_memberships fm WHERE fm.workspace_id=m.workspace_id AND fm.member_id=m.id AND fm.factory_id=$3))",
      [ws(c), f.owner_member_id, f.factory_id],
    )
  ).rowCount;
  if (!owner) return 'RESPONSIBLE_MEMBER_PERMISSION_LOST';
  try {
    const factory = await requireFactory(c, String(f.factory_id));
    const raw = (
      await c.client.query(
        'SELECT authority_valid_until FROM app.factories WHERE workspace_id=$1 AND id=$2',
        [ws(c), f.factory_id],
      )
    ).rows[0];
    if (
      factory.status !== 'active' ||
      (raw.authority_valid_until &&
        new Date(raw.authority_valid_until) <= (await databaseNow(c.client)))
    )
      return 'FACTORY_PERMISSION_LOST';
    if (!t.primary_contact_point_id) return 'CONTACT_MISSING';
    await eligibleContact(c.client, ws(c), t.primary_contact_point_id);
    if (f.quote_version_id) {
      const q = await requireQuoteVersion(c, String(f.quote_version_id));
      if (!q.availability.available)
        return 'QUOTE_OR_FACT_INVALID: ' + q.availability.reasons.join('；');
    }
  } catch (e) {
    if (e instanceof BoundaryError) return e.message;
    throw e;
  }
  return null;
}
async function stopFollowup(c: Context, f: Record<string, unknown>, reason: string) {
  if (['completed', 'cancelled', 'failed'].includes(String(f.state))) return;
  if (f.outbound_request_id) await stopRequest(c, String(f.outbound_request_id), reason);
  await c.client.query(
    "UPDATE app.followups SET state='cancelled',stop_reason=$3 WHERE workspace_id=$1 AND id=$2",
    [ws(c), f.id, reason],
  );
  await audit(c, 'd2.followup-stopped', 'followup', String(f.id), {
    reason,
    businessVersion: String(f.business_version),
  });
}
export async function saveFollowup(
  c: Context,
  boss: PgBoss,
  raw: unknown,
  store: PrivateObjectStore,
) {
  const i = followupSchema.parse(raw);
  await requireThread(c, i.threadId);
  await requireOpportunityThreads(c, i.opportunityId);
  let due: string;
  try {
    due = resolveLocalTime(i.localTime, i.timeZone, i.disambiguation);
  } catch (e) {
    throw new BoundaryError(422, e instanceof Error ? e.message : '时间无效');
  }
  return command(c, i.commandId, 'd2.followup-save', i, async () => {
    const t = await requireThread(c, i.threadId, true),
      o = (
        await c.client.query('SELECT * FROM app.opportunities WHERE workspace_id=$1 AND id=$2', [
          ws(c),
          i.opportunityId,
        ])
      ).rows[0];
    if (
      !o?.factory_id ||
      !(
        await c.client.query(
          'SELECT 1 FROM app.opportunity_threads WHERE workspace_id=$1 AND thread_id=$2 AND opportunity_id=$3',
          [ws(c), t.id, o.id],
        )
      ).rowCount
    )
      throw new BoundaryError(409, '跟进需要明确关联的工厂及商机');
    await requireFactory(c, o.factory_id);
    if (Date.parse(due) <= (await databaseNow(c.client)).getTime())
      throw new BoundaryError(422, '跟进到期时间必须在未来');
    const old = i.followupId
      ? (
          await c.client.query(
            'SELECT * FROM app.followups WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
            [ws(c), i.followupId],
          )
        ).rows[0]
      : null;
    if (
      i.followupId &&
      (!old ||
        old.row_version !== i.expectedVersion ||
        old.thread_id !== t.id ||
        old.opportunity_id !== o.id)
    )
      throw new BoundaryError(409, '跟进版本或关联已变化');
    if (old) await stopFollowup(c, old, 'PLAN_RESCHEDULED_OR_CHANGED');
    const id = old?.id ?? randomUUID(),
      v = old ? String(BigInt(old.business_version) + 1n) : '1';
    const plan = {
      ...i,
      commandId: i.commandId,
      dueAt: due,
      businessVersion: v,
      stopConditions: [
        'reply',
        'human_takeover',
        'unsubscribe',
        'pause',
        'closed',
        'requirements',
        'quote',
        'facts',
        'permissions',
      ],
    };
    let request: Awaited<ReturnType<typeof createRequest>> | null = null;
    if (i.mode === 'approved_automatic') {
      if (!i.body.trim() && !i.quoteVersionId)
        throw new BoundaryError(422, '自动模拟跟进需要最终正文');
      request = await createRequest(c, store, {
        threadId: t.id,
        opportunityId: o.id,
        factoryId: o.factory_id,
        quoteVersionId: i.quoteVersionId,
        subject: i.subject,
        body: i.body,
        scheduledAt: new Date(due),
        timeZone: i.timeZone,
        d2: { origin: 'automatic_followup', id, version: v, leadId: null },
      });
    }
    if (old)
      await c.client.query(
        "UPDATE app.followups SET business_version=$3,owner_member_id=$4,quote_version_id=$5,outbound_request_id=$6,purpose=$7,execution_mode=$8,state='scheduled',due_at=$9,time_zone=$10,baseline_thread_revision=$11,baseline_requirements_revision=$12,internal_draft=$13,plan_snapshot=$14,stop_conditions=$15,stop_reason=NULL,completed_at=NULL WHERE workspace_id=$1 AND id=$2",
        [
          ws(c),
          id,
          v,
          i.ownerMemberId,
          i.quoteVersionId,
          request?.r.id ?? null,
          i.purpose,
          i.mode,
          due,
          i.timeZone,
          t.context_revision,
          o.requirements_revision,
          i.internalDraft,
          JSON.stringify(plan),
          JSON.stringify(plan.stopConditions.reduce((a, k) => ({ ...a, [k]: true }), {})),
        ],
      );
    else
      await c.client.query(
        'INSERT INTO app.followups(id,workspace_id,factory_id,opportunity_id,thread_id,owner_member_id,quote_version_id,outbound_request_id,purpose,execution_mode,due_at,time_zone,baseline_thread_revision,baseline_requirements_revision,dedupe_key,internal_draft,plan_snapshot,created_by_member_id,stop_conditions) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$1::uuid::text,$15,$16,$17,$18)',
        [
          id,
          ws(c),
          o.factory_id,
          o.id,
          t.id,
          i.ownerMemberId,
          i.quoteVersionId,
          request?.r.id ?? null,
          i.purpose,
          i.mode,
          due,
          i.timeZone,
          t.context_revision,
          o.requirements_revision,
          i.internalDraft,
          JSON.stringify(plan),
          c.member.id,
          JSON.stringify(plan.stopConditions.reduce((a, k) => ({ ...a, [k]: true }), {})),
        ],
      );
    const f = (
      await c.client.query('SELECT * FROM app.followups WHERE workspace_id=$1 AND id=$2', [
        ws(c),
        id,
      ])
    ).rows[0];
    const reason = await followupReason(c, f);
    if (reason) throw new BoundaryError(409, reason);
    if (request) {
      const a = (
        await c.client.query(
          'INSERT INTO app.approvals(workspace_id,outbound_request_id,payload_version_id,snapshot_sha256,requested_by_member_id,expires_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
          [ws(c), request.r.id, request.pid, request.sha, c.member.id, request.expires],
        )
      ).rows[0];
      await approvalEvent(c, a.id, 'requested', '自动模拟跟进：批准最终正文、收件人和明确计划版本');
    }
    const eid = randomUUID(),
      payload = { followupId: id, businessVersion: v, memberId: c.member.id, userId: c.user.id };
    await c.client.query(
      "INSERT INTO app.outbox_events(id,workspace_id,event_type,aggregate_type,aggregate_id,aggregate_version,handler_key,idempotency_key,payload) VALUES($1,$2,'d2.followup-due','followup',$3,$4,$5,$6,$7)",
      [eid, ws(c), id, v, FOLLOWUP_QUEUE, id + ':' + v, JSON.stringify(payload)],
    );
    const jid = await boss.send(
      FOLLOWUP_QUEUE,
      { eventId: eid, workspaceId: ws(c), userId: c.user.id },
      {
        id: eid,
        startAfter: new Date(due),
        retryLimit: 3,
        retryDelay: 2,
        db: { executeSql: (sql, values) => c.client.query(sql, values) },
      },
    );
    if (!jid) throw new Error('Followup enqueue rejected');
    await c.client.query(
      'UPDATE app.outbox_events SET pg_boss_job_id=$3,enqueued_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',
      [ws(c), eid, jid],
    );
    await audit(c, 'd2.followup-version', 'followup', id, {
      plan,
      requestId: request?.r.id ?? null,
      eventId: eid,
      jobId: jid,
    });
    return { id, businessVersion: v, requestId: request?.r.id ?? null, jobId: jid };
  });
}
export async function cancelFollowup(c: Context, id: string, expectedVersion: string) {
  const f = (
    await c.client.query('SELECT * FROM app.followups WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [
      ws(c),
      id,
    ])
  ).rows[0];
  if (!f) throw new BoundaryError(404, '跟进不存在');
  await requireThread(c, f.thread_id);
  if (f.row_version !== expectedVersion) throw new BoundaryError(409, '跟进已变化');
  await stopFollowup(c, f, 'MEMBER_CANCELLED');
  return { state: 'cancelled' };
}
export async function consumeFollowupJob(pool: pg.Pool, data: unknown, jobId: string) {
  const hint = data as { eventId: string; workspaceId: string; userId: string };
  try {
    return await transaction(pool, async (client) => {
      const e = (
        await client.query('SELECT app.d2_followup_job($1,$2) AS data', [hint.eventId, jobId])
      ).rows[0].data;
      if (e.workspace_id !== hint.workspaceId || e.payload.userId !== hint.userId)
        throw new BoundaryError(403, '跟进队列上下文不一致');
      await client.query('SELECT app.d2_stop_revoked_followup($1,$2)', [hint.eventId, jobId]);
      await client.query("SELECT set_config('app.user_id',$1,true)", [e.payload.userId]);
      const member = await establishWorkspace(client, e.payload.userId, e.workspace_id);
      if (member.id !== e.payload.memberId) throw new BoundaryError(403, '跟进发起成员不一致');
      const user = (
        await client.query('SELECT * FROM app.app_users WHERE id=$1', [e.payload.userId])
      ).rows[0];
      const c: Context = { client, member, user, orm: drizzle(client) },
        f = (
          await client.query(
            'SELECT * FROM app.followups WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
            [ws(c), e.aggregate_id],
          )
        ).rows[0];
      if (
        !f ||
        String(f.business_version) !== e.payload.businessVersion ||
        !['scheduled', 'ready'].includes(f.state)
      )
        return;
      if (new Date(f.due_at) > (await databaseNow(client))) return;
      const reason = await followupReason(c, f);
      if (reason) {
        await stopFollowup(c, f, reason);
        return;
      }
      await client.query("UPDATE app.followups SET state='ready' WHERE workspace_id=$1 AND id=$2", [
        ws(c),
        f.id,
      ]);
      await audit(c, 'd2.followup-due', 'followup', f.id, {
        businessVersion: f.business_version,
        mode: f.execution_mode,
      });
    });
  } catch (e) {
    if (!(e instanceof BoundaryError)) throw e;
    await transaction(pool, (c) =>
      c.query('SELECT app.d2_stop_revoked_followup($1,$2)', [hint.eventId, jobId]),
    );
  }
}
export async function validateD2Payload(
  c: Context,
  r: DeliveryRequest,
  p: OutboundPayload,
  approved: boolean,
) {
  const d = p.channel_payload.d2 as D2Identity | undefined;
  if (
    !d ||
    !['approved_batch', 'automatic_followup'].includes(d.origin) ||
    outboundHash(channel(r, d)) !== outboundHash(p.channel_payload) ||
    p.language_code !== 'en' ||
    String(p.policy_version) !== '3'
  )
    throw new BoundaryError(409, 'D2 最终快照协议不一致');
  const o = (
    await c.client.query('SELECT * FROM app.opportunities WHERE workspace_id=$1 AND id=$2', [
      ws(c),
      r.opportunity_id,
    ])
  ).rows[0];
  if (
    !o ||
    ['closed', 'paused'].includes(o.stage) ||
    String(o.requirements_revision) !== String(p.requirements_revision)
  )
    throw new BoundaryError(409, '商机已关闭、暂停或需求已变化');
  if (p.quote_version_id) {
    const q = await requireQuoteVersion(c, p.quote_version_id),
      mail = quoteMail(q.snapshot);
    if (
      !q.availability.available ||
      q.opportunity_id !== r.opportunity_id ||
      q.snapshot_sha256 !== p.quote_snapshot_sha256 ||
      mail.subject !== p.subject ||
      mail.body !== p.body_text
    )
      throw new BoundaryError(409, '引用报价或事实失效，须重新审批');
  }
  if (
    r.intent === 'outreach' &&
    r.authorization_mode === 'batch_approval' &&
    d.origin === 'approved_batch'
  ) {
    const v = (
      await c.client.query(
        'SELECT v.*,b.current_version_id,b.state AS batch_state FROM app.outreach_batch_versions v JOIN app.outreach_batches b ON b.workspace_id=v.workspace_id AND b.id=v.batch_id WHERE v.workspace_id=$1 AND v.id=$2',
        [ws(c), d.id],
      )
    ).rows[0];
    const item = (
      await c.client.query(
        'SELECT * FROM app.outreach_batch_items WHERE workspace_id=$1 AND batch_version_id=$2 AND outbound_request_id=$3',
        [ws(c), d.id, r.id],
      )
    ).rows[0];
    if (
      !v ||
      !item ||
      v.current_version_id !== v.id ||
      v.invalidated_at ||
      !v.frozen_at ||
      String(v.version_no) !== d.version ||
      item.payload_version_id !== p.id ||
      item.payload_sha256 !== p.snapshot_sha256 ||
      item.lead_id !== d.leadId ||
      new Date(v.valid_until) <= (await databaseNow(c.client)) ||
      ['paused', 'cancelled'].includes(v.batch_state) ||
      outboundHash(await batchSnapshot(c, v.id)) !== v.snapshot_sha256
    )
      throw new BoundaryError(409, '批次版本、名单、截止或冻结摘要已失效');
    await lead(c, item.lead_id);
    const permission = (
      await c.client.query(
        "SELECT * FROM app.contact_permissions WHERE workspace_id=$1 AND contact_point_id=$2 AND channel_kind='simulation' AND purpose='outreach' AND status='allowed' AND NOT do_not_contact AND (valid_from IS NULL OR valid_from<=clock_timestamp()) AND (valid_until IS NULL OR valid_until>clock_timestamp())",
        [ws(c), r.contact_point_id],
      )
    ).rows[0];
    if (!permission) throw new BoundaryError(409, '缺少 simulation 首触达资格');
    if (approved) {
      const a = await currentApproval(c, v.id);
      if (a.snapshot_sha256 !== v.snapshot_sha256 || v.batch_state !== 'active')
        throw new BoundaryError(409, '批次批准不匹配');
    }
  } else if (
    r.intent === 'followup' &&
    r.authorization_mode === 'human_approval' &&
    d.origin === 'automatic_followup'
  ) {
    const f = (
      await c.client.query('SELECT * FROM app.followups WHERE workspace_id=$1 AND id=$2', [
        ws(c),
        d.id,
      ])
    ).rows[0];
    if (
      !f ||
      f.execution_mode !== 'approved_automatic' ||
      String(f.business_version) !== d.version ||
      f.outbound_request_id !== r.id ||
      !['scheduled', 'ready', 'executing'].includes(f.state)
    )
      throw new BoundaryError(409, '旧跟进版本或授权已停止');
    const reason = await followupReason(c, f);
    if (reason) throw new BoundaryError(409, reason);
    if (approved) {
      const a = await currentApproval(c, '', p.id);
      if (a.snapshot_sha256 !== p.snapshot_sha256)
        throw new BoundaryError(409, '跟进批准摘要不匹配');
    }
  } else throw new BoundaryError(409, 'D2 请求来源或授权模式不一致');
}
/** Called only inside the C claim transaction, after current authorization checks. */
export async function reserveD2Slot(
  c: Context,
  boss: PgBoss | undefined,
  r: DeliveryRequest,
  p: OutboundPayload,
) {
  if (!p.channel_payload.d2) return true;
  const account = (
    await c.client.query(
      'SELECT next_claim_at,min_interval_ms FROM app.channel_accounts WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
      [ws(c), r.channel_account_id],
    )
  ).rows[0];
  const d = p.channel_payload.d2 as D2Identity;
  const v =
    d.origin === 'approved_batch'
      ? (
          await c.client.query(
            'SELECT v.send_rules,b.id,b.next_claim_at FROM app.outreach_batch_versions v JOIN app.outreach_batches b ON b.workspace_id=v.workspace_id AND b.id=v.batch_id WHERE v.workspace_id=$1 AND v.id=$2',
            [ws(c), d.id],
          )
        ).rows[0]
      : null;
  const schedule = (
    await c.client.query(
      'SELECT scheduled_at FROM app.outbound_requests WHERE workspace_id=$1 AND id=$2',
      [ws(c), r.id],
    )
  ).rows[0].scheduled_at;
  const now = await databaseNow(c.client),
    at = new Date(
      Math.max(
        new Date(schedule).getTime(),
        account.next_claim_at ? new Date(account.next_claim_at).getTime() : 0,
        v?.next_claim_at ? new Date(v.next_claim_at).getTime() : 0,
      ),
    );
  const inFlight = (
    await c.client.query(
      "SELECT id,state FROM app.outbound_requests WHERE workspace_id=$1 AND channel_account_id=$2 AND id<>$3 AND state IN('claimed','dispatching','unknown') ORDER BY created_at LIMIT 1",
      [ws(c), r.channel_account_id, r.id],
    )
  ).rows[0];
  if (inFlight?.state === 'unknown')
    throw new BoundaryError(409, '该模拟账号有 unknown 请求，须核对后重新提交后续动作');
  if (inFlight) at.setTime(Math.max(at.getTime(), now.getTime() + 5000));
  if (at > now) {
    if (!boss) throw new Error('D2 durable scheduling requires the queue instance');
    const key = 'd2.defer:' + r.id + ':' + at.toISOString();
    if (
      !(
        await c.client.query(
          'SELECT 1 FROM app.outbox_events WHERE workspace_id=$1 AND handler_key=$2 AND idempotency_key=$3',
          [ws(c), 'a2.delivery', key],
        )
      ).rowCount
    )
      await enqueueDelivery(c, boss, r, p.id, key, 'c.delivery-ready', {}, at);
    await c.client.query(
      "UPDATE app.outbound_requests SET stop_reason='DELAYED_BY_DURABLE_PACING' WHERE workspace_id=$1 AND id=$2",
      [ws(c), r.id],
    );
    return false;
  }
  await c.client.query(
    "UPDATE app.channel_accounts SET next_claim_at=$3::timestamptz+min_interval_ms*interval '1 millisecond' WHERE workspace_id=$1 AND id=$2",
    [ws(c), r.channel_account_id, now],
  );
  if (v)
    await c.client.query(
      "UPDATE app.outreach_batches SET next_claim_at=$3::timestamptz+$4*interval '1 millisecond' WHERE workspace_id=$1 AND id=$2",
      [ws(c), v.id, now, (v.send_rules as BatchDraft).intervalMs],
    );
  return true;
}
export async function settleD2Pacing(client: pg.PoolClient, requestId: string, token: string) {
  await client.query('SELECT app.d2_settle_pacing($1,$2)', [requestId, token]);
}
export async function setOutboundPause(
  c: Context,
  threadId: string,
  expectedVersion: string,
  paused: boolean,
) {
  const t = await requireThread(c, threadId, true);
  if (t.row_version !== expectedVersion) throw new BoundaryError(409, '会话已变化');
  await c.client.query(
    'UPDATE app.threads SET outbound_paused=$3,context_revision=context_revision+1 WHERE workspace_id=$1 AND id=$2',
    [ws(c), threadId, paused],
  );
  await audit(c, 'd2.outbound-pause', 'thread', threadId, { paused });
  return { paused };
}
export async function setSimulationPermission(c: Context, pointId: string, allowed: boolean) {
  if (allowed) requireApprover(c);
  const point = (
    await c.client.query(
      "SELECT * FROM app.contact_points WHERE workspace_id=$1 AND id=$2 AND namespace='zutrade-simulation'",
      [ws(c), pointId],
    )
  ).rows[0];
  if (!point?.lead_id) throw new BoundaryError(404, '独立模拟身份不存在');
  await lead(c, point.lead_id);
  await c.client.query(
    "UPDATE app.contact_permissions SET status=$3,do_not_contact=$4,suppression_reason=$5,changed_by_member_id=$6 WHERE workspace_id=$1 AND contact_point_id=$2 AND channel_kind='simulation'",
    [
      ws(c),
      pointId,
      allowed ? 'allowed' : 'revoked',
      !allowed,
      allowed ? null : 'MEMBER_SIMULATION_OPT_OUT',
      c.member.id,
    ],
  );
  await c.client.query(
    'UPDATE app.threads SET context_revision=context_revision+1 WHERE workspace_id=$1 AND primary_contact_point_id=$2',
    [ws(c), pointId],
  );
  if (!allowed) {
    for (const r of (
      await c.client.query(
        "SELECT id FROM app.outbound_requests WHERE workspace_id=$1 AND contact_point_id=$2 AND state NOT IN('simulated','failed','cancelled')",
        [ws(c), pointId],
      )
    ).rows)
      await stopRequest(c, r.id, 'MEMBER_SIMULATION_OPT_OUT');
  }
  await audit(c, 'd2.simulation-permission', 'lead', point.lead_id, {
    pointId,
    allowed,
    realChannelChanged: false,
  });
  return { allowed };
}
export async function completeManualFollowup(c: Context, id: string, expectedVersion: string) {
  const f = (
    await c.client.query('SELECT * FROM app.followups WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [
      ws(c),
      id,
    ])
  ).rows[0];
  if (!f) throw new BoundaryError(404, '跟进不存在');
  await requireThread(c, f.thread_id);
  if (f.row_version !== expectedVersion || f.execution_mode !== 'manual' || f.state !== 'ready')
    throw new BoundaryError(409, '仅可完成当前版本的到期人工提醒');
  const reason = await followupReason(c, f);
  if (reason) throw new BoundaryError(409, reason);
  await c.client.query(
    "UPDATE app.followups SET state='completed',completed_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",
    [ws(c), id],
  );
  await audit(c, 'd2.followup-manually-completed', 'followup', id, {
    businessVersion: f.business_version,
  });
  return { state: 'completed' };
}
export async function retryInboundReceipt(c: Context, boss: PgBoss, id: string, commandId: string) {
  const r = (
    await c.client.query('SELECT * FROM app.inbound_events WHERE workspace_id=$1 AND id=$2', [
      ws(c),
      id,
    ])
  ).rows[0];
  if (!r) throw new BoundaryError(404, '入站收据不存在');
  if (r.normalized_thread_id) await requireThread(c, r.normalized_thread_id);
  else if (r.requested_factory_id) await requireFactory(c, r.requested_factory_id);
  else if (c.member.role !== 'owner') throw new BoundaryError(403, '未归属收据仅 owner 可处理');
  if (!['retry', 'dead'].includes(r.state)) throw new BoundaryError(409, '此收据无需重新处理');
  return command(c, commandId, 'd2.inbound-retry', { id }, async () => {
    const eid = randomUUID();
    await c.client.query(
      "INSERT INTO app.outbox_events(id,workspace_id,event_type,aggregate_type,aggregate_id,handler_key,idempotency_key,payload) VALUES($1,$2,'a2.inbound-received','inbound_event',$3,'a2.inbound',$4,$5)",
      [
        eid,
        ws(c),
        id,
        commandId,
        JSON.stringify({ inboundEventId: id, channelAccountId: r.channel_account_id }),
      ],
    );
    const jid = await boss.send(
      'a2.inbound',
      { eventId: eid, workspaceId: ws(c) },
      {
        id: eid,
        retryLimit: 3,
        retryDelay: 2,
        db: { executeSql: (sql, values) => c.client.query(sql, values) },
      },
    );
    if (!jid) throw new Error('Inbound retry enqueue rejected');
    await c.client.query(
      'UPDATE app.outbox_events SET pg_boss_job_id=$3,enqueued_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',
      [ws(c), eid, jid],
    );
    await audit(c, 'd2.inbound-retry-requested', 'inbound_event', id, {
      eventId: eid,
      jobId: jid,
      barrierRetained: true,
    });
    return { state: 'queued', eventId: eid, jobId: jid };
  });
}
export async function d2Workspace(c: Context, threadId?: string) {
  if (threadId) await requireThread(c, threadId);
  const leads = [];
  for (const l of (
    await c.client.query(
      "SELECT l.*,b.name FROM app.leads l JOIN app.buyers b ON b.workspace_id=l.workspace_id AND b.id=l.buyer_id WHERE l.workspace_id=$1 AND l.source_kind='research' ORDER BY l.created_at DESC LIMIT 100",
      [ws(c)],
    )
  ).rows) {
    const points = [];
    const channels = [];
    let tid = null,
      aid = null;
    for (const p of (
      await c.client.query(
        'SELECT p.*,c.identity_status FROM app.contact_points p LEFT JOIN app.contacts c ON c.workspace_id=p.workspace_id AND c.id=p.contact_id WHERE p.workspace_id=$1 AND p.buyer_id=$2 AND (p.lead_id IS NULL OR p.lead_id=$3) ORDER BY p.created_at',
        [ws(c), l.buyer_id, l.id],
      )
    ).rows) {
      const permissions = (
        await c.client.query(
          'SELECT channel_kind,purpose,status,do_not_contact,evidence,(valid_from IS NULL OR valid_from<=clock_timestamp()) AND (valid_until IS NULL OR valid_until>clock_timestamp()) AS valid FROM app.contact_permissions WHERE workspace_id=$1 AND contact_point_id=$2',
          [ws(c), p.id],
        )
      ).rows;
      points.push({
        id: p.id,
        identity: p.display_value ?? p.normalized_value,
        source: p.source_evidence,
        identityStatus: p.identity_status ?? 'unverified',
        permissions,
      });
      if (p.lead_id === l.id) {
        const t = (
          await c.client.query(
            'SELECT id,channel_account_id FROM app.threads WHERE workspace_id=$1 AND primary_contact_point_id=$2',
            [ws(c), p.id],
          )
        ).rows[0];
        if (t) {
          await requireThread(c, t.id);
          tid = t.id;
          aid = t.channel_account_id;
          channels.push({
            threadId: t.id,
            accountId: t.channel_account_id,
            pointId: p.id,
            permitted:
              !p.disabled_at &&
              permissions.some(
                (x) =>
                  x.channel_kind === 'simulation' &&
                  x.purpose === 'service' &&
                  x.status === 'allowed' &&
                  !x.do_not_contact &&
                  x.valid,
              ),
          });
        }
      }
    }
    leads.push({
      id: l.id,
      factoryName: (await requireFactory(c, l.factory_id)).name,
      factory_id: l.factory_id,
      buyer_id: l.buyer_id,
      name: l.name,
      origin: l.research_snapshot.origin ?? 'unknown',
      identityConfirmed: Boolean(l.research_snapshot.identityConfirmedBy),
      source: l.research_snapshot,
      points,
      channels,
      threadId: tid,
      accountId: aid,
    });
  }
  const batches = [];
  for (const b of (
    await c.client.query(
      'SELECT * FROM app.outreach_batches WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 40',
      [ws(c)],
    )
  ).rows) {
    const versions = [];
    let summary: Record<string, number> = {};
    let visible = true;
    for (const v of (
      await c.client.query(
        'SELECT * FROM app.outreach_batch_versions WHERE workspace_id=$1 AND batch_id=$2 ORDER BY version_no DESC',
        [ws(c), b.id],
      )
    ).rows) {
      for (const item of (v.send_rules as BatchDraft).items) {
        try {
          await requireThread(c, item.threadId);
        } catch (e) {
          if (e instanceof BoundaryError) {
            visible = false;
            break;
          }
          throw e;
        }
      }
      if (!visible) break;
      const items = (
        await c.client.query(
          'SELECT i.*,r.state,r.stop_reason,r.thread_id,r.cancel_requested_at,r.dispatch_claimed_at,p.subject,p.body_text,p.recipients_snapshot,p.sender_snapshot,p.attachment_manifest,p.quote_version_id FROM app.outreach_batch_items i JOIN app.outbound_requests r ON r.workspace_id=i.workspace_id AND r.id=i.outbound_request_id JOIN app.outbound_payload_versions p ON p.workspace_id=i.workspace_id AND p.id=i.payload_version_id WHERE i.workspace_id=$1 AND i.batch_version_id=$2 ORDER BY i.position',
          [ws(c), v.id],
        )
      ).rows;
      for (const item of items) await requireThread(c, item.thread_id);
      const a =
        (
          await c.client.query(
            'SELECT id,state,row_version,reason,expires_at FROM app.approvals WHERE workspace_id=$1 AND batch_version_id=$2 ORDER BY created_at DESC LIMIT 1',
            [ws(c), v.id],
          )
        ).rows[0] ?? null;
      if (a && ['pending', 'approved'].includes(a.state)) {
        let reason: string | null = null,
          state = 'invalidated';
        if (new Date(a.expires_at) <= (await databaseNow(c.client))) {
          reason = '批次审批固定有效期已到';
          state = 'expired';
        } else if (a.state === 'approved') {
          try {
            await currentApproval(c, v.id);
          } catch (e) {
            if (e instanceof BoundaryError) reason = e.message;
            else throw e;
          }
        }
        if (reason) {
          await endApproval(c, a, state, reason);
          a.state = state;
          a.reason = reason;
          a.row_version = String(BigInt(a.row_version) + 1n);
          for (const item of items) {
            await stopRequest(c, item.outbound_request_id, reason);
            const latest = await readOutbound(c, item.outbound_request_id);
            item.state = latest.state;
            item.stop_reason = latest.stop_reason;
            item.cancel_requested_at = latest.cancel_requested_at;
          }
        }
      }
      if (v.id === b.current_version_id)
        summary = items.reduce(
          (s: Record<string, number>, x) => ({ ...s, [x.state]: (s[x.state] ?? 0) + 1 }),
          {},
        );
      versions.push({ ...v, items, approval: a });
    }
    if (!visible) continue;
    const completed =
      Object.keys(summary).length > 0 &&
      Object.keys(summary).every((s) =>
        ['simulated', 'failed', 'cancelled', 'blocked'].includes(s),
      );
    batches.push({
      ...b,
      state: completed && b.state === 'active' ? 'completed' : b.state,
      versions,
      summary,
    });
  }
  const followups = [];
  for (const f of (
    await c.client.query(
      'SELECT * FROM app.followups WHERE workspace_id=$1 AND ($2::uuid IS NULL OR thread_id=$2) ORDER BY due_at DESC LIMIT 100',
      [ws(c), threadId ?? null],
    )
  ).rows) {
    await requireThread(c, f.thread_id);
    if (['scheduled', 'ready', 'executing'].includes(f.state)) {
      const reason = await followupReason(c, f);
      if (reason) {
        await stopFollowup(c, f, reason);
        Object.assign(
          f,
          (
            await c.client.query('SELECT * FROM app.followups WHERE workspace_id=$1 AND id=$2', [
              ws(c),
              f.id,
            ])
          ).rows[0],
        );
      }
    }
    const history = (
      await c.client.query(
        "SELECT id,action,occurred_at,details FROM app.audit_events WHERE workspace_id=$1 AND aggregate_type='followup' AND aggregate_id=$2 ORDER BY occurred_at,id",
        [ws(c), f.id],
      )
    ).rows;
    followups.push({ ...f, history });
  }
  const tasks = [];
  for (const r of (
    await c.client.query(
      "SELECT id,state,last_error,normalized_thread_id,requested_factory_id FROM app.inbound_events WHERE workspace_id=$1 AND state IN('retry','dead') ORDER BY received_at DESC LIMIT 60",
      [ws(c)],
    )
  ).rows) {
    if (r.normalized_thread_id) await requireThread(c, r.normalized_thread_id);
    else if (r.requested_factory_id) await requireFactory(c, r.requested_factory_id);
    else if (c.member.role !== 'owner') continue;
    tasks.push({
      id: r.id,
      kind: '原始入站失败',
      reason: r.last_error ?? r.state,
      threadId: r.normalized_thread_id,
    });
  }
  for (const r of (
    await c.client.query(
      "SELECT id,thread_id,state,stop_reason FROM app.outbound_requests WHERE workspace_id=$1 AND state IN('failed','unknown','blocked') ORDER BY created_at DESC LIMIT 60",
      [ws(c)],
    )
  ).rows) {
    await requireThread(c, r.thread_id);
    tasks.push({
      id: r.id,
      kind: r.state === 'unknown' ? '发送 unknown 待核对' : '发送失败或阻挡',
      reason: r.stop_reason ?? r.state,
      threadId: r.thread_id,
    });
  }
  const accounts = (
    await c.client.query(
      "SELECT id,display_name FROM app.channel_accounts WHERE workspace_id=$1 AND transport_mode='simulation' AND channel_kind='simulation' AND state='active' ORDER BY display_name",
      [ws(c)],
    )
  ).rows;
  const members = (
    await c.client.query(
      "SELECT m.id,u.display_name FROM app.workspace_members m JOIN app.app_users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.status='active' AND u.status='active' ORDER BY u.display_name",
      [ws(c)],
    )
  ).rows;
  return { leads, batches, followups, accounts, members, tasks };
}
