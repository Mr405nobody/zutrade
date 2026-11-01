import { BoundaryError, requireFactory, databaseNow } from '@zutrade/db';
import type { Context } from '@zutrade/db';
import { requireThread } from './inbox.js';
import { requireQuoteVersion } from './quoting.js';
import { QUOTE_PDF_TEMPLATE_VERSION } from './quote-pdf.js';
import {
  replyTemplates,
  lockAccount,
  eligibleContact,
  legacyHash,
  legacySnapshot,
} from './delivery.js';
import { outboundHash, outboundSnapshot } from './outbound-canonical.js';
import type { OutboundPayload, AttachmentManifest } from './outbound-canonical.js';
import { quoteMail } from './approval.js';
import type { DeliveryRequest } from './approval.js';

export function payloadDigest(p: OutboundPayload) {
  return p.channel_payload.canonicalVersion === 'c-outbound-v1'
    ? outboundHash(outboundSnapshot(p))
    : legacyHash(legacySnapshot(p));
}
export async function checkCreator(c: Context, r: DeliveryRequest) {
  const valid = (
    await c.client.query(
      `SELECT m.* FROM app.workspace_members m JOIN app.app_users u ON u.id=m.user_id AND u.status='active' JOIN app.workspaces w ON w.id=m.workspace_id AND w.status='active' WHERE m.workspace_id=$1 AND m.id=$2 AND m.status='active' AND m.role IN('owner','sales') FOR SHARE OF m`,
      [c.member.workspace_id, r.created_by_member_id],
    )
  ).rows[0];
  if (!valid) throw new BoundaryError(409, '发起成员已停用或权限失效');
  const inaccessible = (
    await c.client.query(
      `SELECT 1 FROM app.opportunity_threads ot JOIN app.opportunities o ON o.workspace_id=ot.workspace_id AND o.id=ot.opportunity_id WHERE ot.workspace_id=$1 AND ot.thread_id=$2 AND ((o.factory_id IS NULL AND $3<>'owner') OR (o.factory_id IS NOT NULL AND NOT($4::boolean OR EXISTS(SELECT 1 FROM app.factory_memberships fm WHERE fm.workspace_id=$1 AND fm.member_id=$5 AND fm.factory_id=o.factory_id)))) LIMIT 1`,
      [c.member.workspace_id, r.thread_id, valid.role, valid.all_factories, valid.id],
    )
  ).rowCount;
  if (inaccessible) throw new BoundaryError(409, '发起成员工厂授权已失效');
}
export async function checkManifest(c: Context, p: OutboundPayload) {
  if (!p.quote_version_id) {
    if (p.attachment_manifest.length)
      throw new BoundaryError(409, '自由文本不能附带未经绑定的附件');
    return;
  }
  const m = (
    await c.client.query(
      `SELECT * FROM app.quote_pdf_artifacts WHERE workspace_id=$1 AND quote_version_id=$2 AND template_version=$3`,
      [c.member.workspace_id, p.quote_version_id, QUOTE_PDF_TEMPLATE_VERSION],
    )
  ).rows[0];
  const a = p.attachment_manifest[0];
  if (
    !m ||
    m.state !== 'ready' ||
    p.attachment_manifest.length !== 1 ||
    !a ||
    m.id !== a.artifactId ||
    m.quote_version_id !== a.quoteVersionId ||
    m.snapshot_sha256 !== p.quote_snapshot_sha256 ||
    m.snapshot_sha256 !== a.quoteSnapshotSha256 ||
    m.object_key !== a.objectKey ||
    m.object_version !== a.objectVersion ||
    m.pdf_sha256 !== a.sha256 ||
    Number(m.byte_length) !== a.byteLength ||
    m.content_type !== a.contentType
  )
    throw new BoundaryError(409, 'PDF 归属、版本或摘要绑定不一致');
}
export async function validatePayload(
  c: Context,
  r: DeliveryRequest,
  p: OutboundPayload,
  options: { approval?: boolean; barrier?: boolean } = {},
) {
  const ws = c.member.workspace_id;
  const now = await databaseNow(c.client);
  await checkCreator(c, r);
  const t = await requireThread(c, r.thread_id, true);
  const account = await lockAccount(c.client, ws, r.channel_account_id);
  if (account.transport_mode !== 'simulation' || r.transport_mode !== 'simulation')
    throw new BoundaryError(409, '只允许 simulation');
  if (t.state === 'closed') throw new BoundaryError(409, '会话已关闭');
  if (t.outbound_paused) throw new BoundaryError(409, 'THREAD_PAUSED：会话已暂停新外发');
  if (
    t.primary_contact_point_id !== r.contact_point_id ||
    t.channel_account_id !== r.channel_account_id
  )
    throw new BoundaryError(409, '主收件人或渠道账号已变化，须新建请求');
  if (r.factory_id) {
    const f = await requireFactory(c, r.factory_id);
    if (f.status !== 'active') throw new BoundaryError(409, '工厂已停用');
    const a = (
      await c.client.query(
        'SELECT authority_valid_until FROM app.factories WHERE workspace_id=$1 AND id=$2',
        [ws, r.factory_id],
      )
    ).rows[0];
    if (a?.authority_valid_until && new Date(a.authority_valid_until) <= now)
      throw new BoundaryError(409, '工厂代理授权已到期');
  }
  const point = await eligibleContact(c.client, ws, r.contact_point_id);
  if (point.namespace !== 'zutrade-simulation' || point.scope_key !== account.id)
    throw new BoundaryError(409, '收件渠道身份不一致');
  const cp = (
    await c.client.query(
      'SELECT buyer_id,contact_id FROM app.contact_points WHERE workspace_id=$1 AND id=$2',
      [ws, point.id],
    )
  ).rows[0];
  if (r.opportunity_id) {
    const o = (
      await c.client.query(
        `SELECT o.* FROM app.opportunities o JOIN app.opportunity_threads ot ON ot.workspace_id=o.workspace_id AND ot.opportunity_id=o.id WHERE o.workspace_id=$1 AND o.id=$2 AND ot.thread_id=$3`,
        [ws, r.opportunity_id, t.id],
      )
    ).rows[0];
    if (!o || o.factory_id !== r.factory_id || o.buyer_id !== cp.buyer_id)
      throw new BoundaryError(409, '买家、商机或工厂归属不一致');
  }
  if (
    (
      await c.client.query(
        'SELECT 1 FROM app.contact_permissions WHERE workspace_id=$1 AND contact_point_id=$2 AND do_not_contact LIMIT 1',
        [ws, point.id],
      )
    ).rowCount
  )
    throw new BoundaryError(409, '联系人已要求停止联系');
  if (
    options.barrier !== false &&
    (await c.client.query('SELECT app.a2_has_inbound_barrier($1,$2) blocked', [ws, account.id]))
      .rows[0].blocked
  )
    throw new BoundaryError(409, '存在未处理的原始入站收据（重试或 dead 仍阻挡）');
  if (!p.frozen_at || p.invalidated_at || p.snapshot_sha256 !== payloadDigest(p))
    throw new BoundaryError(409, '冻结外发快照无法核验');
  if (String(p.thread_context_revision) !== String(t.context_revision))
    throw new BoundaryError(409, '会话上下文已变化，须重新查看和审批');
  const legacy = p.channel_payload.canonicalVersion !== 'c-outbound-v1';
  const sender = {
    accountId: account.id,
    provider: account.provider,
    externalAccountKey: account.external_account_key,
    displayName: account.display_name,
    ...(!legacy ? { channelKind: 'simulation', transportMode: 'simulation' } : {}),
  };
  const recipient = {
    contactPointId: point.id,
    namespace: point.namespace,
    scopeKey: point.scope_key,
    identity: point.normalized_value,
    ...(!legacy ? { buyerId: cp.buyer_id, contactId: cp.contact_id } : {}),
  };
  if (
    outboundHash(p.sender_snapshot) !== outboundHash(sender) ||
    p.recipients_snapshot.length !== 1 ||
    outboundHash(p.recipients_snapshot) !== outboundHash([recipient])
  )
    throw new BoundaryError(409, '发件或收件身份已变化，不能重定向已批准内容');
  const d2 = Boolean(p.channel_payload.d2);
  if (d2) {
    const { validateD2Payload } = await import('./outreach.js');
    await validateD2Payload(c, r, p, options.approval !== false);
  } else if (r.authorization_mode === 'verified_faq_policy') {
    const { validateFAQPayload } = await import('./ai.js');
    await validateFAQPayload(c, r, p);
  } else if (r.authorization_mode === 'member_send') {
    const template = replyTemplates.find((x) => x.id === p.channel_payload.templateId);
    if (
      r.intent !== 'human_reply' ||
      !template ||
      p.body_text !== template.bodyText ||
      p.subject !== null ||
      p.body_html !== null ||
      p.quote_version_id !== null ||
      p.attachment_manifest.length ||
      String(p.policy_version) !== '1' ||
      p.language_code !== 'en' ||
      legacyHash(p.channel_payload) !==
        legacyHash({ templateId: template.id, templateVersion: 1, simulation: true })
    )
      throw new BoundaryError(409, '受控中性模板不符合 member_send 协议');
  } else if (r.authorization_mode === 'human_approval') {
    if (
      legacy ||
      p.channel_payload.origin !== 'member_action' ||
      !['quote', 'human_reply'].includes(r.intent)
    )
      throw new BoundaryError(409, '缺少明确的人工动作来源');
    if (
      p.channel_payload.threadId !== r.thread_id ||
      p.channel_payload.opportunityId !== r.opportunity_id ||
      p.channel_payload.factoryId !== r.factory_id ||
      p.channel_payload.intent !== r.intent ||
      p.channel_payload.authorizationMode !== r.authorization_mode
    )
      throw new BoundaryError(409, '完整快照业务身份不一致');
  } else {
    // Future FAQ/batch/followup producers have typed intents, but no production authorization yet.
    throw new BoundaryError(
      409,
      t.control_mode === 'human' ? '人工接管已停止旧自动动作' : '该自动生产者尚未启用',
    );
  }
  if (!d2 && r.intent === 'quote') {
    if (!p.quote_version_id) throw new BoundaryError(409, '报价请求缺少报价版本');
    const q = await requireQuoteVersion(c, p.quote_version_id);
    if (!q.availability.available) throw new BoundaryError(409, q.availability.reasons.join('；'));
    const parameters = p.channel_payload.parameters as { introduction?: string } | undefined;
    const mail = quoteMail(q.snapshot, parameters?.introduction);
    if (
      !['standard', 'thanks'].includes(parameters?.introduction ?? '') ||
      mail.body !== p.body_text ||
      mail.subject !== p.subject
    )
      throw new BoundaryError(409, '报价正文与冻结商业条款不一致');
    if (
      q.snapshot_sha256 !== p.quote_snapshot_sha256 ||
      q.opportunity_id !== r.opportunity_id ||
      String(q.requirements_revision) !== String(p.requirements_revision) ||
      q.snapshot.buyer.channelIdentity !== point.normalized_value
    )
      throw new BoundaryError(409, '冻结报价或需求关联不一致');
  }
  if (!legacy && !d2 && r.authorization_mode !== 'verified_faq_policy') {
    const expectedChannel = {
      canonicalVersion: 'c-outbound-v1',
      origin: 'member_action',
      threadId: r.thread_id,
      opportunityId: r.opportunity_id,
      factoryId: r.factory_id,
      intent: r.intent,
      authorizationMode: r.authorization_mode,
      templateId: r.intent === 'quote' ? 'quote.c1' : 'owner-reviewed-free-text.c1',
      templateVersion: 1,
      parameters:
        r.intent === 'quote'
          ? {
              introduction: (p.channel_payload.parameters as { introduction: string }).introduction,
              quoteVersionId: p.quote_version_id,
            }
          : {},
      simulation: true,
    };
    if (
      outboundHash(expectedChannel) !== outboundHash(p.channel_payload) ||
      p.body_html !== null ||
      p.language_code !== 'en' ||
      String(p.policy_version) !== '2'
    )
      throw new BoundaryError(409, '含额外收件人、渠道字段或未支持的外发内容');
  }
  await checkManifest(c, p);
  if (options.approval !== false && r.authorization_mode === 'human_approval') {
    const a = (
      await c.client.query(
        `SELECT a.*,m.status AS member_status,m.role,u.status AS user_status,w.approver_member_id FROM app.approvals a JOIN app.workspaces w ON w.id=a.workspace_id LEFT JOIN app.workspace_members m ON m.workspace_id=a.workspace_id AND m.id=a.approved_by_member_id LEFT JOIN app.app_users u ON u.id=m.user_id WHERE a.workspace_id=$1 AND a.outbound_request_id=$2 AND a.payload_version_id=$3 AND a.state='approved' FOR SHARE OF a`,
        [ws, r.id, p.id],
      )
    ).rows[0];
    if (
      !a ||
      a.snapshot_sha256 !== p.snapshot_sha256 ||
      new Date(a.expires_at) <= now ||
      a.role !== 'owner' ||
      a.member_status !== 'active' ||
      a.user_status !== 'active' ||
      a.approver_member_id !== a.approved_by_member_id
    )
      throw new BoundaryError(409, '审批过期、失效或指定 owner 已变化');
  }
  return { account, point };
}
export async function readVerifiedAttachments(
  store: {
    readVerified: (o: { key: string; sha256: string; byteLength: number }) => Promise<Uint8Array>;
  },
  manifest: AttachmentManifest[],
) {
  const files = [];
  for (const a of manifest) {
    try {
      const bytes = await store.readVerified({
        key: a.objectKey,
        sha256: a.sha256,
        byteLength: a.byteLength,
      });
      files.push({ sha256: a.sha256, bytes });
    } catch {
      throw new BoundaryError(409, 'PDF 文件缺失、被替换或摘要不符；请恢复原始字节');
    }
  }
  return files;
}
