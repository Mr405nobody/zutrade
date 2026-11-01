import { expectedBusinessTableCount } from './business-table-expectations.mjs';
import assert from 'node:assert/strict';
import { loadEnvFile } from 'node:process';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import {
  pg,
  withWorkspace,
  transaction,
  createQueue,
  createAuth,
  createAuthPool,
} from '@zutrade/db';
import {
  createResearch,
  researchDetail,
  reviewCandidate,
  importCandidate,
  cancelResearch,
  consumeResearchJob,
} from '@zutrade/domain';
import { researchRequestSchema, importCandidateSchema } from '@zutrade/contracts';
import { FixtureResearchProvider, SafeResearchHttp } from '@zutrade/prospecting';
import { fixtureHooks } from './d1-fixture.mjs';
loadEnvFile('.env');
process.env.NODE_ENV = 'test';
const evidence = process.env.EVIDENCE_DIR ?? 'docs/build/evidence/d1';
mkdirSync(evidence, { recursive: true });
const name = 'zutrade_d1_test_' + randomUUID().replaceAll('-', '');
const env = {
  ...process.env,
  POSTGRES_DB: name,
  API_PORT: '3501',
  WORKER_PORT: '3502',
  WEB_PORT: '5373',
};
for (const k of [
  'DATABASE_URL',
  'MIGRATION_DATABASE_URL',
  'API_DATABASE_URL',
  'WORKER_DATABASE_URL',
  'AUTH_DATABASE_URL',
  'SIMULATION_DATABASE_URL',
]) {
  const u = new URL(process.env[k]);
  u.pathname = '/' + name;
  env[k] = u.href;
}
const adminUrl = new URL(process.env.DATABASE_URL);
adminUrl.username = process.env.POSTGRES_USER;
adminUrl.password = process.env.POSTGRES_PASSWORD;
const admin = new pg.Pool({ connectionString: adminUrl.href }),
  m = new pg.Pool({ connectionString: env.MIGRATION_DATABASE_URL }),
  api = new pg.Pool({ connectionString: env.API_DATABASE_URL, max: 12 }),
  worker = new pg.Pool({ connectionString: env.WORKER_DATABASE_URL, max: 8 });
const authPool = createAuthPool(env.MIGRATION_DATABASE_URL);
let boss, wb;
const children = [];
const checks = [],
  crashes = [];
const users = {};
const ids = {
  ws: randomUUID(),
  other: randomUUID(),
  a: randomUUID(),
  b: randomUUID(),
  product: randomUUID(),
};
const brave = { storageRights: false };
const scope = (role, fn, workspace = ids.ws) =>
  withWorkspace(api, { id: users[role].subject, name: role }, workspace, fn);
const row = async (id) =>
  (await m.query('SELECT * FROM app.prospecting_runs WHERE id=$1', [id])).rows[0];
const input = (extra = {}) =>
  researchRequestSchema.parse({
    commandId: randomUUID(),
    factoryId: ids.a,
    provider: 'public_directory',
    directoryId: 'wikimedia-events-sg',
    country: 'SG',
    limit: 3,
    ...extra,
  });
async function create(extra = {}, role = 'sales') {
  return scope(role, (c) => createResearch(c, boss, input(extra), brave));
}
async function check(label, fn) {
  await fn();
  checks.push({ label, result: 'passed' });
  console.log('PASS ' + label);
}
function command(path) {
  const r = spawnSync(process.execPath, [path], { env, encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) throw new Error(`${path}: ${r.stderr.slice(0, 1000)}`);
  return r.stdout;
}
async function fetchJob(id) {
  for (let i = 0; i < 100; i++) {
    const j = (await wb.fetch('d1.research', { batchSize: 100 })).find((j) => j.id === id);
    if (j) return j;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('Queue fetch timeout');
}
async function consume(r, mode = 'normal', hooks = {}) {
  const j = await fetchJob(r.jobId);
  await consumeResearchJob(worker, j.data, j.id, brave, { ...fixtureHooks(mode), ...hooks });
  await wb.complete('d1.research', j);
  return row(r.runId);
}
async function detail(id) {
  return scope('sales', (c) => researchDetail(c, id));
}
async function keep(id, key, decision = 'keep', revision) {
  const r = await row(id);
  return scope('sales', (c) =>
    reviewCandidate(c, id, {
      candidateKey: key,
      resultVersion: r.result_version,
      reviewRevision: revision ?? r.review_revision,
      decision,
      reason: 'Offline test: reviewed fictional source and entity identity',
    }),
  );
}
async function importOne(id, key, extra = {}) {
  const r = await row(id);
  return scope('sales', (c) =>
    importCandidate(c, id, {
      commandId: randomUUID(),
      candidateKey: key,
      resultVersion: r.result_version,
      reviewRevision: r.review_revision,
      buyerId: null,
      identityConfirmed: true,
      ...extra,
    }),
  );
}
async function counts() {
  return (
    await m.query(
      'SELECT (SELECT count(*) FROM app.buyers)::int buyers,(SELECT count(*) FROM app.contacts)::int contacts,(SELECT count(*) FROM app.leads)::int leads,(SELECT count(*) FROM app.prospecting_runs)::int runs,(SELECT count(*) FROM app.outbox_events)::int events,(SELECT count(*) FROM pgboss.job)::int jobs',
    )
  ).rows[0];
}
function child(r, pause, replay = false) {
  const cp = spawn(process.execPath, ['scripts/d1-test-worker.mjs'], {
    env: {
      ...env,
      D1_JOB_ID: r.jobId,
      D1_JOB_DATA: JSON.stringify(r.data),
      D1_PAUSE: pause ?? '',
      D1_REPLAY: String(replay),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  cp.messages = [];
  cp.output = '';
  cp.stdout.on('data', (b) => (cp.output += b));
  cp.stderr.on('data', (b) => (cp.output += b));
  cp.on('message', (v) => cp.messages.push(v));
  children.push(cp);
  return cp;
}
async function point(cp, name) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const p = cp.messages.find((p) => p.point === name);
    if (p) return p;
    if (cp.exitCode !== null || cp.signalCode !== null)
      throw new Error('Worker exited: ' + cp.output);
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Worker IPC timeout: ' + name + ' ' + cp.output);
}
async function kill(cp) {
  const done = new Promise((r) => cp.once('exit', (code, signal) => r({ code, signal })));
  cp.kill('SIGKILL');
  return done;
}
let successful = false;
try {
  await admin.query(`CREATE DATABASE "${name}"`);
  command('scripts/db-provision.mjs');
  command('scripts/db-migrate.mjs');
  const auth = createAuth(authPool, env.BETTER_AUTH_SECRET, 5373, 3501, true);
  for (const role of ['owner', 'sales', 'outside']) {
    const password = randomBytes(24).toString('hex'),
      email = role + '@d1.test';
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
      "INSERT INTO app.workspaces(id,name) VALUES($1,'D1 offline isolated'),($2,'D1 other isolated')",
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
          role === 'owner' ? 'owner' : 'sales',
          role === 'owner',
        ],
      );
    }
    await c.query(
      "INSERT INTO app.factories(id,workspace_id,name,factory_code,status) VALUES($1,$3,'D1 simulated factory A','D1-A','active'),($2,$3,'D1 simulated factory B','D1-B','active')",
      [ids.a, ids.b, ids.ws],
    );
    await c.query(
      'INSERT INTO app.factory_memberships(workspace_id,factory_id,member_id) VALUES($1,$2,$3)',
      [ids.ws, ids.a, users.sales.memberId],
    );
  });
  boss = createQueue(env.API_DATABASE_URL);
  await m.query(
    "INSERT INTO app.products(id,workspace_id,factory_id,sku,name,state) VALUES($1,$2,$3,'D1-TEST','D1 simulated product','active')",
    [ids.product, ids.ws, ids.a],
  );
  wb = createQueue(env.WORKER_DATABASE_URL);
  await boss.start();
  await wb.start();
  await check(
    'research table retained alongside later additive tables, RLS and restricted roles',
    async () => {
      assert.equal(
        (await m.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='app'")).rows[0].n,
        expectedBusinessTableCount,
      );
      const r = (
        await m.query(
          "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='app.prospecting_runs'::regclass",
        )
      ).rows[0];
      assert.deepEqual(r, { relrowsecurity: true, relforcerowsecurity: true });
      for (const p of [api, worker]) {
        const r = (
          await p.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')
        ).rows[0];
        assert.deepEqual(r, { rolsuper: false, rolbypassrls: false });
      }
    },
  );
  await check('business + outbox + real pg-boss rollback, three failure points', async () => {
    for (const failure of ['business', 'outbox', 'enqueue']) {
      const before = await counts();
      await assert.rejects(() =>
        scope('sales', (c) => createResearch(c, boss, input(), brave, failure)),
      );
      assert.deepEqual(await counts(), before);
    }
  });
  let r;
  await check(
    'request idempotency, strict input, factory and workspace authorization',
    async () => {
      const i = input({ productId: ids.product });
      r = await scope('sales', (c) => createResearch(c, boss, i, brave));
      assert.deepEqual(await scope('sales', (c) => createResearch(c, boss, i, brave)), r);
      await assert.rejects(
        () => scope('sales', (c) => createResearch(c, boss, { ...i, limit: 2 }, brave)),
        /内容不一致/,
      );
      await assert.rejects(() => create({ factoryId: ids.b }));
      await assert.rejects(() => scope('outside', (c) => researchDetail(c, r.runId), ids.other));
      assert.equal(
        importCandidateSchema.safeParse({
          commandId: randomUUID(),
          candidateKey: 'a'.repeat(64),
          resultVersion: 1,
          reviewRevision: '0',
          identityConfirmed: true,
          name: 'tampered',
        }).success,
        false,
      );
      await assert.rejects(() => create({ provider: 'brave_search' }), /未配置/);
    },
  );
  await check(
    'offline directory discovers links, follows entities and websites, bounded evidence',
    async () => {
      const result = await consume(r);
      assert.equal(result.state, 'completed');
      assert.equal(result.data_origin, 'offline_fixture');
      assert.equal(result.candidate_count, 3);
      assert.equal(result.request_count, 10);
      const c = result.results_snapshot.candidates[0];
      assert.equal(c.country, 'SG');
      assert(c.website.includes('?company='));
      assert.equal(
        c.evidence.filter((e) => e.kind === 'official_website' && e.status === 'read').length,
        1,
      );
      assert(c.evidence.every((e) => e.sha256 && e.hashScope === 'decoded_response_body'));
      assert(c.reasons.every((v) => c.evidence.some((e) => e.id === v.evidenceId)));
    },
  );
  const candidate = (await row(r.runId)).results_snapshot.candidates[0];
  await check(
    'tampered candidate, old result and review versions, excluded import reject',
    async () => {
      await assert.rejects(() => importOne(r.runId, 'a'.repeat(64)));
      await assert.rejects(() => importOne(r.runId, candidate.key, { resultVersion: 2 }));
      await keep(r.runId, candidate.key);
      const rev = (await row(r.runId)).review_revision;
      await keep(r.runId, candidate.key, 'exclude');
      await assert.rejects(
        () => importOne(r.runId, candidate.key, { reviewRevision: rev }),
        /审核版本/,
      );
      await assert.rejects(() => importOne(r.runId, candidate.key), /排除/);
      await assert.rejects(() => keep(r.runId, candidate.key, 'keep', rev), /审核版本/);
    },
  );
  let imported;
  await check('concurrent repeated import returns one lead, no orphan buyer/contact', async () => {
    await keep(r.runId, candidate.key);
    const before = await counts();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => importOne(r.runId, candidate.key)),
    );
    assert.equal(new Set(results.map((r) => r.leadId)).size, 1);
    const after = await counts();
    assert.equal(after.buyers, before.buyers + 1);
    assert.equal(after.contacts, before.contacts);
    assert.equal(after.leads, before.leads + 1);
    imported = results[0];
    const lead = (await m.query('SELECT * FROM app.leads WHERE id=$1', [imported.leadId])).rows[0];
    assert.equal(lead.research_snapshot.contactPermission, 'unknown');
    assert.equal(lead.primary_contact_id, null);
    assert.equal((await m.query('SELECT count(*)::int n FROM app.contact_points')).rows[0].n, 0);
    assert.equal((await m.query('SELECT count(*)::int n FROM app.facts')).rows[0].n, 0);
  });
  let repeated;
  await check(
    'cross-run duplicates are suggestions, explicit buyer link; old evidence retained',
    async () => {
      const original = JSON.stringify((await row(r.runId)).results_snapshot);
      repeated = await create();
      await consume(repeated);
      const d = await detail(repeated.runId);
      assert.equal(d.duplicates[candidate.key][0].id, imported.buyerId);
      await keep(repeated.runId, candidate.key);
      const second = await importOne(repeated.runId, candidate.key, { buyerId: imported.buyerId });
      assert.equal(second.buyerId, imported.buyerId);
      assert.notEqual(second.leadId, imported.leadId);
      assert.equal(JSON.stringify((await row(r.runId)).results_snapshot), original);
    },
  );
  await check(
    'terminal snapshot and imported historical evidence SQL freeze, audit and composite FK',
    async () => {
      for (const [sql, params] of [
        ["UPDATE app.prospecting_runs SET results_snapshot='{}' WHERE id=$1", [r.runId]],
        ["UPDATE app.leads SET research_snapshot='{}' WHERE id=$1", [imported.leadId]],
        ['UPDATE app.leads SET factory_id=$2 WHERE id=$1', [imported.leadId, ids.b]],
      ])
        await assert.rejects(() => m.query(sql, params));
      assert(
        (
          await m.query(
            "SELECT count(*)::int n FROM app.audit_events WHERE action='d1.candidate-reviewed'",
          )
        ).rows[0].n >= 3,
      );
      assert.equal((await api.query('SELECT * FROM app.prospecting_runs')).rowCount, 0);
    },
  );
  await check('zero results, denied source, partial success, 429 and retries', async () => {
    for (const [mode, state, count] of [
      ['zero', 'completed', 0],
      ['denied', 'failed', 0],
      ['partial', 'partial', 3],
      ['rate', 'failed', 0],
    ]) {
      const x = await create();
      const result = await consume(x, mode);
      assert.equal(result.state, state, mode);
      assert.equal(result.candidate_count, count, mode);
      if (mode === 'rate') {
        assert.equal(result.error, 'HTTP_429');
        assert.equal(result.request_count, 1);
      }
    }
  });
  await check(
    'cancel before and during execution fences further request/result writes',
    async () => {
      const x = await create();
      await scope('sales', (c) => cancelResearch(c, x.runId));
      await consume(x);
      assert.equal((await row(x.runId)).request_count, 0);
      const y = await create();
      await consume(y, 'normal', {
        afterCheckpoint: async (cp) => {
          if (cp.cursor === 1) await scope('sales', (c) => cancelResearch(c, y.runId));
        },
      });
      const result = await row(y.runId);
      assert.equal(result.state, 'cancelled');
      assert.equal(result.candidate_count, 1);
      assert.equal(result.request_count, 4);
    },
  );
  await check('80 request budget atomically persists and never resets', async () => {
    const x = await create();
    await consume(x, 'normal', {
      provider: new FixtureResearchProvider(async (c) => {
        for (let i = 0; i < 81; i++) await c.http.get('https://budget.example.org/');
        return c.checkpoint.snapshot;
      }),
    });
    assert.equal((await row(x.runId)).request_count, 80);
    assert.equal((await row(x.runId)).error, 'REQUEST_BUDGET_EXHAUSTED');
    assert.equal((await row(x.runId)).state, 'failed');
  });
  await check(
    'SIGKILL + real queue retry resumes checkpoint with original deadline and counter',
    async () => {
      const x = await create();
      const job = (await m.query('SELECT data FROM pgboss.job WHERE id=$1', [x.jobId])).rows[0];
      x.data = job.data;
      const cp = child(x, 'checkpoint');
      const before = await point(cp, 'checkpoint');
      const original = await row(x.runId);
      assert.equal(original.request_count, 4);
      const exit = await kill(cp);
      assert.equal(exit.signal, 'SIGKILL');
      await wb.fail('d1.research', x.jobId, { reason: 'actual dedicated test worker SIGKILL' });
      const restored = child(x);
      const afterClaim = await point(restored, 'claimed');
      await point(restored, 'done');
      const restoredRow = await row(x.runId);
      assert.equal(restoredRow.deadline.toISOString(), original.deadline.toISOString());
      assert.equal(afterClaim.requests, 4);
      assert.equal(restoredRow.request_count, 10);
      assert.equal(restoredRow.execution_version, 2);
      assert.equal(restoredRow.candidate_count, 3);
      crashes.push({
        before,
        exit,
        recovery: afterClaim,
        deadline: restoredRow.deadline,
        originalRequests: 4,
        finalRequests: 10,
        checkpointCursor: 1,
        jobId: x.jobId,
      });
    },
  );
  await check('old active executor cannot overwrite a replacement execution', async () => {
    const x = await create();
    x.data = (await m.query('SELECT data FROM pgboss.job WHERE id=$1', [x.jobId])).rows[0].data;
    const old = child(x, 'checkpoint');
    await point(old, 'checkpoint');
    const original = await row(x.runId);
    await wb.fail('d1.research', x.jobId, { reason: 'explicit same-job retry for fencing test' });
    const fresh = child(x);
    await point(fresh, 'done');
    const frozen = await row(x.runId);
    old.send({ resume: true });
    await point(old, 'done');
    const final = await row(x.runId);
    assert.equal(JSON.stringify(final.results_snapshot), JSON.stringify(frozen.results_snapshot));
    assert.equal(final.request_count, 10);
    assert.notEqual(final.execution_token, original.execution_token);
  });
  await check(
    'actor revocation stops a queued research without escalating runtime privileges',
    async () => {
      const x = await create();
      await m.query("UPDATE app.workspace_members SET status='disabled' WHERE id=$1", [
        users.sales.memberId,
      ]);
      await consume(x);
      assert.equal((await row(x.runId)).error, 'ACTOR_NO_LONGER_AUTHORIZED');
      await m.query("UPDATE app.workspace_members SET status='active' WHERE id=$1", [
        users.sales.memberId,
      ]);
    },
  );
  await check(
    'DB fixed deadline rejects expired checkpoint/results, no renewed budget',
    async () => {
      const x = await create();
      const expired = new Date(Date.now() - 240000);
      await m.query(
        "UPDATE app.prospecting_runs SET state='running',first_started_at=$2,deadline=$2::timestamptz+interval '180 seconds',execution_token=$3,execution_version=1 WHERE id=$1",
        [x.runId, expired, randomUUID()],
      );
      await consume(x);
      assert.equal((await row(x.runId)).state, 'failed');
      assert.equal((await row(x.runId)).error, 'RUN_DEADLINE');
      assert.equal((await row(x.runId)).request_count, 0);
    },
  );
  // Persist only local credentials and environment, excluded by .gitignore.
  await check(
    'database network gates enforce one/host and two/global across independent pools',
    async () => {
      for (const sameHost of [true, false]) {
        const created = await Promise.all([create(), create(), create()]);
        const jobs = await wb.fetch('d1.research', { batchSize: 100 });
        let active = 0,
          peak = 0;
        await Promise.all(
          created.map(async (x, index) => {
            const pool = new pg.Pool({ connectionString: env.WORKER_DATABASE_URL, max: 3 });
            const job = jobs.find((j) => j.id === x.jobId);
            assert(job);
            try {
              await consumeResearchJob(pool, job.data, job.id, brave, {
                provider: new FixtureResearchProvider(async (c) => {
                  await c.http.get(
                    `https://${sameHost ? 'same' : 'different-' + index}.example.org/`,
                  );
                  return c.checkpoint.snapshot;
                }),
                http: (budget) =>
                  new SafeResearchHttp(
                    budget,
                    async () => [{ address: '8.8.8.8', family: 4 }],
                    async () => {
                      active++;
                      peak = Math.max(active, peak);
                      await new Promise((r) => setTimeout(r, 80));
                      active--;
                      return {
                        status: 200,
                        headers: { 'content-type': 'text/plain' },
                        body: Buffer.from('offline'),
                      };
                    },
                  ),
              });
              await wb.complete('d1.research', job);
            } finally {
              await pool.end();
            }
          }),
        );
        assert.equal(peak, sameHost ? 1 : 2);
        for (const x of created) assert.equal((await row(x.runId)).request_count, 1);
      }
    },
  );
  writeFileSync(
    process.env.D1_TEST_POINTER ?? '.local/d1-test-last.json',
    JSON.stringify(
      { name, env, users, ids, runId: r.runId, repeatedRunId: repeated.runId },
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
  const p = evidence + '/retained-test-databases.json';
  let history = [];
  try {
    history = JSON.parse(readFileSync(p));
  } catch {
    // First run has no retained database list.
  }
  history.push({ name, successful, at: new Date().toISOString() });
  writeFileSync(p, JSON.stringify(history, null, 2) + '\n');
}
