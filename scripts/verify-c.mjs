import assert from 'node:assert/strict';
import { loadEnvFile } from 'node:process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  pg,
  transaction,
  withWorkspace,
  createAuth,
  createAuthPool,
  createQueue,
} from '@zutrade/db';
import {
  createProduct,
  createSource,
  publishPrice,
  generateQuote,
  saveRequirements,
  generateQuotePdf,
  downloadQuotePdf,
  injectSimulation,
  consumeInboundJob,
  requireThread,
  createReply,
  consumeDeliveryJob,
} from '@zutrade/domain';
import {
  prepareOutbound,
  decideApproval,
  requestReconciliation,
  outboundWorkspace,
  outboundHash,
  outboundSnapshot,
} from '@zutrade/domain';
import { MockAdapter } from '@zutrade/channels';
import { LocalPrivateObjectStore } from '@zutrade/storage';
loadEnvFile('.env');
const evidence = process.env.EVIDENCE_DIR ?? 'docs/build/evidence/c';
mkdirSync(evidence, { recursive: true });
const name = process.env.C_TEST_DATABASE ?? 'zutrade_c_test_' + randomUUID().replaceAll('-', '');
const env = {
  ...process.env,
  POSTGRES_DB: name,
  API_PORT: process.env.C_API_PORT ?? '3401',
  WORKER_PORT: process.env.C_WORKER_PORT ?? '3402',
  WEB_PORT: '5173',
};
for (const key of [
  'DATABASE_URL',
  'MIGRATION_DATABASE_URL',
  'API_DATABASE_URL',
  'WORKER_DATABASE_URL',
  'AUTH_DATABASE_URL',
  'SIMULATION_DATABASE_URL',
]) {
  const u = new URL(process.env[key]);
  u.pathname = '/' + name;
  env[key] = u.href;
}
const root = mkdtempSync(resolve('.local/c-test-'));
env.PRIVATE_DATA_DIR = root + '/private';
const au = new URL(process.env.DATABASE_URL);
au.username = process.env.POSTGRES_USER;
au.password = process.env.POSTGRES_PASSWORD;
const admin = new pg.Pool({ connectionString: au.href });
const m = new pg.Pool({ connectionString: env.MIGRATION_DATABASE_URL });
const api = new pg.Pool({
  connectionString: env.API_DATABASE_URL,
  max: 12,
  application_name: 'zutrade-b-test',
});
const worker = new pg.Pool({ connectionString: env.WORKER_DATABASE_URL });
const ap = createAuthPool(env.MIGRATION_DATABASE_URL);
const store = new LocalPrivateObjectStore(env.PRIVATE_DATA_DIR);
const checks = [];
const users = {};
const f = { ws: randomUUID(), other: randomUUID(), a: randomUUID(), b: randomUUID() };
let success = false,
  boss,
  child;
let logs = '';
let tid, oid, p, s, v1;
let workerBoss;
const crashes = [];
const snapshotEvidence = [];
const until = new Date(Date.now() + 30 * 86400000).toISOString();
const value = {
  seller: { name: '模拟棉织工厂（非真实供应商确认）' },
  specifications: {
    fabric: '12oz',
    dimensions: '35×40cm',
    color: 'Natural',
    printing: 'Single colour / single side logo',
  },
  production: {
    days: 20,
    dayKind: 'business',
    startConditions: 'After artwork/sample approval and deposit confirmation.',
  },
  discountBoundary: { basis: 'product_subtotal', maxPercent: '5' },
  sampleTerms: 'Samples quoted separately.',
  exclusions: [
    'Shipping excluded; quote separately.',
    'Taxes excluded; confirm separately.',
    'Samples quoted separately.',
    'No arrival promise.',
  ],
  simulation: true,
};
let requirements;
const scope = (role, run) => withWorkspace(api, { id: users[role].subject, name: role }, f.ws, run);
async function check(label, fn) {
  await fn();
  checks.push({ label, result: 'passed' });
  console.log('PASS ' + label);
}
function command(path) {
  const r = spawnSync(process.execPath, [path], { env, encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) throw new Error(path + ': ' + r.stderr.slice(0, 1500));
  return r.stdout;
}
async function opp() {
  return (await m.query('SELECT * FROM app.opportunities WHERE id=$1', [oid])).rows[0];
}
async function save(extra = {}) {
  const o = await opp();
  return scope('sales', (c) =>
    saveRequirements(c, tid, oid, {
      expectedVersion: o.row_version,
      requirements: { ...requirements, ...extra },
    }),
  );
}
async function gen(extra = {}, clock) {
  clock ??= (await m.query('SELECT clock_timestamp() AS now')).rows[0].now;
  const o = await opp();
  const q = (
    await m.query('SELECT current_version_id FROM app.quotes WHERE opportunity_id=$1', [oid])
  ).rows[0];
  return scope('sales', (c) =>
    generateQuote(
      c,
      tid,
      oid,
      {
        commandId: randomUUID(),
        expectedVersion: o.row_version,
        expectedCurrentVersionId: q?.current_version_id ?? null,
        ...extra,
      },
      clock,
    ),
  );
}
async function rejectSql(sql, params = []) {
  await assert.rejects(
    () => transaction(m, (c) => c.query(sql, params)),
    (e) => ['P0001', '23503', '23514', '42501', '22004'].includes(e.code),
  );
}
async function waitFor(fn, label) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('Timeout ' + label);
}
const base = `http://127.0.0.1:${env.API_PORT}`;
async function http(path, role = 'owner', body) {
  return fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(users[role]?.cookie ? { cookie: users[role].cookie } : {}),
      ...(body ? { 'content-type': 'application/json', origin: 'http://127.0.0.1:5173' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function launch() {
  child = spawn(process.execPath, ['apps/api/dist/main.js'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (b) => (logs += b));
  child.stderr.on('data', (b) => (logs += b));
  await waitFor(async () => {
    try {
      return (await fetch(base + '/health/live')).ok;
    } catch {
      return false;
    }
  }, 'api');
}
async function stop() {
  if (child && child.exitCode === null && child.signalCode === null) {
    const done = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    await done;
  }
}
try {
  await admin.query(`CREATE DATABASE "${name}"`);
  command('scripts/db-provision.mjs');
  command('scripts/db-migrate.mjs');
  const auth = createAuth(ap, env.BETTER_AUTH_SECRET, 5173, Number(env.API_PORT), true);
  for (const role of ['owner', 'sales', 'outside', 'deputy']) {
    const password = randomBytes(24).toString('hex');
    const email = role + '@b.test';
    const r = await auth.api.signUpEmail({ body: { email, password, name: role } });
    users[role] = {
      subject: r.user.id,
      userId: randomUUID(),
      memberId: randomUUID(),
      email,
      password,
    };
  }
  await transaction(m, async (c) => {
    await c.query(
      "INSERT INTO app.workspaces(id,name) VALUES($1,'B isolated'),($2,'Other isolated')",
      [f.ws, f.other],
    );
    for (const [role, u] of Object.entries(users)) {
      await c.query('INSERT INTO app.app_users(id,auth_subject,display_name) VALUES($1,$2,$3)', [
        u.userId,
        u.subject,
        role,
      ]);
      await c.query(
        'INSERT INTO app.workspace_members(id,workspace_id,user_id,role,all_factories) VALUES($1,$2,$3,$4,$5)',
        [
          u.memberId,
          role === 'outside' ? f.other : f.ws,
          u.userId,
          ['owner', 'deputy'].includes(role) ? 'owner' : 'sales',
          ['owner', 'deputy'].includes(role),
        ],
      );
    }
    await c.query(
      "INSERT INTO app.factories(id,workspace_id,name,factory_code,status) VALUES($1,$3,'工厂模拟 A','A','active'),($2,$3,'工厂模拟 B','B','active')",
      [f.a, f.b, f.ws],
    );
    await c.query(
      'INSERT INTO app.factory_memberships(workspace_id,factory_id,member_id) VALUES($1,$2,$3)',
      [f.ws, f.a, users.sales.memberId],
    );
  });
  await m.query('UPDATE app.workspaces SET approver_member_id=$2 WHERE id=$1', [
    f.ws,
    users.owner.memberId,
  ]);
  boss = createQueue(env.API_DATABASE_URL);
  await boss.start();
  const receipt = await scope('owner', (c) =>
    injectSimulation(c, boss, {
      eventId: randomUUID(),
      providerMessageId: randomUUID(),
      identity: 'alex.morgan@northstar-events.example',
      displayName: 'Alex（模拟）',
      body: '500 cotton bags, delivery in six weeks?',
      occurredAt: new Date().toISOString(),
      factoryId: f.a,
    }),
  );
  const job = (
    await m.query('SELECT id,pg_boss_job_id FROM app.outbox_events WHERE aggregate_id=$1', [
      receipt.receiptId,
    ])
  ).rows[0];
  await consumeInboundJob(worker, { eventId: job.id, workspaceId: f.ws }, job.pg_boss_job_id);
  tid = (
    await m.query('SELECT normalized_thread_id FROM app.inbound_events WHERE id=$1', [
      receipt.receiptId,
    ])
  ).rows[0].normalized_thread_id;
  oid = (
    await m.query('SELECT opportunity_id FROM app.opportunity_threads WHERE thread_id=$1', [tid])
  ).rows[0].opportunity_id;
  workerBoss = createQueue(env.WORKER_DATABASE_URL);
  await workerBoss.start();
  p = await scope('sales', (c) =>
    createProduct(c, {
      factoryId: f.a,
      sku: 'CT-01',
      name: 'C isolated simulation',
      unitCode: 'piece',
      configuration: { simulation: true },
    }),
  );
  const sourceBytes = Buffer.from(
    'SIMULATION supplier USD 2.40 + setup 30; 20 business days after approval and deposit.',
  );
  const obj = await store.putImmutable(sourceBytes);
  s = await scope('sales', (c) =>
    createSource(c, p.id, {
      title: 'C simulation evidence',
      kind: 'simulation',
      contentSha256: obj.sha256,
      contentType: 'text/plain',
      contentSize: sourceBytes.length,
      objectKey: obj.key,
      extractedSnapshot: { simulation: true },
      validUntil: until,
    }),
  );
  await scope('owner', (c) =>
    publishPrice(c, p.id, {
      sourceVersionId: s.id,
      locator: 'Simulation terms',
      excerpt: sourceBytes.toString(),
      scopeKey: 'default',
      qtyMin: '500',
      qtyMax: '1000',
      unitCode: 'piece',
      currencyCode: 'USD',
      unitPrice: '2.40',
      setupFee: '30',
      validUntil: until,
      value,
      applicability: value.specifications,
    }),
  );
  requirements = {
    productId: p.id,
    quantity: '800',
    unitCode: 'piece',
    specifications: value.specifications,
    destination: 'UK',
    purpose: 'Events',
    requestedTiming: 'six weeks arrival requested',
    language: 'en',
    pendingItems: [],
    internalNote: 'INTERNAL_COST_1.25_SECRET',
  };
  await save();
  v1 = await gen();
  assert.ok(v1.id, JSON.stringify(v1));
  await scope('sales', (c) => generateQuotePdf(c, v1.id, store));
  async function thread(label) {
    const r = await scope('owner', (c) =>
      injectSimulation(c, boss, {
        eventId: randomUUID(),
        providerMessageId: randomUUID(),
        identity: `${label}-${randomUUID()}@c.example`,
        displayName: `C isolated ${label}`,
        body: 'C independent test',
        occurredAt: new Date().toISOString(),
        factoryId: f.a,
      }),
    );
    const e = (
      await m.query('SELECT * FROM app.outbox_events WHERE aggregate_id=$1', [r.receiptId])
    ).rows[0];
    await consumeInboundJob(worker, { eventId: e.id, workspaceId: f.ws }, e.pg_boss_job_id);
    return (
      await m.query('SELECT normalized_thread_id FROM app.inbound_events WHERE id=$1', [
        r.receiptId,
      ])
    ).rows[0].normalized_thread_id;
  }
  const row = async (id) =>
    (await m.query('SELECT * FROM app.outbound_requests WHERE id=$1', [id])).rows[0];
  const approval = async (id) =>
    (
      await m.query(
        'SELECT * FROM app.approvals WHERE outbound_request_id=$1 ORDER BY created_at DESC,id LIMIT 1',
        [id],
      )
    ).rows[0];
  async function prep(t, extra = {}) {
    return scope('sales', async (c) => {
      const input = {
        commandId: randomUUID(),
        contextRevision: (await requireThread(c, t)).context_revision,
        kind: 'human_reply',
        quoteVersionId: null,
        body: 'Please review our response.',
        ...extra,
      };
      if (input.body === undefined) delete input.body;
      return prepareOutbound(c, input, t, store);
    });
  }
  async function decide(r, decision = 'approve', extra = {}, role = 'owner', failure) {
    const a = await approval(r.requestId);
    return scope(role, (c) =>
      decideApproval(
        c,
        boss,
        a.id,
        {
          commandId: randomUUID(),
          payloadId: a.payload_version_id,
          snapshotSha256: a.snapshot_sha256,
          expectedVersion: a.row_version,
          decision,
          reason: 'C independent test',
          ...extra,
        },
        store,
        failure,
      ),
    );
  }
  const jobData = async (j) => ({
    eventId: j.eventId,
    workspaceId: f.ws,
    userId: (await m.query('SELECT payload FROM app.outbox_events WHERE id=$1', [j.eventId]))
      .rows[0].payload.userId,
  });
  const dispatch = async (j, hooks = {}) =>
    consumeDeliveryJob(worker, await jobData(j), j.jobId, {
      store,
      simulationUrl: env.SIMULATION_DATABASE_URL,
      ...hooks,
    });
  const counts = async (id) => ({
    calls: (
      await m.query('SELECT count(*)::int n FROM simulation.invocations WHERE request_id=$1', [id])
    ).rows[0].n,
    effects: (
      await m.query('SELECT count(*)::int n FROM simulation.acceptances WHERE request_id=$1', [id])
    ).rows[0].n,
  });
  async function mock(config) {
    await m.query(
      'UPDATE app.channel_accounts SET configuration=$2 WHERE id=(SELECT channel_account_id FROM app.threads WHERE id=$1)',
      [
        tid,
        JSON.stringify({
          mock: { idempotent: true, guaranteeSeconds: 86400, scenario: 'normal', ...config },
        }),
      ],
    );
  }
  async function lookup(r, action = 'lookup') {
    const current = await row(r.requestId);
    const j = await scope('owner', (c) =>
      requestReconciliation(c, boss, current.id, {
        commandId: randomUUID(),
        expectedVersion: current.row_version,
        action,
      }),
    );
    await dispatch(j);
    return row(current.id);
  }
  async function drain() {
    while (true) {
      const jobs = await workerBoss.fetch('a2.delivery', { batchSize: 100 });
      if (!jobs.length) break;
      for (const j of jobs) await workerBoss.complete('a2.delivery', j.id);
    }
  }
  async function childWorker(j, pause, replay = false) {
    const events = [];
    const child = spawn(process.execPath, ['scripts/c-test-worker.mjs'], {
      env: {
        ...env,
        C_JOB_ID: j.jobId,
        C_JOB_DATA: JSON.stringify(await jobData(j)),
        C_PAUSE: pause ?? '',
        C_REPLAY: String(replay),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let output = '';
    child.stdout.on('data', (b) => (output += b));
    child.stderr.on('data', (b) => (output += b));
    const exit = new Promise((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal, output })),
    );
    child.on('message', (e) => events.push(e));
    return {
      child,
      events,
      exit,
      wait: (label) =>
        waitFor(
          () =>
            events.some((e) => e.point === label) ||
            child.exitCode !== null ||
            child.signalCode !== null,
          `child ${label}`,
        ).then(() => {
          if (!events.some((e) => e.point === label))
            throw new Error(`Child exited before ${label}: ${output}`);
        }),
      go: () => child.send({ continue: true }),
    };
  }
  await check(
    'sales submits current 800 / 1950 quote, owner sees exact content and stored PDF; strict payload identity and full hash',
    async () => {
      const r = await prep(tid, { kind: 'quote', quoteVersionId: v1.id, body: undefined });
      // undefined optional input disappears only in command identity; normalize rejects it,
      // so callers omit optional body rather than signing a different JSON shape.
      const p = (
        await m.query('SELECT * FROM app.outbound_payload_versions WHERE id=$1', [r.payloadId])
      ).rows[0];
      assert.equal(p.snapshot_sha256, outboundHash(outboundSnapshot(p)));
      assert.notEqual(p.snapshot_sha256, p.quote_snapshot_sha256);
      assert.notEqual(p.snapshot_sha256, p.attachment_manifest[0].sha256);
      assert.match(p.body_text, /1950.00/);
      assert.ok(!JSON.stringify(p).includes('INTERNAL_COST_1.25_SECRET'));
      const a = await approval(r.requestId);
      assert.equal(a.snapshot_sha256, p.snapshot_sha256);
      const preview = await scope('owner', (c) => outboundWorkspace(c, tid));
      assert.equal(preview.items[0].payload.id, p.id);
      const j = await decide(r);
      await dispatch(j);
      assert.equal((await row(r.requestId)).state, 'simulated');
      assert.deepEqual(await counts(r.requestId), { calls: 1, effects: 1 });
      const ledger = (
        await m.query('SELECT * FROM simulation.acceptances WHERE request_id=$1', [r.requestId])
      ).rows[0];
      assert.deepEqual(ledger.attachment_digests, [
        {
          sha256: p.attachment_manifest[0].sha256,
          byteLength: p.attachment_manifest[0].byteLength,
        },
      ]);
      assert.equal(ledger.content.body, p.body_text);
      snapshotEvidence.push({
        requestId: r.requestId,
        payloadId: p.id,
        approvalId: a.id,
        quoteVersionId: v1.id,
        jobId: j.jobId,
        eventId: j.eventId,
        providerAcceptance: ledger.id,
        payloadSha256: p.snapshot_sha256,
        attachmentSha256: p.attachment_manifest[0].sha256,
        quoteSnapshotSha256: v1.snapshot_sha256,
      });
    },
  );
  await check(
    'sales/non-designated/disabled owner cannot approve; stale v1 page cannot approve v2; immutable request identity and frozen evidence',
    async () => {
      const t = await thread('permissions'),
        r = await prep(t);
      const a = await approval(r.requestId);
      for (const role of ['sales', 'deputy'])
        await assert.rejects(
          () => decide(r, 'approve', {}, role),
          (e) => e.status === 403,
        );
      await m.query("UPDATE app.workspace_members SET status='disabled' WHERE id=$1", [
        users.owner.memberId,
      ]);
      await assert.rejects(
        () => decide(r),
        (e) => e.status === 403,
      );
      await m.query("UPDATE app.workspace_members SET status='active' WHERE id=$1", [
        users.owner.memberId,
      ]);
      const original = await row(r.requestId);
      const r2 = await prep(t, {
        requestId: r.requestId,
        expectedVersion: original.row_version,
        body: 'Changed final text, reviewed by owner.',
      });
      await assert.rejects(
        () =>
          scope('owner', (c) =>
            decideApproval(
              c,
              boss,
              a.id,
              {
                commandId: randomUUID(),
                payloadId: a.payload_version_id,
                snapshotSha256: a.snapshot_sha256,
                expectedVersion: a.row_version,
                decision: 'approve',
                reason: '',
              },
              store,
            ),
          ),
        (e) => e.status === 409,
      );
      assert.equal(
        (await m.query('SELECT state FROM app.approvals WHERE id=$1', [a.id])).rows[0].state,
        'invalidated',
      );
      for (const sql of [
        'UPDATE app.outbound_requests SET contact_point_id=gen_random_uuid() WHERE id=$1',
        'UPDATE app.outbound_requests SET channel_account_id=gen_random_uuid() WHERE id=$1',
        'UPDATE app.outbound_requests SET thread_id=gen_random_uuid() WHERE id=$1',
        'UPDATE app.outbound_requests SET factory_id=gen_random_uuid() WHERE id=$1',
        'UPDATE app.outbound_requests SET opportunity_id=gen_random_uuid() WHERE id=$1',
        "UPDATE app.outbound_requests SET intent='quote' WHERE id=$1",
        "UPDATE app.outbound_requests SET authorization_mode='member_send' WHERE id=$1",
        "UPDATE app.outbound_requests SET provider_idempotency_key='new-key' WHERE id=$1",
      ])
        await rejectSql(sql, [r.requestId]);
      await rejectSql(
        "UPDATE app.outbound_payload_versions SET body_text='tamper' WHERE outbound_request_id=$1",
        [r.requestId],
      );
      await rejectSql('DELETE FROM app.approval_events WHERE approval_id=$1', [a.id]);
      const j = await decide(r2);
      await dispatch(j);
      assert.equal((await row(r.requestId)).state, 'simulated');
    },
  );
  await check(
    'command idempotency and concurrent approve have one event and one durable business job',
    async () => {
      const t = await thread('idempotency');
      const id = randomUUID();
      const input = {
        commandId: id,
        kind: 'human_reply',
        quoteVersionId: null,
        body: 'Review this exact text.',
        contextRevision: (await scope('sales', (c) => requireThread(c, t))).context_revision,
      };
      const r = await scope('sales', (c) => prepareOutbound(c, input, t, store));
      assert.deepEqual(await scope('sales', (c) => prepareOutbound(c, input, t, store)), r);
      await assert.rejects(
        () => scope('sales', (c) => prepareOutbound(c, { ...input, body: 'Different' }, t, store)),
        (e) => e.status === 409,
      );
      const a = await approval(r.requestId),
        commandId = randomUUID();
      const d = {
        commandId,
        payloadId: a.payload_version_id,
        snapshotSha256: a.snapshot_sha256,
        expectedVersion: a.row_version,
        decision: 'approve',
        reason: '',
      };
      const results = await Promise.all([
        scope('owner', (c) => decideApproval(c, boss, a.id, d, store)),
        scope('owner', (c) => decideApproval(c, boss, a.id, d, store)),
      ]);
      assert.deepEqual(results[0], results[1]);
      await assert.rejects(
        () =>
          scope('owner', (c) =>
            decideApproval(c, boss, a.id, { ...d, reason: 'different' }, store),
          ),
        (e) => e.status === 409,
      );
      assert.equal(
        (
          await m.query(
            "SELECT count(*)::int n FROM app.approval_events WHERE approval_id=$1 AND event_kind='approved'",
            [a.id],
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await m.query('SELECT count(*)::int n FROM app.outbox_events WHERE aggregate_id=$1', [
            r.requestId,
          ])
        ).rows[0].n,
        1,
      );
      await dispatch(results[0]);
      const r2 = await prep(t);
      const a2 = await approval(r2.requestId);
      const race = await Promise.allSettled([decide(r2), decide(r2)]);
      assert.equal(race.filter((x) => x.status === 'fulfilled').length, 1);
      assert.equal(
        (
          await m.query(
            "SELECT count(*)::int n FROM app.approval_events WHERE approval_id=$1 AND event_kind='approved'",
            [a2.id],
          )
        ).rows[0].n,
        1,
      );
      await dispatch(race.find((x) => x.status === 'fulfilled').value);
    },
  );
  await check(
    'approval/business/outbox/real pg-boss enqueue failures atomically roll back; jobs unconsumable until commit',
    async () => {
      const t = await thread('rollback'),
        r = await prep(t),
        a = await approval(r.requestId);
      const snapshot = async () =>
        JSON.stringify({
          r: await row(r.requestId),
          a: await approval(r.requestId),
          events: (
            await m.query(
              'SELECT * FROM app.approval_events WHERE approval_id=$1 ORDER BY event_no',
              [a.id],
            )
          ).rows,
          outbox: (
            await m.query('SELECT * FROM app.outbox_events WHERE aggregate_id=$1', [r.requestId])
          ).rows,
          jobs: (await m.query("SELECT id FROM pgboss.job WHERE name='a2.delivery' ORDER BY id"))
            .rows,
        });
      for (const point of ['approval', 'business', 'outbox', 'enqueue']) {
        const before = await snapshot();
        await assert.rejects(() => decide(r, 'approve', {}, 'owner', point), /Injected/);
        assert.equal(await snapshot(), before);
      }
      const held = await api.connect();
      await held.query('BEGIN');
      await held.query(
        "SELECT set_config('app.auth_subject',$1,true),set_config('app.user_id',$2,true)",
        [users.owner.subject, users.owner.userId],
      );
      const { establishWorkspace, drizzle } = await import('@zutrade/db');
      const member = await establishWorkspace(held, users.owner.userId, f.ws);
      const j = await decideApproval(
        {
          client: held,
          member,
          user: {
            id: users.owner.userId,
            auth_subject: users.owner.subject,
            display_name: 'owner',
            status: 'active',
          },
          orm: drizzle(held),
        },
        boss,
        a.id,
        {
          commandId: randomUUID(),
          payloadId: a.payload_version_id,
          snapshotSha256: a.snapshot_sha256,
          expectedVersion: a.row_version,
          decision: 'approve',
          reason: '',
        },
        store,
      );
      assert.equal(
        (await m.query('SELECT count(*)::int n FROM pgboss.job WHERE id=$1', [j.jobId])).rows[0].n,
        0,
      );
      await held.query('COMMIT');
      held.release();
      assert.equal(
        (await m.query('SELECT count(*)::int n FROM pgboss.job WHERE id=$1', [j.jobId])).rows[0].n,
        1,
      );
      await dispatch(j);
    },
  );
  await check(
    'unclaimed queued v1 job never sends revised v2, and current recipient address never redirects approved content',
    async () => {
      const t = await thread('versions'),
        r = await prep(t),
        old = await decide(r);
      const rr = await row(r.requestId),
        r2 = await prep(t, {
          requestId: r.requestId,
          expectedVersion: rr.row_version,
          body: 'Second immutable version',
        });
      await dispatch(old);
      assert.equal((await row(r.requestId)).state, 'awaiting_approval');
      assert.deepEqual(await counts(r.requestId), { calls: 0, effects: 0 });
      const j = await decide(r2);
      const cp = (
        await m.query(
          'SELECT * FROM app.contact_points WHERE id=(SELECT contact_point_id FROM app.outbound_requests WHERE id=$1)',
          [r.requestId],
        )
      ).rows[0];
      await m.query(
        "UPDATE app.contact_points SET normalized_value='changed@c.example' WHERE id=$1",
        [cp.id],
      );
      await dispatch(j);
      assert.equal((await row(r.requestId)).state, 'blocked');
      assert.match((await row(r.requestId)).stop_reason, /身份已变化/);
      assert.deepEqual(await counts(r.requestId), { calls: 0, effects: 0 });
    },
  );
  await check(
    'expired approvals remain historical and cannot extend expires_at; reapplication creates a new target and lifecycle',
    async () => {
      const t = await thread('expired'),
        r = await prep(t),
        a = await approval(r.requestId);
      await decide(r, 'reject');
      const old = (
        await m.query(
          `INSERT INTO app.approvals(workspace_id,outbound_request_id,payload_version_id,snapshot_sha256,requested_by_member_id,created_at,expires_at) VALUES($1,$2,$3,$4,$5,now()-interval '2 hours',now()-interval '1 hour') RETURNING *`,
          [f.ws, r.requestId, a.payload_version_id, a.snapshot_sha256, users.sales.memberId],
        )
      ).rows[0];
      await rejectSql("UPDATE app.approvals SET expires_at=now()+interval '1 day' WHERE id=$1", [
        old.id,
      ]);
      await scope('owner', (c) => outboundWorkspace(c, t));
      assert.equal(
        (await m.query('SELECT state FROM app.approvals WHERE id=$1', [old.id])).rows[0].state,
        'expired',
      );
      const rr = await row(r.requestId);
      const renewed = await prep(t, { requestId: rr.id, expectedVersion: rr.row_version });
      const a2 = await approval(r.requestId);
      assert.notEqual(a2.id, old.id);
      assert.notEqual(a2.payload_version_id, old.payload_version_id);
      assert.equal(
        (
          await m.query('SELECT count(*)::int n FROM app.approvals WHERE outbound_request_id=$1', [
            r.requestId,
          ])
        ).rows[0].n,
        3,
      );
      await dispatch(await decide(renewed));
    },
  );
  await check(
    'member and factory revocation serialize before claim; current human mode still permits new explicitly approved manual actions',
    async () => {
      for (const mode of ['member', 'factory']) {
        const t = await thread('revoke-' + mode),
          r = await prep(t),
          j = await decide(r);
        if (mode === 'member')
          await m.query("UPDATE app.workspace_members SET status='disabled' WHERE id=$1", [
            users.sales.memberId,
          ]);
        else
          await m.query(
            'DELETE FROM app.factory_memberships WHERE member_id=$1 AND factory_id=$2',
            [users.sales.memberId, f.a],
          );
        await dispatch(j);
        assert.equal((await row(r.requestId)).state, 'blocked');
        assert.deepEqual(await counts(r.requestId), { calls: 0, effects: 0 });
        if (mode === 'member')
          await m.query("UPDATE app.workspace_members SET status='active' WHERE id=$1", [
            users.sales.memberId,
          ]);
        else
          await m.query(
            'INSERT INTO app.factory_memberships(workspace_id,factory_id,member_id) VALUES($1,$2,$3)',
            [f.ws, f.a, users.sales.memberId],
          );
      }
      const t = await thread('human');
      const { changeThreadControl } = await import('@zutrade/domain');
      await scope('owner', async (c) =>
        changeThreadControl(c, t, 'takeover', (await requireThread(c, t)).row_version),
      );
      const r = await prep(t);
      assert.equal(
        (await m.query('SELECT control_mode FROM app.threads WHERE id=$1', [t])).rows[0]
          .control_mode,
        'human',
      );
      await dispatch(await decide(r));
      assert.equal((await row(r.requestId)).state, 'simulated');
    },
  );
  await check(
    'human mode owner-prepared current quote remains pending until explicit approval and then executes',
    async () => {
      const { changeThreadControl } = await import('@zutrade/domain');
      await scope('owner', async (c) =>
        changeThreadControl(c, tid, 'takeover', (await requireThread(c, tid)).row_version),
      );
      const r = await scope('owner', async (c) =>
        prepareOutbound(
          c,
          {
            commandId: randomUUID(),
            kind: 'quote',
            quoteVersionId: v1.id,
            contextRevision: (await requireThread(c, tid)).context_revision,
          },
          tid,
          store,
        ),
      );
      assert.equal((await row(r.requestId)).state, 'awaiting_approval');
      assert.equal((await approval(r.requestId)).state, 'pending');
      assert.equal(
        (
          await m.query('SELECT count(*)::int n FROM app.outbox_events WHERE aggregate_id=$1', [
            r.requestId,
          ])
        ).rows[0].n,
        0,
      );
      await dispatch(await decide(r));
      assert.equal((await row(r.requestId)).state, 'simulated');
      assert.deepEqual(await counts(r.requestId), { calls: 1, effects: 1 });
    },
  );
  await check(
    'nested channel recipient smuggling and alternate-thread copies cannot bypass exact content or unresolved outcome',
    async () => {
      const r = await prep(tid, { kind: 'quote', quoteVersionId: v1.id, body: undefined });
      await decide(r, 'reject');
      const original = (
        await m.query('SELECT * FROM app.outbound_payload_versions WHERE id=$1', [r.payloadId])
      ).rows[0];
      const channel = {
        ...original.channel_payload,
        parameters: { ...original.channel_payload.parameters, cc: ['hidden@c.example'] },
      };
      const digest = outboundHash(outboundSnapshot({ ...original, channel_payload: channel })),
        pid = randomUUID();
      await m.query(
        'INSERT INTO app.outbound_payload_versions(id,workspace_id,factory_id,outbound_request_id,version_no,quote_version_id,quote_snapshot_sha256,thread_context_revision,requirements_revision,policy_version,language_code,body_text,subject,body_html,sender_snapshot,recipients_snapshot,attachment_manifest,channel_payload,snapshot_sha256,frozen_at) SELECT $2,workspace_id,factory_id,outbound_request_id,2,quote_version_id,quote_snapshot_sha256,thread_context_revision,requirements_revision,policy_version,language_code,body_text,subject,body_html,sender_snapshot,recipients_snapshot,attachment_manifest,$3,$4,clock_timestamp() FROM app.outbound_payload_versions WHERE id=$1',
        [r.payloadId, pid, JSON.stringify(channel), digest],
      );
      await m.query(
        "UPDATE app.outbound_requests SET current_payload_version_id=$2,state='awaiting_approval' WHERE id=$1",
        [r.requestId, pid],
      );
      await m.query(
        "INSERT INTO app.approvals(workspace_id,outbound_request_id,payload_version_id,snapshot_sha256,requested_by_member_id,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '1 day')",
        [f.ws, r.requestId, pid, digest, users.sales.memberId],
      );
      const rejected = await decide(r);
      assert.equal(rejected.state, 'invalidated');
      assert.match(rejected.conflict, /额外收件人/);
      assert.deepEqual(await counts(r.requestId), { calls: 0, effects: 0 });
      const t = await thread('alias-unknown'),
        old = await prep(t),
        j = await decide(old);
      await dispatch(j, { afterClaim: () => decide(old, 'revoke') });
      assert.equal((await row(old.requestId)).state, 'unknown');
      const alias = randomUUID();
      await transaction(m, async (c) => {
        await c.query(
          "INSERT INTO app.threads(id,workspace_id,channel_account_id,primary_contact_point_id,provider_thread_key,subject,owner_member_id) SELECT $2,workspace_id,channel_account_id,primary_contact_point_id,$2::uuid::text,'C same target alias',owner_member_id FROM app.threads WHERE id=$1",
          [t, alias],
        );
        await c.query(
          'INSERT INTO app.opportunity_threads(workspace_id,opportunity_id,thread_id) SELECT workspace_id,opportunity_id,$2 FROM app.opportunity_threads WHERE thread_id=$1',
          [t, alias],
        );
      });
      await assert.rejects(
        () => prep(alias),
        (e) => e.status === 409,
      );
      await assert.rejects(
        () =>
          scope('sales', async (c) =>
            createReply(c, boss, alias, {
              commandId: randomUUID(),
              templateId: 'use',
              contextRevision: (await requireThread(c, alias)).context_revision,
            }),
          ),
        (e) => e.status === 409,
      );
    },
  );
  await check(
    'PDF missing/corrupt/replaced bytes block submission and claim; actual adapter uses the same verified bytes despite file replacement after preflight',
    async () => {
      const pdf = await scope('owner', (c) => downloadQuotePdf(c, v1.id, store));
      const path = resolve(
        env.PRIVATE_DATA_DIR,
        pdf.manifest.object_key.slice(0, 2),
        pdf.manifest.object_key,
      );
      const { rename } = await import('node:fs/promises');
      await rename(path, path + '.held');
      try {
        await assert.rejects(
          () => prep(tid, { kind: 'quote', quoteVersionId: v1.id, body: undefined }),
          (e) => e.status === 409,
        );
      } finally {
        await rename(path + '.held', path);
      }
      for (const scenario of ['corrupt', 'replacement']) {
        const r = await prep(tid, { kind: 'quote', quoteVersionId: v1.id, body: undefined }),
          j = await decide(r);
        try {
          await writeFile(
            path,
            scenario === 'corrupt'
              ? Buffer.from('bad')
              : Buffer.from('%PDF-1.7 different document %%EOF'),
          );
          await dispatch(j);
          assert.equal((await row(r.requestId)).state, 'blocked');
          assert.deepEqual(await counts(r.requestId), { calls: 0, effects: 0 });
        } finally {
          await writeFile(path, pdf.bytes);
        }
      }
      const r = await prep(tid, { kind: 'quote', quoteVersionId: v1.id, body: undefined }),
        j = await decide(r);
      try {
        await dispatch(j, {
          beforeClaim: async () => writeFile(path, Buffer.from('changed after verified read')),
        });
        assert.equal((await row(r.requestId)).state, 'simulated');
        const ledger = (
          await m.query(
            'SELECT attachment_digests FROM simulation.acceptances WHERE request_id=$1',
            [r.requestId],
          )
        ).rows[0];
        assert.equal(ledger.attachment_digests[0].sha256, pdf.manifest.pdf_sha256);
      } finally {
        await writeFile(path, pdf.bytes);
      }
      await rejectSql("UPDATE app.quote_pdf_artifacts SET object_key='different' WHERE id=$1", [
        pdf.manifest.id,
      ]);
      await rejectSql(
        "UPDATE app.outbound_payload_versions SET attachment_manifest='[]' WHERE id=$1",
        [r.payloadId],
      );
    },
  );
  await check(
    'cancellation cutoff before claim blocks; after claim records cancellation and unknown without pretending recall; after last check accepted fact persists',
    async () => {
      for (const point of ['beforeClaim', 'afterClaim', 'afterFinalCheck']) {
        const t = await thread('cancel-' + point),
          r = await prep(t),
          j = await decide(r);
        await dispatch(j, {
          [point]: async () => {
            const outcome = await decide(r, 'revoke');
            assert.equal(outcome.state, point === 'beforeClaim' ? 'cancelled' : 'cancel_requested');
          },
        });
        const rr = await row(r.requestId);
        assert.equal(
          rr.state,
          point === 'beforeClaim'
            ? 'cancelled'
            : point === 'afterFinalCheck'
              ? 'simulated'
              : 'unknown',
        );
        assert.deepEqual(await counts(r.requestId), {
          calls: point === 'afterFinalCheck' ? 1 : 0,
          effects: point === 'afterFinalCheck' ? 1 : 0,
        });
        if (point !== 'beforeClaim')
          assert.equal(
            (
              await m.query(
                "SELECT count(*)::int n FROM app.approval_events WHERE approval_id=(SELECT id FROM app.approvals WHERE outbound_request_id=$1 ORDER BY created_at DESC LIMIT 1) AND event_kind='revocation_too_late'",
                [r.requestId],
              )
            ).rows[0].n,
            1,
          );
      }
    },
  );
  await check(
    'takeover race at exact barriers prevents old preclaim action and respects the post-last-check window',
    async () => {
      const { changeThreadControl } = await import('@zutrade/domain');
      for (const point of ['beforeClaim', 'afterFinalCheck']) {
        const t = await thread('takeover-' + point),
          r = await prep(t),
          j = await decide(r);
        await dispatch(j, {
          [point]: async () =>
            scope('owner', async (c) =>
              changeThreadControl(c, t, 'takeover', (await requireThread(c, t)).row_version),
            ),
        });
        assert.equal(
          (await row(r.requestId)).state,
          point === 'beforeClaim' ? 'blocked' : 'simulated',
        );
        assert.deepEqual(await counts(r.requestId), {
          calls: point === 'beforeClaim' ? 0 : 1,
          effects: point === 'beforeClaim' ? 0 : 1,
        });
      }
    },
  );
  await check(
    'persistent independent Mock is capability-accurate: explicit rejection, delay, lost response, stable idempotency and non-idempotent side effects',
    async () => {
      const adapter = new MockAdapter(env.SIMULATION_DATABASE_URL);
      const input = {
        requestId: randomUUID(),
        accountId: randomUUID(),
        dispatchToken: randomUUID(),
        providerIdempotencyKey: randomUUID(),
        payloadSha256: 'a'.repeat(64),
        content: { body: 'Isolated provider capability check' },
        attachments: [],
      };
      try {
        const idem = { idempotent: true, guaranteeSeconds: 86400, scenario: 'normal' };
        const a = await adapter.send(input, idem),
          b = await adapter.send(input, idem);
        assert.equal(a.acceptanceId, b.acceptanceId);
        assert.deepEqual(await counts(input.requestId), { calls: 2, effects: 1 });
        await assert.rejects(
          () => adapter.send({ ...input, payloadSha256: 'b'.repeat(64) }, idem),
          /conflict/,
        );
        assert.deepEqual(await counts(input.requestId), { calls: 3, effects: 1 });
        const n = { ...input, requestId: randomUUID(), providerIdempotencyKey: randomUUID() };
        await adapter.send(n, { ...idem, idempotent: false });
        await adapter.send(n, { ...idem, idempotent: false });
        assert.deepEqual(await counts(n.requestId), { calls: 2, effects: 2 });
      } finally {
        await adapter.close();
      }
      for (const scenario of ['reject', 'delay', 'lost_response', 'callbacks']) {
        await mock({ scenario });
        const t = await thread(scenario),
          r = await prep(t),
          j = await decide(r);
        await dispatch(j);
        assert.equal(
          (await row(r.requestId)).state,
          scenario === 'reject' ? 'failed' : scenario === 'lost_response' ? 'unknown' : 'simulated',
        );
        if (scenario === 'lost_response') {
          assert.equal((await lookup(r)).state, 'simulated');
          assert.deepEqual(await counts(r.requestId), { calls: 1, effects: 1 });
        }
        if (scenario === 'callbacks') {
          assert.equal(
            (
              await m.query(
                'SELECT count(*)::int n FROM simulation.callbacks c JOIN simulation.acceptances a ON a.id=c.acceptance_id WHERE a.request_id=$1',
                [r.requestId],
              )
            ).rows[0].n,
            4,
          );
          await lookup(r);
          await lookup(r);
          assert.equal(
            (
              await m.query(
                'SELECT count(*)::int n FROM app.messages WHERE outbound_request_id=$1',
                [r.requestId],
              )
            ).rows[0].n,
            1,
          );
          assert.equal((await row(r.requestId)).state, 'simulated');
        }
      }
      await mock({});
    },
  );
  await check(
    'two dedicated worker processes contend for the same persisted job; only one business claim and provider call',
    async () => {
      await drain();
      const t = await thread('two-workers'),
        r = await prep(t),
        j = await decide(r);
      const first = await childWorker(j, 'beforeClaim');
      await first.wait('beforeClaim');
      const second = await childWorker(j, 'beforeClaim', true);
      await second.wait('beforeClaim');
      first.go();
      second.go();
      const exits = await Promise.all([first.exit, second.exit]);
      for (const e of exits) assert.equal(e.code, 0, e.output);
      assert.deepEqual(await counts(r.requestId), { calls: 1, effects: 1 });
      assert.equal(
        (
          await m.query(
            "SELECT count(*)::int n FROM app.audit_events WHERE aggregate_id=$1 AND action='c.delivery-claimed'",
            [r.requestId],
          )
        ).rows[0].n,
        1,
      );
      crashes.push({
        scenario: 'two-workers',
        pids: [first.child.pid, second.child.pid],
        events: [first.events, second.events],
        exits,
      });
    },
  );
  await check(
    'actual SIGKILL at claim-before-call and acceptance-before-projection; durable restart covers idempotent and non-idempotent modes',
    async () => {
      for (const idempotent of [false, true])
        for (const point of ['afterClaim', 'afterAccepted']) {
          await mock({ idempotent });
          await drain();
          const t = await thread(`crash-${idempotent}-${point}`),
            r = await prep(t),
            j = await decide(r);
          const w = await childWorker(j, point);
          await w.wait(point);
          const before = await counts(r.requestId);
          assert.equal(before.effects, point === 'afterAccepted' ? 1 : 0);
          w.child.kill('SIGKILL');
          const exit = await w.exit;
          assert.equal(exit.signal, 'SIGKILL');
          assert.equal(
            (await row(r.requestId)).state,
            point === 'afterClaim' ? 'claimed' : 'dispatching',
          );
          // A real retry of the same pg-boss job. The replay path below preserves its
          // persisted identity and actual retry counter after confirmed death.
          await workerBoss.fail('a2.delivery', j.jobId, {
            reason: 'dedicated test worker terminated',
          });
          const recovered = await childWorker(j);
          await recovered.wait('done');
          const recoveredExit = await recovered.exit;
          assert.equal(recoveredExit.code, 0, recoveredExit.output);
          const after = await counts(r.requestId),
            rr = await row(r.requestId);
          assert.deepEqual(after, {
            calls: point === 'afterAccepted' ? 1 : idempotent ? 1 : 0,
            effects: point === 'afterAccepted' ? 1 : idempotent ? 1 : 0,
          });
          assert.equal(rr.state, point === 'afterAccepted' || idempotent ? 'simulated' : 'unknown');
          const attempts = (
            await m.query(
              'SELECT payload_version_id,dispatch_token,state FROM app.delivery_attempts WHERE outbound_request_id=$1 ORDER BY attempt_no',
              [r.requestId],
            )
          ).rows;
          assert.ok(attempts.every((a) => a.payload_version_id === r.payloadId));
          if (rr.state === 'unknown') {
            const noRetry = await lookup(r, 'safe_retry');
            assert.equal(noRetry.state, 'unknown');
            assert.deepEqual(await counts(r.requestId), after);
            await assert.rejects(
              () => prep(t, { body: 'Different request id cannot bypass unknown' }),
              (e) => e.status === 409,
            );
            await assert.rejects(
              () =>
                scope('sales', async (c) =>
                  createReply(c, boss, t, {
                    commandId: randomUUID(),
                    templateId: 'use',
                    contextRevision: (await requireThread(c, t)).context_revision,
                  }),
                ),
              (e) => e.status === 409,
            );
            await rejectSql(
              'UPDATE app.outbound_requests SET current_payload_version_id=NULL WHERE id=$1',
              [r.requestId],
            );
          }
          crashes.push({
            scenario: `${idempotent ? 'idempotent' : 'non-idempotent'}-${point}`,
            database: name,
            requestId: r.requestId,
            payloadId: r.payloadId,
            jobId: j.jobId,
            providerKey: rr.provider_idempotency_key,
            pid: w.child.pid,
            events: w.events,
            termination: exit,
            recoveryPid: recovered.child.pid,
            recoveryEvents: recovered.events,
            recoveredExit,
            before,
            after,
            state: rr.state,
            attempts,
          });
        }
      await mock({});
    },
  );
  await check(
    'old worker token is fenced before new call; accepted late response is retained and reconciled after permission loss',
    async () => {
      for (const point of ['beforeFinalCheck', 'afterAccepted']) {
        await mock({ idempotent: false });
        await drain();
        const t = await thread('stale-' + point),
          r = await prep(t),
          j = await decide(r),
          w = await childWorker(j, point);
        await w.wait(point);
        if (point === 'afterAccepted')
          await m.query("UPDATE app.workspace_members SET status='disabled' WHERE id=$1", [
            users.sales.memberId,
          ]);
        await lookup(r); // first evidence projection works even after initiating member is disabled
        w.go();
        const exit = await w.exit;
        assert.equal(exit.code, 0, exit.output);
        if (point === 'afterAccepted')
          await m.query("UPDATE app.workspace_members SET status='active' WHERE id=$1", [
            users.sales.memberId,
          ]);
        assert.deepEqual(await counts(r.requestId), {
          calls: point === 'afterAccepted' ? 1 : 0,
          effects: point === 'afterAccepted' ? 1 : 0,
        });
        assert.equal(
          (await row(r.requestId)).state,
          point === 'afterAccepted' ? 'simulated' : 'unknown',
        );
        if (point === 'afterAccepted')
          assert.ok(
            (
              await m.query(
                "SELECT id FROM app.audit_events WHERE aggregate_id=$1 AND action='c.late-evidence'",
                [r.requestId],
              )
            ).rowCount,
          );
        crashes.push({ scenario: 'stale-' + point, pid: w.child.pid, events: w.events, exit });
      }
      await mock({});
    },
  );
  await check(
    'provider idempotency guarantee expiry forbids recovery calls, and stopping unresolved outcome preserves unknown',
    async () => {
      await mock({ idempotent: true, guaranteeSeconds: 1 });
      await drain();
      const t = await thread('guarantee-expired'),
        r = await prep(t),
        j = await decide(r),
        w = await childWorker(j, 'afterClaim');
      await w.wait('afterClaim');
      w.child.kill('SIGKILL');
      await w.exit;
      await waitFor(
        async () => new Date((await row(r.requestId)).provider_guarantee_until) <= new Date(),
        'fixed provider guarantee expires',
      );
      await workerBoss.fail('a2.delivery', j.jobId, { reason: 'dedicated expiry worker stopped' });
      const expiredRecovery = await childWorker(j);
      await expiredRecovery.wait('done');
      const expiredRecoveryExit = await expiredRecovery.exit;
      assert.equal(expiredRecoveryExit.code, 0, expiredRecoveryExit.output);
      assert.equal((await row(r.requestId)).state, 'unknown');
      assert.deepEqual(await counts(r.requestId), { calls: 0, effects: 0 });
      await lookup(r, 'safe_retry');
      assert.deepEqual(await counts(r.requestId), { calls: 0, effects: 0 });
      const stopped = await lookup(r, 'stop');
      assert.equal(stopped.state, 'unknown');
      assert.ok(stopped.cancel_requested_at);
      await mock({});
    },
  );
  await check(
    'real HTTP authentication, strict mode/extra-recipient refusal, owner decision conflict and private saved PDF preview',
    async () => {
      await launch();
      for (const role of Object.keys(users)) {
        const res = await http('/api/auth/sign-in/email', role, {
          email: users[role].email,
          password: users[role].password,
        });
        assert.equal(res.status, 200);
        users[role].cookie = res.headers
          .getSetCookie()
          .map((s) => s.split(';')[0])
          .join('; ');
      }
      const base = `/api/workspaces/${f.ws}/dispatch`;
      const t = await thread('http'),
        r = await prep(t);
      const a = await approval(r.requestId);
      const d = {
        commandId: randomUUID(),
        payloadId: a.payload_version_id,
        snapshotSha256: a.snapshot_sha256,
        expectedVersion: a.row_version,
        decision: 'approve',
        reason: '',
      };
      for (const role of ['sales', 'deputy'])
        assert.equal((await http(`${base}/approvals/${a.id}/decision`, role, d)).status, 403);
      const current = (await scope('owner', (c) => requireThread(c, t))).context_revision;
      for (const extra of [
        { authorization_mode: 'member_send' },
        { approved_by_member_id: users.owner.memberId },
        { recipients: ['extra@c.example'] },
        { cc: ['extra@c.example'] },
        { bcc: ['extra@c.example'] },
        { channel_payload: { to: ['extra@c.example'] } },
      ])
        assert.equal(
          (
            await http(`${base}/threads/${t}/prepare`, 'sales', {
              commandId: randomUUID(),
              contextRevision: current,
              kind: 'human_reply',
              quoteVersionId: null,
              body: 'Test',
              ...extra,
            })
          ).status,
          400,
        );
      const quote = snapshotEvidence[0];
      const url = `${base}/requests/${quote.requestId}/payloads/${quote.payloadId}/pdf`;
      const pdf = await http(url, 'owner');
      assert.equal(pdf.status, 200);
      assert.equal(
        createHash('sha256')
          .update(Buffer.from(await pdf.arrayBuffer()))
          .digest('hex'),
        quote.attachmentSha256,
      );
      assert.equal((await http(url, 'none')).status, 401);
      assert.equal((await http(url, 'outside')).status, 403);
      assert.equal((await http(`${base}/approvals/${a.id}/decision`, 'owner', d)).status, 201);
      assert.equal(
        (
          await http(`${base}/approvals/${a.id}/decision`, 'owner', {
            ...d,
            commandId: randomUUID(),
          })
        ).status,
        409,
      );
      const j = (
        await m.query(
          'SELECT id event_id,pg_boss_job_id job_id FROM app.outbox_events WHERE aggregate_id=$1',
          [r.requestId],
        )
      ).rows[0];
      await dispatch({ eventId: j.event_id, jobId: j.job_id });
      await stop();
      await launch();
      assert.equal((await http(url, 'owner')).status, 200);
      await stop();
    },
  );

  await check(
    'raw pending/retry/dead receipt blocks old typed automatic actions; explicit processing keeps account lock and protected recovery',
    async () => {
      const { enqueueDelivery } = await import('@zutrade/domain');
      async function automatic(t) {
        const base = await scope('owner', async (c) =>
          createReply(c, boss, t, {
            commandId: randomUUID(),
            templateId: 'use',
            contextRevision: (await requireThread(c, t)).context_revision,
          }),
        );
        const source = await row(base.requestId),
          id = randomUUID(),
          pid = randomUUID();
        await m.query("UPDATE app.outbound_requests SET state='cancelled' WHERE id=$1", [
          base.requestId,
        ]);
        await transaction(m, async (c) => {
          await c.query(
            `INSERT INTO app.outbound_requests(id,workspace_id,factory_id,opportunity_id,thread_id,channel_account_id,transport_mode,contact_point_id,intent,authorization_mode,state,idempotency_key,command_sha256,provider_idempotency_key,created_by_member_id) SELECT $2,workspace_id,factory_id,opportunity_id,thread_id,channel_account_id,transport_mode,contact_point_id,'faq','verified_faq_policy','queued',$2::uuid::text,command_sha256,$2::uuid::text,created_by_member_id FROM app.outbound_requests WHERE id=$1`,
            [source.id, id],
          );
          await c.query(
            `INSERT INTO app.outbound_payload_versions(id,workspace_id,factory_id,outbound_request_id,version_no,thread_context_revision,policy_version,language_code,body_text,subject,body_html,sender_snapshot,recipients_snapshot,attachment_manifest,channel_payload,snapshot_sha256,frozen_at) SELECT $3,workspace_id,factory_id,$2,1,thread_context_revision,policy_version,language_code,body_text,subject,body_html,sender_snapshot,recipients_snapshot,attachment_manifest,channel_payload,snapshot_sha256,frozen_at FROM app.outbound_payload_versions WHERE id=$1`,
            [base.payloadId, id, pid],
          );
          await c.query(
            'UPDATE app.outbound_requests SET current_payload_version_id=$2 WHERE id=$1',
            [id, pid],
          );
        });
        const r = await row(id),
          j = await scope('owner', (c) => enqueueDelivery(c, boss, r, pid, randomUUID()));
        return { r: { requestId: id, payloadId: pid }, j };
      }
      const t = await thread('barrier');
      for (const state of ['pending', 'retry', 'dead']) {
        const { r, j } = await automatic(t);
        const receipt = await scope('owner', (c) =>
          injectSimulation(c, boss, {
            eventId: randomUUID(),
            providerMessageId: randomUUID(),
            identity: `barrier-${randomUUID()}@c.example`,
            displayName: 'C paused normalization',
            body: 'new inbound has committed',
            occurredAt: new Date().toISOString(),
            factoryId: f.a,
          }),
        );
        if (state !== 'pending')
          await m.query('UPDATE app.inbound_events SET state=$2,last_error=$3 WHERE id=$1', [
            receipt.receiptId,
            state,
            'C isolated normalization failure',
          ]);
        await dispatch(j);
        assert.equal((await row(r.requestId)).state, 'blocked');
        assert.match((await row(r.requestId)).stop_reason, /原始入站收据/);
        assert.deepEqual(await counts(r.requestId), { calls: 0, effects: 0 });
        assert.equal(
          (
            await m.query('SELECT processed_at FROM app.inbound_events WHERE id=$1', [
              receipt.receiptId,
            ])
          ).rows[0].processed_at,
          null,
        );
        // Resume the real trusted normalizer with its original persisted job identity;
        // do not clear receipts or forge processed_at to remove the barrier.
        const e = (
          await m.query('SELECT id,pg_boss_job_id FROM app.outbox_events WHERE aggregate_id=$1', [
            receipt.receiptId,
          ])
        ).rows[0];
        await consumeInboundJob(worker, { eventId: e.id, workspaceId: f.ws }, e.pg_boss_job_id);
        assert.ok(
          (
            await m.query('SELECT processed_at FROM app.inbound_events WHERE id=$1', [
              receipt.receiptId,
            ])
          ).rows[0].processed_at,
        );
      }
      const { r, j } = await automatic(t);
      await scope('owner', async (c) => {
        const { changeThreadControl } = await import('@zutrade/domain');
        await changeThreadControl(c, t, 'takeover', (await requireThread(c, t)).row_version);
      });
      await dispatch(j);
      assert.equal((await row(r.requestId)).state, 'blocked');
      assert.deepEqual(await counts(r.requestId), { calls: 0, effects: 0 });
    },
  );
  await check(
    'workspace lock serializes actual revocation and claim, and receipt ingestion cannot pass an active claim transaction',
    async () => {
      const t = await thread('workspace-lock'),
        r = await prep(t),
        j = await decide(r);
      const held = await m.connect();
      await held.query('BEGIN');
      await held.query('SELECT app.c_lock_workspace($1)', [f.ws]);
      await held.query('DELETE FROM app.factory_memberships WHERE member_id=$1 AND factory_id=$2', [
        users.sales.memberId,
        f.a,
      ]);
      const waiting = dispatch(j);
      await waitFor(
        async () =>
          Number(
            (
              await admin.query(
                "SELECT count(*) n FROM pg_stat_activity WHERE datname=$1 AND usename='zutrade_worker' AND wait_event_type='Lock'",
                [name],
              )
            ).rows[0].n,
          ) > 0,
        'claim waits workspace lock',
      );
      await held.query('COMMIT');
      held.release();
      await waiting;
      assert.equal((await row(r.requestId)).state, 'blocked');
      assert.deepEqual(await counts(r.requestId), { calls: 0, effects: 0 });
      await m.query(
        'INSERT INTO app.factory_memberships(workspace_id,factory_id,member_id) VALUES($1,$2,$3)',
        [f.ws, f.a, users.sales.memberId],
      );
      const latch = await m.connect();
      await latch.query('BEGIN');
      await latch.query('SELECT app.c_lock_workspace($1)', [f.ws]);
      const incoming = scope('owner', (c) =>
        injectSimulation(c, boss, {
          eventId: randomUUID(),
          providerMessageId: randomUUID(),
          identity: 'locked-inbound@c.example',
          displayName: 'C locked receipt',
          body: 'waits for claim protocol',
          occurredAt: new Date().toISOString(),
          factoryId: f.a,
        }),
      );
      await waitFor(
        async () =>
          Number(
            (
              await admin.query(
                "SELECT count(*) n FROM pg_stat_activity WHERE datname=$1 AND application_name='zutrade-b-test' AND wait_event_type='Lock'",
                [name],
              )
            ).rows[0].n,
          ) > 0,
        'receipt waits workspace lock',
      );
      await latch.query('COMMIT');
      latch.release();
      const receipt = await incoming,
        e = (
          await m.query('SELECT id,pg_boss_job_id FROM app.outbox_events WHERE aggregate_id=$1', [
            receipt.receiptId,
          ])
        ).rows[0];
      await consumeInboundJob(worker, { eventId: e.id, workspaceId: f.ws }, e.pg_boss_job_id);
    },
  );
  await check(
    'C reuses B current requirements and factory/source eligibility; old quote and removed evidence cannot dispatch',
    async () => {
      const r = await prep(tid, { kind: 'quote', quoteVersionId: v1.id, body: undefined }),
        j = await decide(r);
      await save({ quantity: '500' });
      await dispatch(j);
      assert.equal((await row(r.requestId)).state, 'blocked');
      assert.match((await row(r.requestId)).stop_reason, /需求/);
      const next = await gen();
      assert.equal(next.snapshot.totalAmount, '1230.00');
      await scope('owner', (c) => generateQuotePdf(c, next.id, store));
      await assert.rejects(
        () => prep(tid, { kind: 'quote', quoteVersionId: v1.id, body: undefined }),
        (e) => e.status === 409,
      );
      const r2 = await prep(tid, { kind: 'quote', quoteVersionId: next.id, body: undefined }),
        j2 = await decide(r2);
      await m.query(
        "UPDATE app.factories SET authority_valid_until=now()-interval '1 second' WHERE id=$1",
        [f.a],
      );
      await dispatch(j2);
      assert.equal((await row(r2.requestId)).state, 'blocked');
      assert.match((await row(r2.requestId)).stop_reason, /授权/);
      await m.query('UPDATE app.factories SET authority_valid_until=NULL WHERE id=$1', [f.a]);
      const r3 = await prep(tid, { kind: 'quote', quoteVersionId: next.id, body: undefined }),
        j3 = await decide(r3);
      const { withdrawSource } = await import('@zutrade/domain');
      await scope('owner', (c) => withdrawSource(c, s.id, 'C isolated source withdrawal'));
      await dispatch(j3);
      assert.equal((await row(r3.requestId)).state, 'blocked');
      assert.match((await row(r3.requestId)).stop_reason, /来源/);
      assert.deepEqual(await counts(r3.requestId), { calls: 0, effects: 0 });
    },
  );
  await check(
    'restricted runtime cannot read or modify simulation ledger; simulation cannot become real delivered/read; complete process restart retains approvals/attempts/files/ledger',
    async () => {
      await assert.rejects(
        () => api.query('SELECT * FROM simulation.acceptances'),
        (e) => e.code === '42501',
      );
      await assert.rejects(
        () => worker.query('DELETE FROM simulation.acceptances'),
        (e) => e.code === '42501',
      );
      const q = snapshotEvidence[0];
      await rejectSql("UPDATE app.outbound_requests SET state='delivered' WHERE id=$1", [
        q.requestId,
      ]);
      await rejectSql(
        "UPDATE app.messages SET delivery_state='read' WHERE outbound_request_id=$1",
        [q.requestId],
      );
      const mixed = randomUUID(),
        o = await opp();
      await transaction(m, async (c) => {
        await c.query(
          `INSERT INTO app.opportunities(id,workspace_id,factory_id,buyer_id,primary_contact_id,owner_member_id,title) VALUES($1,$2,$3,$4,$5,$6,'C mixed factory')`,
          [mixed, f.ws, f.b, o.buyer_id, o.primary_contact_id, users.owner.memberId],
        );
        await c.query(
          'INSERT INTO app.opportunity_threads(workspace_id,opportunity_id,thread_id) VALUES($1,$2,$3)',
          [f.ws, mixed, tid],
        );
      });
      assert.equal(
        (await scope('sales', (c) => outboundWorkspace(c))).items.some(
          (x) => x.request.id === q.requestId,
        ),
        false,
      );
      await launch();
      const url = `/api/workspaces/${f.ws}/dispatch/requests/${q.requestId}/payloads/${q.payloadId}/pdf`;
      assert.equal((await http(url, 'sales')).status, 404);
      await stop();
      await m.query('DELETE FROM app.opportunity_threads WHERE opportunity_id=$1', [mixed]);
      const before = (
        await m.query(
          `SELECT jsonb_build_object('approval',(SELECT jsonb_agg(a ORDER BY a.id) FROM app.approvals a),'attempts',(SELECT jsonb_agg(a ORDER BY a.id) FROM app.delivery_attempts a),'ledger',(SELECT jsonb_agg(a ORDER BY a.id) FROM simulation.acceptances a),'payloads',(SELECT jsonb_agg(a ORDER BY a.id) FROM app.outbound_payload_versions a)) data`,
        )
      ).rows[0].data;
      const restart = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import {pg} from '@zutrade/db';const p=new pg.Pool({connectionString:process.env.MIGRATION_DATABASE_URL});console.log(JSON.stringify((await p.query("SELECT jsonb_build_object('approval',(SELECT jsonb_agg(a ORDER BY a.id) FROM app.approvals a),'attempts',(SELECT jsonb_agg(a ORDER BY a.id) FROM app.delivery_attempts a),'ledger',(SELECT jsonb_agg(a ORDER BY a.id) FROM simulation.acceptances a),'payloads',(SELECT jsonb_agg(a ORDER BY a.id) FROM app.outbound_payload_versions a)) data")).rows[0].data));await p.end();`,
        ],
        { env, encoding: 'utf8' },
      );
      assert.equal(restart.status, 0);
      assert.deepEqual(JSON.parse(restart.stdout), before);
      const pdf = await scope('owner', (c) => downloadQuotePdf(c, v1.id, store));
      assert.equal(createHash('sha256').update(pdf.bytes).digest('hex'), q.attachmentSha256);
      writeFileSync(
        evidence + '/process-persistence.json',
        JSON.stringify(
          {
            checkedAt: new Date().toISOString(),
            database: name,
            beforeSha256: createHash('sha256').update(JSON.stringify(before)).digest('hex'),
            afterSha256: createHash('sha256')
              .update(JSON.stringify(JSON.parse(restart.stdout)))
              .digest('hex'),
            pdfSha256: q.attachmentSha256,
            independentProcessExit: restart.status,
          },
          null,
          2,
        ) + '\n',
      );
    },
  );

  writeFileSync(
    '.local/c-test-session.json',
    JSON.stringify(
      { env, database: name, root, workspaceId: f.ws, factories: [f.a, f.b], users },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  await check(
    'permission loss after committed claim but before last token check stops a new call without losing unknown history',
    async () => {
      for (const kind of ['member', 'factory']) {
        const t = await thread('last-check-' + kind),
          r = await prep(t),
          j = await decide(r);
        await dispatch(j, {
          afterClaim: async () => {
            if (kind === 'member')
              await m.query("UPDATE app.workspace_members SET status='disabled' WHERE id=$1", [
                users.sales.memberId,
              ]);
            else
              await m.query(
                'DELETE FROM app.factory_memberships WHERE member_id=$1 AND factory_id=$2',
                [users.sales.memberId, f.a],
              );
          },
        });
        assert.equal((await row(r.requestId)).state, 'unknown');
        assert.deepEqual(await counts(r.requestId), { calls: 0, effects: 0 });
        if (kind === 'member')
          await m.query("UPDATE app.workspace_members SET status='active' WHERE id=$1", [
            users.sales.memberId,
          ]);
        else
          await m.query(
            'INSERT INTO app.factory_memberships(workspace_id,factory_id,member_id) VALUES($1,$2,$3)',
            [f.ws, f.a, users.sales.memberId],
          );
        await lookup(r, 'stop');
      }
    },
  );
  success = true;
} finally {
  await stop();
  if (workerBoss) await workerBoss.stop();
  if (boss) await boss.stop();
  for (const pool of [m, api, worker, ap]) await pool.end();
  // Exact isolated DB is retained as process/persistence evidence, even on success.
  await admin.end();
  writeFileSync(evidence + '/integration-processes.txt', logs);
  writeFileSync(
    evidence + '/integration.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        stage: 'C',
        passed: success,
        database: name,
        privateRoot: root,
        disposableDatabaseRetained: true,
        checks,
        crashes,
        snapshotEvidence,
      },
      null,
      2,
    ) + '\n',
  );
}
