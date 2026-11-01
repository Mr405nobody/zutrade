import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { PgBoss } from 'pg-boss';
import {
  drizzle,
  BoundaryError,
  establishWorkspace,
  requireFactory,
  transaction,
  databaseNow,
} from '@zutrade/db';
import type { Context, pg } from '@zutrade/db';
import { researchRequestSchema, researchSnapshotSchema, researchLimits } from '@zutrade/contracts';
import type {
  ResearchRequest,
  ResearchSnapshot,
  ReviewInput,
  ImportCandidateInput,
} from '@zutrade/contracts';
import {
  PublicDirectoryProvider,
  OutboundManualProvider,
  normalizeOutboundUrls,
  BraveSearchProvider,
  SafeResearchHttp,
  directoryConfigs,
  braveReady,
  emptyCheckpoint,
  networkCode,
  ResearchNetworkError,
} from '@zutrade/prospecting';
import type {
  ResearchCheckpoint,
  ResearchProvider,
  BraveConfig,
  RequestBudget,
} from '@zutrade/prospecting';

export const RESEARCH_QUEUE = 'd1.research';
const digest = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const ws = (c: Context) => c.member.workspace_id;
interface Run {
  id: string;
  workspace_id: string;
  factory_id: string;
  initiated_by_member_id: string;
  provider: string;
  request: ResearchRequest;
  request_sha256: string;
  state: string;
  result_version: number;
  results_snapshot: ResearchSnapshot;
  review_revision: string;
  review_decisions: Record<
    string,
    { decision: string; reason: string; memberId: string; at: string; revision: string }
  >;
  checkpoint: ResearchCheckpoint | Record<string, never>;
  data_origin: string;
  execution_token: string | null;
  execution_version: number;
  job_retry_count: number;
  first_started_at: Date | null;
  deadline: Date | null;
  pg_boss_job_id: string;
  outbox_event_id: string;
  request_count: number;
  finished_at: Date | null;
  error: string | null;
}
async function audit(c: Context, action: string, id: string, details: unknown) {
  await c.client.query(
    `INSERT INTO app.audit_events(workspace_id,actor_kind,actor_member_id,action,aggregate_type,aggregate_id,details) VALUES($1,'member',$2,$3,'prospecting_run',$4,$5)`,
    [ws(c), c.member.id, action, id, JSON.stringify(details)],
  );
}
export function researchOptions(brave: BraveConfig) {
  return {
    directories: directoryConfigs.map(({ id, label, country, coverage, source, license }) => ({
      id,
      label,
      country,
      coverage,
      source,
      license,
    })),
    brave: {
      enabled: braveReady(brave),
      detail: braveReady(brave)
        ? '关键词搜索已启用；结果留存权已在本地配置'
        : '关键词搜索未启用：需要本地凭据及明确的结果留存权。公开目录无需搜索服务账号。',
    },
    limits: researchLimits,
  };
}
export async function createResearch(
  c: Context,
  boss: PgBoss,
  raw: ResearchRequest,
  brave: BraveConfig,
  failure?: 'business' | 'outbox' | 'enqueue',
) {
  const input = researchRequestSchema.parse(raw);
  if (input.provider === 'outbound_manual') {
    if (!input.permissionAcknowledged || !input.websiteUrls.length)
      throw new BoundaryError(400, '请确认公开资料使用权限并输入官网');
    try {
      normalizeOutboundUrls(input.websiteUrls);
    } catch {
      throw new BoundaryError(400, '官网 URL 不安全或格式无效');
    }
  }
  const factory = await requireFactory(c, input.factoryId);
  if (factory.status !== 'active') throw new BoundaryError(409, '工厂已停用');
  if (
    input.productId &&
    !(
      await c.client.query(
        "SELECT id FROM app.products WHERE workspace_id=$1 AND factory_id=$2 AND id=$3 AND state='active'",
        [ws(c), input.factoryId, input.productId],
      )
    ).rowCount
  )
    throw new BoundaryError(404, '产品不存在或不属于此工厂');
  if (input.provider === 'brave_search' && !braveReady(brave))
    throw new BoundaryError(409, '关键词搜索尚未配置凭据及所需留存权');
  if (
    input.provider === 'public_directory' &&
    directoryConfigs.find((d) => d.id === input.directoryId)?.country !== input.country
  )
    throw new BoundaryError(400, '目录覆盖地区与目标地区不一致');
  // Preserve the original D1 command digest across additive request fields.
  const { websiteUrls: _urls, permissionAcknowledged: _permission, ...legacyInput } = input;
  const storedInput = input.provider.startsWith('outbound_') ? input : legacyInput;
  const hash = digest({ memberId: c.member.id, input: storedInput });
  const old = (
    await c.client.query<Run>(
      'SELECT * FROM app.prospecting_runs WHERE workspace_id=$1 AND idempotency_key=$2',
      [ws(c), input.commandId],
    )
  ).rows[0];
  if (old) {
    if (old.request_sha256 !== hash) throw new BoundaryError(409, '同一研究命令内容不一致');
    return { runId: old.id, jobId: old.pg_boss_job_id };
  }
  const run = (
    await c.client.query<{ id: string }>(
      `INSERT INTO app.prospecting_runs(workspace_id,factory_id,initiated_by_member_id,provider,idempotency_key,request,request_sha256) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        ws(c),
        input.factoryId,
        c.member.id,
        input.provider,
        input.commandId,
        JSON.stringify(storedInput),
        hash,
      ],
    )
  ).rows[0]!;
  if (failure === 'business') throw new Error('D1 test rollback after business');
  const eventId = randomUUID();
  const data = { eventId, workspaceId: ws(c), userId: c.user.id };
  await c.client.query(
    `INSERT INTO app.outbox_events(id,workspace_id,event_type,aggregate_type,aggregate_id,handler_key,idempotency_key,payload) VALUES($1,$2,'d1.research-requested','prospecting_run',$3,$4,$5,$6)`,
    [
      eventId,
      ws(c),
      run.id,
      RESEARCH_QUEUE,
      input.commandId,
      JSON.stringify({ runId: run.id, memberId: c.member.id, userId: c.user.id }),
    ],
  );
  if (failure === 'outbox') throw new Error('D1 test rollback after outbox');
  const jobId = await boss.send(RESEARCH_QUEUE, data, {
    id: eventId,
    retryLimit: 2,
    retryDelay: 1,
    expireInSeconds: 200,
    heartbeatSeconds: 20,
    db: { executeSql: (sql, values) => c.client.query(sql, values) },
  });
  if (!jobId) throw new Error('D1 queue rejected');
  if (failure === 'enqueue') throw new Error('D1 test rollback after enqueue');
  await c.client.query(
    'UPDATE app.outbox_events SET pg_boss_job_id=$1,enqueued_at=clock_timestamp() WHERE id=$2',
    [jobId, eventId],
  );
  await c.client.query(
    'UPDATE app.prospecting_runs SET outbox_event_id=$1,pg_boss_job_id=$2 WHERE id=$3',
    [eventId, jobId, run.id],
  );
  await audit(c, 'd1.research-created', run.id, {
    jobId,
    provider: input.provider,
    requestSha256: hash,
  });
  return { runId: run.id, jobId };
}
async function runRow(c: Context, id: string, lock = false, active = false): Promise<Run> {
  const r = (
    await c.client.query<Run>(
      `SELECT * FROM app.prospecting_runs WHERE workspace_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`,
      [ws(c), id],
    )
  ).rows[0];
  if (!r) throw new BoundaryError(404, '研究不存在或未获工厂授权');
  const factory = await requireFactory(c, r.factory_id);
  if (active && factory.status !== 'active') throw new BoundaryError(403, '研究工厂已停用');
  return r;
}
function view(r: Run) {
  const { execution_token: _token, checkpoint: _checkpoint, ...visible } = r;
  return visible;
}
export async function listResearch(c: Context, outboundOnly = false) {
  // Also resolves an expired crashed run without granting a fresh deadline or enqueueing work.
  const expired = await c.client.query<{ id: string }>(
    `UPDATE app.prospecting_runs SET state=CASE WHEN candidate_count>0 THEN 'partial' ELSE 'failed' END,finished_at=clock_timestamp(),error='RUN_DEADLINE' WHERE workspace_id=$1 AND state='running' AND deadline<=clock_timestamp() RETURNING id`,
    [ws(c)],
  );
  for (const row of expired.rows)
    await audit(c, 'd1.research-deadline', row.id, { reason: 'RUN_DEADLINE' });
  return (
    await c.client.query<Run>(
      `SELECT * FROM app.prospecting_runs WHERE workspace_id=$1 ${outboundOnly ? "AND provider IN ('outbound_manual','outbound_unavailable')" : ''} ORDER BY created_at DESC,id LIMIT 30`,
      [ws(c)],
    )
  ).rows.map(view);
}
export async function researchDetail(c: Context, id: string) {
  const r = await runRow(c, id);
  const duplicates: Record<string, { id: string; name: string; domain: string | null }[]> = {};
  for (const candidate of r.results_snapshot.candidates) {
    duplicates[candidate.key] = (
      await c.client.query<{ id: string; name: string; domain: string | null }>(
        `SELECT id,name,domain_name AS domain FROM app.buyers WHERE workspace_id=$1 AND (($2::text IS NOT NULL AND lower(regexp_replace(domain_name,'^www\\.','','i'))=lower($2)) OR lower(name)=lower($3)) ORDER BY name,id LIMIT 10`,
        [ws(c), candidate.domain, candidate.name],
      )
    ).rows;
  }
  const imported = Object.fromEntries(
    (
      await c.client.query<{ id: string; prospecting_candidate_key: string }>(
        'SELECT id,prospecting_candidate_key FROM app.leads WHERE workspace_id=$1 AND prospecting_run_id=$2',
        [ws(c), id],
      )
    ).rows.map((v) => [v.prospecting_candidate_key, v.id]),
  );
  return { run: view(r), duplicates, imported };
}
export async function cancelResearch(c: Context, id: string) {
  const r = await runRow(c, id, true);
  if (r.finished_at) return view(r);
  await c.client.query(
    `UPDATE app.prospecting_runs SET state='cancelled',finished_at=clock_timestamp(),error='USER_CANCELLED' WHERE id=$1`,
    [id],
  );
  await audit(c, 'd1.research-cancelled', id, { executionVersion: r.execution_version });
  return view(await runRow(c, id));
}
function candidateAt(r: Run, key: string, version: number) {
  if (!r.finished_at || r.result_version !== version)
    throw new BoundaryError(409, '研究仍在执行或结果版本已变化');
  const candidate = r.results_snapshot.candidates.find((v) => v.key === key);
  if (!candidate) throw new BoundaryError(404, '候选不在此服务端研究快照中');
  return candidate;
}
export async function reviewCandidate(c: Context, id: string, input: ReviewInput) {
  const r = await runRow(c, id, true);
  candidateAt(r, input.candidateKey, input.resultVersion);
  if (r.review_revision !== input.reviewRevision)
    throw new BoundaryError(409, '审核版本已变化，请重新查看');
  const revision = (BigInt(r.review_revision) + 1n).toString();
  const review = {
    decision: input.decision,
    reason: input.reason,
    memberId: c.member.id,
    at: (await databaseNow(c.client)).toISOString(),
    revision,
  };
  await c.client.query(
    'UPDATE app.prospecting_runs SET review_decisions=$1,review_revision=review_revision+1 WHERE id=$2',
    [JSON.stringify({ ...r.review_decisions, [input.candidateKey]: review }), id],
  );
  await audit(c, 'd1.candidate-reviewed', id, {
    candidateKey: input.candidateKey,
    resultVersion: r.result_version,
    ...review,
  });
  return researchDetail(c, id);
}
export async function importCandidate(c: Context, id: string, input: ImportCandidateInput) {
  const r = await runRow(c, id, true, true);
  const candidate = candidateAt(r, input.candidateKey, input.resultVersion);
  if (r.review_revision !== input.reviewRevision)
    throw new BoundaryError(409, '审核版本已变化，请重新查看');
  const decision = r.review_decisions[candidate.key];
  if (decision?.decision !== 'keep')
    throw new BoundaryError(409, '须先核对来源并保留候选；已排除候选不能导入');
  if (!input.identityConfirmed) throw new BoundaryError(400, '请先确认公司身份');
  const hash = digest({ runId: id, memberId: c.member.id, ...input });
  const receipt = (
    await c.client.query(
      'SELECT * FROM app.command_receipts WHERE workspace_id=$1 AND command_id=$2',
      [ws(c), input.commandId],
    )
  ).rows[0];
  if (receipt) {
    if (receipt.command_sha256 !== hash) throw new BoundaryError(409, '导入命令键内容不一致');
    return receipt.result as { leadId: string; buyerId: string };
  }
  // Workspace lock + run row lock precede all inserts. Concurrent retries cannot orphan a buyer/contact.
  const existing = (
    await c.client.query<{ id: string; buyer_id: string }>(
      'SELECT id,buyer_id FROM app.leads WHERE workspace_id=$1 AND prospecting_run_id=$2 AND prospecting_candidate_key=$3',
      [ws(c), id, candidate.key],
    )
  ).rows[0];
  let result: { leadId: string; buyerId: string };
  if (existing) {
    if (input.buyerId && input.buyerId !== existing.buyer_id)
      throw new BoundaryError(409, '候选已关联其他买家');
    result = { leadId: existing.id, buyerId: existing.buyer_id };
  } else {
    let buyerId = input.buyerId;
    if (buyerId) {
      if (
        !(
          await c.client.query('SELECT id FROM app.buyers WHERE workspace_id=$1 AND id=$2', [
            ws(c),
            buyerId,
          ])
        ).rowCount
      )
        throw new BoundaryError(404, '所选买家不存在');
    } else
      buyerId = (
        await c.client.query<{ id: string }>(
          'INSERT INTO app.buyers(workspace_id,name,domain_name,country_code) VALUES($1,$2,$3,$4) RETURNING id',
          [ws(c), candidate.name, candidate.domain, candidate.country],
        )
      ).rows[0]!.id;
    const source = {
      schema: 'd1-lead-v1',
      runId: id,
      resultVersion: r.result_version,
      origin: r.data_origin,
      candidate,
      review: decision,
      reviewRevision: r.review_revision,
      identityConfirmedBy: c.member.id,
      identityConfirmedAt: (await databaseNow(c.client)).toISOString(),
      contactPermission: 'unknown',
    };
    const lead = (
      await c.client.query<{ id: string }>(
        `INSERT INTO app.leads(workspace_id,factory_id,buyer_id,owner_member_id,source_kind,research_snapshot,research_observed_at,fit_reason,prospecting_run_id,prospecting_candidate_key) VALUES($1,$2,$3,$4,'research',$5,$6,$7,$8,$9) RETURNING id`,
        [
          ws(c),
          r.factory_id,
          buyerId,
          c.member.id,
          JSON.stringify(source),
          candidate.evidence[0]?.observedAt ?? null,
          candidate.reasons.map((v) => v.detail).join('; '),
          id,
          candidate.key,
        ],
      )
    ).rows[0]!;
    result = { leadId: lead.id, buyerId };
    await audit(c, 'd1.candidate-imported', id, {
      ...result,
      candidateKey: candidate.key,
      resultVersion: r.result_version,
      reviewRevision: r.review_revision,
      commandId: input.commandId,
      contactCreated: false,
    });
  }
  await c.client.query(
    `INSERT INTO app.command_receipts(workspace_id,command_id,member_id,command_kind,command_sha256,result) VALUES($1,$2,$3,'d1.import',$4,$5)`,
    [ws(c), input.commandId, c.member.id, hash, JSON.stringify(result)],
  );
  return result;
}
const jobInput = z.object({ eventId: z.uuid(), workspaceId: z.uuid(), userId: z.uuid() }).strict();
export interface ResearchWorkerHooks {
  provider?: ResearchProvider;
  http?: (budget: RequestBudget) => SafeResearchHttp;
  afterCheckpoint?: (checkpoint: ResearchCheckpoint) => Promise<void>;
  afterClaim?: (details: {
    token: string;
    deadline: string;
    requests: number;
    executionVersion: number;
  }) => Promise<void>;
}
async function executeResearchJob(
  pool: pg.Pool,
  data: unknown,
  jobId: string,
  brave: BraveConfig,
  hooks: ResearchWorkerHooks = {},
) {
  if ((hooks.provider || hooks.http) && process.env.NODE_ENV !== 'test')
    throw new Error('Research injection is test-only');
  const hint = jobInput.parse(data);
  const scope = async <T>(run: (c: Context) => Promise<T>): Promise<T> =>
    transaction(pool, async (client) => {
      await client.query("SELECT set_config('app.user_id',$1,true)", [hint.userId]);
      const member = await establishWorkspace(client, hint.userId, hint.workspaceId);
      const user = (
        await client.query("SELECT * FROM app.app_users WHERE id=$1 AND status='active'", [
          hint.userId,
        ])
      ).rows[0];
      if (!user) throw new BoundaryError(403, '研究发起账号失效');
      return run({ client, member, user, orm: drizzle(client) });
    });
  const claimed = await scope(async (c) => {
    const e = (
      await c.client.query(
        `SELECT * FROM app.outbox_events WHERE id=$1 AND workspace_id=$2 AND handler_key=$3 AND event_type='d1.research-requested' AND pg_boss_job_id=$4`,
        [hint.eventId, ws(c), RESEARCH_QUEUE, jobId],
      )
    ).rows[0];
    if (
      !e ||
      e.payload.userId !== c.user.id ||
      e.payload.memberId !== c.member.id ||
      e.aggregate_id !== e.payload.runId
    )
      throw new BoundaryError(403, '研究任务身份不一致');
    const r = await runRow(c, e.aggregate_id, true, true);
    if (
      r.initiated_by_member_id !== c.member.id ||
      r.outbox_event_id !== hint.eventId ||
      r.pg_boss_job_id !== jobId
    )
      throw new BoundaryError(403, '研究任务归属不一致');
    if (r.finished_at) return null;
    const job = (
      await c.client.query('SELECT retry_count,state FROM pgboss.job WHERE id=$1 AND name=$2', [
        jobId,
        RESEARCH_QUEUE,
      ])
    ).rows[0];
    if (!job || job.state !== 'active') throw new BoundaryError(409, '必须先领取持久队列任务');
    if (r.state === 'running' && job.retry_count <= r.job_retry_count) return null;
    const now = await databaseNow(c.client);
    if (r.deadline && r.deadline <= now) {
      await c.client.query(
        `UPDATE app.prospecting_runs SET state=CASE WHEN candidate_count>0 THEN 'partial' ELSE 'failed' END,finished_at=clock_timestamp(),error='RUN_DEADLINE' WHERE id=$1`,
        [r.id],
      );
      return null;
    }
    const provider =
      hooks.provider ??
      (r.provider.startsWith('outbound_')
        ? new OutboundManualProvider()
        : r.provider === 'public_directory'
          ? new PublicDirectoryProvider()
          : new BraveSearchProvider(brave));
    const token = randomUUID();
    const row = (
      await c.client.query<Run>(
        `UPDATE app.prospecting_runs SET state='running',first_started_at=COALESCE(first_started_at,$2),deadline=COALESCE(deadline,$2::timestamptz+interval '180 seconds'),execution_token=$3,execution_version=execution_version+1,job_retry_count=$4,data_origin=$5,provider_version=$6 WHERE id=$1 RETURNING *`,
        [r.id, now, token, job.retry_count, provider.origin, provider.version],
      )
    ).rows[0]!;
    await audit(c, 'd1.research-execution', r.id, {
      executionVersion: row.execution_version,
      jobId,
      retryCount: job.retry_count,
      deadline: row.deadline,
      requests: row.request_count,
    });
    return { row, provider, token };
  });
  if (!claimed) return;
  const { row, provider, token } = claimed;
  await hooks.afterClaim?.({
    token,
    deadline: row.deadline!.toISOString(),
    requests: row.request_count,
    executionVersion: row.execution_version,
  });
  const fenced = async <T>(run: (c: Context, r: Run) => Promise<T>): Promise<T> =>
    scope(async (c) => {
      const r = await runRow(c, row.id, true, true);
      if (
        r.state !== 'running' ||
        r.execution_token !== token ||
        !r.deadline ||
        r.deadline <= (await databaseNow(c.client))
      )
        throw new BoundaryError(409, 'RUN_FENCED_OR_DEADLINE');
      await c.client.query("SELECT set_config('app.d1_token',$1,true)", [token]);
      return run(c, r);
    });
  const budget: RequestBudget = {
    reserve: () =>
      fenced(async (c, r) => {
        if (r.request_count >= researchLimits.requests)
          throw new ResearchNetworkError('REQUEST_BUDGET_EXHAUSTED');
        await c.client.query(
          'UPDATE app.prospecting_runs SET request_count=request_count+1 WHERE id=$1',
          [r.id],
        );
        // Convert the remaining database duration to a host deadline without assuming clocks match.
        const remaining = r.deadline!.getTime() - (await databaseNow(c.client)).getTime();
        return { deadline: Date.now() + remaining };
      }),
    guard: () => fenced(async () => {}),
    gate: async <T>(host: string, request: () => Promise<T>): Promise<T> => {
      // Session advisory locks span only the HTTP call, never a business transaction.
      // They enforce two global slots and one request/host across worker processes.
      const connection = await pool.connect();
      const held: string[] = [];
      try {
        for (;;) {
          await budget.guard();
          const hostKey = `d1-http-host:${host}`;
          const hostAcquired = (
            await connection.query<{ ok: boolean }>(
              'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok',
              [hostKey],
            )
          ).rows[0]!.ok;
          if (hostAcquired) {
            held.push(hostKey);
            for (const slot of ['d1-http-slot:0', 'd1-http-slot:1']) {
              const acquired = (
                await connection.query<{ ok: boolean }>(
                  'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok',
                  [slot],
                )
              ).rows[0]!.ok;
              if (acquired) {
                held.push(slot);
                try {
                  return await request();
                } finally {
                  if (row.provider === 'outbound_manual')
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                }
              }
            }
            await connection.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [hostKey]);
            held.pop();
          }
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
      } finally {
        let healthy = true;
        try {
          for (const key of held.reverse())
            await connection.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]);
        } catch {
          healthy = false;
        } finally {
          connection.release(!healthy);
        }
      }
    },
  };
  const http = hooks.http?.(budget) ?? new SafeResearchHttp(budget);
  const cp: ResearchCheckpoint =
    'snapshot' in row.checkpoint ? (row.checkpoint as ResearchCheckpoint) : emptyCheckpoint();
  const save = async (checkpoint: ResearchCheckpoint) => {
    const snapshot = researchSnapshotSchema.parse(checkpoint.snapshot);
    // PostgreSQL jsonb text includes spacing. Leave headroom relative to 512 KiB.
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 480000)
      throw new BoundaryError(409, 'SNAPSHOT_BYTE_LIMIT');
    await fenced(async (c, r) => {
      await c.client.query(
        'UPDATE app.prospecting_runs SET checkpoint=$1,results_snapshot=$2,candidate_count=$3 WHERE id=$4',
        [JSON.stringify(checkpoint), JSON.stringify(snapshot), snapshot.candidates.length, r.id],
      );
    });
    await hooks.afterCheckpoint?.(checkpoint);
  };
  let error: string | null = null;
  try {
    await provider.run({ request: row.request, http, checkpoint: cp, save, guard: budget.guard });
  } catch (e) {
    error = e instanceof BoundaryError ? e.message : networkCode(e);
  }
  await scope(async (c) => {
    const r = await runRow(c, row.id, true);
    if (r.finished_at || r.execution_token !== token) return;
    if (r.deadline && r.deadline <= (await databaseNow(c.client))) error = 'RUN_DEADLINE';
    const state =
      error || r.results_snapshot.errors.length
        ? r.results_snapshot.candidates.length
          ? 'partial'
          : 'failed'
        : 'completed';
    await c.client.query(
      'UPDATE app.prospecting_runs SET state=$1,error=$2,finished_at=clock_timestamp() WHERE id=$3',
      [state, error ?? r.results_snapshot.errors[0]?.code ?? null, r.id],
    );
    if (r.provider === 'outbound_manual') {
      for (const candidate of r.results_snapshot.candidates) {
        if (!candidate.domain) continue;
        await c.client.query(
          `INSERT INTO app.outbound_companies(workspace_id,factory_id,domain,name,run_id,candidate_key) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,factory_id,domain) DO NOTHING`,
          [ws(c), r.factory_id, candidate.domain, candidate.name, r.id, candidate.key],
        );
      }
    }
    await audit(c, 'd1.research-finished', r.id, {
      state,
      error,
      candidates: r.results_snapshot.candidates.length,
      requests: r.request_count,
      executionVersion: r.execution_version,
    });
  });
}
export async function consumeResearchJob(
  pool: pg.Pool,
  data: unknown,
  jobId: string,
  brave: BraveConfig,
  hooks: ResearchWorkerHooks = {},
) {
  try {
    await executeResearchJob(pool, data, jobId, brave, hooks);
  } catch (error) {
    if (error instanceof BoundaryError && [403, 404].includes(error.status)) {
      const hint = jobInput.parse(data);
      await transaction(pool, async (client) => {
        await client.query('SELECT app.d1_stop_revoked_job($1,$2)', [hint.eventId, jobId]);
      });
      return;
    }
    throw error;
  }
}
