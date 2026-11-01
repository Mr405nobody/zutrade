import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BoundaryError, requireApprover, requireFactory, databaseNow } from '@zutrade/db';
import type { Context } from '@zutrade/db';
import type { PgBoss } from 'pg-boss';
import type { QuoteSnapshot } from '@zutrade/contracts';
import type { PrivateObjectStore } from '@zutrade/storage';
import { requireThread } from './inbox.js';
import { requireOpportunityThreads, requireQuoteVersion } from './quoting.js';
import { downloadQuotePdf } from './quote-pdf.js';
import { lockAccount, eligibleContact, DELIVERY_QUEUE } from './delivery.js';
import { outboundHash, normalizeOutbound, outboundSnapshot } from './outbound-canonical.js';
import type { AttachmentManifest, OutboundPayload } from './outbound-canonical.js';

const seq = z.string().regex(/^[1-9]\d*$/);
export const prepareOutboundInput = z
  .object({
    commandId: z.uuid(),
    contextRevision: seq,
    kind: z.enum(['quote', 'human_reply']),
    quoteVersionId: z.uuid().nullable(),
    body: z.string().min(1).max(10000).optional(),
    // Quote commercial text is server-owned; only a neutral reviewed introduction is selectable.
    introduction: z.enum(['standard', 'thanks']).default('standard'),
    requestId: z.uuid().optional(),
    expectedVersion: seq.optional(),
  })
  .strict();
export const decisionInput = z
  .object({
    commandId: z.uuid(),
    payloadId: z.uuid(),
    snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
    expectedVersion: seq,
    decision: z.enum(['approve', 'reject', 'revoke']),
    reason: z.string().trim().max(1000).default(''),
  })
  .strict();
export const reconcileInput = z
  .object({
    commandId: z.uuid(),
    expectedVersion: seq,
    action: z.enum(['lookup', 'stop', 'safe_retry']),
  })
  .strict();
export interface DeliveryRequest {
  id: string;
  workspace_id: string;
  factory_id: string | null;
  opportunity_id: string | null;
  thread_id: string;
  channel_account_id: string;
  contact_point_id: string;
  created_by_member_id: string;
  intent: string;
  authorization_mode: string;
  transport_mode: string;
  state: string;
  current_payload_version_id: string;
  dispatch_payload_version_id: string | null;
  provider_idempotency_key: string;
  provider_capabilities: import('@zutrade/channels').MockCapabilities | null;
  provider_guarantee_until: Date | null;
  stop_reason?: string | null;
  dispatch_token: string | null;
  dispatch_claimed_at: Date | null;
  cancel_requested_at: Date | null;
  row_version: string;
  scheduled_at?: Date | null;
}
const ws = (c: Context) => c.member.workspace_id;
export async function readOutbound(c: Context, id: string, lock = false) {
  const r = (
    await c.client.query<DeliveryRequest>(
      `SELECT * FROM app.outbound_requests WHERE workspace_id=$1 AND id=$2 ${lock ? 'FOR UPDATE' : ''}`,
      [ws(c), id],
    )
  ).rows[0];
  if (!r) throw new BoundaryError(404, '外发请求不存在或未获授权');
  await requireThread(c, r.thread_id);
  if (r.opportunity_id) await requireOpportunityThreads(c, r.opportunity_id);
  return r;
}
export async function readPayload(
  c: Context,
  r: DeliveryRequest,
  id = r.current_payload_version_id,
) {
  const p = (
    await c.client.query<OutboundPayload>(
      'SELECT * FROM app.outbound_payload_versions WHERE workspace_id=$1 AND outbound_request_id=$2 AND id=$3',
      [ws(c), r.id, id],
    )
  ).rows[0];
  if (!p) throw new BoundaryError(409, '外发版本不存在');
  return p;
}
export async function cAudit(c: Context, action: string, id: string, details: unknown) {
  await c.client.query(
    `INSERT INTO app.audit_events(workspace_id,actor_kind,actor_member_id,action,aggregate_type,aggregate_id,details) VALUES($1,'member',$2,$3,'outbound_request',$4,$5)`,
    [ws(c), c.member.id, action, id, JSON.stringify(details)],
  );
}
export async function command<T>(
  c: Context,
  id: string,
  kind: string,
  input: unknown,
  run: () => Promise<T>,
): Promise<T> {
  const digest = outboundHash({ kind, input, memberId: c.member.id });
  const old = (
    await c.client.query(
      'SELECT * FROM app.command_receipts WHERE workspace_id=$1 AND command_id=$2',
      [ws(c), id],
    )
  ).rows[0];
  if (old) {
    if (old.command_sha256 !== digest || old.member_id !== c.member.id)
      throw new BoundaryError(409, '同一命令键内容不一致');
    return old.result as T;
  }
  const result = await run();
  await c.client.query(
    'INSERT INTO app.command_receipts(workspace_id,command_id,member_id,command_kind,command_sha256,result) VALUES($1,$2,$3,$4,$5,$6)',
    [ws(c), id, c.member.id, kind, digest, JSON.stringify(result)],
  );
  return result;
}
export async function approvalEvent(
  c: Context,
  id: string,
  kind: string,
  reason: string,
  details: unknown = {},
) {
  await c.client.query(
    `INSERT INTO app.approval_events(workspace_id,approval_id,event_no,event_kind,actor_member_id,reason,details) SELECT $1,$2,COALESCE(max(event_no),0)+1,$3,$4,$5,$6 FROM app.approval_events WHERE workspace_id=$1 AND approval_id=$2`,
    [ws(c), id, kind, c.member.id, reason, JSON.stringify(details)],
  );
}
export async function endApproval(c: Context, a: { id: string }, state: string, reason: string) {
  await c.client.query(
    'UPDATE app.approvals SET state=$3,reason=$4 WHERE workspace_id=$1 AND id=$2',
    [ws(c), a.id, state, reason],
  );
  await approvalEvent(c, a.id, state, reason);
}
export function quoteMail(s: QuoteSnapshot, introduction = 'standard') {
  return normalizeOutbound({
    subject: `Quotation ${s.quoteNumber} v${s.version} — ${s.currency} ${s.totalAmount}`,
    body: [
      introduction === 'thanks'
        ? 'Thank you for confirming your requirements.'
        : 'Please review the following quotation and the attached PDF.',
      `Seller: ${s.seller.name}. The factory is the contracting, payment and fulfillment party.`,
      `Buyer: ${s.buyer.name}; Recipient: ${s.buyer.contactName} (${s.buyer.channelIdentity}).`,
      ...s.lines.map(
        (l) =>
          `${l.description}: ${l.quantity} ${l.unitCode} x ${s.currency} ${l.unitPrice} = ${l.kind === 'discount' ? '- ' : ''}${s.currency} ${l.amount}`,
      ),
      `TOTAL: ${s.currency} ${s.totalAmount}.`,
      `Specifications: ${s.requirements.specifications.fabric}; ${s.requirements.specifications.dimensions}; ${s.requirements.specifications.color}; ${s.requirements.specifications.printing}.`,
      `Production: ${s.production.days} ${s.production.dayKind} days. Starts after: ${s.production.startConditions}`,
      `Payment: ${s.paymentTerms ?? 'To be confirmed.'}`,
      `Samples: ${s.sampleTerms}`,
      ...s.exclusions.map((x) => `Excluded / scope: ${x}`),
      ...s.pendingItems.map((x) => `Pending confirmation: ${x}`),
      `Valid until: ${s.validUntil} (${s.timeZone}). Production time is not an arrival commitment.`,
      'SIMULATION. The saved PDF retains its original internal-preview watermark; this approval authorizes this exact saved content only.',
    ].join('\n\n'),
  });
}
export async function attachmentForQuote(c: Context, id: string, store: PrivateObjectStore) {
  const f = await downloadQuotePdf(c, id, store),
    m = f.manifest;
  if (!m.object_key || !m.object_version || !m.pdf_sha256)
    throw new BoundaryError(409, 'PDF 产物身份不完整');
  const manifest: AttachmentManifest = {
    artifactId: m.id,
    quoteVersionId: id,
    quoteSnapshotSha256: m.snapshot_sha256,
    objectKey: m.object_key,
    objectVersion: m.object_version,
    sha256: m.pdf_sha256,
    filename: f.filename,
    contentType: 'application/pdf',
    byteLength: Number(m.byte_length),
  };
  return { manifest, bytes: f.bytes };
}
export async function prepareOutbound(
  c: Context,
  input: unknown,
  threadId: string,
  store: PrivateObjectStore,
) {
  const i = prepareOutboundInput.parse(input);
  await requireThread(c, threadId);
  return command(c, i.commandId, 'prepare', { threadId, ...i }, async () => {
    const t = await requireThread(c, threadId, true);
    if (t.context_revision !== i.contextRevision)
      throw new BoundaryError(409, '会话上下文已变化，请重新查看');
    if (!t.primary_contact_point_id) throw new BoundaryError(409, '请先确认主收件人');
    const account = await lockAccount(c.client, ws(c), t.channel_account_id);
    const point = await eligibleContact(c.client, ws(c), t.primary_contact_point_id);
    const unresolved = await c.client.query(
      `SELECT id FROM app.outbound_requests WHERE workspace_id=$1 AND (thread_id=$2 OR (channel_account_id=$3 AND contact_point_id=$4)) AND state IN('claimed','dispatching','unknown') LIMIT 1`,
      [ws(c), threadId, account.id, point.id],
    );
    if (unresolved.rowCount)
      throw new BoundaryError(
        409,
        '此会话仍有在途或结果未知请求，请先核对；更换请求身份不能消除重复风险',
      );
    let q: Awaited<ReturnType<typeof requireQuoteVersion>> | undefined;
    let a: Awaited<ReturnType<typeof attachmentForQuote>> | undefined;
    if (i.kind === 'quote') {
      if (!i.quoteVersionId || i.body !== undefined)
        throw new BoundaryError(422, '报价正文必须由冻结报价字段生成');
      q = await requireQuoteVersion(c, i.quoteVersionId);
      if (!q.availability.available)
        throw new BoundaryError(409, q.availability.reasons.join('；'));
      if (q.snapshot.buyer.channelIdentity !== point.normalized_value)
        throw new BoundaryError(409, '报价收件人与当前联系人不一致');
      if (
        !(
          await c.client.query(
            'SELECT 1 FROM app.opportunity_threads WHERE workspace_id=$1 AND opportunity_id=$2 AND thread_id=$3',
            [ws(c), q.opportunity_id, threadId],
          )
        ).rowCount
      )
        throw new BoundaryError(409, '报价不属于当前会话');
      a = await attachmentForQuote(c, q.id, store);
    } else if (i.quoteVersionId !== null || !i.body?.trim())
      throw new BoundaryError(422, '自由文本须明确正文且不能附带未校验报价');
    const o =
      q ??
      (
        await c.client.query(
          'SELECT o.* FROM app.opportunities o JOIN app.opportunity_threads ot ON ot.workspace_id=o.workspace_id AND ot.opportunity_id=o.id WHERE ot.workspace_id=$1 AND ot.thread_id=$2 ORDER BY o.created_at,o.id LIMIT 1',
          [ws(c), threadId],
        )
      ).rows[0];
    if (o?.factory_id) await requireFactory(c, o.factory_id);
    let r: DeliveryRequest,
      version = 1;
    if (i.requestId) {
      r = await readOutbound(c, i.requestId, true);
      if (r.row_version !== i.expectedVersion)
        throw new BoundaryError(409, '外发内容已变化，请重新查看');
      if (
        r.dispatch_claimed_at ||
        ['claimed', 'dispatching', 'unknown'].includes(r.state) ||
        (
          await c.client.query(
            'SELECT id FROM app.delivery_attempts WHERE workspace_id=$1 AND outbound_request_id=$2',
            [ws(c), r.id],
          )
        ).rowCount
      )
        throw new BoundaryError(409, '已领取或尝试的请求不能更换内容');
      if (!['awaiting_approval', 'queued', 'ready', 'blocked', 'cancelled'].includes(r.state))
        throw new BoundaryError(409, '此请求不能追加版本');
      if (
        r.thread_id !== threadId ||
        r.contact_point_id !== point.id ||
        r.channel_account_id !== account.id ||
        r.factory_id !== (o?.factory_id ?? null) ||
        r.opportunity_id !== (q?.opportunity_id ?? o?.id ?? null) ||
        r.intent !== i.kind ||
        r.authorization_mode !== 'human_approval'
      )
        throw new BoundaryError(409, '请求身份不能修改，请建立新的审批请求');
      version = (
        await c.client.query(
          'SELECT COALESCE(max(version_no),0)+1 n FROM app.outbound_payload_versions WHERE workspace_id=$1 AND outbound_request_id=$2',
          [ws(c), r.id],
        )
      ).rows[0].n;
      const previous = (
        await c.client.query(
          "SELECT * FROM app.approvals WHERE workspace_id=$1 AND outbound_request_id=$2 AND state IN('pending','approved') FOR UPDATE",
          [ws(c), r.id],
        )
      ).rows;
      for (const old of previous)
        await endApproval(
          c,
          old,
          new Date(old.expires_at) <= (await databaseNow(c.client)) ? 'expired' : 'invalidated',
          '正文或附件已形成新版本',
        );
    } else {
      const id = randomUUID();
      r = (
        await c.client.query<DeliveryRequest>(
          `INSERT INTO app.outbound_requests(id,workspace_id,factory_id,opportunity_id,thread_id,channel_account_id,contact_point_id,transport_mode,intent,authorization_mode,state,idempotency_key,command_sha256,provider_idempotency_key,created_by_member_id) VALUES($1,$2,$3,$4,$5,$6,$7,'simulation',$8,'human_approval','awaiting_approval',$9,$10,$1::uuid::text,$11) RETURNING *`,
          [
            id,
            ws(c),
            o?.factory_id ?? null,
            q?.opportunity_id ?? o?.id ?? null,
            threadId,
            account.id,
            point.id,
            i.kind,
            i.commandId,
            outboundHash(i),
            c.member.id,
          ],
        )
      ).rows[0]!;
    }
    const mail = q ? quoteMail(q.snapshot, i.introduction) : { subject: null, body: i.body! };
    const cp = (
      await c.client.query(
        'SELECT buyer_id,contact_id FROM app.contact_points WHERE workspace_id=$1 AND id=$2',
        [ws(c), point.id],
      )
    ).rows[0];
    const p = normalizeOutbound({
      quote_version_id: q?.id ?? null,
      quote_snapshot_sha256: q?.snapshot_sha256 ?? null,
      thread_context_revision: String(t.context_revision),
      requirements_revision: q ? String(q.requirements_revision) : null,
      policy_version: '2',
      language_code: 'en',
      subject: mail.subject,
      body_text: mail.body,
      body_html: null,
      sender_snapshot: {
        accountId: account.id,
        provider: account.provider,
        externalAccountKey: account.external_account_key,
        displayName: account.display_name,
        channelKind: 'simulation',
        transportMode: 'simulation',
      },
      recipients_snapshot: [
        {
          contactPointId: point.id,
          namespace: point.namespace,
          scopeKey: point.scope_key,
          identity: point.normalized_value,
          buyerId: cp.buyer_id,
          contactId: cp.contact_id,
        },
      ],
      attachment_manifest: a ? [a.manifest] : [],
      channel_payload: {
        canonicalVersion: 'c-outbound-v1',
        origin: 'member_action',
        threadId,
        opportunityId: r.opportunity_id,
        factoryId: r.factory_id,
        intent: r.intent,
        authorizationMode: r.authorization_mode,
        templateId: q ? 'quote.c1' : 'owner-reviewed-free-text.c1',
        templateVersion: 1,
        parameters: q ? { introduction: i.introduction, quoteVersionId: q.id } : {},
        simulation: true,
      },
    });
    const payloadId = randomUUID(),
      digest = outboundHash(outboundSnapshot(p));
    await c.client.query(
      `INSERT INTO app.outbound_payload_versions(id,workspace_id,factory_id,outbound_request_id,version_no,quote_version_id,quote_snapshot_sha256,thread_context_revision,requirements_revision,policy_version,language_code,subject,body_text,body_html,sender_snapshot,recipients_snapshot,attachment_manifest,channel_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,2,'en',$10,$11,NULL,$12,$13,$14,$15)`,
      [
        payloadId,
        ws(c),
        r.factory_id,
        r.id,
        version,
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
        [ws(c), q.id, payloadId],
      );
    await c.client.query(
      'UPDATE app.outbound_payload_versions SET snapshot_sha256=$3,frozen_at=now() WHERE workspace_id=$1 AND id=$2',
      [ws(c), payloadId, digest],
    );
    await c.client.query(
      "UPDATE app.outbound_requests SET current_payload_version_id=$3,state='awaiting_approval',stop_reason=NULL,cancel_requested_at=NULL WHERE workspace_id=$1 AND id=$2",
      [ws(c), r.id, payloadId],
    );
    const expires = new Date(
      Math.min(
        (await databaseNow(c.client)).getTime() + 24 * 3600000,
        q ? new Date(q.valid_until).getTime() : Infinity,
      ),
    );
    const approval = (
      await c.client.query(
        `INSERT INTO app.approvals(workspace_id,outbound_request_id,payload_version_id,snapshot_sha256,requested_by_member_id,expires_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
        [ws(c), r.id, payloadId, digest, c.member.id, expires],
      )
    ).rows[0];
    await approvalEvent(c, approval.id, 'requested', '已冻结最终正文、主收件人与已保存 PDF', {
      payloadId,
      digest,
    });
    await cAudit(c, 'c.prepared', r.id, { payloadId, approvalId: approval.id });
    return { requestId: r.id, payloadId, approvalId: approval.id, state: 'awaiting_approval' };
  });
}
export async function enqueueDelivery(
  c: Context,
  boss: PgBoss,
  r: DeliveryRequest,
  payloadId: string,
  commandId: string,
  type = 'c.delivery-ready',
  extra: Record<string, unknown> = {},
  startAfter?: Date,
) {
  const eventId = randomUUID();
  const creator = (
    await c.client.query(
      'SELECT user_id FROM app.workspace_members WHERE workspace_id=$1 AND id=$2',
      [ws(c), r.created_by_member_id],
    )
  ).rows[0];
  if (!creator) throw new BoundaryError(409, '发起成员不存在');
  const payload = {
    requestId: r.id,
    payloadId,
    memberId: r.created_by_member_id,
    userId: creator.user_id,
    ...extra,
  };
  await c.client.query(
    "INSERT INTO app.outbox_events(id,workspace_id,event_type,aggregate_type,aggregate_id,handler_key,idempotency_key,payload) VALUES($1,$2,$3,'outbound_request',$4,$5,$6,$7)",
    [eventId, ws(c), type, r.id, DELIVERY_QUEUE, commandId, JSON.stringify(payload)],
  );
  const jobId = await boss.send(
    DELIVERY_QUEUE,
    { eventId, workspaceId: ws(c), userId: creator.user_id },
    {
      id: eventId,
      retryLimit: 3,
      retryDelay: 2,
      expireInSeconds: 90,
      ...(startAfter ? { startAfter } : {}),
      db: { executeSql: (sql, values) => c.client.query(sql, values) },
    },
  );
  if (!jobId) throw new Error('Queue rejected delivery');
  await c.client.query(
    'UPDATE app.outbox_events SET pg_boss_job_id=$3,enqueued_at=now() WHERE workspace_id=$1 AND id=$2',
    [ws(c), eventId, jobId],
  );
  return { eventId, jobId };
}

// Test-only injection is a service argument; HTTP schemas never accept it.
export type ApprovalFailure = 'approval' | 'business' | 'outbox' | 'enqueue';
export async function decideApproval(
  c: Context,
  boss: PgBoss,
  id: string,
  input: unknown,
  store: PrivateObjectStore,
  failure?: ApprovalFailure,
) {
  const i = decisionInput.parse(input);
  requireApprover(c);
  const visible = (
    await c.client.query(
      'SELECT outbound_request_id FROM app.approvals WHERE workspace_id=$1 AND id=$2',
      [ws(c), id],
    )
  ).rows[0];
  if (!visible) throw new BoundaryError(404, '审批不存在或未获授权');
  await readOutbound(c, visible.outbound_request_id);
  return command(c, i.commandId, 'decision', { id, ...i }, async () => {
    const a = (
      await c.client.query(
        'SELECT * FROM app.approvals WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
        [ws(c), id],
      )
    ).rows[0];
    if (!a) throw new BoundaryError(404, '审批不存在或未获授权');
    const r = await readOutbound(c, a.outbound_request_id, true),
      p = await readPayload(c, r);
    if (
      a.row_version !== i.expectedVersion ||
      a.payload_version_id !== i.payloadId ||
      a.snapshot_sha256 !== i.snapshotSha256 ||
      r.current_payload_version_id !== i.payloadId
    )
      throw new BoundaryError(409, '审批目标或版本已变化，请重新查看正文、收件人与 PDF');
    if (i.decision === 'revoke') {
      if (!['pending', 'approved'].includes(a.state))
        throw new BoundaryError(409, '该审批已结束，不能重复撤销');
      const late = Boolean(r.dispatch_claimed_at);
      await c.client.query(
        "UPDATE app.approvals SET state='revoked',revoked_by_member_id=$3,revoked_at=now(),reason=$4 WHERE workspace_id=$1 AND id=$2",
        [ws(c), a.id, c.member.id, i.reason || 'owner 撤销'],
      );
      await approvalEvent(c, a.id, 'revoked', i.reason || 'owner 撤销', { claimed: late });
      if (late)
        await approvalEvent(
          c,
          a.id,
          'revocation_too_late',
          '发送权已领取；本次可能已被渠道接受，须核对',
        );
      await c.client.query(
        `UPDATE app.outbound_requests SET cancel_requested_at=now(),state=CASE WHEN dispatch_claimed_at IS NULL THEN 'cancelled' ELSE state END,stop_reason=$3 WHERE workspace_id=$1 AND id=$2`,
        [ws(c), r.id, late ? '取消申请已记录，不能承诺本次已撤回' : '已在领取发送权前撤销'],
      );
      return { state: late ? 'cancel_requested' : 'cancelled', requestId: r.id };
    }
    if (a.state !== 'pending') throw new BoundaryError(409, '审批已处理，请查看最新状态');
    if (new Date(a.expires_at) <= (await databaseNow(c.client))) {
      await endApproval(c, a, 'expired', '审批固定有效期已到，请重新申请');
      return { state: 'expired', conflict: '审批已过期，请重新提交最终内容' };
    }
    if (i.decision === 'reject') {
      await endApproval(c, a, 'rejected', i.reason || 'owner 拒绝');
      await c.client.query(
        "UPDATE app.outbound_requests SET state='blocked',stop_reason=$3 WHERE workspace_id=$1 AND id=$2",
        [ws(c), r.id, i.reason || 'owner 拒绝，请修改后重新申请'],
      );
      return { state: 'rejected', requestId: r.id };
    }
    const { validatePayload, readVerifiedAttachments } = await import('./delivery-checks.js');
    try {
      await validatePayload(c, r, p, { approval: false });
      await readVerifiedAttachments(store, p.attachment_manifest);
    } catch (e) {
      if (!(e instanceof BoundaryError)) throw e;
      await endApproval(c, a, 'invalidated', e.message);
      await c.client.query(
        "UPDATE app.outbound_requests SET state='blocked',stop_reason=$3 WHERE workspace_id=$1 AND id=$2",
        [ws(c), r.id, e.message],
      );
      return { state: 'invalidated', conflict: e.message };
    }
    await c.client.query(
      "UPDATE app.approvals SET state='approved',approved_by_member_id=$3,approved_at=now() WHERE workspace_id=$1 AND id=$2",
      [ws(c), a.id, c.member.id],
    );
    await approvalEvent(c, a.id, 'approved', '批准确切最终内容并模拟执行', {
      payloadId: p.id,
      snapshotSha256: p.snapshot_sha256,
    });
    if (failure === 'approval') throw new Error('Injected after approval');
    await c.client.query(
      "UPDATE app.outbound_requests SET state='queued',stop_reason=NULL WHERE workspace_id=$1 AND id=$2",
      [ws(c), r.id],
    );
    if (failure === 'business') throw new Error('Injected after business');
    // Split enqueue hooks are explicit and still use this exact transaction connection.
    const eventId = randomUUID(),
      creator = (
        await c.client.query(
          'SELECT user_id FROM app.workspace_members WHERE workspace_id=$1 AND id=$2',
          [ws(c), r.created_by_member_id],
        )
      ).rows[0];
    await c.client.query(
      `INSERT INTO app.outbox_events(id,workspace_id,event_type,aggregate_type,aggregate_id,handler_key,idempotency_key,payload) VALUES($1,$2,'c.delivery-ready','outbound_request',$3,$4,$5,$6)`,
      [
        eventId,
        ws(c),
        r.id,
        DELIVERY_QUEUE,
        i.commandId,
        JSON.stringify({
          requestId: r.id,
          payloadId: p.id,
          memberId: r.created_by_member_id,
          userId: creator.user_id,
        }),
      ],
    );
    if (failure === 'outbox') throw new Error('Injected after outbox');
    const jobId = await boss.send(
      DELIVERY_QUEUE,
      { eventId, workspaceId: ws(c), userId: creator.user_id },
      {
        id: eventId,
        retryLimit: 3,
        retryDelay: 2,
        expireInSeconds: 90,
        ...(p.channel_payload.d2 && r.scheduled_at ? { startAfter: new Date(r.scheduled_at) } : {}),
        db: { executeSql: (sql, values) => c.client.query(sql, values) },
      },
    );
    if (!jobId) throw new Error('Queue rejected approval');
    if (failure === 'enqueue') throw new Error('Injected after enqueue');
    await c.client.query(
      'UPDATE app.outbox_events SET pg_boss_job_id=$3,enqueued_at=now() WHERE workspace_id=$1 AND id=$2',
      [ws(c), eventId, jobId],
    );
    await cAudit(c, 'c.approved-and-enqueued', r.id, {
      approvalId: a.id,
      payloadId: p.id,
      eventId,
      jobId,
    });
    return { state: 'queued', requestId: r.id, eventId, jobId };
  });
}
export async function requestReconciliation(c: Context, boss: PgBoss, id: string, input: unknown) {
  const i = reconcileInput.parse(input);
  requireApprover(c);
  await readOutbound(c, id);
  return command(c, i.commandId, 'reconcile', { id, ...i }, async () => {
    const r = await readOutbound(c, id, true);
    if (r.row_version !== i.expectedVersion)
      throw new BoundaryError(409, '执行状态已变化，请重新查看');
    if (!r.dispatch_token || !['claimed', 'dispatching', 'unknown', 'simulated'].includes(r.state))
      throw new BoundaryError(409, '此请求没有需要核对的执行');
    if (i.action === 'stop') {
      await c.client.query(
        "UPDATE app.outbound_requests SET cancel_requested_at=now(),stop_reason='已停止后续尝试；本次结果仍须核对' WHERE workspace_id=$1 AND id=$2",
        [ws(c), id],
      );
      await cAudit(c, 'c.stop-future-attempts', id, {
        conclusion: 'inconclusive',
        providerKey: r.provider_idempotency_key,
      });
    }
    const job = await enqueueDelivery(
      c,
      boss,
      r,
      r.dispatch_payload_version_id!,
      i.commandId,
      'c.reconcile',
      { action: i.action, operatorMemberId: c.member.id },
    );
    return { state: 'reconciling', ...job };
  });
}
export async function outboundWorkspace(c: Context, threadId?: string) {
  if (threadId) await requireThread(c, threadId);
  const requests = (
    await c.client.query<DeliveryRequest>(
      `SELECT * FROM app.outbound_requests WHERE workspace_id=$1 AND authorization_mode IN('human_approval','batch_approval') AND ($2::uuid IS NULL OR thread_id=$2) ORDER BY created_at DESC,id LIMIT 60`,
      [ws(c), threadId ?? null],
    )
  ).rows;
  const { validatePayload } = await import('./delivery-checks.js');
  const items = [];
  for (const r of requests) {
    try {
      await readOutbound(c, r.id);
    } catch (e) {
      if (e instanceof BoundaryError && e.status === 404) continue;
      throw e;
    }
    const p = await readPayload(c, r);
    const approvals = (
      await c.client.query(
        'SELECT * FROM app.approvals WHERE workspace_id=$1 AND outbound_request_id=$2 ORDER BY created_at DESC,id',
        [ws(c), r.id],
      )
    ).rows;
    const a = approvals.find(
      (x) => x.payload_version_id === p.id && ['pending', 'approved'].includes(x.state),
    );
    if (a) {
      let state: string | undefined,
        reason = '';
      if (new Date(a.expires_at) <= (await databaseNow(c.client))) {
        state = 'expired';
        reason = '审批固定有效期已到，请重新提交';
      } else if (!r.dispatch_claimed_at) {
        try {
          await validatePayload(c, r, p, { approval: a.state === 'approved', barrier: false });
        } catch (e) {
          if (!(e instanceof BoundaryError)) throw e;
          state = 'invalidated';
          reason = e.message;
        }
      }
      if (state) {
        await endApproval(c, a, state, reason);
        a.state = state;
        a.reason = reason;
        a.row_version = String(BigInt(a.row_version) + 1n);
        if (!r.dispatch_claimed_at) {
          await c.client.query(
            "UPDATE app.outbound_requests SET state='blocked',stop_reason=$3 WHERE workspace_id=$1 AND id=$2",
            [ws(c), r.id, reason],
          );
          r.state = 'blocked';
          r.stop_reason = reason;
        }
      }
    }
    const events = (
      await c.client.query(
        'SELECT e.* FROM app.approval_events e JOIN app.approvals a ON a.workspace_id=e.workspace_id AND a.id=e.approval_id WHERE a.workspace_id=$1 AND a.outbound_request_id=$2 ORDER BY e.created_at,e.event_no',
        [ws(c), r.id],
      )
    ).rows;
    const attempts = (
      await c.client.query(
        'SELECT * FROM app.delivery_attempts WHERE workspace_id=$1 AND outbound_request_id=$2 ORDER BY attempt_no',
        [ws(c), r.id],
      )
    ).rows;
    const audit = (
      await c.client.query(
        'SELECT * FROM app.audit_events WHERE workspace_id=$1 AND aggregate_id=$2 ORDER BY occurred_at,id',
        [ws(c), r.id],
      )
    ).rows;
    const versions = (
      await c.client.query(
        'SELECT id,version_no,body_text,subject,snapshot_sha256,quote_version_id,attachment_manifest FROM app.outbound_payload_versions WHERE workspace_id=$1 AND outbound_request_id=$2 ORDER BY version_no',
        [ws(c), r.id],
      )
    ).rows;
    items.push({ request: r, payload: p, approvals, events, attempts, audit, versions });
  }
  return { items };
}
