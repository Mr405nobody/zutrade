import type { PgBoss } from 'pg-boss';
import { BoundaryError, requireFactory } from '@zutrade/db';
import type { Context } from '@zutrade/db';
import {
  outboundInputSchema,
  outboundReviewSchema,
  researchRequestSchema,
} from '@zutrade/contracts';
import type {
  OutboundInput,
  OutboundCompany,
  OutboundReviewInput,
  ResearchCandidate,
} from '@zutrade/contracts';
import { buildDueDiligence } from '@zutrade/prospecting';
import { createResearch, listResearch } from './prospecting.js';
export async function createOutbound(c: Context, boss: PgBoss, raw: OutboundInput) {
  const input = outboundInputSchema.parse(raw);
  return createResearch(
    c,
    boss,
    researchRequestSchema.parse({
      commandId: input.commandId,
      factoryId: input.factoryId,
      provider: input.mode === 'manual' ? 'outbound_manual' : 'outbound_unavailable',
      country: input.country,
      buyerType: input.buyerType,
      keywords: [input.product],
      limit: input.limit,
      websiteUrls: input.mode === 'manual' ? input.websiteUrls : [],
      permissionAcknowledged: input.permissionAcknowledged,
    }),
    { storageRights: false },
  );
}
const companySelect = `SELECT o.*,u.display_name AS reviewer_name,c->>'country' AS country,r.data_origin
 FROM app.outbound_companies o JOIN app.prospecting_runs r ON r.workspace_id=o.workspace_id AND r.factory_id=o.factory_id AND r.id=o.run_id
 CROSS JOIN LATERAL jsonb_array_elements(r.results_snapshot->'candidates') c
 LEFT JOIN app.workspace_members m ON m.workspace_id=o.workspace_id AND m.id=o.reviewed_by
 LEFT JOIN app.app_users u ON u.id=m.user_id
 WHERE o.workspace_id=$1 AND c->>'key'=o.candidate_key`;
export async function outboundDashboard(c: Context) {
  const runs = (await listResearch(c)).filter((r) => r.provider.startsWith('outbound_'));
  const companies = (
    await c.client.query<OutboundCompany>(
      companySelect + ' ORDER BY o.created_at DESC,o.id LIMIT 100',
      [c.member.workspace_id],
    )
  ).rows;
  return {
    automatic: {
      available: false,
      detail:
        '自动搜索不可用：本机未配置可用的免费搜索源。当前使用手动官网导入；不会调用商业搜索 API。',
    },
    runs,
    companies,
  };
}
export async function outboundCompanyDetail(c: Context, id: string) {
  const company = (
    await c.client.query<OutboundCompany>(companySelect + ' AND o.id=$2', [
      c.member.workspace_id,
      id,
    ])
  ).rows[0];
  if (!company) throw new BoundaryError(404, '公司不存在或未获工厂授权');
  await requireFactory(c, company.factory_id);
  const run = (
    await c.client.query(
      'SELECT request,results_snapshot FROM app.prospecting_runs WHERE workspace_id=$1 AND id=$2',
      [c.member.workspace_id, company.run_id],
    )
  ).rows[0]!;
  const candidate = run.results_snapshot.candidates.find(
    (v: ResearchCandidate) => v.key === company.candidate_key,
  ) as ResearchCandidate;
  const history = (
    await c.client.query(
      `SELECT a.occurred_at AS at,COALESCE(u.display_name,'未知成员') AS actor,a.details FROM app.audit_events a LEFT JOIN app.workspace_members m ON m.workspace_id=a.workspace_id AND m.id=a.actor_member_id LEFT JOIN app.app_users u ON u.id=m.user_id WHERE a.workspace_id=$1 AND a.aggregate_type='outbound_company' AND a.aggregate_id=$2 ORDER BY a.occurred_at DESC,a.id DESC LIMIT 30`,
      [c.member.workspace_id, id],
    )
  ).rows;
  return { company, candidate, report: buildDueDiligence(candidate, run.request), history };
}
export async function reviewOutboundCompany(c: Context, id: string, raw: OutboundReviewInput) {
  const input = outboundReviewSchema.parse(raw);
  const detail = await outboundCompanyDetail(c, id);
  const factory = await requireFactory(c, detail.company.factory_id);
  if (factory.status !== 'active') throw new BoundaryError(409, '工厂已停用');
  const r = await c.client.query(
    `UPDATE app.outbound_companies SET review_status=$1,corrections=$2,review_notes=$3,reviewed_by=$4,reviewed_at=clock_timestamp(),revision=revision+1 WHERE workspace_id=$5 AND id=$6 AND revision=$7 RETURNING revision`,
    [
      input.status,
      JSON.stringify(input.corrections),
      input.notes,
      c.member.id,
      c.member.workspace_id,
      id,
      input.revision,
    ],
  );
  if (!r.rowCount) throw new BoundaryError(409, '审核版本已变化，请刷新后重试');
  await c.client.query(
    `INSERT INTO app.audit_events(workspace_id,actor_kind,actor_member_id,action,aggregate_type,aggregate_id,details) VALUES($1,'member',$2,'outbound.company-reviewed','outbound_company',$3,$4)`,
    [
      c.member.workspace_id,
      c.member.id,
      id,
      JSON.stringify({
        ...input,
        revision: r.rows[0].revision,
        sourceRunId: detail.company.run_id,
      }),
    ],
  );
  return outboundCompanyDetail(c, id);
}
