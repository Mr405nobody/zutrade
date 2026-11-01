import assert from 'node:assert/strict';
import { loadEnvFile } from 'node:process';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pg, createQueue, withWorkspace, transaction } from '@zutrade/db';
import { injectSimulation, consumeInboundJob } from '@zutrade/domain';
loadEnvFile('.env');
const name = 'zutrade_inbound_test_' + randomUUID().replaceAll('-', '');
const adminUrl = new URL(process.env.DATABASE_URL);
adminUrl.username = process.env.POSTGRES_USER;
adminUrl.password = process.env.POSTGRES_PASSWORD;
const admin = new pg.Pool({ connectionString: adminUrl.href });
const env = { ...process.env, POSTGRES_DB: name };
for (const k of [
  'DATABASE_URL',
  'MIGRATION_DATABASE_URL',
  'API_DATABASE_URL',
  'WORKER_DATABASE_URL',
  'AUTH_DATABASE_URL',
]) {
  const u = new URL(env[k]);
  u.pathname = '/' + name;
  env[k] = u.href;
}
const db = new pg.Pool({ connectionString: env.MIGRATION_DATABASE_URL });
const api = new pg.Pool({ connectionString: env.API_DATABASE_URL });
const worker = new pg.Pool({ connectionString: env.WORKER_DATABASE_URL });
const boss = createQueue(env.API_DATABASE_URL);
let success = false;
try {
  await admin.query('CREATE DATABASE "' + name + '"');
  for (const script of ['scripts/db-provision.mjs', 'scripts/db-migrate.mjs']) {
    const r = spawnSync(process.execPath, [script], { env, encoding: 'utf8', timeout: 60000 });
    if (r.status !== 0) throw Error(script + ' exit ' + r.status + ' ' + r.stderr.slice(0, 800));
  }
  console.log('PASS isolated PostgreSQL 18 incremental migration and queues');
  const ws = randomUUID(),
    uid = randomUUID(),
    mid = randomUUID(),
    fid = randomUUID();
  await db.query('INSERT INTO app.workspaces(id,name) VALUES($1,$2)', [
    ws,
    'Isolated inbound test',
  ]);
  await db.query('INSERT INTO app.app_users(id,auth_subject,display_name) VALUES($1,$2,$3)', [
    uid,
    'inbound-test-owner',
    'Owner',
  ]);
  await db.query(
    "INSERT INTO app.workspace_members(id,workspace_id,user_id,role,all_factories) VALUES($1,$2,$3,'owner',true)",
    [mid, ws, uid],
  );
  await db.query(
    "INSERT INTO app.factories(id,workspace_id,name,factory_code,status) VALUES($1,$2,'Test','TEST','active')",
    [fid, ws],
  );
  await boss.start();
  const input = {
    eventId: 'stable-event-one',
    providerMessageId: 'provider-one',
    identity: 'alex-one',
    displayName: 'Alex',
    body: 'Hello',
    occurredAt: new Date().toISOString(),
    factoryId: fid,
  };
  const inject = (x, b = boss) =>
    withWorkspace(api, { id: 'inbound-test-owner', name: 'Owner' }, ws, (c) =>
      injectSimulation(c, b, x),
    );
  const receipt = await inject(input);
  const job = (
    await db.query(
      "SELECT id,pg_boss_job_id FROM app.outbox_events WHERE aggregate_id=$1 AND handler_key='a2.inbound'",
      [receipt.receiptId],
    )
  ).rows[0];
  assert.ok(
    (await db.query('SELECT id FROM pgboss.job WHERE id=$1', [job.pg_boss_job_id])).rowCount,
  );
  await consumeInboundJob(worker, { eventId: job.id, workspaceId: ws }, job.pg_boss_job_id);
  await consumeInboundJob(worker, { eventId: job.id, workspaceId: ws }, job.pg_boss_job_id);
  await inject(input);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM app.messages')).rows[0].n, 1);
  console.log('PASS receipt/outbox/pg-boss transaction and repeated job/event deduplication');
  await assert.rejects(() => inject({ ...input, body: 'changed' }));
  console.log('PASS immutable event digest conflict');
  const next = await inject({
    ...input,
    eventId: 'stable-event-two',
    providerMessageId: 'provider-two',
    identity: 'alex-two',
  });
  const nextJob = (
    await db.query('SELECT id,pg_boss_job_id FROM app.outbox_events WHERE aggregate_id=$1', [
      next.receiptId,
    ])
  ).rows[0];
  await consumeInboundJob(worker, { eventId: nextJob.id, workspaceId: ws }, nextJob.pg_boss_job_id);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM app.contacts')).rows[0].n, 2);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM app.audit_events WHERE actor_kind='system' AND actor_member_id IS NULL AND action='a2.inbound-normalized'",
      )
    ).rows[0].n,
    2,
  );
  console.log('PASS same names with distinct channel identities and system actor audits');
  const pending = await inject({
    ...input,
    eventId: 'missing-identity',
    providerMessageId: 'provider-three',
    identity: null,
  });
  const pendingJob = (
    await db.query('SELECT id,pg_boss_job_id FROM app.outbox_events WHERE aggregate_id=$1', [
      pending.receiptId,
    ])
  ).rows[0];
  await consumeInboundJob(
    worker,
    { eventId: pendingJob.id, workspaceId: ws },
    pendingJob.pg_boss_job_id,
  );
  const unresolved = (
    await db.query('SELECT state,processed_at FROM app.inbound_events WHERE id=$1', [
      pending.receiptId,
    ])
  ).rows[0];
  assert.equal(unresolved.state, 'dead');
  assert.equal(unresolved.processed_at, null);
  console.log('PASS unmatched identity remains an unresolved inbound barrier');
  await assert.rejects(() =>
    inject(
      { ...input, eventId: 'rollback-event', providerMessageId: 'rollback-message' },
      {
        send: async () => {
          throw Error('Injected queue failure');
        },
      },
    ),
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM app.inbound_events WHERE event_key='rollback-event'",
      )
    ).rows[0].n,
    0,
  );
  console.log('PASS enqueue failure rolls receipt and event back');

  const first = (
    await db.query(
      'SELECT normalized_thread_id,channel_account_id FROM app.inbound_events WHERE id=$1',
      [receipt.receiptId],
    )
  ).rows[0];
  const otherBuyer = randomUUID(),
    otherAccount = randomUUID(),
    otherContact = randomUUID(),
    otherPoint = randomUUID(),
    otherThread = randomUUID();
  await db.query('INSERT INTO app.buyers(id,workspace_id,name) VALUES($1,$2,$3)', [
    otherBuyer,
    ws,
    'Other account buyer',
  ]);
  await db.query(
    'INSERT INTO app.contacts(id,workspace_id,buyer_id,display_name) VALUES($1,$2,$3,$4)',
    [otherContact, ws, otherBuyer, 'Other account contact'],
  );
  await db.query(
    "INSERT INTO app.contact_points(id,workspace_id,contact_id,buyer_id,kind,namespace,scope_key,normalized_value) VALUES($1,$2,$3,$4,'provider_identity','external-provider','global','other')",
    [otherPoint, ws, otherContact, otherBuyer],
  );
  await db.query(
    "INSERT INTO app.channel_accounts(id,workspace_id,channel_kind,transport_mode,provider,external_account_key,display_name,state) VALUES($1,$2,'simulation','simulation','zutrade-mock','other-account','Other','active')",
    [otherAccount, ws],
  );
  await db.query(
    'INSERT INTO app.threads(id,workspace_id,channel_account_id,primary_contact_point_id) VALUES($1,$2,$3,$4)',
    [otherThread, ws, otherAccount, otherPoint],
  );
  await transaction(worker, async (c) => {
    await c.query('SELECT app.begin_inbound_task($1,$2)', [job.id, job.pg_boss_job_id]);
    assert.equal(
      (await c.query('SELECT count(*)::int AS n FROM app.channel_accounts')).rows[0].n,
      1,
    );
    assert.equal((await c.query('SELECT count(*)::int AS n FROM app.contacts')).rows[0].n, 2);
    assert.equal((await c.query('SELECT count(*)::int AS n FROM app.buyers')).rows[0].n, 2);
    assert.equal(
      (await c.query('SELECT count(*)::int AS n FROM app.workspace_members')).rows[0].n,
      0,
    );
    assert.equal((await c.query('SELECT count(*)::int AS n FROM app.workspaces')).rows[0].n, 0);
    assert.equal((await c.query('SELECT count(*)::int AS n FROM app.app_users')).rows[0].n, 0);
    assert.equal((await c.query('SELECT count(*)::int AS n FROM app.outbox_events')).rows[0].n, 1);
    assert.equal((await c.query('SELECT count(*)::int AS n FROM app.threads')).rows[0].n, 2);
    assert.equal(
      (
        await c.query('SELECT app.a2_has_inbound_barrier($1,$2) AS b', [
          ws,
          first.channel_account_id,
        ])
      ).rows[0].b,
      true,
    );
  });
  assert.equal(
    (
      await db.query(
        "SELECT has_function_privilege('zutrade_api','app.begin_inbound_task(uuid,uuid)','EXECUTE') AS allowed",
      )
    ).rows[0].allowed,
    false,
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE n.nspname='app' AND p.prosecdef AND a.grantee=0 AND a.privilege_type='EXECUTE'",
      )
    ).rows[0].n,
    0,
  );
  console.log(
    'PASS trusted account system scope, no organization identity reads, PUBLIC/API task function denial, and full-account barrier',
  );
  const suid = randomUUID(),
    smid = randomUUID(),
    fidB = randomUUID();
  await db.query('INSERT INTO app.app_users(id,auth_subject,display_name) VALUES($1,$2,$3)', [
    suid,
    'inbound-test-sales',
    'Sales',
  ]);
  await db.query(
    "INSERT INTO app.workspace_members(id,workspace_id,user_id,role,all_factories) VALUES($1,$2,$3,'sales',false)",
    [smid, ws, suid],
  );
  await db.query(
    'INSERT INTO app.factory_memberships(workspace_id,factory_id,member_id) VALUES($1,$2,$3)',
    [ws, fid, smid],
  );
  const sales = (fn) => withWorkspace(api, { id: 'inbound-test-sales', name: 'Sales' }, ws, fn);
  assert.equal(
    await sales(
      async (c) =>
        (
          await c.client.query('SELECT app.can_read_thread($1,$2) AS allowed', [
            ws,
            first.normalized_thread_id,
          ])
        ).rows[0].allowed,
    ),
    true,
  );
  const before = (
    await db.query('SELECT context_revision FROM app.threads WHERE id=$1', [
      first.normalized_thread_id,
    ])
  ).rows[0].context_revision;
  await db.query(
    "INSERT INTO app.factories(id,workspace_id,name,factory_code,status) VALUES($1,$2,'B','B','active')",
    [fidB, ws],
  );
  const src = (await db.query('SELECT * FROM app.opportunities LIMIT 1')).rows[0];
  const oid = randomUUID();
  await db.query(
    "INSERT INTO app.opportunities(id,workspace_id,factory_id,buyer_id,primary_contact_id,owner_member_id,title) VALUES($1,$2,$3,$4,$5,$6,'Mixed factory')",
    [oid, ws, fidB, src.buyer_id, src.primary_contact_id, mid],
  );
  await db.query(
    'INSERT INTO app.opportunity_threads(workspace_id,opportunity_id,thread_id) VALUES($1,$2,$3)',
    [ws, oid, first.normalized_thread_id],
  );
  assert.equal(
    await sales(
      async (c) =>
        (
          await c.client.query('SELECT app.can_read_thread($1,$2) AS allowed', [
            ws,
            first.normalized_thread_id,
          ])
        ).rows[0].allowed,
    ),
    false,
  );
  assert.equal(
    await sales(
      async (c) =>
        (
          await c.client.query('SELECT count(*)::int AS n FROM app.messages WHERE thread_id=$1', [
            first.normalized_thread_id,
          ])
        ).rows[0].n,
    ),
    0,
  );
  assert.ok(
    Number(
      (
        await db.query('SELECT context_revision FROM app.threads WHERE id=$1', [
          first.normalized_thread_id,
        ])
      ).rows[0].context_revision,
    ) > Number(before),
  );
  console.log(
    'PASS complete association authorization hides mixed factory messages and increments context on new link',
  );
  await assert.rejects(() =>
    sales((c) =>
      injectSimulation(c, boss, {
        ...input,
        eventId: 'sales-forbidden',
        providerMessageId: 'sales-forbidden',
      }),
    ),
  );
  console.log('PASS simulation injection is owner-only');

  await db.query(
    "INSERT INTO app.contact_points(workspace_id,kind,namespace,scope_key,normalized_value) VALUES($1,'provider_identity','zutrade-simulation',$2,'broken-point')",
    [ws, first.channel_account_id],
  );
  const broken = await inject({
    ...input,
    eventId: 'broken-point-event',
    providerMessageId: 'broken-point-message',
    identity: 'broken-point',
  });
  const brokenJob = (
    await db.query('SELECT id,pg_boss_job_id FROM app.outbox_events WHERE aggregate_id=$1', [
      broken.receiptId,
    ])
  ).rows[0];
  for (let i = 0; i < 4; i++)
    await assert.rejects(() =>
      consumeInboundJob(
        worker,
        { eventId: brokenJob.id, workspaceId: ws },
        brokenJob.pg_boss_job_id,
      ),
    );
  const failedReceipt = (
    await db.query(
      'SELECT state,attempt_count,processed_at,last_error FROM app.inbound_events WHERE id=$1',
      [broken.receiptId],
    )
  ).rows[0];
  assert.equal(failedReceipt.state, 'dead');
  assert.equal(failedReceipt.attempt_count, 4);
  assert.equal(failedReceipt.processed_at, null);
  assert.equal(failedReceipt.last_error, '标准化失败，入站屏障保留；请检查任务并重试');
  console.log(
    'PASS normalization exception retry/dead projection increments attempts and retains unresolved barrier',
  );

  await db.query(
    "UPDATE pgboss.job SET state='failed',retry_count=3 WHERE name='a2.inbound' AND id=$1",
    [brokenJob.pg_boss_job_id],
  );
  const preJobs = (await db.query('SELECT count(*)::int AS n FROM pgboss.job')).rows[0].n;
  const preEvents = (await db.query('SELECT count(*)::int AS n FROM app.outbox_events')).rows[0].n;
  const maintained = spawnSync(
    process.execPath,
    ['scripts/db-queue-maintain.mjs', '--retry-failed-inbox'],
    { env, encoding: 'utf8', timeout: 30000 },
  );
  assert.equal(maintained.status, 0, maintained.stderr);
  assert.ok(maintained.stdout.includes('"queue":"a2.inbound","maintained":true,"retried":1'));
  const retried = (
    await db.query('SELECT state FROM pgboss.job WHERE id=$1', [brokenJob.pg_boss_job_id])
  ).rows[0];
  assert.ok(['created', 'retry'].includes(retried.state));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM pgboss.job')).rows[0].n, preJobs);
  assert.equal(
    (await db.query('SELECT count(*)::int AS n FROM app.outbox_events')).rows[0].n,
    preEvents,
  );
  console.log(
    'PASS explicit failed-inbox official pg-boss retry preserves job and outbox identities',
  );
  success = true;
} catch (e) {
  console.error('FAIL', e.code ?? '', e.message);
  process.exitCode = 1;
} finally {
  await boss.stop().catch(() => {});
  await Promise.all([api.end(), worker.end(), db.end()]);
  if (success) await admin.query('DROP DATABASE "' + name + '"');
  else console.log('Retained isolated database', name);
  await admin.end();
}
