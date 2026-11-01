import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  BoundaryError,
  requireFactory,
  requireApprover,
  databaseNow,
  withWorkspace,
  transaction,
} from '@zutrade/db';
import type { Context, pg } from '@zutrade/db';
import type { PgBoss } from 'pg-boss';
import type { PrivateObjectStore } from '@zutrade/storage';
import { saveFollowup } from './outreach.js';
import {
  aiInputSchema,
  aiOutputSchema,
  startAIInput,
  decideAIInput,
  AI_SCENARIO_VERSION,
  AI_BUSINESS_CLOCK,
  AI_FAQ_VALUES,
} from '@zutrade/contracts';
import type { AIInput, AIOutput, AIContext } from '@zutrade/contracts';
import { MockAIProvider, scenarioFor, scenarios, faqBody } from '@zutrade/ai';
import type { AIProvider } from '@zutrade/ai';
import { requireThread } from './inbox.js';
import { requireProduct } from './supply.js';
import { saveRequirements, requirementsSchema, requireOpportunityThreads } from './quoting.js';
import { saveInternalDraft, lockAccount, eligibleContact, DELIVERY_QUEUE } from './delivery.js';
import { outboundHash, outboundSnapshot } from './outbound-canonical.js';
import type { OutboundPayload } from './outbound-canonical.js';
import type { DeliveryRequest } from './approval.js';
export const AI_QUEUE = 'e.ai';
export { scenarios as aiScenarios };
const ws = (c: Context) => c.member.workspace_id;
async function audit(c: Context, action: string, id: string, details: object) {
  await c.client.query(
    `INSERT INTO app.audit_events(workspace_id,actor_member_id,actor_kind,action,aggregate_type,aggregate_id,details) VALUES($1,$2,'member',$3,'ai_run',$4,$5)`,
    [ws(c), c.member.id, action, id, JSON.stringify(details)],
  );
}
const templatePolicy = {
  version: 'faq.e1',
  material: 'The confirmed material of CT-01 is {fabric}.',
  dimensions: 'The confirmed dimensions of CT-01 are {dimensions}.',
  fields: ['fabric', 'dimensions'],
  allowedValues: AI_FAQ_VALUES,
  commercial: false,
};
export async function reviewFAQPolicy(c: Context, enabled: boolean) {
  requireApprover(c);
  await audit(c, 'e.faq-policy', ws(c), { enabled, policyHash: outboundHash(templatePolicy) });
  return { enabled };
}
async function faqReview(c: Context) {
  return (
    await c.client.query(
      `SELECT a.id FROM app.audit_events a JOIN app.workspaces w ON w.id=a.workspace_id JOIN app.workspace_members m ON m.workspace_id=w.id AND m.id=a.actor_member_id AND m.status='active' AND m.role='owner' JOIN app.app_users u ON u.id=m.user_id AND u.status='active' WHERE a.workspace_id=$1 AND a.action='e.faq-policy' AND a.actor_member_id=w.approver_member_id AND a.details->>'policyHash'=$2 ORDER BY a.occurred_at DESC,a.id DESC LIMIT 1`,
      [ws(c), outboundHash(templatePolicy)],
    )
  ).rows[0];
}
async function policyEnabled(c: Context) {
  const row = await faqReview(c);
  if (!row) throw new BoundaryError(409, 'FAQ 模板尚未经当前指定 owner 审核');
  const a = (await c.client.query(`SELECT details FROM app.audit_events WHERE id=$1`, [row.id]))
    .rows[0];
  if (a.details.enabled !== true) throw new BoundaryError(409, 'FAQ 模板策略已停用');
  return row.id as string;
}
async function contextFor(
  c: Context,
  threadId: string,
  opportunityId: string,
  productId: string,
): Promise<{ inputContext: AIContext; text: string }> {
  const thread = await requireThread(c, threadId);
  await requireOpportunityThreads(c, opportunityId);
  const o = (
    await c.client.query(
      `SELECT o.* FROM app.opportunities o JOIN app.opportunity_threads ot ON ot.workspace_id=o.workspace_id AND ot.opportunity_id=o.id WHERE o.workspace_id=$1 AND o.id=$2 AND ot.thread_id=$3`,
      [ws(c), opportunityId, threadId],
    )
  ).rows[0];
  if (!o?.factory_id) throw new BoundaryError(404, '请先确认商机及工厂');
  const f = await requireFactory(c, o.factory_id);
  if (f.status !== 'active') throw new BoundaryError(409, '工厂已停用');
  const p = await requireProduct(c, productId);
  if (p.factory_id !== o.factory_id || p.state !== 'active')
    throw new BoundaryError(404, '产品不属于商机工厂或已停用');
  const message = (
    await c.client.query(
      `SELECT id,body_text FROM app.messages WHERE workspace_id=$1 AND thread_id=$2 AND direction='inbound' ORDER BY ingest_seq DESC LIMIT 1`,
      [ws(c), threadId],
    )
  ).rows[0];
  if (!message) throw new BoundaryError(409, '没有买家入站消息');
  // Strict projection: provider never receives source snapshots, costs, internal facts or other factories.
  const facts = (
    await c.client.query(
      `SELECT v.id,v.value->'specifications' AS specifications FROM app.facts f JOIN app.fact_versions v ON v.workspace_id=f.workspace_id AND v.id=f.current_version_id WHERE f.workspace_id=$1 AND f.factory_id=$2 AND f.product_id=$3 AND v.state='published' AND v.invalidated_at IS NULL AND v.verified_by_member_id IS NOT NULL AND v.disclosure='buyer_visible' AND v.valid_from<=clock_timestamp() AND v.valid_until>clock_timestamp() AND jsonb_typeof(v.value->'specifications')='object' AND EXISTS(SELECT 1 FROM app.fact_evidence e WHERE e.workspace_id=v.workspace_id AND e.fact_version_id=v.id) AND NOT EXISTS(SELECT 1 FROM app.fact_evidence e JOIN app.source_versions sv ON sv.workspace_id=e.workspace_id AND sv.id=e.source_version_id JOIN app.source_documents sd ON sd.workspace_id=sv.workspace_id AND sd.id=sv.source_document_id WHERE e.workspace_id=v.workspace_id AND e.fact_version_id=v.id AND (sv.revoked_at IS NOT NULL OR sv.valid_until<=clock_timestamp() OR sd.state<>'active' OR sd.current_version_id IS DISTINCT FROM sv.id)) ORDER BY v.id LIMIT 50`,
      [ws(c), o.factory_id, productId],
    )
  ).rows;
  const projected = [];
  for (const fact of facts) {
    const evidence = (
      await c.client.query(
        `SELECT e.fact_version_id AS "factVersionId",e.source_version_id AS "sourceVersionId",sv.content_sha256 AS "sourceSha256",e.locator,e.excerpt FROM app.fact_evidence e JOIN app.source_versions sv ON sv.workspace_id=e.workspace_id AND sv.id=e.source_version_id WHERE e.workspace_id=$1 AND e.fact_version_id=$2 ORDER BY e.id`,
        [ws(c), fact.id],
      )
    ).rows;
    projected.push({ specifications: fact.specifications, evidence });
  }
  return {
    text: message.body_text,
    inputContext: aiInputSchema.shape.context.parse({
      workspaceId: ws(c),
      factoryId: o.factory_id,
      threadId,
      opportunityId,
      productId,
      sku: p.sku,
      threadRevision: String(thread.context_revision),
      requirementsRevision: String(o.requirements_revision),
      opportunityVersion: String(o.row_version),
      controlMode: thread.control_mode,
      paused: thread.outbound_paused,
      messageId: message.id,
      facts: projected,
    }),
  };
}
async function runRow(c: Context, id: string) {
  const r = (
    await c.client.query(`SELECT * FROM app.ai_runs WHERE workspace_id=$1 AND id=$2`, [ws(c), id])
  ).rows[0];
  if (!r) throw new BoundaryError(404, '模拟 AI 运行不存在或未授权');
  await requireThread(c, r.thread_id);
  await requireFactory(c, r.factory_id);
  return r;
}
async function freshness(c: Context, r: Awaited<ReturnType<typeof runRow>>) {
  const input = aiInputSchema.parse(r.input_references.input);
  const cur = await contextFor(c, r.thread_id, r.opportunity_id, input.context.productId);
  if (
    outboundHash({ context: cur.inputContext, text: cur.text }) !== r.input_references.contextHash
  )
    return '上下文或事实已变化，旧建议失效';
  if ((await databaseNow(c.client)).getTime() - new Date(r.started_at).getTime() > 1800000)
    return '建议超过30分钟，请重新生成';
  if (
    (
      await c.client.query('SELECT app.a2_has_inbound_barrier($1,$2) blocked', [
        ws(c),
        (await requireThread(c, r.thread_id)).channel_account_id,
      ])
    ).rows[0].blocked
  )
    return '存在未处理入站收据，旧建议暂停';
  return null;
}
export async function aiWorkspace(c: Context, threadId: string) {
  await requireThread(c, threadId);
  const rows = (
    await c.client.query(
      `SELECT id FROM app.ai_runs WHERE workspace_id=$1 AND thread_id=$2 ORDER BY started_at DESC,id DESC LIMIT 20`,
      [ws(c), threadId],
    )
  ).rows;
  const runs = [];
  for (const { id } of rows) {
    const r = await runRow(c, id);
    const staleReason = await freshness(c, r);
    const action = (
      await c.client.query(
        `SELECT action,details FROM app.audit_events WHERE workspace_id=$1 AND aggregate_id=$2 AND action IN('e.faq-created','e.faq-blocked','e.faq-reused') ORDER BY occurred_at DESC,id DESC LIMIT 1`,
        [ws(c), id],
      )
    ).rows[0];
    let faqAction = null;
    if (action) {
      const requestId = action.details.requestId ?? null;
      const req = requestId
        ? (
            await c.client.query(
              `SELECT state,stop_reason FROM app.outbound_requests WHERE workspace_id=$1 AND id=$2`,
              [ws(c), requestId],
            )
          ).rows[0]
        : null;
      faqAction = {
        status: req?.state ?? 'blocked',
        reason:
          req?.stop_reason ??
          action.details.reason ??
          (action.action === 'e.faq-reused' ? '同一买家消息已有 FAQ 请求，重放不重复外发' : null),
        requestId,
      };
    }
    runs.push({ ...r, current: !staleReason, staleReason, faqAction });
  }
  let policy = null;
  try {
    policy = await policyEnabled(c);
  } catch {
    /* Explicit disabled status. */
  }
  return {
    scenarios,
    scenarioVersion: AI_SCENARIO_VERSION,
    businessClock: AI_BUSINESS_CLOCK,
    faqPolicyReviewed: Boolean(policy),
    templatePolicy,
    runs,
  };
}
export async function startAIRun(c: Context, boss: PgBoss, threadId: string, raw: unknown) {
  const p = startAIInput.parse(raw),
    ctx = await contextFor(c, threadId, p.opportunityId, p.productId);
  const commandHash = outboundHash({ threadId, memberId: c.member.id, ...p });
  const old = (
    await c.client.query(`SELECT * FROM app.ai_runs WHERE workspace_id=$1 AND command_id=$2`, [
      ws(c),
      p.commandId,
    ])
  ).rows[0];
  if (old) {
    if (old.input_references.commandHash !== commandHash)
      throw new BoundaryError(409, '同一 AI 命令内容不一致');
    return { runId: old.id, reused: true };
  }
  const input: AIInput = {
    task: p.task,
    text: ctx.text,
    context: ctx.inputContext,
    businessClock: AI_BUSINESS_CLOCK,
    scenarioVersion: AI_SCENARIO_VERSION,
  };
  const id = randomUUID(),
    eventId = randomUUID();
  await c.client.query(
    `INSERT INTO app.ai_runs(id,workspace_id,factory_id,thread_id,opportunity_id,trigger_message_id,provider,model_id,prompt_version,execution_mode,state,input_references,command_id,created_by_member_id,scenario_id,scenario_version,business_clock,auto_faq) VALUES($1,$2,$3,$4,$5,$6,'zutrade-mock','ct01-presets-v1','e-contract.v1','preset','running',$7,$8,$9,$10,$11,$12,$13)`,
    [
      id,
      ws(c),
      ctx.inputContext.factoryId,
      threadId,
      p.opportunityId,
      ctx.inputContext.messageId,
      JSON.stringify({
        input,
        contextHash: outboundHash({ context: ctx.inputContext, text: ctx.text }),
        commandHash,
      }),
      p.commandId,
      c.member.id,
      scenarioFor(input.text),
      AI_SCENARIO_VERSION,
      AI_BUSINESS_CLOCK,
      p.autoFaq,
    ],
  );
  await enqueue(c, boss, AI_QUEUE, 'e.ai-requested', id, eventId, {
    runId: id,
    memberId: c.member.id,
  });
  await audit(c, 'e.ai-requested', id, { task: p.task, autoFaq: p.autoFaq });
  return { runId: id, reused: false };
}
async function enqueue(
  c: Context,
  boss: PgBoss,
  queue: string,
  eventType: string,
  id: string,
  eventId: string,
  fields: Record<string, unknown>,
) {
  const payload = { ...fields, userId: c.user.id };
  await c.client.query(
    `INSERT INTO app.outbox_events(id,workspace_id,event_type,aggregate_type,aggregate_id,handler_key,idempotency_key,payload) VALUES($1,$2,$3,$4,$5,$6,$1::uuid::text,$7)`,
    [
      eventId,
      ws(c),
      eventType,
      queue === AI_QUEUE ? 'ai_run' : 'outbound_request',
      id,
      queue,
      JSON.stringify(payload),
    ],
  );
  const jobId = await boss.send(
    queue,
    { eventId, workspaceId: ws(c), userId: c.user.id },
    { id: eventId, db: { executeSql: (sql, values) => c.client.query(sql, values) } },
  );
  if (!jobId) throw new Error('Queue rejected AI event');
  await c.client.query(
    `UPDATE app.outbox_events SET pg_boss_job_id=$1,enqueued_at=clock_timestamp() WHERE workspace_id=$2 AND id=$3`,
    [jobId, ws(c), eventId],
  );
  return jobId;
}
export async function cancelAIRun(c: Context, id: string) {
  const r = await runRow(c, id);
  if (r.state === 'running') {
    await c.client.query(
      `UPDATE app.ai_runs SET state='cancelled',completed_at=clock_timestamp(),validation_result=$3 WHERE workspace_id=$1 AND id=$2`,
      [ws(c), id, JSON.stringify({ valid: false, reason: '用户取消' })],
    );
    await audit(c, 'e.ai-cancelled', id, {});
  }
  return { state: r.state === 'running' ? 'cancelled' : r.state };
}
export async function consumeAIJob(
  pool: pg.Pool,
  boss: PgBoss,
  data: unknown,
  jobId: string,
  hooks: { provider?: AIProvider; afterGenerate?: () => Promise<void> } = {},
) {
  const hint = z
    .object({ eventId: z.uuid(), workspaceId: z.uuid(), userId: z.uuid() })
    .strict()
    .parse(data);
  const meta = await transaction(
    pool,
    async (client) =>
      (await client.query(`SELECT app.e_ai_job($1,$2) meta`, [hint.eventId, jobId])).rows[0].meta,
  );
  if (!meta) return;
  if (meta.workspaceId !== hint.workspaceId) throw new Error('AI workspace mismatch');
  const scope = <T>(fn: (c: Context) => Promise<T>) =>
    withWorkspace(pool, { id: meta.subject, name: 'AI task actor' }, meta.workspaceId, fn);
  const r = await scope((c) => runRow(c, meta.runId));
  if (r.state !== 'running') return;
  const provider = hooks.provider ?? new MockAIProvider();
  let rawOutput: unknown = null;
  const started = performance.now();
  let output: AIOutput | null = null,
    error: string | null = null;
  try {
    if (provider.provider !== r.provider || provider.modelId !== r.model_id)
      throw new Error('PROVIDER_IDENTITY_MISMATCH');
    const response = await provider.generate(aiInputSchema.parse(r.input_references.input));
    const serialized = JSON.stringify(response);
    if (serialized && Buffer.byteLength(serialized) <= 32768) rawOutput = JSON.parse(serialized);
    output = aiOutputSchema.parse(response);
    const expected = await new MockAIProvider().generate(
      aiInputSchema.parse(r.input_references.input),
    );
    if (outboundHash(output) !== outboundHash(expected)) throw new Error('PRESET_OUTPUT_MISMATCH');
  } catch {
    error = 'PROVIDER_OR_OUTPUT_VALIDATION_FAILED';
  }
  const duration = Math.max(0, Math.round(performance.now() - started));
  await hooks.afterGenerate?.();
  // Recheck permission and cancellation after provider execution, outside its capabilities.
  const live = await transaction(
    pool,
    async (client) =>
      (await client.query(`SELECT app.e_ai_job($1,$2) meta`, [hint.eventId, jobId])).rows[0].meta,
  );
  if (!live) return;
  await scope(async (c) => {
    const run = await runRow(c, r.id);
    if (run.state !== 'running') return;
    const stale = await freshness(c, run);
    const reason = error ?? stale ?? output?.reason ?? null;
    await c.client.query(
      `UPDATE app.ai_runs SET state=$3,proposed_action=$4,validation_result=$5,completed_at=clock_timestamp(),duration_ms=$6,error_detail=$7,explanation_summary=$8 WHERE workspace_id=$1 AND id=$2`,
      [
        ws(c),
        r.id,
        error ? 'failed' : 'succeeded',
        JSON.stringify(output),
        JSON.stringify({
          valid: !error && !stale,
          reason,
          ...(error
            ? { rawOutput, outputValidation: 'rejected' }
            : { outputValidation: 'preset_recomputed' }),
        }),
        duration,
        error,
        output?.summary ?? null,
      ],
    );
    await audit(c, 'e.ai-completed', r.id, { state: error ? 'failed' : 'succeeded', reason });
    if (run.auto_faq && output?.faq && !stale && !error) {
      // A failed FAQ gate must not roll back the truthful AI result.
      await c.client.query('SAVEPOINT faq_action');
      try {
        await createFAQ(c, boss, r.id);
      } catch (e) {
        await c.client.query('ROLLBACK TO SAVEPOINT faq_action');
        await audit(c, 'e.faq-blocked', r.id, {
          reason: e instanceof Error ? e.message : 'FAQ_BLOCKED',
        });
      } finally {
        await c.client.query('RELEASE SAVEPOINT faq_action');
      }
    }
  });
}
export async function decideAISuggestion(
  c: Context,
  id: string,
  raw: unknown,
  services: { boss: PgBoss; store: PrivateObjectStore },
) {
  const p = decideAIInput.parse(raw),
    r = await runRow(c, id);
  const previous = (
    await c.client.query(
      `SELECT details FROM app.audit_events WHERE workspace_id=$1 AND action='e.ai-decision' AND aggregate_id=$2 AND details->>'commandId'=$3`,
      [ws(c), id, p.commandId],
    )
  ).rows[0];
  if (previous) {
    if (previous.details.inputHash !== outboundHash(p))
      throw new BoundaryError(409, '决策命令内容冲突');
    return r.decision_result;
  }
  if (r.decision) throw new BoundaryError(409, '建议已处理');
  if (r.state !== 'succeeded') throw new BoundaryError(409, '仅成功运行可处理建议');
  let result: Record<string, unknown> = {};
  if (p.decision !== 'reject') {
    const stale = await freshness(c, r);
    if (stale) throw new BoundaryError(409, stale);
    if (!r.validation_result?.valid) throw new BoundaryError(409, '生成时校验未通过，请重新生成');
    const out = aiOutputSchema.parse(r.proposed_action),
      input = aiInputSchema.parse(r.input_references.input);
    if (p.decision === 'modify') {
      if (!p.editedText) throw new BoundaryError(422, '修改建议需要正文');
      result = await saveInternalDraft(c, r.thread_id, {
        commandId: p.commandId,
        body: p.editedText,
      });
    } else if (out.quantity) {
      const o = (
        await c.client.query(`SELECT * FROM app.opportunities WHERE workspace_id=$1 AND id=$2`, [
          ws(c),
          r.opportunity_id,
        ])
      ).rows[0];
      const specs = input.context.facts[0]?.specifications;
      if (!specs) throw new BoundaryError(409, '无可用规格');
      const req = requirementsSchema.parse({
        unitCode: 'piece',
        destination: '',
        purpose: '',
        requestedTiming: '',
        language: 'en',
        pendingItems: ['目的地、用途与期望时间待买家确认'],
        internalNote: '',
        ...requirementsSchema.partial().strip().parse(o.requirements),
        ...{ quantity: out.quantity, productId: input.context.productId, specifications: specs },
      });
      const updated = await saveRequirements(c, r.thread_id, o.id, {
        expectedVersion: o.row_version,
        requirements: req,
      });
      result = {
        opportunityId: o.id,
        requirementsRevision: updated.requirements_revision,
        next: '请在采购需求中生成报价、PDF 并提交 owner 审批',
      };
    } else {
      result = await saveInternalDraft(c, r.thread_id, {
        commandId: p.commandId,
        body: out.retrieval?.request ?? out.followup?.internalDraft ?? out.summary,
      });
      if (out.retrieval || out.followup) {
        if (out.followup && (!p.localTime || !p.timeZone))
          throw new BoundaryError(422, '采用跟进建议需明确未来时间和时区');
        const due = new Date((await databaseNow(c.client)).getTime() + 3600000)
          .toISOString()
          .slice(0, 16);
        const plan = await saveFollowup(
          c,
          services.boss,
          {
            commandId: p.commandId,
            followupId: null,
            expectedVersion: null,
            threadId: r.thread_id,
            opportunityId: r.opportunity_id,
            ownerMemberId: c.member.id,
            quoteVersionId: null,
            purpose: out.retrieval?.request ?? out.followup!.purpose,
            internalDraft: out.retrieval?.request ?? out.followup!.internalDraft,
            mode: 'manual',
            localTime: out.followup ? p.localTime : due,
            timeZone: out.followup ? p.timeZone : 'UTC',
            disambiguation: 'reject',
            subject: 'Follow-up',
            body: '',
          },
          services.store,
        );
        result.followup = plan;
        result.next = out.retrieval
          ? '已创建资料待确认任务；不发布事实'
          : '已保存人工提醒；没有自动发送';
      }
    }
  }
  await c.client.query(
    `UPDATE app.ai_runs SET decision=$3,decision_text=$4,decision_result=$5 WHERE workspace_id=$1 AND id=$2`,
    [ws(c), id, p.decision, p.editedText ?? null, JSON.stringify(result)],
  );
  await audit(c, 'e.ai-decision', id, {
    commandId: p.commandId,
    inputHash: outboundHash(p),
    decision: p.decision,
    result,
  });
  return result;
}
async function createFAQ(c: Context, boss: PgBoss, id: string) {
  const r = await runRow(c, id),
    input = aiInputSchema.parse(r.input_references.input),
    output = aiOutputSchema.parse(r.proposed_action);
  if (
    r.state !== 'succeeded' ||
    !r.validation_result.valid ||
    !output.faq ||
    output.status !== 'suggestion' ||
    r.decision === 'reject' ||
    r.decision === 'modify'
  )
    throw new BoundaryError(409, '没有可用受控 FAQ 建议');
  const stale = await freshness(c, r);
  if (stale) throw new BoundaryError(409, stale);
  const reviewId = await policyEnabled(c),
    t = await requireThread(c, r.thread_id);
  if (t.control_mode === 'human' || t.outbound_paused)
    throw new BoundaryError(409, '人工接管或暂停阻止 FAQ');
  const old = (
    await c.client.query(
      `SELECT id FROM app.outbound_requests WHERE workspace_id=$1 AND idempotency_key=$2`,
      [
        ws(c),
        `e-faq:${r.thread_id}:${input.context.messageId}:${output.faq.templateId}:${AI_SCENARIO_VERSION}`,
      ],
    )
  ).rows[0];
  if (old) {
    await audit(c, 'e.faq-reused', id, { requestId: old.id });
    return { requestId: old.id };
  }
  const account = await lockAccount(c.client, ws(c), t.channel_account_id);
  if (!t.primary_contact_point_id) throw new BoundaryError(409, '无收件人');
  const point = await eligibleContact(c.client, ws(c), t.primary_contact_point_id);
  const cp = (
    await c.client.query(
      `SELECT buyer_id,contact_id FROM app.contact_points WHERE workspace_id=$1 AND id=$2`,
      [ws(c), point.id],
    )
  ).rows[0];
  if (
    (
      await c.client.query(
        `SELECT id FROM app.outbound_requests WHERE workspace_id=$1 AND (thread_id=$2 OR (channel_account_id=$3 AND contact_point_id=$4)) AND state IN('claimed','dispatching','unknown')`,
        [ws(c), t.id, account.id, point.id],
      )
    ).rowCount
  )
    throw new BoundaryError(409, '仍有在途或未知外发');
  const requestId = randomUUID(),
    payloadId = randomUUID();
  const p = {
    quote_version_id: null,
    quote_snapshot_sha256: null,
    thread_context_revision: String(t.context_revision),
    requirements_revision: input.context.requirementsRevision,
    policy_version: '3',
    language_code: 'en',
    subject: null,
    body_text: output.faq.body,
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
    attachment_manifest: [],
    channel_payload: {
      canonicalVersion: 'c-outbound-v1',
      origin: 'verified_faq_policy',
      aiRunId: id,
      reviewId,
      templateId: output.faq.templateId,
      templateVersion: 1,
      contextHash: r.input_references.contextHash,
      evidence: output.evidence,
      simulation: true,
    },
  };
  const hash = outboundHash(outboundSnapshot(p));
  await c.client.query(
    `INSERT INTO app.outbound_requests(id,workspace_id,factory_id,opportunity_id,thread_id,channel_account_id,transport_mode,contact_point_id,intent,authorization_mode,state,idempotency_key,command_sha256,provider_idempotency_key,created_by_member_id) VALUES($1,$2,$3,$4,$5,$6,'simulation',$7,'faq','verified_faq_policy','queued',$8,$9,$1::uuid::text,$10)`,
    [
      requestId,
      ws(c),
      r.factory_id,
      r.opportunity_id,
      t.id,
      account.id,
      point.id,
      `e-faq:${r.thread_id}:${input.context.messageId}:${output.faq.templateId}:${AI_SCENARIO_VERSION}`,
      hash,
      c.member.id,
    ],
  );
  await c.client.query(
    `INSERT INTO app.outbound_payload_versions(id,workspace_id,factory_id,outbound_request_id,version_no,thread_context_revision,requirements_revision,policy_version,language_code,body_text,sender_snapshot,recipients_snapshot,attachment_manifest,channel_payload,snapshot_sha256,frozen_at) VALUES($1,$2,$3,$4,1,$5,$6,3,'en',$7,$8,$9,'[]',$10,$11,clock_timestamp())`,
    [
      payloadId,
      ws(c),
      r.factory_id,
      requestId,
      p.thread_context_revision,
      p.requirements_revision,
      p.body_text,
      JSON.stringify(p.sender_snapshot),
      JSON.stringify(p.recipients_snapshot),
      JSON.stringify(p.channel_payload),
      hash,
    ],
  );
  await c.client.query(
    `UPDATE app.outbound_requests SET current_payload_version_id=$1 WHERE workspace_id=$2 AND id=$3`,
    [payloadId, ws(c), requestId],
  );
  const eventId = randomUUID();
  await enqueue(c, boss, DELIVERY_QUEUE, 'a2.reply-created', requestId, eventId, {
    requestId,
    payloadId,
    memberId: c.member.id,
  });
  await audit(c, 'e.faq-created', id, { requestId, payloadId });
  return { requestId };
}
export async function validateFAQPayload(c: Context, r: DeliveryRequest, p: OutboundPayload) {
  const id = z.uuid().parse(p.channel_payload.aiRunId),
    run = await runRow(c, id),
    out = aiOutputSchema.parse(run.proposed_action),
    input = aiInputSchema.parse(run.input_references.input);
  const stale = await freshness(c, run);
  if (stale) throw new BoundaryError(409, stale);
  const t = await requireThread(c, r.thread_id);
  if (t.control_mode !== 'assisted' || t.outbound_paused)
    throw new BoundaryError(409, '人工接管或暂停阻止 FAQ');
  const review = await policyEnabled(c);
  const expected = {
    canonicalVersion: 'c-outbound-v1',
    origin: 'verified_faq_policy',
    aiRunId: id,
    reviewId: review,
    templateId: out.faq?.templateId,
    templateVersion: 1,
    contextHash: run.input_references.contextHash,
    evidence: out.evidence,
    simulation: true,
  };
  if (
    !out.faq ||
    !(AI_FAQ_VALUES[out.faq.templateId] as readonly string[]).includes(
      out.faq.templateId === 'material'
        ? input.context.facts[0]!.specifications.fabric
        : input.context.facts[0]!.specifications.dimensions,
    )
  )
    throw new BoundaryError(409, 'FAQ 字段不在审核允许值中');
  if (
    r.intent !== 'faq' ||
    r.authorization_mode !== 'verified_faq_policy' ||
    run.state !== 'succeeded' ||
    !run.auto_faq ||
    !run.validation_result.valid ||
    run.decision === 'reject' ||
    run.decision === 'modify' ||
    out.status !== 'suggestion' ||
    !out.faq ||
    run.thread_id !== r.thread_id ||
    run.opportunity_id !== r.opportunity_id ||
    run.factory_id !== r.factory_id ||
    run.created_by_member_id !== r.created_by_member_id ||
    p.subject !== null ||
    p.body_html !== null ||
    p.quote_version_id !== null ||
    p.attachment_manifest.length ||
    String(p.policy_version) !== '3' ||
    p.language_code !== 'en' ||
    p.body_text !== faqBody(out.faq.templateId, input.context) ||
    outboundHash(p.channel_payload) !== outboundHash(expected)
  )
    throw new BoundaryError(409, 'FAQ 冻结内容、事实或模板校验失败');
}
