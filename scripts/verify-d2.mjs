import assert from 'node:assert/strict';
import { loadEnvFile } from 'node:process';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  pg,
  transaction,
  withWorkspace,
  createQueue,
  createAuth,
  createAuthPool,
} from '@zutrade/db';
import {
  createResearch,
  consumeResearchJob,
  reviewCandidate,
  importCandidate,
  createSimulationContact,
  saveBatchDraft,
  freezeBatch,
  decideBatch,
  d2Workspace,
  consumeDeliveryJob,
  saveFollowup,
  consumeFollowupJob,
  decideApproval,
  cancelFollowup,
  setOutboundPause,
  setSimulationPermission,
  requestReconciliation,
  changeThreadControl,
  createProduct,
  createSource,
  publishPrice,
  saveRequirements,
  generateQuote,
  generateQuotePdf,
  withdrawSource,
  injectSimulation,
  consumeInboundJob,
  retryInboundReceipt,
  prepareOutbound,
} from '@zutrade/domain';
import { resolveLocalTime } from '@zutrade/contracts';
import { LocalPrivateObjectStore } from '@zutrade/storage';
import { fixtureHooks } from './d1-fixture.mjs';
loadEnvFile('.env');
process.env.NODE_ENV = 'test';
const evidence = process.env.EVIDENCE_DIR ?? 'docs/build/evidence/d2';
mkdirSync(evidence, { recursive: true });
const name = 'zutrade_d2_test_' + randomUUID().replaceAll('-', ''),
  root = mkdtempSync(resolve('.local/d2-test-'));
const env = {
  ...process.env,
  NODE_ENV: 'test',
  POSTGRES_DB: name,
  API_PORT: '3701',
  WORKER_PORT: '3702',
  WEB_PORT: '5473',
  PRIVATE_DATA_DIR: root + '/private',
};
for (const k of [
  'DATABASE_URL',
  'MIGRATION_DATABASE_URL',
  'API_DATABASE_URL',
  'WORKER_DATABASE_URL',
  'AUTH_DATABASE_URL',
  'SIMULATION_DATABASE_URL',
]) {
  const u = new URL(env[k]);
  u.pathname = '/' + name;
  env[k] = u.href;
}
const adminUrl = new URL(process.env.DATABASE_URL);
adminUrl.username = process.env.POSTGRES_USER;
adminUrl.password = process.env.POSTGRES_PASSWORD;
const admin = new pg.Pool({ connectionString: adminUrl.href }),
  m = new pg.Pool({ connectionString: env.MIGRATION_DATABASE_URL }),
  api = new pg.Pool({ connectionString: env.API_DATABASE_URL, max: 12 }),
  worker = new pg.Pool({ connectionString: env.WORKER_DATABASE_URL, max: 12 }),
  authPool = createAuthPool(env.MIGRATION_DATABASE_URL);
const store = new LocalPrivateObjectStore(env.PRIVATE_DATA_DIR),
  users = {},
  ids = { ws: randomUUID(), other: randomUUID(), a: randomUUID(), b: randomUUID() },
  checks = [],
  crashes = [],
  children = [];
let boss,
  wb,
  successful = false;
const scope = (role, run, workspace = ids.ws) =>
  withWorkspace(api, { id: users[role].subject, name: role }, workspace, run);
const row = async (table, id) =>
  (await m.query(`SELECT * FROM app.${table} WHERE id=$1`, [id])).rows[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(30);
  }
  throw new Error('Timeout ' + label);
}
async function check(label, fn) {
  await fn();
  checks.push({ label, result: 'passed' });
  console.log('PASS ' + label);
}
function command(path) {
  const r = spawnSync(process.execPath, [path], { env, encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) throw new Error(path + ': ' + r.stderr.slice(0, 1500));
}
async function jobsForRequest(id) {
  return (
    await m.query(
      "SELECT * FROM app.outbox_events WHERE aggregate_id=$1 AND handler_key='a2.delivery' ORDER BY created_at",
      [id],
    )
  ).rows;
}
async function jobData(e) {
  return { eventId: e.id, workspaceId: e.workspace_id, userId: e.payload.userId };
}
async function execute(id, hooks = {}) {
  const events = await jobsForRequest(id),
    e = events.at(-1);
  await consumeDeliveryJob(worker, await jobData(e), e.pg_boss_job_id, {
    queue: wb,
    store,
    simulationUrl: env.SIMULATION_DATABASE_URL,
    ...hooks,
  });
}
async function pump() {
  for (const queue of ['d2.followup', 'a2.delivery'])
    for (const job of await wb.fetch(queue, { batchSize: 100 })) {
      if (queue === 'd2.followup') await consumeFollowupJob(worker, job.data, job.id);
      else
        await consumeDeliveryJob(worker, job.data, job.id, {
          queue: wb,
          store,
          simulationUrl: env.SIMULATION_DATABASE_URL,
        });
      await wb.complete(queue, job);
    }
}
async function approveRequest(id) {
  const a = (
    await m.query("SELECT * FROM app.approvals WHERE outbound_request_id=$1 AND state='pending'", [
      id,
    ])
  ).rows[0];
  return scope('owner', (c) =>
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
        reason: 'D2 isolated',
      },
      store,
    ),
  );
}
const contacts = [],
  leads = [],
  accounts = [];
async function makeBatch(contactList = contacts, extra = {}) {
  const now = (await m.query('SELECT clock_timestamp() AS now')).rows[0].now;
  const draft = {
    name: 'D2 离线隔离批次',
    factoryId: ids.a,
    timeZone: 'Asia/Shanghai',
    startAt: now.toISOString(),
    deadline: new Date(now.getTime() + 3600000).toISOString(),
    intervalMs: 1000,
    items: contactList.map((x) => ({
      threadId: x.threadId,
      leadId: x.leadId,
      quoteVersionId: null,
      subject: 'Introduction',
      body: 'Internal simulation. May we share product information?',
    })),
    ...extra,
  };
  const b = await scope('sales', (c) =>
    saveBatchDraft(c, { commandId: randomUUID(), batchId: null, expectedVersion: null, draft }),
  );
  const frozen = await scope('sales', (c) =>
    freezeBatch(c, b.id, { commandId: randomUUID(), expectedVersion: b.row_version }, store),
  );
  return frozen;
}
async function batchInput(b, decision = 'approve') {
  const a = (
    await m.query(
      "SELECT * FROM app.approvals WHERE batch_version_id=$1 AND state IN('pending','approved')",
      [b.versionId],
    )
  ).rows[0];
  return {
    commandId: randomUUID(),
    versionId: b.versionId,
    snapshotSha256: a.snapshot_sha256,
    expectedVersion: a.row_version,
    decision,
    reason: 'D2 isolated',
  };
}
async function batchRequests(b) {
  return (
    await m.query(
      'SELECT outbound_request_id FROM app.outreach_batch_items WHERE batch_version_id=$1 ORDER BY position',
      [b.versionId],
    )
  ).rows.map((x) => x.outbound_request_id);
}
async function plan(contact = contacts[0], extra = {}) {
  const o = (
    await m.query('SELECT opportunity_id FROM app.opportunity_threads WHERE thread_id=$1', [
      contact.threadId,
    ])
  ).rows[0];
  const when = new Date(Math.ceil((Date.now() + 2000) / 60000) * 60000);
  return scope('sales', (c) =>
    saveFollowup(
      c,
      boss,
      {
        commandId: randomUUID(),
        followupId: null,
        expectedVersion: null,
        threadId: contact.threadId,
        opportunityId: o.opportunity_id,
        ownerMemberId: users.sales.memberId,
        quoteVersionId: null,
        purpose: 'D2 isolated reminder',
        internalDraft: 'INTERNAL_DRAFT_MUST_NOT_LEAK',
        mode: 'manual',
        localTime: when.toISOString().slice(0, 16),
        timeZone: 'UTC',
        disambiguation: 'reject',
        subject: 'Follow-up',
        body: 'Internal simulation: may we provide further information?',
        ...extra,
      },
      store,
    ),
  );
}
function dedicated(extra = {}) {
  const cp = spawn(process.execPath, ['scripts/d2-test-worker.mjs'], {
    env: { ...env, ...extra },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  cp.messages = [];
  cp.output = '';
  cp.on('message', (x) => cp.messages.push(x));
  cp.stdout.on('data', (b) => (cp.output += b));
  cp.stderr.on('data', (b) => (cp.output += b));
  children.push(cp);
  return cp;
}
async function point(cp, p) {
  await until(() => {
    if (cp.messages.some((x) => x.point === p)) return true;
    if (cp.exitCode !== null || cp.signalCode !== null)
      throw new Error('Child stopped: ' + cp.output);
    return false;
  }, p);
  return cp.messages.find((x) => x.point === p);
}
async function kill(cp) {
  const done = new Promise((r) => cp.once('exit', (code, signal) => r({ code, signal })));
  cp.kill('SIGKILL');
  return done;
}
try {
  await admin.query(`CREATE DATABASE "${name}"`);
  command('scripts/db-provision.mjs');
  command('scripts/db-migrate.mjs');
  const auth = createAuth(authPool, env.BETTER_AUTH_SECRET, 5473, 3701, true);
  for (const role of ['owner', 'sales', 'deputy', 'outside']) {
    const password = randomBytes(24).toString('hex'),
      email = role + '@d2.test';
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
      "INSERT INTO app.workspaces(id,name) VALUES($1,'D2 offline isolated'),($2,'D2 other isolated')",
      [ids.ws, ids.other],
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
          role === 'outside' ? ids.other : ids.ws,
          u.userId,
          ['owner', 'deputy'].includes(role) ? 'owner' : 'sales',
          ['owner', 'deputy'].includes(role),
        ],
      );
    }
    await c.query(
      "INSERT INTO app.factories(id,workspace_id,name,factory_code,status) VALUES($1,$3,'D2 simulated factory A','D2-A','active'),($2,$3,'D2 simulated factory B','D2-B','active')",
      [ids.a, ids.b, ids.ws],
    );
    await c.query(
      'INSERT INTO app.factory_memberships(workspace_id,factory_id,member_id) VALUES($1,$2,$3)',
      [ids.ws, ids.a, users.sales.memberId],
    );
    await c.query('UPDATE app.workspaces SET approver_member_id=$2 WHERE id=$1', [
      ids.ws,
      users.owner.memberId,
    ]);
    for (const [index, scenario] of ['normal', 'reject', 'delay'].entries()) {
      const id = randomUUID();
      accounts.push(id);
      await c.query(
        "INSERT INTO app.channel_accounts(id,workspace_id,channel_kind,transport_mode,provider,external_account_key,display_name,state,configuration) VALUES($1,$2,'simulation','simulation','zutrade-mock',$3,$4,'active',$5)",
        [
          id,
          ids.ws,
          index === 0 ? 'a2-inbox' : 'd2-' + scenario,
          'D2 simulation ' + scenario,
          JSON.stringify({ mock: { idempotent: true, guaranteeSeconds: 600, scenario } }),
        ],
      );
    }
  });
  boss = createQueue(env.API_DATABASE_URL);
  wb = createQueue(env.WORKER_DATABASE_URL);
  await boss.start();
  await wb.start();
  await check(
    'D1 fixture -> review -> import remains explicitly offline; independent demo contact has no real permission',
    async () => {
      const run = await scope('sales', (c) =>
        createResearch(
          c,
          boss,
          {
            commandId: randomUUID(),
            factoryId: ids.a,
            productId: null,
            provider: 'public_directory',
            directoryId: 'wikimedia-events-sg',
            country: 'SG',
            buyerType: 'events',
            keywords: ['events'],
            exclusions: [],
            limit: 3,
          },
          { storageRights: false },
        ),
      );
      const e = (
        await m.query(
          'SELECT * FROM app.outbox_events WHERE id=(SELECT outbox_event_id FROM app.prospecting_runs WHERE id=$1)',
          [run.runId],
        )
      ).rows[0];
      const fetched = await wb.fetch('d1.research', { batchSize: 1 });
      assert.equal(fetched[0]?.id, run.jobId);
      await consumeResearchJob(
        worker,
        await jobData(e),
        run.jobId,
        { storageRights: false },
        fixtureHooks(),
      );
      await wb.complete('d1.research', fetched[0]);
      for (const [index, candidate] of (
        await row('prospecting_runs', run.runId)
      ).results_snapshot.candidates.entries()) {
        const r = await row('prospecting_runs', run.runId);
        await scope('sales', (c) =>
          reviewCandidate(c, run.runId, {
            candidateKey: candidate.key,
            resultVersion: r.result_version,
            reviewRevision: r.review_revision,
            decision: 'keep',
            reason: 'Offline test evidence reviewed',
          }),
        );
        const after = await row('prospecting_runs', run.runId);
        const l = await scope('sales', (c) =>
          importCandidate(c, run.runId, {
            commandId: randomUUID(),
            candidateKey: candidate.key,
            resultVersion: after.result_version,
            reviewRevision: after.review_revision,
            identityConfirmed: true,
            buyerId: null,
          }),
        );
        leads.push(l.leadId);
        const contact = await scope('owner', (c) =>
          createSimulationContact(c, {
            commandId: randomUUID(),
            leadId: l.leadId,
            accountId: accounts[index],
            simulationAuthorized: true,
          }),
        );
        contacts.push({ ...contact, leadId: l.leadId });
      }
      assert.equal(contacts.length, 3);
      assert.equal(
        (
          await m.query(
            "SELECT count(*)::int n FROM app.contact_permissions WHERE channel_kind<>'simulation'",
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await m.query(
            'SELECT count(*)::int n FROM app.contact_points WHERE verified_at IS NOT NULL',
          )
        ).rows[0].n,
        0,
      );
    },
  );
  const mixed = await makeBatch();
  await check(
    'Only current designated active owner approves; workspace/factory access checked',
    async () => {
      const input = await batchInput(mixed);
      for (const role of ['sales', 'deputy', 'outside'])
        await assert.rejects(() =>
          scope(role, (c) => decideBatch(c, boss, mixed.id, input, store)),
        );
      await m.query("UPDATE app.workspace_members SET status='disabled' WHERE id=$1", [
        users.owner.memberId,
      ]);
      await assert.rejects(() =>
        scope('owner', (c) => decideBatch(c, boss, mixed.id, input, store)),
      );
      await m.query("UPDATE app.workspace_members SET status='active' WHERE id=$1", [
        users.owner.memberId,
      ]);
      const d = (await row('outreach_batches', mixed.id)).draft;
      await assert.rejects(() =>
        scope('sales', (c) =>
          saveBatchDraft(c, {
            commandId: randomUUID(),
            batchId: null,
            expectedVersion: null,
            draft: { ...d, factoryId: ids.b },
          }),
        ),
      );
      await assert.rejects(() => scope('outside', (c) => d2Workspace(c), ids.ws));
    },
  );
  await check(
    'Approval/business/outbox/enqueue rollback together; duplicate approve retains one event per item',
    async () => {
      const before = (
        await m.query(
          'SELECT (SELECT count(*) FROM app.outbox_events)::int events,(SELECT count(*) FROM pgboss.job)::int jobs',
        )
      ).rows[0];
      for (const point of ['approval', 'business', 'outbox', 'enqueue']) {
        await assert.rejects(() =>
          scope('owner', async (c) =>
            decideBatch(c, boss, mixed.id, await batchInput(mixed), store, point),
          ),
        );
        assert.equal(
          (
            await m.query('SELECT state FROM app.approvals WHERE batch_version_id=$1', [
              mixed.versionId,
            ])
          ).rows[0].state,
          'pending',
        );
        assert.deepEqual(
          (
            await m.query(
              'SELECT (SELECT count(*) FROM app.outbox_events)::int events,(SELECT count(*) FROM pgboss.job)::int jobs',
            )
          ).rows[0],
          before,
        );
      }
      const input = await batchInput(mixed);
      const results = await Promise.all([
        scope('owner', (c) => decideBatch(c, boss, mixed.id, input, store)),
        scope('owner', (c) => decideBatch(c, boss, mixed.id, input, store)),
      ]);
      assert.deepEqual(results[0], results[1]);
      assert.equal(results[0].state, 'queued');
      assert.deepEqual(
        (await scope('owner', (c) => d2Workspace(c))).batches.find((x) => x.id === mixed.id)
          .summary,
        { queued: 3 },
      );
    },
  );
  await check(
    'Frozen batch/payload/items cannot change names, content, account, attachments or membership',
    async () => {
      const [rid] = await batchRequests(mixed),
        r = await row('outbound_requests', rid);
      for (const [sql, params] of [
        ["UPDATE app.outreach_batch_versions SET send_rules='{}' WHERE id=$1", [mixed.versionId]],
        ['DELETE FROM app.outreach_batch_items WHERE batch_version_id=$1', [mixed.versionId]],
        [
          "UPDATE app.outbound_payload_versions SET body_text='changed' WHERE id=$1",
          [r.current_payload_version_id],
        ],
        [
          'UPDATE app.outbound_payload_versions SET attachment_manifest=$2 WHERE id=$1',
          [r.current_payload_version_id, JSON.stringify([{ filename: 'changed.pdf' }])],
        ],
        ['UPDATE app.outbound_requests SET channel_account_id=$2 WHERE id=$1', [rid, accounts[1]]],
      ])
        await assert.rejects(() => m.query(sql, params));
    },
  );
  await check(
    'Mixed batch actual results are success/failure/delayed; queue is not completion',
    async () => {
      const requests = await batchRequests(mixed);
      let delayed = false;
      await until(async () => {
        await pump();
        for (const id of requests) {
          const r = await row('outbound_requests', id);
          if (r.state === 'queued') delayed = true;
        }
        return (await Promise.all(requests.map((id) => row('outbound_requests', id)))).every((r) =>
          ['simulated', 'failed'].includes(r.state),
        );
      }, 'mixed results');
      const states = await Promise.all(
        requests.map(async (id) => (await row('outbound_requests', id)).state),
      );
      assert.deepEqual(states, ['simulated', 'failed', 'simulated']);
      assert.ok(delayed);
      assert.equal(
        (await m.query('SELECT count(*)::int n FROM simulation.acceptances')).rows[0].n,
        2,
      );
    },
  );
  await check('New batch version cannot inherit prior approval', async () => {
    const b = await row('outreach_batches', mixed.id),
      d = { ...b.draft, name: 'D2 v2', startAt: new Date().toISOString() };
    const saved = await scope('sales', (c) =>
      saveBatchDraft(c, {
        commandId: randomUUID(),
        batchId: b.id,
        expectedVersion: b.row_version,
        draft: d,
      }),
    );
    const v = await scope('sales', (c) =>
      freezeBatch(c, b.id, { commandId: randomUUID(), expectedVersion: saved.row_version }, store),
    );
    assert.notEqual(v.versionId, mixed.versionId);
    const a = (
      await m.query('SELECT * FROM app.approvals WHERE batch_version_id=$1', [v.versionId])
    ).rows[0];
    assert.equal(a.state, 'pending');
  });
  await check(
    'Multi-worker/duplicate jobs obey persistent account pacing and keep request/provider identity',
    async () => {
      const extra = await scope('owner', (c) =>
        createSimulationContact(c, {
          commandId: randomUUID(),
          leadId: leads[1],
          accountId: accounts[0],
          simulationAuthorized: true,
        }),
      );
      const list = [contacts[0], { ...extra, leadId: leads[1] }];
      const b = await makeBatch(list);
      await scope('owner', async (c) => decideBatch(c, boss, b.id, await batchInput(b), store));
      const rr = await batchRequests(b);
      await Promise.all(rr.flatMap((id) => [execute(id), execute(id)]));
      await until(async () => {
        await pump();
        return (await Promise.all(rr.map((id) => row('outbound_requests', id)))).every(
          (r) => r.state === 'simulated',
        );
      }, 'pacing');
      const q = (
        await m.query(
          'SELECT request_id,invoked_at AS called_at,provider_key FROM simulation.invocations WHERE request_id=ANY($1::uuid[]) ORDER BY invoked_at',
          [rr],
        )
      ).rows;
      assert.equal(q.length, 2);
      assert.ok(new Date(q[1].called_at) - new Date(q[0].called_at) >= 950);
      assert.equal(q[0].provider_key, q[0].request_id);
      assert.equal(q[1].provider_key, q[1].request_id);
    },
  );
  await check(
    'A worker stalled after claim cannot compress later provider calls past account pacing',
    async () => {
      const extra = await scope('owner', (c) =>
        createSimulationContact(c, {
          commandId: randomUUID(),
          leadId: leads[2],
          accountId: accounts[0],
          simulationAuthorized: true,
        }),
      );
      const b = await makeBatch([contacts[0], { ...extra, leadId: leads[2] }]);
      await scope('owner', async (c) => decideBatch(c, boss, b.id, await batchInput(b), store));
      const rr = await batchRequests(b);
      await sleep(1100);
      let release, claimed;
      const pause = new Promise((r) => (release = r)),
        entered = new Promise((r) => (claimed = r));
      const first = execute(rr[0], {
        afterClaim: async () => {
          claimed();
          await pause;
        },
      });
      await entered;
      await sleep(1100);
      await execute(rr[1]);
      assert.equal((await row('outbound_requests', rr[1])).state, 'queued');
      release();
      await first;
      await until(async () => {
        await pump();
        return (await row('outbound_requests', rr[1])).state === 'simulated';
      }, 'post-claim pacing');
      const invocations = (
        await m.query(
          'SELECT invoked_at FROM simulation.invocations WHERE request_id=ANY($1::uuid[]) ORDER BY invoked_at',
          [rr],
        )
      ).rows;
      assert.equal(invocations.length, 2);
      assert.ok(new Date(invocations[1].invoked_at) - new Date(invocations[0].invoked_at) >= 950);
    },
  );
  await check('DST gaps rejected, overlaps explicit and timezone conversion correct', async () => {
    assert.equal(resolveLocalTime('2026-10-29T18:00', 'Asia/Shanghai'), '2026-10-29T10:00:00.000Z');
    assert.throws(() => resolveLocalTime('2027-03-14T02:30', 'America/New_York'));
    assert.throws(() => resolveLocalTime('2026-11-01T01:30', 'America/New_York'));
    assert.equal(
      resolveLocalTime('2026-11-01T01:30', 'America/New_York', 'earlier'),
      '2026-11-01T05:30:00.000Z',
    );
    assert.equal(
      resolveLocalTime('2026-11-01T01:30', 'America/New_York', 'later'),
      '2026-11-01T06:30:00.000Z',
    );
  });
  await check(
    'Default followup only reminder/internal draft; reschedule preserves history and rejects old jobs',
    async () => {
      const p = await plan(),
        old = await row('followups', p.id);
      assert.equal(old.outbound_request_id, null);
      const oldEvent = (
        await m.query('SELECT * FROM app.outbox_events WHERE aggregate_id=$1', [p.id])
      ).rows[0];
      const input = {
        ...old.plan_snapshot,
        followupId: p.id,
        expectedVersion: old.row_version,
        commandId: randomUUID(),
        localTime: new Date(Date.parse(old.due_at) + 60000).toISOString().slice(0, 16),
      };
      delete input.dueAt;
      delete input.businessVersion;
      delete input.stopConditions;
      const updated = await scope('sales', (c) => saveFollowup(c, boss, input, store));
      assert.equal(updated.businessVersion, '2');
      await consumeFollowupJob(worker, await jobData(oldEvent), oldEvent.pg_boss_job_id);
      assert.equal((await row('followups', p.id)).business_version, '2');
      assert.ok(
        (await scope('owner', (c) => d2Workspace(c))).followups.find((f) => f.id === p.id).history
          .length >= 3,
      );
    },
  );
  await check(
    'New reply/takeover/pause/closed/requirements/optout stop old automatic plans with explicit reasons',
    async () => {
      for (const reason of ['reply', 'takeover', 'pause', 'closed', 'requirements', 'optout']) {
        const p = await plan(contacts[0], { mode: 'approved_automatic' });
        await approveRequest(p.requestId);
        const f = await row('followups', p.id),
          t = await row('threads', contacts[0].threadId),
          o = await row('opportunities', f.opportunity_id);
        if (reason === 'reply')
          await m.query(
            'UPDATE app.threads SET context_revision=context_revision+1,last_inbound_at=clock_timestamp() WHERE id=$1',
            [t.id],
          );
        if (reason === 'takeover')
          await scope('sales', (c) => changeThreadControl(c, t.id, 'takeover', t.row_version));
        if (reason === 'pause')
          await scope('sales', (c) => setOutboundPause(c, t.id, t.row_version, true));
        if (reason === 'closed')
          await m.query("UPDATE app.opportunities SET stage='closed' WHERE id=$1", [o.id]);
        if (reason === 'requirements')
          await m.query(
            'UPDATE app.opportunities SET requirements_revision=requirements_revision+1 WHERE id=$1',
            [o.id],
          );
        if (reason === 'optout')
          await scope('sales', (c) => setSimulationPermission(c, contacts[0].pointId, false));
        await execute(p.requestId);
        assert.ok(
          ['blocked', 'cancelled'].includes((await row('outbound_requests', p.requestId)).state),
        );
        assert.equal((await row('followups', p.id)).state, 'cancelled');
        assert.ok((await row('followups', p.id)).stop_reason);
        await m.query(
          "UPDATE app.threads SET control_mode='assisted',takeover_member_id=NULL,outbound_paused=false WHERE id=$1",
          [t.id],
        );
        await m.query("UPDATE app.opportunities SET stage='clarifying' WHERE id=$1", [o.id]);
        if (reason === 'optout')
          await scope('owner', (c) => setSimulationPermission(c, contacts[0].pointId, true));
      }
    },
  );
  await check(
    'Current member/factory authorization rechecked by gateway; stale followup cannot regain authority',
    async () => {
      const p = await plan(contacts[0], { mode: 'approved_automatic' });
      await approveRequest(p.requestId);
      await m.query("UPDATE app.workspace_members SET status='disabled' WHERE id=$1", [
        users.sales.memberId,
      ]);
      await execute(p.requestId);
      assert.equal((await row('outbound_requests', p.requestId)).state, 'blocked');
      await m.query("UPDATE app.workspace_members SET status='active' WHERE id=$1", [
        users.sales.memberId,
      ]);
      await execute(p.requestId);
      assert.equal((await row('outbound_requests', p.requestId)).state, 'blocked');
      const manual = await plan();
      const e = (
        await m.query('SELECT * FROM app.outbox_events WHERE aggregate_id=$1', [manual.id])
      ).rows[0];
      await m.query('DELETE FROM app.factory_memberships WHERE member_id=$1 AND factory_id=$2', [
        users.sales.memberId,
        ids.a,
      ]);
      await consumeFollowupJob(worker, await jobData(e), e.pg_boss_job_id);
      assert.equal((await row('followups', manual.id)).stop_reason, 'ACTOR_NO_LONGER_AUTHORIZED');
      await m.query(
        'INSERT INTO app.factory_memberships(workspace_id,member_id,factory_id) VALUES($1,$2,$3)',
        [ids.ws, users.sales.memberId, ids.a],
      );
    },
  );
  await check(
    'Real worker stop -> due -> restart retains reminder and blocks changed plan',
    async () => {
      const unchanged = await plan(),
        changed = await plan(contacts[2]);
      const automatic = await plan(contacts[0], { mode: 'approved_automatic' });
      await approveRequest(automatic.requestId);
      const cp = dedicated();
      const started = await point(cp, 'working');
      const exit = await kill(cp);
      assert.equal(exit.signal, 'SIGKILL');
      const due = (await row('followups', unchanged.id)).due_at;
      await m.query('UPDATE app.threads SET context_revision=context_revision+1 WHERE id=$1', [
        contacts[2].threadId,
      ]);
      await sleep(Math.max(0, new Date(due).getTime() - Date.now() + 500));
      assert.equal((await row('followups', unchanged.id)).state, 'scheduled');
      const resumed = dedicated();
      await point(resumed, 'working');
      await until(
        async () =>
          ['ready'].includes((await row('followups', unchanged.id)).state) &&
          ['cancelled'].includes((await row('followups', changed.id)).state) &&
          (await row('outbound_requests', automatic.requestId)).state === 'simulated',
        'restart retained plans',
      );
      crashes.push({
        pid: cp.pid,
        started,
        exit,
        resumedPid: resumed.pid,
        due,
        unchanged: unchanged.id,
        changed: changed.id,
        reason: (await row('followups', changed.id)).stop_reason,
        automatic: {
          id: automatic.id,
          requestId: automatic.requestId,
          state: (await row('followups', automatic.id)).state,
        },
      });
      await kill(resumed);
    },
  );
  await check('Cancel failure/old job replay cannot restore stopped followup', async () => {
    const p = await plan(contacts[0], { mode: 'approved_automatic' });
    await approveRequest(p.requestId);
    const f = await row('followups', p.id);
    await scope('sales', (c) => cancelFollowup(c, p.id, f.row_version));
    const before = (await m.query('SELECT count(*)::int n FROM simulation.invocations')).rows[0].n;
    await execute(p.requestId);
    assert.equal((await row('outbound_requests', p.requestId)).state, 'cancelled');
    assert.equal(
      (await m.query('SELECT count(*)::int n FROM simulation.invocations')).rows[0].n,
      before,
    );
  });
  await check(
    'Claim cutoff and accepted-lost-response reuse C unknown/reconciliation',
    async () => {
      const b = await makeBatch([contacts[0]]);
      await scope('owner', async (c) => decideBatch(c, boss, b.id, await batchInput(b), store));
      const [id] = await batchRequests(b);
      await execute(id, {
        beforeClaim: async () => {
          await scope('owner', async (c) =>
            decideBatch(c, boss, b.id, await batchInput(b, 'revoke'), store),
          );
        },
      });
      assert.equal((await row('outbound_requests', id)).state, 'cancelled');
      await m.query('UPDATE app.channel_accounts SET configuration=$2 WHERE id=$1', [
        accounts[0],
        JSON.stringify({
          mock: { idempotent: false, guaranteeSeconds: 600, scenario: 'lost_response' },
        }),
      ]);
      const lost = await makeBatch([contacts[0]]);
      await scope('owner', async (c) =>
        decideBatch(c, boss, lost.id, await batchInput(lost), store),
      );
      const [rid] = await batchRequests(lost);
      await sleep(1100);
      await execute(rid);
      assert.equal((await row('outbound_requests', rid)).state, 'unknown');
      const r = await row('outbound_requests', rid);
      await scope('owner', (c) =>
        requestReconciliation(c, boss, rid, {
          commandId: randomUUID(),
          expectedVersion: r.row_version,
          action: 'lookup',
        }),
      );
      await execute(rid);
      assert.equal((await row('outbound_requests', rid)).state, 'simulated');
      assert.equal(
        (
          await m.query('SELECT count(*)::int n FROM simulation.invocations WHERE request_id=$1', [
            rid,
          ])
        ).rows[0].n,
        1,
      );
      await m.query('UPDATE app.channel_accounts SET configuration=$2 WHERE id=$1', [
        accounts[0],
        JSON.stringify({ mock: { idempotent: true, guaranteeSeconds: 600, scenario: 'normal' } }),
      ]);
    },
  );
  await check(
    'Live transport refused; all message and qualification records remain simulation',
    async () => {
      await assert.rejects(() =>
        m.query("UPDATE app.channel_accounts SET transport_mode='live' WHERE id=$1", [accounts[0]]),
      );
      assert.equal(
        (
          await m.query(
            "SELECT count(*)::int n FROM app.messages WHERE transport_mode<>'simulation' OR delivery_state IN('delivered','read')",
          )
        ).rows[0].n,
        0,
      );
    },
  );
  await check(
    'Actual raw inbound barrier and reply block old automatic actions; retry keeps original receipt identity',
    async () => {
      const p = await plan(contacts[0], { mode: 'approved_automatic' });
      await approveRequest(p.requestId);
      const input = {
        eventId: randomUUID(),
        providerMessageId: randomUUID(),
        identity: 'internal-demo:' + contacts[0].leadId,
        displayName: '内部演示身份',
        body: 'SIMULATION: a new reply',
        occurredAt: new Date().toISOString(),
        factoryId: ids.a,
      };
      const receipt = await scope('owner', (c) => injectSimulation(c, boss, input));
      await execute(p.requestId);
      assert.equal((await row('outbound_requests', p.requestId)).state, 'blocked');
      const e = (
        await m.query(
          "SELECT * FROM app.outbox_events WHERE aggregate_id=$1 AND handler_key='a2.inbound'",
          [receipt.receiptId],
        )
      ).rows[0];
      await consumeInboundJob(worker, { eventId: e.id, workspaceId: ids.ws }, e.pg_boss_job_id);
      assert.equal(
        (await row('inbound_events', receipt.receiptId)).normalized_thread_id,
        contacts[0].threadId,
      );
      const missing = await scope('owner', (c) =>
        injectSimulation(c, boss, {
          ...input,
          eventId: randomUUID(),
          providerMessageId: randomUUID(),
          identity: null,
        }),
      );
      const me = (
        await m.query(
          "SELECT * FROM app.outbox_events WHERE aggregate_id=$1 AND handler_key='a2.inbound'",
          [missing.receiptId],
        )
      ).rows[0];
      await consumeInboundJob(worker, { eventId: me.id, workspaceId: ids.ws }, me.pg_boss_job_id);
      assert.equal((await row('inbound_events', missing.receiptId)).state, 'dead');
      const retry = await scope('owner', (c) =>
        retryInboundReceipt(c, boss, missing.receiptId, randomUUID()),
      );
      await consumeInboundJob(worker, { eventId: retry.eventId, workspaceId: ids.ws }, retry.jobId);
      assert.equal((await row('inbound_events', missing.receiptId)).state, 'dead');
      // Keep this unresolved receipt on its own isolated account; do not clear a barrier.
      const extraAccount = randomUUID();
      await m.query(
        "INSERT INTO app.channel_accounts(id,workspace_id,channel_kind,transport_mode,provider,external_account_key,display_name,state) VALUES($1,$2,'simulation','simulation','zutrade-mock','d2-after-barrier','D2 isolated additional account','active')",
        [extraAccount, ids.ws],
      );
      accounts.push(extraAccount);
      const replacement = await scope('owner', (c) =>
        createSimulationContact(c, {
          commandId: randomUUID(),
          leadId: leads[0],
          accountId: extraAccount,
          simulationAuthorized: true,
        }),
      );
      contacts[0] = { ...replacement, leadId: leads[0] };
    },
  );
  await check(
    'Quote/PDF binding, changing quote and withdrawing facts block approved followups; internal notes never copied',
    async () => {
      const product = await scope('sales', (c) =>
        createProduct(c, {
          factoryId: ids.a,
          sku: 'D2-CT-01',
          name: 'D2 isolated cotton bag',
          unitCode: 'piece',
          configuration: { simulation: true },
        }),
      );
      const bytes = Buffer.from('SIMULATION D2 supplier terms USD2.40 + USD30.');
      const object = await store.putImmutable(bytes),
        validUntil = new Date(Date.now() + 30 * 86400000).toISOString();
      const source = await scope('sales', (c) =>
        createSource(c, product.id, {
          title: 'D2 isolated supply',
          kind: 'simulation',
          contentSha256: object.sha256,
          contentType: 'text/plain',
          contentSize: bytes.length,
          objectKey: object.key,
          extractedSnapshot: { simulation: true },
          validUntil,
        }),
      );
      const specs = {
        fabric: '12oz',
        dimensions: '35×40cm',
        color: 'Natural',
        printing: 'Single colour / single side logo',
      };
      await scope('owner', (c) =>
        publishPrice(c, product.id, {
          sourceVersionId: source.id,
          locator: 'D2 fixture terms',
          excerpt: bytes.toString(),
          scopeKey: 'default',
          qtyMin: '500',
          qtyMax: '1000',
          unitCode: 'piece',
          currencyCode: 'USD',
          unitPrice: '2.40',
          setupFee: '30',
          validUntil,
          value: {
            seller: { name: 'D2 simulated factory' },
            specifications: specs,
            production: {
              days: 20,
              dayKind: 'business',
              startConditions: 'After artwork/sample approval and deposit confirmation.',
            },
            discountBoundary: { basis: 'product_subtotal', maxPercent: '5' },
            sampleTerms: 'Samples quoted separately.',
            exclusions: ['Shipping excluded.', 'Taxes excluded.', 'No arrival promise.'],
            simulation: true,
          },
          applicability: specs,
        }),
      );
      const oId = (
        await m.query('SELECT opportunity_id FROM app.opportunity_threads WHERE thread_id=$1', [
          contacts[0].threadId,
        ])
      ).rows[0].opportunity_id;
      await scope('sales', async (c) =>
        saveRequirements(c, contacts[0].threadId, oId, {
          expectedVersion: (await row('opportunities', oId)).row_version,
          requirements: {
            productId: product.id,
            quantity: '500',
            unitCode: 'piece',
            specifications: specs,
            destination: 'GB',
            purpose: 'Internal simulation',
            requestedTiming: 'unconfirmed',
            language: 'en',
            pendingItems: [],
            internalNote: 'INTERNAL_D2_SECRET',
          },
        }),
      );
      const makeQuote = async (current) => {
        const q = await scope('sales', async (c) =>
          generateQuote(c, contacts[0].threadId, oId, {
            commandId: randomUUID(),
            expectedVersion: (await row('opportunities', oId)).row_version,
            expectedCurrentVersionId: current,
          }),
        );
        assert.ok(q.id);
        await scope('sales', (c) => generateQuotePdf(c, q.id, store));
        return q;
      };
      const q1 = await makeQuote(null),
        f1 = await plan(contacts[0], { mode: 'approved_automatic', quoteVersionId: q1.id });
      await approveRequest(f1.requestId);
      const payload1 = await row(
        'outbound_payload_versions',
        (await row('outbound_requests', f1.requestId)).current_payload_version_id,
      );
      assert.equal(payload1.attachment_manifest.length, 1);
      assert.equal(payload1.body_text.includes('INTERNAL_D2_SECRET'), false);
      assert.equal(payload1.body_text.includes('INTERNAL_DRAFT_MUST_NOT_LEAK'), false);
      const q2 = await makeQuote(q1.id);
      await execute(f1.requestId);
      assert.equal((await row('outbound_requests', f1.requestId)).state, 'blocked');
      const f2 = await plan(contacts[0], { mode: 'approved_automatic', quoteVersionId: q2.id });
      await approveRequest(f2.requestId);
      await scope('owner', (c) => withdrawSource(c, source.id, 'D2 isolated fact withdrawal'));
      await execute(f2.requestId);
      assert.equal((await row('outbound_requests', f2.requestId)).state, 'blocked');
      assert.ok((await row('followups', f2.id)).stop_reason);
    },
  );
  await check(
    'Human mode blocks automation but allows newly approved current manual reply; paused blocks new manual sending',
    async () => {
      const t = await row('threads', contacts[0].threadId);
      await scope('sales', (c) => changeThreadControl(c, t.id, 'takeover', t.row_version));
      await assert.rejects(() => plan(contacts[0], { mode: 'approved_automatic' }));
      const request = await scope('sales', async (c) =>
        prepareOutbound(
          c,
          {
            commandId: randomUUID(),
            contextRevision: (await row('threads', t.id)).context_revision,
            kind: 'human_reply',
            quoteVersionId: null,
            body: 'Owner-reviewed current manual reply in human mode.',
          },
          t.id,
          store,
        ),
      );
      await approveRequest(request.requestId);
      await execute(request.requestId);
      assert.equal((await row('outbound_requests', request.requestId)).state, 'simulated');
      const current = await row('threads', t.id);
      await scope('sales', (c) => setOutboundPause(c, t.id, current.row_version, true));
      const paused = await scope('sales', async (c) =>
        prepareOutbound(
          c,
          {
            commandId: randomUUID(),
            contextRevision: (await row('threads', t.id)).context_revision,
            kind: 'human_reply',
            quoteVersionId: null,
            body: 'This must remain blocked.',
          },
          t.id,
          store,
        ),
      );
      const result = await approveRequest(paused.requestId);
      assert.equal(result.state, 'invalidated');
      const after = await row('threads', t.id);
      await scope('sales', (c) => setOutboundPause(c, t.id, after.row_version, false));
      const latest = await row('threads', t.id);
      await scope('sales', (c) => changeThreadControl(c, t.id, 'release', latest.row_version));
      const live = spawnSync(process.execPath, ['apps/worker/dist/main.js'], {
        env: { ...env, CHANNEL_MODE: 'live' },
        encoding: 'utf8',
        timeout: 10000,
      });
      assert.notEqual(live.status, 0);
      assert.ok(live.stderr.includes('CHANNEL_MODE'));
    },
  );
  await check(
    'Two dedicated processes contend for same D2 request; only one claim/provider invocation',
    async () => {
      const b = await makeBatch([contacts[0]]);
      await scope('owner', async (c) => decideBatch(c, boss, b.id, await batchInput(b), store));
      const [rid] = await batchRequests(b),
        e = (await jobsForRequest(rid)).at(-1);
      await sleep(1100);
      const extra = {
        D2_JOB_ID: e.pg_boss_job_id,
        D2_JOB_DATA: JSON.stringify(await jobData(e)),
        D2_PAUSE: 'beforeClaim',
      };
      const first = dedicated(extra);
      await point(first, 'beforeClaim');
      const second = dedicated({ ...extra, D2_REPLAY: 'true' });
      await point(second, 'beforeClaim');
      first.send({ resume: true });
      second.send({ resume: true });
      await Promise.all([point(first, 'done'), point(second, 'done')]);
      assert.equal((await row('outbound_requests', rid)).state, 'simulated');
      assert.equal(
        (
          await m.query('SELECT count(*)::int n FROM simulation.invocations WHERE request_id=$1', [
            rid,
          ])
        ).rows[0].n,
        1,
      );
      crashes.push({
        kind: 'two-process-contention',
        jobId: e.pg_boss_job_id,
        requestId: rid,
        pids: [first.pid, second.pid],
        points: [...first.messages, ...second.messages],
      });
    },
  );
  await check(
    'Batch revocation after claim records cancel request and preserves unknown cutoff',
    async () => {
      const b = await makeBatch([contacts[1]]);
      await scope('owner', async (c) => decideBatch(c, boss, b.id, await batchInput(b), store));
      const [rid] = await batchRequests(b);
      await execute(rid, {
        afterClaim: () =>
          scope('owner', async (c) =>
            decideBatch(c, boss, b.id, await batchInput(b, 'revoke'), store),
          ),
      });
      const r = await row('outbound_requests', rid);
      assert.equal(r.state, 'unknown');
      assert.ok(r.cancel_requested_at);
      assert.equal(
        (
          await m.query('SELECT count(*)::int n FROM simulation.invocations WHERE request_id=$1', [
            rid,
          ])
        ).rows[0].n,
        0,
      );
    },
  );
  const ui = await makeBatch([contacts[0]]);
  const manual = await plan();
  writeFileSync(
    '.local/d2-test-last.json',
    JSON.stringify(
      { name, env, users, ids, contacts, accounts, leads, uiBatch: ui, manual },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  successful = true;
} finally {
  for (const cp of children) if (cp.exitCode === null && cp.signalCode === null) cp.kill('SIGTERM');
  if (boss) await boss.stop();
  if (wb) await wb.stop();
  await Promise.all([admin.end(), m.end(), api.end(), worker.end(), authPool.end()]);
  writeFileSync(
    evidence + '/integration.json',
    JSON.stringify(
      {
        observedAt: new Date().toISOString(),
        database: name,
        origin: 'offline_fixture',
        successful,
        checks,
        crashes,
      },
      null,
      2,
    ) + '\n',
  );
  const path = evidence + '/retained-test-databases.json';
  let previous = [];
  try {
    previous = JSON.parse(readFileSync(path));
  } catch {
    /* First retained run. */
  }
  previous.push({ name, successful, at: new Date().toISOString() });
  writeFileSync(path, JSON.stringify(previous, null, 2) + '\n');
}
