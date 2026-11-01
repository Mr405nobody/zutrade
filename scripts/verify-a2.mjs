import { expectedBusinessTableCount } from './business-table-expectations.mjs';
import assert from 'node:assert/strict';
import { loadEnvFile } from 'node:process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  pg,
  createAuth,
  createAuthPool,
  createQueue,
  transaction,
  withWorkspace,
  assertRuntimeRole,
  renameFactoryAndEnqueue,
} from '@zutrade/db';
import {
  injectSimulation,
  consumeInboundJob,
  consumeDeliveryJob,
  listThreads,
  threadDetail,
  threadMessages,
  markThreadRead,
  addTeamNote,
  changeThreadControl,
  requireThread,
  createReply,
  saveInternalDraft,
  inboxSnapshot,
  assignIntake,
} from '@zutrade/domain';
loadEnvFile('.env');
const name = `zutrade_a2_test_${randomUUID().replaceAll('-', '')}`;
const evidence = process.env.EVIDENCE_DIR ?? 'docs/build/evidence/a2';
mkdirSync(evidence, { recursive: true });
const checks = [];
const children = [];
const pools = [];
let succeeded = false;
let apiChild;
let workerChild;
const adminUrl = new URL(process.env.DATABASE_URL);
adminUrl.username = process.env.POSTGRES_USER;
adminUrl.password = process.env.POSTGRES_PASSWORD;
const admin = new pg.Pool({ connectionString: adminUrl.href });
const env = {
  ...process.env,
  POSTGRES_DB: name,
  API_PORT: '3201',
  WORKER_PORT: '3202',
  WEB_PORT: '5173',
};
for (const key of [
  'DATABASE_URL',
  'MIGRATION_DATABASE_URL',
  'API_DATABASE_URL',
  'WORKER_DATABASE_URL',
  'AUTH_DATABASE_URL',
]) {
  const u = new URL(process.env[key]);
  u.pathname = '/' + name;
  env[key] = u.href;
}
const m = new pg.Pool({ connectionString: env.MIGRATION_DATABASE_URL });
const api = new pg.Pool({ connectionString: env.API_DATABASE_URL, max: 6 });
const worker = new pg.Pool({ connectionString: env.WORKER_DATABASE_URL, max: 6 });
const authPool = createAuthPool(env.MIGRATION_DATABASE_URL);
pools.push(m, api, worker, authPool);
for (const p of [...pools, admin])
  p.on('error', (e) => console.error(JSON.stringify({ event: 'test_idle_error', code: e.code })));
let boss;
async function check(label, run) {
  await run();
  checks.push({ label, result: 'passed' });
  console.log('PASS ' + label);
}
function command(script) {
  const r = spawnSync(process.execPath, [script], { env, encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) throw new Error(script + ' failed: ' + r.stderr.slice(0, 1200));
  return r.stdout;
}
function launch(path) {
  const child = spawn(process.execPath, [path], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  for (const s of [child.stdout, child.stderr]) s.on('data', (c) => (logs += c.toString()));
  children.push({ child, logs: () => logs });
  return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  await done;
}
async function until(run, description) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await run()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('Timed out: ' + description);
}
const f = { ws: randomUUID(), a: randomUUID(), b: randomUUID() };
const users = {};
const scope = (role, run) => withWorkspace(api, { id: users[role].subject, name: role }, f.ws, run);
const input = (identity, extra = {}) => ({
  eventId: randomUUID(),
  providerMessageId: randomUUID(),
  identity,
  displayName: 'Alex Morgan / Northstar Events（虚构）',
  body: 'We need 500 cotton bags with a single-colour logo. Could you quote and deliver within six weeks? These are buyer requirements only.',
  occurredAt: new Date().toISOString(),
  factoryId: f.a,
  ...extra,
});
async function inject(value) {
  return scope('owner', (c) => injectSimulation(c, boss, value));
}
async function inboundJob(receipt) {
  return (
    await m.query(
      'SELECT id AS "eventId",workspace_id AS "workspaceId",pg_boss_job_id AS "jobId" FROM app.outbox_events WHERE handler_key=\'a2.inbound\' AND aggregate_id=$1',
      [receipt.receiptId],
    )
  ).rows[0];
}
async function normalize(receipt) {
  const j = await inboundJob(receipt);
  await consumeInboundJob(worker, { eventId: j.eventId, workspaceId: j.workspaceId }, j.jobId);
  return (
    await m.query(
      'SELECT normalized_thread_id AS id,normalized_message_id AS message FROM app.inbound_events WHERE id=$1',
      [receipt.receiptId],
    )
  ).rows[0];
}
async function delivery(command) {
  const row = (
    await m.query('SELECT payload FROM app.outbox_events WHERE id=$1', [command.eventId])
  ).rows[0];
  const user = Object.values(users).find((u) => u.userId === row.payload.userId);
  assert.ok(user);
  return consumeDeliveryJob(
    worker,
    { eventId: command.eventId, workspaceId: f.ws, userId: user.userId },
    command.jobId,
  );
}
const thread = (id, role = 'owner') => scope(role, (c) => requireThread(c, id));
const reply = async (id, extra = {}, role = 'owner') =>
  scope(role, async (c) =>
    createReply(c, boss, id, {
      commandId: randomUUID(),
      templateId: 'destination',
      contextRevision: (await requireThread(c, id)).context_revision,
      ...extra,
    }),
  );
const base = 'http://127.0.0.1:3201';
async function http(path, role = 'owner', body, method = body ? 'POST' : 'GET') {
  return fetch(base + path, {
    method,
    headers: {
      ...(users[role]?.cookie ? { cookie: users[role].cookie } : {}),
      ...(body ? { 'content-type': 'application/json', origin: 'http://127.0.0.1:5173' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const path = (tail = '') => `/api/workspaces/${f.ws}/inbox${tail}`;
async function openSse(role) {
  const ctrl = new globalThis.AbortController();
  const r = await fetch(base + path('/events'), {
    headers: { cookie: users[role].cookie },
    signal: ctrl.signal,
  });
  assert.equal(r.status, 200);
  const reader = r.body.getReader();
  let text = '';
  let ended = false;
  const pumping = (async () => {
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        text += new globalThis.TextDecoder().decode(part.value);
      }
    } catch (e) {
      if (e.name !== 'AbortError') throw e;
    } finally {
      ended = true;
    }
  })();
  await until(() => text.includes('event: connected'), 'SSE initial');
  return {
    get text() {
      return text;
    },
    get ended() {
      return ended;
    },
    close: async () => {
      ctrl.abort();
      await pumping;
    },
  };
}
let alex;
let first;
let allIds = [];
try {
  await admin.query(`CREATE DATABASE "${name}"`);
  command('scripts/db-provision.mjs');
  command('scripts/db-migrate.mjs');
  boss = createQueue(env.API_DATABASE_URL);
  await boss.start();
  const auth = createAuth(authPool, env.BETTER_AUTH_SECRET, 5173, 3201, true);
  for (const role of ['owner', 'sales']) {
    const password = randomBytes(24).toString('hex');
    const email = role + '@a2.test';
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
    await c.query('INSERT INTO app.workspaces(id,name) VALUES($1,$2)', [f.ws, 'Isolated A2']);
    for (const [role, u] of Object.entries(users)) {
      await c.query('INSERT INTO app.app_users(id,auth_subject,display_name) VALUES($1,$2,$3)', [
        u.userId,
        u.subject,
        role,
      ]);
      await c.query(
        'INSERT INTO app.workspace_members(id,workspace_id,user_id,role,all_factories) VALUES($1,$2,$3,$4,$5)',
        [u.memberId, f.ws, u.userId, role, role === 'owner'],
      );
    }
    for (const id of [f.a, f.b])
      await c.query(
        "INSERT INTO app.factories(id,workspace_id,name,factory_code,status) VALUES($1,$2,$3,$3,'active')",
        [id, f.ws, id === f.a ? 'A' : 'B'],
      );
    await c.query(
      'INSERT INTO app.factory_memberships(workspace_id,factory_id,member_id) VALUES($1,$2,$3)',
      [f.ws, f.a, users.sales.memberId],
    );
  });
  await check(
    'A1 runtime role, RLS, original SQL and incremental migration boundaries retained',
    async () => {
      await assertRuntimeRole(api);
      await assertRuntimeRole(worker);
      assert.equal(
        (
          await m.query(
            "SELECT count(*)::int n FROM pg_class WHERE relnamespace='app'::regnamespace AND relkind='r' AND relrowsecurity AND relforcerowsecurity",
          )
        ).rows[0].n,
        expectedBusinessTableCount,
      );
      assert.equal(
        createHash('sha256')
          .update(readFileSync('zutrade-build-kit/references/zutrade-schema-v1.sql'))
          .digest('hex'),
        'b7f72b68adce6ad161eedf66b65389cd35461ec20446a9e97fa560550c21a1fe',
      );
      command('scripts/db-migrate.mjs');
    },
  );
  first = input('alex-northstar');
  await check(
    'inbound receipt persists before worker; duplicate same event reused and changed content conflicts; injection owner-only',
    async () => {
      alex = await inject(first);
      const repeated = await inject(first);
      assert.equal(alex.receiptId, repeated.receiptId);
      assert.equal((await m.query('SELECT count(*)::int n FROM app.messages')).rows[0].n, 0);
      await assert.rejects(
        () => inject({ ...first, body: 'changed' }),
        (e) => e.status === 409,
      );
      await assert.rejects(
        () => scope('sales', (c) => injectSimulation(c, boss, input('forbidden'))),
        (e) => e.status === 403,
      );
    },
  );
  await check('real worker restart consumes committed inbound queue without reseed', async () => {
    workerChild = launch('apps/worker/dist/main.js');
    await until(
      async () =>
        (await m.query('SELECT state FROM app.inbound_events WHERE id=$1', [alex.receiptId]))
          .rows[0].state === 'processed',
      'worker inbound',
    );
    await stop(workerChild);
    alex = await normalize(alex);
    allIds.push(alex.id);
    assert.ok(alex.id);
    assert.equal(
      (
        await m.query(
          "SELECT count(*)::int n FROM app.audit_events WHERE actor_kind='system' AND action='a2.inbound-normalized'",
        )
      ).rows[0].n,
      1,
    );
  });
  await check(
    'different event envelopes for same provider message do not duplicate message or advance context; same-name distinct identity stays distinct',
    async () => {
      const before = await thread(alex.id);
      const dup = await inject({ ...first, eventId: randomUUID() });
      const result = await normalize(dup);
      assert.equal(result.message, alex.message);
      assert.equal((await thread(alex.id)).context_revision, before.context_revision);
      const other = await normalize(await inject(input('alex-other')));
      assert.notEqual(other.id, alex.id);
      allIds.push(other.id);
      assert.equal((await m.query('SELECT count(*)::int n FROM app.contacts')).rows[0].n, 2);
    },
  );
  await check(
    'independent read cursors; late occurred_at remains unread; monotonic reads and cursor pagination',
    async () => {
      await scope('owner', (c) => markThreadRead(c, alex.id, alex.message));
      let owner = await scope('owner', listThreads);
      let sales = await scope('sales', listThreads);
      assert.equal(owner.items.find((t) => t.id === alex.id).unread_count, 0);
      assert.equal(sales.items.find((t) => t.id === alex.id).unread_count, 1);
      const late = await normalize(
        await inject(input('alex-northstar', { occurredAt: '2020-01-01T00:00:00.000Z' })),
      );
      owner = await scope('owner', listThreads);
      assert.equal(owner.items.find((t) => t.id === alex.id).unread_count, 1);
      const newer = await scope('owner', (c) => threadMessages(c, alex.id, { limit: 1 }));
      assert.equal(newer.items[0].id, late.message);
      assert.ok(newer.next_cursor);
      const older = await scope('owner', (c) =>
        threadMessages(c, alex.id, { before: newer.next_cursor, limit: 1 }),
      );
      assert.equal(older.items[0].id, alex.message);
      await scope('owner', (c) => markThreadRead(c, alex.id, late.message));
      await scope('owner', (c) => markThreadRead(c, alex.id, alex.message));
      assert.equal(
        (await scope('owner', listThreads)).items.find((t) => t.id === alex.id).unread_count,
        0,
      );
      assert.equal(
        (await scope('sales', listThreads)).items.find((t) => t.id === alex.id).unread_count,
        2,
      );
    },
  );
  await check(
    'thread lock is explicit synchronization point: concurrent inbound cannot be skipped by read or pagination',
    async () => {
      const receipt = await inject(input('alex-northstar'));
      let release;
      const held = new Promise((r) => (release = r));
      let entered;
      const ready = new Promise((r) => (entered = r));
      const holding = scope('owner', async (c) => {
        await requireThread(c, alex.id, true);
        entered();
        await held;
      });
      await ready;
      const job = await inboundJob(receipt);
      const running = consumeInboundJob(
        worker,
        { eventId: job.eventId, workspaceId: f.ws },
        job.jobId,
      );
      try {
        await until(
          async () =>
            (
              await admin.query(
                "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'",
                [name],
              )
            ).rows[0].n > 0,
          'known blocked normalizer',
        );
      } finally {
        release();
      }
      await holding;
      await running;
      const rows = await scope('owner', (c) => threadMessages(c, alex.id));
      const ids = rows.items.map((r) => r.id);
      assert.equal(ids.length, new Set(ids).size);
      assert.equal(rows.items.length, 3);
      await scope('owner', (c) => markThreadRead(c, alex.id, rows.items.at(-2).id));
      assert.equal(
        (await scope('owner', listThreads)).items.find((t) => t.id === alex.id).unread_count,
        1,
      );
    },
  );
  let noteId;
  let draft;
  await check(
    'notes and free-text internal drafts never create buyer messages, frozen snapshots or delivery jobs; notes/read do not invalidate context',
    async () => {
      const before = await thread(alex.id);
      const commandId = randomUUID();
      const note = await scope('sales', (c) =>
        addTeamNote(c, alex.id, { commandId, body: 'TEAM SECRET internal only' }),
      );
      noteId = note.id;
      assert.equal(
        (
          await scope('sales', (c) =>
            addTeamNote(c, alex.id, { commandId, body: 'TEAM SECRET internal only' }),
          )
        ).id,
        note.id,
      );
      draft = await scope('owner', (c) =>
        saveInternalDraft(c, alex.id, {
          commandId: randomUUID(),
          body: 'INTERNAL DRAFT price USD 1,000 deliver in 6 weeks',
        }),
      );
      assert.equal(
        (
          await m.query('SELECT frozen_at FROM app.outbound_payload_versions WHERE id=$1', [
            draft.payloadId,
          ])
        ).rows[0].frozen_at,
        null,
      );
      assert.equal(
        (
          await m.query('SELECT count(*)::int n FROM app.outbox_events WHERE aggregate_id=$1', [
            draft.requestId,
          ])
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await m.query(
            "SELECT count(*)::int n FROM app.messages WHERE body_text LIKE '%TEAM SECRET%' OR body_text LIKE '%INTERNAL DRAFT%'",
          )
        ).rows[0].n,
        0,
      );
      assert.equal((await thread(alex.id)).context_revision, before.context_revision);
      assert.equal((await thread(alex.id)).row_version, before.row_version);
    },
  );
  let successful;
  await check(
    'gateway command idempotency, fixed templates, atomic request/payload/outbox/queue and worker simulated completion',
    async () => {
      const t = await thread(alex.id);
      const request = {
        commandId: randomUUID(),
        templateId: 'destination',
        contextRevision: t.context_revision,
      };
      successful = await scope('sales', (c) => createReply(c, boss, alex.id, request));
      const duplicate = await scope('sales', (c) => createReply(c, boss, alex.id, request));
      assert.equal(successful.requestId, duplicate.requestId);
      await assert.rejects(
        () =>
          scope('sales', (c) => createReply(c, boss, alex.id, { ...request, templateId: 'use' })),
        (e) => e.status === 409,
      );
      await assert.rejects(() =>
        scope('owner', (c) =>
          createReply(c, boss, alex.id, { ...request, commandId: randomUUID(), body: 'price $1' }),
        ),
      );
      const x = (
        await m.query(
          `SELECT r.xmin::text AS r,p.xmin::text AS p,e.xmin::text AS e,j.xmin::text AS j FROM app.outbound_requests r JOIN app.outbound_payload_versions p ON p.outbound_request_id=r.id JOIN app.outbox_events e ON e.aggregate_id=r.id JOIN pgboss.job j ON j.id=e.pg_boss_job_id WHERE r.id=$1`,
          [successful.requestId],
        )
      ).rows[0];
      assert.equal(new Set(Object.values(x)).size, 1);
      workerChild = launch('apps/worker/dist/main.js');
      await until(
        async () =>
          (
            await m.query('SELECT state FROM app.outbound_requests WHERE id=$1', [
              successful.requestId,
            ])
          ).rows[0].state === 'simulated',
        'simulated delivery',
      );
      await stop(workerChild);
      await delivery(successful);
      assert.equal(
        (
          await m.query('SELECT count(*)::int n FROM app.messages WHERE outbound_request_id=$1', [
            successful.requestId,
          ])
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await m.query(
            'SELECT count(*)::int n FROM app.delivery_attempts WHERE outbound_request_id=$1',
            [successful.requestId],
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await m.query(
            "SELECT count(*)::int n FROM app.messages WHERE delivery_state IN ('submitted','delivered','read')",
          )
        ).rows[0].n,
        0,
      );
      assert.equal((await scope('owner', (c) => threadDetail(c, alex.id))).notes[0].id, noteId);
    },
  );
  await check(
    'business/outbox/enqueue all roll back on enqueue failure; no partial command survives',
    async () => {
      const key = randomUUID();
      const broken = {
        send: async () => {
          throw new Error('Injected queue failure');
        },
      };
      await assert.rejects(() =>
        scope('owner', async (c) =>
          createReply(c, broken, alex.id, {
            commandId: key,
            templateId: 'quantity',
            contextRevision: (await requireThread(c, alex.id)).context_revision,
          }),
        ),
      );
      assert.equal(
        (
          await m.query(
            'SELECT count(*)::int n FROM app.outbound_requests WHERE idempotency_key=$1',
            [key],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await m.query('SELECT count(*)::int n FROM app.outbox_events WHERE idempotency_key=$1', [
            key,
          ])
        ).rows[0].n,
        0,
      );
    },
  );
  await check(
    'two-window CAS conflict, takeover invalidates old action, latest human reply allowed and release explicit',
    async () => {
      const old = await reply(alex.id);
      const before = await thread(alex.id);
      const outcomes = await Promise.allSettled([
        scope('owner', (c) => changeThreadControl(c, alex.id, 'takeover', before.row_version)),
        scope('sales', (c) => changeThreadControl(c, alex.id, 'takeover', before.row_version)),
      ]);
      assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
      assert.equal(outcomes.find((o) => o.status === 'rejected').reason.status, 409);
      await delivery(old);
      assert.equal(
        (await m.query('SELECT state FROM app.outbound_requests WHERE id=$1', [old.requestId]))
          .rows[0].state,
        'blocked',
      );
      await assert.rejects(
        () => reply(alex.id, { contextRevision: before.context_revision }),
        (e) => e.status === 409,
      );
      const fresh = await reply(alex.id);
      await delivery(fresh);
      assert.equal(
        (await m.query('SELECT state FROM app.outbound_requests WHERE id=$1', [fresh.requestId]))
          .rows[0].state,
        'simulated',
      );
      let t = await thread(alex.id);
      await scope('owner', (c) => changeThreadControl(c, alex.id, 'release', t.row_version));
      assert.equal((await thread(alex.id)).control_mode, 'assisted');
    },
  );
  await check(
    'claim revalidates paused channel, contact eligibility, member and factory revocation; records explicit blocking',
    async () => {
      const account = (await thread(alex.id)).channel_account_id;
      const paused = await reply(alex.id);
      await m.query("UPDATE app.channel_accounts SET state='paused' WHERE id=$1", [account]);
      await delivery(paused);
      assert.equal(
        (await m.query('SELECT state FROM app.outbound_requests WHERE id=$1', [paused.requestId]))
          .rows[0].state,
        'blocked',
      );
      await m.query("UPDATE app.channel_accounts SET state='active' WHERE id=$1", [account]);
      const point = (await thread(alex.id)).primary_contact_point_id;
      const noConsent = await reply(alex.id);
      await m.query(
        "UPDATE app.contact_permissions SET status='revoked' WHERE contact_point_id=$1",
        [point],
      );
      await delivery(noConsent);
      assert.equal(
        (
          await m.query('SELECT state FROM app.outbound_requests WHERE id=$1', [
            noConsent.requestId,
          ])
        ).rows[0].state,
        'blocked',
      );
      await m.query(
        "UPDATE app.contact_permissions SET status='allowed' WHERE contact_point_id=$1",
        [point],
      );
      const disabled = await reply(alex.id, {}, 'sales');
      await m.query("UPDATE app.workspace_members SET status='disabled' WHERE id=$1", [
        users.sales.memberId,
      ]);
      await delivery(disabled);
      assert.equal(
        (await m.query('SELECT state FROM app.outbound_requests WHERE id=$1', [disabled.requestId]))
          .rows[0].state,
        'blocked',
      );
      await m.query("UPDATE app.workspace_members SET status='active' WHERE id=$1", [
        users.sales.memberId,
      ]);
      const revoked = await reply(alex.id, {}, 'sales');
      await m.query('DELETE FROM app.factory_memberships WHERE member_id=$1 AND factory_id=$2', [
        users.sales.memberId,
        f.a,
      ]);
      await delivery(revoked);
      assert.equal(
        (await m.query('SELECT state FROM app.outbound_requests WHERE id=$1', [revoked.requestId]))
          .rows[0].state,
        'blocked',
      );
      await m.query(
        'INSERT INTO app.factory_memberships(workspace_id,factory_id,member_id) VALUES($1,$2,$3)',
        [f.ws, f.a, users.sales.memberId],
      );
    },
  );
  await check(
    'expired synthetic claim becomes unknown without an unprotected second send (C preserves active claims; this is not crash proof)',
    async () => {
      const isolated = await normalize(await inject(input('a2-synthetic-claim-' + randomUUID())));
      const command = await reply(isolated.id);
      const token = randomUUID();
      await m.query(
        "UPDATE app.outbound_requests SET state='claimed',dispatch_token=$1,dispatch_payload_version_id=current_payload_version_id,dispatch_claimed_at=now()-interval '2 minutes' WHERE id=$2",
        [token, command.requestId],
      );
      await m.query(
        "INSERT INTO app.delivery_attempts(workspace_id,outbound_request_id,payload_version_id,attempt_no,dispatch_token,state) VALUES($1,$2,$3,1,$4,'started')",
        [f.ws, command.requestId, command.payloadId, token],
      );
      await delivery(command);
      assert.equal(
        (await m.query('SELECT state FROM app.outbound_requests WHERE id=$1', [command.requestId]))
          .rows[0].state,
        'unknown',
      );
      assert.equal(
        (
          await m.query('SELECT count(*)::int n FROM app.messages WHERE outbound_request_id=$1', [
            command.requestId,
          ])
        ).rows[0].n,
        0,
      );
      await delivery(command);
      assert.equal(
        (
          await m.query(
            'SELECT count(*)::int n FROM app.delivery_attempts WHERE outbound_request_id=$1',
            [command.requestId],
          )
        ).rows[0].n,
        1,
      );
    },
  );
  await check(
    'persisted receipt and failed/dead receipt retain account barrier; new inbound invalidates old reply',
    async () => {
      const hiddenOld = await reply(alex.id, {}, 'sales');
      const hiddenReceipt = await inject(input('hidden-pending-b', { factoryId: f.b }));
      await delivery(hiddenOld);
      assert.match(
        (
          await m.query('SELECT stop_reason FROM app.outbound_requests WHERE id=$1', [
            hiddenOld.requestId,
          ])
        ).rows[0].stop_reason,
        /入站收据/,
      );
      await normalize(hiddenReceipt);
      const old = await reply(alex.id);
      const receipt = await inject(input('alex-northstar'));
      await delivery(old);
      assert.match(
        (
          await m.query('SELECT stop_reason FROM app.outbound_requests WHERE id=$1', [
            old.requestId,
          ])
        ).rows[0].stop_reason,
        /入站收据/,
      );
      await normalize(receipt);
      const stale = await reply(alex.id);
      await normalize(await inject(input('alex-northstar')));
      await delivery(stale);
      assert.equal(
        (await m.query('SELECT state FROM app.outbound_requests WHERE id=$1', [stale.requestId]))
          .rows[0].state,
        'blocked',
      );
      const missing = await inject(input(null));
      await normalize(missing);
      assert.equal(
        (
          await m.query('SELECT state,processed_at FROM app.inbound_events WHERE id=$1', [
            missing.receiptId,
          ])
        ).rows[0].processed_at,
        null,
      );
      const blocked = await reply(alex.id);
      await delivery(blocked);
      assert.equal(
        (await m.query('SELECT state FROM app.outbound_requests WHERE id=$1', [blocked.requestId]))
          .rows[0].state,
        'blocked',
      );
    },
  );
  let onlyB;
  let mixed;
  let unassigned;
  await check(
    'complete factory-set authorization: A-only sales cannot read B, A/B mixed, or unassigned via list/detail/messages/notes/read/SSE snapshot',
    async () => {
      onlyB = await normalize(await inject(input('only-b', { factoryId: f.b })));
      mixed = await normalize(await inject(input('mixed')));
      unassigned = await normalize(await inject(input('unassigned', { factoryId: null })));
      await transaction(m, async (c) => {
        const origin = (
          await c.query(
            'SELECT o.* FROM app.opportunities o JOIN app.opportunity_threads ot ON ot.workspace_id=o.workspace_id AND ot.opportunity_id=o.id WHERE ot.thread_id=$1',
            [mixed.id],
          )
        ).rows[0];
        const op = (
          await c.query(
            'INSERT INTO app.opportunities(workspace_id,factory_id,buyer_id,owner_member_id,title) VALUES($1,$2,$3,$4,$5) RETURNING id',
            [f.ws, f.b, origin.buyer_id, users.owner.memberId, 'mixed B'],
          )
        ).rows[0];
        await c.query(
          'INSERT INTO app.opportunity_threads(workspace_id,opportunity_id,thread_id) VALUES($1,$2,$3)',
          [f.ws, op.id, mixed.id],
        );
      });
      const list = await scope('sales', listThreads);
      const snapshot = await scope('sales', inboxSnapshot);
      for (const id of [onlyB.id, mixed.id, unassigned.id]) {
        assert.ok(!list.items.some((t) => t.id === id));
        assert.ok(!snapshot.some((t) => t.id === id));
        await assert.rejects(
          () => scope('sales', (c) => threadDetail(c, id)),
          (e) => e.status === 404,
        );
        await assert.rejects(
          () => scope('sales', (c) => threadMessages(c, id)),
          (e) => e.status === 404,
        );
        await assert.rejects(
          () =>
            scope('sales', (c) =>
              addTeamNote(c, id, { commandId: randomUUID(), body: 'forbidden' }),
            ),
          (e) => e.status === 404,
        );
      }
      await scope('owner', (c) =>
        assignIntake(c, unassigned.id, { factoryId: f.a, expectedVersion: '1' }),
      ).catch(async (e) => {
        if (e.status !== 409) throw e;
        const t = await thread(unassigned.id);
        return scope('owner', (c) =>
          assignIntake(c, unassigned.id, { factoryId: f.a, expectedVersion: t.row_version }),
        );
      });
      assert.ok((await scope('sales', listThreads)).items.some((t) => t.id === unassigned.id));
    },
  );
  await check(
    'system worker cannot forge job or operate outside scoped simulation receipt',
    async () => {
      const j = await inboundJob(await inject(input('scope-test')));
      await assert.rejects(() =>
        consumeInboundJob(worker, { eventId: j.eventId, workspaceId: f.ws }, randomUUID()),
      );
      await transaction(worker, async (c) => {
        await c.query('SELECT app.begin_inbound_task($1,$2)', [j.eventId, j.jobId]);
        await assert.rejects(() =>
          c.query("UPDATE app.workspace_members SET status='disabled' WHERE id=$1", [
            users.owner.memberId,
          ]),
        );
      });
    },
  );
  apiChild = launch('apps/api/dist/main.js');
  await until(async () => {
    try {
      return (await fetch(base + '/health/live')).ok;
    } catch {
      return false;
    }
  }, 'API start');
  for (const [role, u] of Object.entries(users)) {
    const r = await http('/api/auth/sign-in/email', role, { email: u.email, password: u.password });
    assert.equal(r.status, 200);
    u.cookie = r.headers
      .getSetCookie()
      .map((s) => s.split(';')[0])
      .join('; ');
  }
  await check(
    'HTTP strict authorization and templates; A1 login, factory boundary and transaction helper regressions',
    async () => {
      assert.equal((await http('/api/me', 'sales')).status, 200);
      assert.equal((await http(`/api/workspaces/${f.ws}/factories/${f.b}`, 'sales')).status, 404);
      assert.equal((await http(path('/simulation'), 'sales', first)).status, 403);
      assert.equal((await http(path(`/threads/${onlyB.id}`), 'sales')).status, 404);
      assert.equal((await http(path(`/threads/${mixed.id}/messages`), 'sales')).status, 404);
      assert.equal(
        (
          await http(path(`/threads/${alex.id}/reply`), 'owner', {
            commandId: randomUUID(),
            templateId: 'quantity',
            contextRevision: (await thread(alex.id)).context_revision,
            authorization_mode: 'member_send',
          })
        ).status,
        400,
      );
      const key = randomUUID();
      await assert.rejects(() =>
        scope('owner', (c) => renameFactoryAndEnqueue(c, boss, f.a, 'rollback', key, 'enqueue')),
      );
      assert.equal(
        (await m.query('SELECT name FROM app.factories WHERE id=$1', [f.a])).rows[0].name,
        'A',
      );
    },
  );
  await check(
    'SSE rechecks authorization after ACL revocation and newly invisible factory link; no hidden content, ids or counts leak',
    async () => {
      const stream = await openSse('sales');
      assert.ok(!stream.text.includes(onlyB.id));
      await m.query('DELETE FROM app.factory_memberships WHERE member_id=$1 AND factory_id=$2', [
        users.sales.memberId,
        f.a,
      ]);
      await until(() => stream.text.includes('event: permission-lost'), 'live ACL invalidation');
      assert.ok(!stream.text.includes(first.body));
      assert.equal((await http(path(`/threads/${alex.id}`), 'sales')).status, 404);
      await stream.close();
      await m.query(
        'INSERT INTO app.factory_memberships(workspace_id,factory_id,member_id) VALUES($1,$2,$3)',
        [f.ws, f.a, users.sales.memberId],
      );
      const associationStream = await openSse('sales');
      await transaction(m, async (c) => {
        const origin = (
          await c.query(
            'SELECT o.* FROM app.opportunities o JOIN app.opportunity_threads ot ON ot.workspace_id=o.workspace_id AND ot.opportunity_id=o.id WHERE ot.thread_id=$1',
            [unassigned.id],
          )
        ).rows[0];
        const op = (
          await c.query(
            'INSERT INTO app.opportunities(workspace_id,factory_id,buyer_id,owner_member_id,title) VALUES($1,$2,$3,$4,$5) RETURNING id',
            [f.ws, f.b, origin.buyer_id, users.owner.memberId, 'new invisible association'],
          )
        ).rows[0];
        await c.query(
          'INSERT INTO app.opportunity_threads(workspace_id,opportunity_id,thread_id) VALUES($1,$2,$3)',
          [f.ws, op.id, unassigned.id],
        );
      });
      await until(
        () => associationStream.text.includes('event: permission-lost'),
        'new B association invalidates established SSE',
      );
      assert.equal((await http(path(`/threads/${unassigned.id}`), 'sales')).status, 404);
      await associationStream.close();
      const stream2 = await openSse('sales');
      await m.query("UPDATE app.workspace_members SET status='disabled' WHERE id=$1", [
        users.sales.memberId,
      ]);
      await until(() => stream2.text.includes('event: permission-lost'), 'member disabled');
      assert.equal((await http(path('/threads'), 'sales')).status, 403);
      await stream2.close();
      await m.query("UPDATE app.workspace_members SET status='active' WHERE id=$1", [
        users.sales.memberId,
      ]);
    },
  );
  await check(
    'SSE session expiry invalidates established connection and future queries',
    async () => {
      const stream = await openSse('sales');
      await authPool.query(
        'UPDATE auth.session SET "expiresAt"=now()-interval \'1 second\' WHERE "userId"=$1',
        [users.sales.subject],
      );
      await until(() => stream.text.includes('event: permission-lost'), 'session expiry');
      assert.equal((await http(path('/threads'), 'sales')).status, 401);
      await stream.close();
    },
  );
  await check(
    'application restart preserves messages notes reads and committed queued tasks; SSE reconnect/database cursor catch-up',
    async () => {
      const before = (await m.query('SELECT count(*)::int n FROM app.messages')).rows[0].n;
      await stop(apiChild);
      apiChild = launch('apps/api/dist/main.js');
      await until(async () => {
        try {
          return (await fetch(base + '/health/live')).ok;
        } catch {
          return false;
        }
      }, 'API restart');
      assert.equal((await http('/api/me')).status, 200);
      assert.equal((await m.query('SELECT count(*)::int n FROM app.messages')).rows[0].n, before);
      assert.ok(
        (await scope('owner', (c) => threadDetail(c, alex.id))).notes.some((n) => n.id === noteId),
      );
      const rows = await scope('owner', (c) => threadMessages(c, alex.id));
      const cursor = rows.items.at(-1).ingest_seq;
      const disconnected = await openSse('owner');
      await disconnected.close();
      const late = await normalize(await inject(input('alex-northstar')));
      const catchup = await scope('owner', (c) => threadMessages(c, alex.id, { after: cursor }));
      assert.ok(catchup.items.some((r) => r.id === late.message));
      const connected = await openSse('owner');
      await connected.close();
    },
  );
  succeeded = true;
} finally {
  for (const { child } of children) await stop(child);
  writeFileSync(
    evidence + '/integration-processes.txt',
    children.map((r, i) => `process ${i}\n${r.logs()}`).join('\n'),
  );
  if (boss) await boss.stop();
  for (const p of pools) await p.end();
  if (succeeded) {
    await admin.query(`DROP DATABASE "${name}"`);
  }
  await admin.end();
  writeFileSync(
    evidence + '/integration.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        stage: 'A2',
        passed: succeeded,
        disposableDatabaseRemoved: succeeded,
        ...(succeeded ? {} : { failedDatabase: name }),
        checks,
      },
      null,
      2,
    ) + '\n',
  );
}
