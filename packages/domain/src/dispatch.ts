import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { BoundaryError, transaction, establishWorkspace, drizzle, databaseNow } from '@zutrade/db';
import type { Context, pg } from '@zutrade/db';
import { LocalPrivateObjectStore } from '@zutrade/storage';
import type { PrivateObjectStore } from '@zutrade/storage';
import { MockAdapter, normalMock, ProviderRejection } from '@zutrade/channels';
import type { MockCapabilities, SimulationResult } from '@zutrade/channels';
import { readOutbound, readPayload, cAudit } from './approval.js';
import type { DeliveryRequest } from './approval.js';
import { validatePayload, readVerifiedAttachments } from './delivery-checks.js';
import { outboundHash, outboundSnapshot } from './outbound-canonical.js';
import type { OutboundPayload } from './outbound-canonical.js';
import type { PgBoss } from 'pg-boss';
import { reserveD2Slot, settleD2Pacing } from './outreach.js';

const jobInput = z.object({ eventId: z.uuid(), workspaceId: z.uuid(), userId: z.uuid() }).strict();
interface JobMeta {
  retry_count: number;
  id: string;
  workspace_id: string;
  aggregate_id: string;
  event_type: string;
  payload: {
    requestId: string;
    payloadId?: string;
    memberId: string;
    userId: string;
    action?: string;
    operatorMemberId?: string;
  };
  dispatch_token: string | null;
  request_state: string;
  dispatch_claimed_at: Date | null;
}
export interface DispatchHooks {
  queue?: PgBoss;
  beforeClaim?: () => Promise<void>;
  afterClaim?: () => Promise<void>;
  beforeFinalCheck?: () => Promise<void>;
  afterFinalCheck?: () => Promise<void>;
  afterAccepted?: () => Promise<void>;
  store?: PrivateObjectStore;
  simulationUrl?: string;
}
async function metadata(client: pg.PoolClient, eventId: string, jobId: string): Promise<JobMeta> {
  return (await client.query('SELECT app.c_delivery_job($1,$2) AS data', [eventId, jobId])).rows[0]
    .data as JobMeta;
}
async function actor(client: pg.PoolClient, meta: JobMeta): Promise<Context> {
  await client.query("SELECT set_config('app.user_id',$1,true)", [meta.payload.userId]);
  const member = await establishWorkspace(client, meta.payload.userId, meta.workspace_id);
  if (member.id !== meta.payload.memberId) throw new BoundaryError(403, '任务发起成员不匹配');
  const user = (
    await client.query("SELECT * FROM app.app_users WHERE id=$1 AND status='active'", [
      meta.payload.userId,
    ])
  ).rows[0];
  if (!user) throw new BoundaryError(403, '发起账号已停用');
  return { client, member, user, orm: drizzle(client) };
}
const capabilities = (config: unknown): MockCapabilities =>
  z
    .object({
      idempotent: z.boolean(),
      guaranteeSeconds: z.number().int().min(1).max(86400),
      scenario: z.enum(['normal', 'reject', 'delay', 'lost_response', 'callbacks']),
    })
    .strict()
    .parse(config ?? normalMock);
interface Claim {
  r: DeliveryRequest;
  p: OutboundPayload;
  token: string;
  cap: MockCapabilities;
  files: Awaited<ReturnType<typeof readVerifiedAttachments>>;
}
async function markUnknown(pool: pg.Pool, meta: JobMeta, jobId: string, reason: string) {
  return transaction(pool, async (client) => {
    const current = await metadata(client, meta.id, jobId);
    if (
      !current.dispatch_token ||
      !['claimed', 'dispatching', 'unknown'].includes(current.request_state)
    )
      return;
    await client.query('SELECT app.c_fence_delivery($1,$2,$3)', [
      meta.aggregate_id,
      current.dispatch_token,
      reason,
    ]);
  });
}
async function project(
  pool: pg.Pool,
  meta: JobMeta,
  jobId: string,
  result: SimulationResult,
  executionToken: string,
  source: string,
) {
  return transaction(pool, async (client) => {
    const current = await metadata(client, meta.id, jobId);
    if (!current.dispatch_token) return false;
    if (executionToken !== current.dispatch_token) {
      await client.query('SELECT app.c_late_evidence($1,$2,$3)', [
        meta.aggregate_id,
        result.dispatchToken,
        JSON.stringify({ source, result }),
      ]);
      return false;
    }
    await client.query('SELECT app.begin_delivery_result($1,$2)', [
      meta.aggregate_id,
      current.dispatch_token,
    ]);
    const r = (
      await client.query<DeliveryRequest>(
        'SELECT * FROM app.outbound_requests WHERE id=$1 FOR UPDATE',
        [meta.aggregate_id],
      )
    ).rows[0]!;
    const p = (
      await client.query<OutboundPayload>(
        'SELECT * FROM app.outbound_payload_versions WHERE id=$1',
        [r.dispatch_payload_version_id],
      )
    ).rows[0]!;
    if (p.snapshot_sha256 !== result.payloadSha256)
      throw new Error('Provider evidence content mismatch');
    // A stale response can contribute evidence but cannot independently overwrite state.
    await client.query(
      `INSERT INTO app.audit_events(workspace_id,actor_kind,action,aggregate_type,aggregate_id,correlation_id,details) VALUES($1,'provider','c.provider-evidence','outbound_request',$2,$3,$4)`,
      [
        meta.workspace_id,
        r.id,
        meta.id,
        JSON.stringify({
          source,
          provider: 'zutrade-mock',
          providerKey: r.provider_idempotency_key,
          result,
          conclusion: 'accepted',
        }),
      ],
    );
    if (r.state === 'simulated') return true;
    if (p.channel_payload.d2) await settleD2Pacing(client, r.id, current.dispatch_token);
    await client.query('SELECT id FROM app.threads WHERE id=$1 FOR UPDATE', [r.thread_id]);
    await client.query(
      `UPDATE app.delivery_attempts SET state='simulated',provider_message_id=$2,response_code='SIMULATED',response_snapshot=$3,completed_at=$4,error_class=NULL,error_detail=NULL WHERE outbound_request_id=$1 AND dispatch_token=$5`,
      [
        r.id,
        result.providerMessageId,
        JSON.stringify(result),
        result.completedAt,
        result.dispatchToken,
      ],
    );
    await client.query(
      `INSERT INTO app.messages(workspace_id,channel_account_id,thread_id,transport_mode,direction,sender_kind,provider_message_id,outbound_request_id,body_text,attachment_manifest,content_sha256,delivery_state,occurred_at) VALUES($1,$2,$3,'simulation','outbound','operator',$4,$5,$6,$7,$8,'simulated',$9) ON CONFLICT(workspace_id,outbound_request_id) WHERE outbound_request_id IS NOT NULL DO NOTHING`,
      [
        meta.workspace_id,
        r.channel_account_id,
        r.thread_id,
        result.providerMessageId,
        r.id,
        p.body_text,
        JSON.stringify(p.attachment_manifest),
        createHash('sha256').update(p.body_text).digest('hex'),
        result.completedAt,
      ],
    );
    await client.query(
      "UPDATE app.outbound_requests SET state='simulated',stop_reason=CASE WHEN cancel_requested_at IS NULL THEN NULL ELSE '渠道已接受；取消申请未撤回本次接收' END WHERE id=$1 AND dispatch_token=$2",
      [r.id, current.dispatch_token],
    );
    await client.query('UPDATE app.threads SET last_activity_at=now() WHERE id=$1', [r.thread_id]);
    return true;
  });
}
async function reconcile(
  pool: pg.Pool,
  meta: JobMeta,
  jobId: string,
  adapter: MockAdapter,
  action = 'lookup',
) {
  await markUnknown(pool, meta, jobId, '发送权已失效或请求核对；停止无保护调用，结果待核对');
  const evidence = await transaction(pool, async (client) => {
    const current = await metadata(client, meta.id, jobId);
    if (!current.dispatch_token) return null;
    await client.query('SELECT app.begin_delivery_result($1,$2)', [
      meta.aggregate_id,
      current.dispatch_token,
    ]);
    const r = (
      await client.query<DeliveryRequest>('SELECT * FROM app.outbound_requests WHERE id=$1', [
        meta.aggregate_id,
      ])
    ).rows[0]!;
    const p = (
      await client.query<OutboundPayload>(
        'SELECT * FROM app.outbound_payload_versions WHERE id=$1',
        [r.dispatch_payload_version_id],
      )
    ).rows[0]!;
    return { r, p, token: current.dispatch_token };
  });
  if (!evidence) return;
  const found = await adapter.lookup(
    evidence.r.channel_account_id,
    evidence.r.provider_idempotency_key,
    evidence.p.snapshot_sha256,
  );
  await transaction(pool, async (client) => {
    const current = await metadata(client, meta.id, jobId);
    await client.query('SELECT app.begin_delivery_result($1,$2)', [
      meta.aggregate_id,
      current.dispatch_token,
    ]);
    await client.query(
      `INSERT INTO app.audit_events(workspace_id,actor_kind,action,aggregate_type,aggregate_id,correlation_id,details) VALUES($1,'system','c.reconciliation','outbound_request',$2,$3,$4)`,
      [
        meta.workspace_id,
        meta.aggregate_id,
        meta.id,
        JSON.stringify({
          operatorMemberId: meta.payload.operatorMemberId ?? null,
          source: found.source,
          provider: 'zutrade-mock',
          providerKey: evidence.r.provider_idempotency_key,
          payloadId: evidence.p.id,
          conclusion: found.conclusion,
          acceptances: found.results.map((x) => x.acceptanceId),
          action,
          checkedAt: new Date().toISOString(),
        }),
      ],
    );
  });
  if (found.conclusion === 'accepted') {
    const callbacks = await adapter.callbacks(
      evidence.r.channel_account_id,
      evidence.r.provider_idempotency_key,
      evidence.p.snapshot_sha256,
    );
    for (const event of callbacks) {
      if (event.kind === 'accepted')
        await project(
          pool,
          meta,
          jobId,
          event.result,
          evidence.token,
          'simulation.callback:' + event.id,
        );
      else
        await transaction(pool, async (client) => {
          const current = await metadata(client, meta.id, jobId);
          await client.query('SELECT app.begin_delivery_result($1,$2)', [
            meta.aggregate_id,
            current.dispatch_token,
          ]);
          await client.query(
            "INSERT INTO app.audit_events(workspace_id,actor_kind,action,aggregate_type,aggregate_id,correlation_id,details) VALUES($1,'provider','c.provider-callback','outbound_request',$2,$3,$4)",
            [
              meta.workspace_id,
              meta.aggregate_id,
              meta.id,
              JSON.stringify({
                providerEventId: event.id,
                kind: event.kind,
                acceptanceId: event.result.acceptanceId,
                source: 'simulation.callbacks',
                conclusion: 'observation retained; cannot regress acceptance',
              }),
            ],
          );
        });
    }
    await project(pool, meta, jobId, found.results[0]!, evidence.token, 'persistent-ledger-lookup');
    return;
  }
  // Absence is never evidence of non-acceptance. Only an intact provider guarantee
  // permits retrying an unchanged action, and every current authorization is rechecked.
  const providerNow = await transaction(pool, (client) => databaseNow(client));
  if (
    action !== 'stop' &&
    evidence.r.provider_capabilities?.idempotent &&
    !evidence.r.cancel_requested_at &&
    evidence.r.provider_guarantee_until &&
    new Date(evidence.r.provider_guarantee_until) > providerNow
  )
    return 'safe_retry' as const;
  return;
}
export async function consumeDeliveryJob(
  pool: pg.Pool,
  data: unknown,
  jobId: string,
  hooks: DispatchHooks = {},
) {
  const hint = jobInput.parse(data);
  const meta = await transaction(pool, (client) => metadata(client, hint.eventId, jobId));
  const jobNow = await transaction(pool, (client) => databaseNow(client));
  if (meta.workspace_id !== hint.workspaceId || meta.payload.userId !== hint.userId)
    throw new BoundaryError(403, '队列上下文不匹配');
  let simulationUrl = hooks.simulationUrl ?? process.env.SIMULATION_DATABASE_URL;
  // Integration pools and production always use the same database, with an
  // independent provider credential. A test cannot accidentally write daily ledger data.
  if (simulationUrl && pool.options.connectionString) {
    const u = new URL(simulationUrl);
    u.pathname = new URL(pool.options.connectionString).pathname;
    simulationUrl = u.href;
  }
  const adapter = new MockAdapter(simulationUrl);
  const store =
    hooks.store ?? new LocalPrivateObjectStore(process.env.PRIVATE_DATA_DIR ?? './data/private');
  try {
    let recovering = false;
    if (
      meta.event_type === 'c.reconcile' ||
      ['claimed', 'dispatching', 'unknown'].includes(meta.request_state)
    ) {
      if (
        meta.event_type !== 'c.reconcile' &&
        meta.retry_count === 0 &&
        meta.request_state !== 'unknown' &&
        meta.dispatch_claimed_at &&
        jobNow.getTime() - new Date(meta.dispatch_claimed_at).getTime() < 90000
      )
        return;
      const next = await reconcile(pool, meta, jobId, adapter, meta.payload.action ?? 'lookup');
      if (
        next !== 'safe_retry' ||
        (meta.event_type === 'c.reconcile' && meta.payload.action !== 'safe_retry')
      )
        return;
      recovering = true;
    }
    if (['simulated', 'cancelled', 'blocked', 'failed'].includes(meta.request_state) && !recovering)
      return;
    // Resolve authorized immutable metadata in a separate preflight transaction;
    // heavier file reads happen with no claim transaction or row locks held.
    let preflight: { p: OutboundPayload; r: DeliveryRequest };
    try {
      preflight = await transaction(pool, async (client) => {
        const c = await actor(client, meta),
          r = await readOutbound(c, meta.aggregate_id);
        if (r.created_by_member_id !== c.member.id)
          throw new BoundaryError(403, '任务必须使用实际发起成员');
        const p = await readPayload(c, r, meta.payload.payloadId ?? r.current_payload_version_id);
        return { p, r };
      });
    } catch (e) {
      if (!(e instanceof BoundaryError)) throw e;
      await transaction(pool, (c) =>
        c.query('SELECT app.block_delivery_job($1,$2,$3)', [meta.id, jobId, e.message]),
      );
      return;
    }
    let files: Awaited<ReturnType<typeof readVerifiedAttachments>>;
    try {
      files = await readVerifiedAttachments(store, preflight.p.attachment_manifest);
    } catch (e) {
      if (!(e instanceof BoundaryError)) throw e;
      await transaction(pool, (c) =>
        c.query('SELECT app.block_delivery_job($1,$2,$3)', [meta.id, jobId, e.message]),
      );
      return;
    }
    await hooks.beforeClaim?.();
    const claim = await transaction<Claim | null>(pool, async (client) => {
      const c = await actor(client, meta);
      await client.query(
        'SELECT id FROM app.channel_accounts WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
        [meta.workspace_id, preflight.r.channel_account_id],
      );
      const r = await readOutbound(c, meta.aggregate_id, true);
      if (r.created_by_member_id !== c.member.id)
        throw new BoundaryError(403, '发送任务发起成员身份不一致');
      if (r.current_payload_version_id !== preflight.p.id) return null; // obsolete job never sends a newer version
      if (recovering ? r.state !== 'unknown' : !['queued', 'ready'].includes(r.state)) return null;
      if (r.cancel_requested_at) return null;
      const p = await readPayload(c, r, preflight.p.id);
      try {
        await validatePayload(c, r, p);
        if (outboundHash(p.attachment_manifest) !== outboundHash(preflight.p.attachment_manifest))
          throw new BoundaryError(409, '预检 PDF 与领取版本不一致');
      } catch (e) {
        if (!(e instanceof BoundaryError)) throw e;
        if (!recovering)
          await client.query('SELECT app.block_delivery_job($1,$2,$3)', [
            meta.id,
            jobId,
            e.message,
          ]);
        return null;
      }
      const config = (
        await client.query('SELECT configuration FROM app.channel_accounts WHERE id=$1', [
          r.channel_account_id,
        ])
      ).rows[0].configuration;
      const cap = capabilities(config.mock);
      if (
        recovering &&
        (!r.provider_capabilities?.idempotent ||
          !cap.idempotent ||
          cap.guaranteeSeconds !== r.provider_capabilities.guaranteeSeconds ||
          !r.provider_guarantee_until ||
          new Date(r.provider_guarantee_until) <= (await databaseNow(client)))
      )
        return null;
      if (!(await reserveD2Slot(c, hooks.queue, r, p))) return null;
      const token = randomUUID(),
        attemptId = randomUUID();
      await client.query(
        `UPDATE app.outbound_requests SET state='claimed',dispatch_payload_version_id=$2,dispatch_claimed_at=COALESCE(dispatch_claimed_at,clock_timestamp()),dispatch_token=$3,provider_capabilities=COALESCE(provider_capabilities,$4::jsonb),provider_guarantee_until=COALESCE(provider_guarantee_until,clock_timestamp()+$5*interval '1 second') WHERE id=$1`,
        [r.id, p.id, token, JSON.stringify(cap), cap.guaranteeSeconds],
      );
      await client.query(
        `INSERT INTO app.delivery_attempts(id,workspace_id,outbound_request_id,payload_version_id,attempt_no,dispatch_token,state) SELECT $1,$2,$3,$4,COALESCE(max(attempt_no),0)+1,$5,'prepared' FROM app.delivery_attempts WHERE workspace_id=$2 AND outbound_request_id=$3`,
        [attemptId, meta.workspace_id, r.id, p.id, token],
      );
      await cAudit(c, 'c.delivery-claimed', r.id, {
        jobId,
        eventId: meta.id,
        payloadId: p.id,
        token,
        attemptId,
        recovering,
      });
      return { r, p, token, cap, files };
    }).catch(async (e: unknown) => {
      if (!(e instanceof BoundaryError)) throw e;
      await transaction(pool, (c) =>
        c.query('SELECT app.block_delivery_job($1,$2,$3)', [meta.id, jobId, e.message]),
      );
      return null;
    });
    if (!claim) return;
    await hooks.afterClaim?.();
    await hooks.beforeFinalCheck?.();
    const canCall = await transaction(pool, async (client) => {
      const current = await metadata(client, meta.id, jobId);
      if (current.dispatch_token !== claim.token || current.request_state !== 'claimed')
        return false;
      try {
        const c = await actor(client, meta);
        const currentRequest = await readOutbound(c, claim.r.id, true);
        await validatePayload(c, currentRequest, claim.p);
      } catch (e) {
        if (e instanceof BoundaryError) return false;
        throw e;
      }
      await client.query('SELECT app.begin_delivery_result($1,$2)', [claim.r.id, claim.token]);
      const r = (
        await client.query<DeliveryRequest>(
          'SELECT * FROM app.outbound_requests WHERE id=$1 FOR UPDATE',
          [claim.r.id],
        )
      ).rows[0]!;
      if (
        r.cancel_requested_at ||
        (r.provider_guarantee_until &&
          new Date(r.provider_guarantee_until) <= (await databaseNow(client)))
      )
        return false;
      await client.query(
        "UPDATE app.outbound_requests SET state='dispatching',dispatch_started_at=clock_timestamp() WHERE id=$1",
        [r.id],
      );
      await client.query(
        "UPDATE app.delivery_attempts SET state='started',started_at=clock_timestamp() WHERE outbound_request_id=$1 AND dispatch_token=$2",
        [r.id, claim.token],
      );
      return true;
    });
    if (!canCall) {
      await markUnknown(pool, meta, jobId, '执行 token 已失效或领取后收到取消申请，须核对');
      return;
    }
    // The deliberate last-check/network window remains. No second unsafe path is granted.
    await hooks.afterFinalCheck?.();
    let result: SimulationResult;
    try {
      result = await adapter.send(
        {
          requestId: claim.r.id,
          accountId: claim.r.channel_account_id,
          dispatchToken: claim.token,
          providerIdempotencyKey: claim.r.provider_idempotency_key,
          payloadSha256: claim.p.snapshot_sha256,
          content: outboundSnapshot(claim.p),
          attachments: claim.files,
        },
        claim.cap,
      );
    } catch (e) {
      if (e instanceof ProviderRejection) {
        await transaction(pool, async (client) => {
          const current = await metadata(client, meta.id, jobId);
          if (current.dispatch_token !== claim.token) return;
          await client.query('SELECT app.begin_delivery_result($1,$2)', [claim.r.id, claim.token]);
          if (claim.p.channel_payload.d2) await settleD2Pacing(client, claim.r.id, claim.token);
          await client.query(
            "UPDATE app.delivery_attempts SET state='rejected',error_class='permanent_rejection',error_detail='模拟渠道明确拒绝且没有接受',completed_at=clock_timestamp() WHERE outbound_request_id=$1 AND dispatch_token=$2",
            [claim.r.id, claim.token],
          );
          await client.query(
            "UPDATE app.outbound_requests SET state='failed',stop_reason='渠道明确拒绝，未接受；未自动重试' WHERE id=$1",
            [claim.r.id],
          );
        });
      } else
        await markUnknown(
          pool,
          meta,
          jobId,
          '渠道响应不明（包括接受后丢响应）；只能核对或在提供方幂等保证内重试',
        );
      return;
    }
    await hooks.afterAccepted?.();
    const projected = await project(pool, meta, jobId, result, claim.token, 'adapter-response');
    if (!projected) await reconcile(pool, meta, jobId, adapter, 'lookup');
  } finally {
    await adapter.close();
  }
}
