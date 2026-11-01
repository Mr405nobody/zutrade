import assert from 'node:assert/strict';
import { loadEnvFile } from 'node:process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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
  createOutbound,
  createResearch,
  cancelResearch,
  outboundDashboard,
  outboundCompanyDetail,
  reviewOutboundCompany,
  consumeResearchJob,
} from '@zutrade/domain';
import { researchRequestSchema } from '@zutrade/contracts';
import {
  FixtureResearchProvider,
  OutboundManualProvider,
  SafeResearchHttp,
} from '@zutrade/prospecting';
loadEnvFile('.env');
process.env.NODE_ENV = 'test';
const evidence = 'docs/build/evidence/outbound';
mkdirSync(evidence, { recursive: true });
const name = 'zutrade_outbound_test_' + randomUUID().replaceAll('-', '');
const env = {
  ...process.env,
  POSTGRES_DB: name,
  API_PORT: '4201',
  WORKER_PORT: '4202',
  WEB_PORT: '5773',
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
  api = new pg.Pool({ connectionString: env.API_DATABASE_URL }),
  worker = new pg.Pool({ connectionString: env.WORKER_DATABASE_URL });
const authPool = createAuthPool(env.MIGRATION_DATABASE_URL);
const users = {},
  ids = { ws: randomUUID(), other: randomUUID(), a: randomUUID(), b: randomUUID() };
const checks = [];
let successful = false,
  boss,
  wb;
const scope = (role, fn, w = ids.ws) =>
  withWorkspace(api, { id: users[role].subject, name: role }, w, fn);
const input = (extra = {}) => ({
  commandId: randomUUID(),
  factoryId: ids.a,
  product: 'Industrial Fasteners',
  country: 'US',
  buyerType: 'Distributor',
  limit: 20,
  mode: 'manual',
  websiteUrls: ['https://example.com/about?utm_source=test', 'https://www.example.com/'],
  permissionAcknowledged: true,
  ...extra,
});
const row = async (id) =>
  (await m.query('SELECT * FROM app.prospecting_runs WHERE id=$1', [id])).rows[0];
const calls = [];
function mockHttp(budget) {
  return new SafeResearchHttp(
    budget,
    async () => [{ address: '8.8.8.8', family: 4 }],
    async (url) => {
      calls.push(url.href);
      if (url.hostname === 'denied.example.com')
        return {
          status: 200,
          headers: { 'content-type': 'text/plain' },
          body: Buffer.from('User-agent: *\nDisallow: /'),
        };
      if (url.pathname === '/robots.txt')
        return {
          status: 200,
          headers: { 'content-type': 'text/plain' },
          body: Buffer.from('User-agent: *\nAllow: /\nCrawl-delay: 1'),
        };
      if (url.hostname === 'failed.example.com')
        return {
          status: 503,
          headers: { 'content-type': 'text/plain' },
          body: Buffer.from('Unavailable'),
        };
      const body = `<html><head><title>OFFLINE FICTIONAL FIXTURE ONLY</title><script type="application/ld+json">{"@type":"Organization","name":"Fictional Offline Fastener Fixture","address":{"streetAddress":"123 Test Lane","addressCountry":"United States"}}</script><meta name="description" content="Fictional offline industrial fasteners distributor fixture"></head><body>Offline test data only. Industrial fasteners distributor, nuts and bolts for industrial supply. Not a real business or procurement record.<a href="/about">About Us</a><a href="/products">Products</a><a href="/contact">Contact</a></body></html>`;
      return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(body) };
    },
  );
}
async function consume(r, offline = true) {
  const jobs = await wb.fetch('d1.research', { batchSize: 100 });
  const j = jobs.find((j) => j.id === r.jobId);
  assert(j);
  await consumeResearchJob(
    worker,
    j.data,
    j.id,
    { storageRights: false },
    offline
      ? {
          provider: new FixtureResearchProvider((ctx) => new OutboundManualProvider().run(ctx)),
          http: mockHttp,
        }
      : {},
  );
  await wb.complete('d1.research', j);
  return row(r.runId);
}
async function check(label, fn) {
  await fn();
  checks.push({ label, result: 'passed' });
  console.log('PASS ' + label);
}
function command(path, overrides = {}) {
  const r = spawnSync(process.execPath, [path], {
    env: { ...env, ...overrides },
    encoding: 'utf8',
    timeout: 90000,
  });
  if (r.status !== 0) throw new Error(path + ': ' + r.stderr.slice(0, 1500));
  return r.stdout;
}
try {
  await admin.query(`CREATE DATABASE "${name}"`);
  command('scripts/db-provision.mjs');
  command('scripts/db-migrate.mjs');
  const auth = createAuth(authPool, env.BETTER_AUTH_SECRET, 5773, 4201, true);
  for (const role of ['owner', 'sales', 'outside']) {
    const email = role + '@outbound.test',
      password = randomBytes(24).toString('hex');
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
      "INSERT INTO app.workspaces(id,name) VALUES($1,'Outbound OFFLINE isolated'),($2,'Outbound other isolated')",
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
      "INSERT INTO app.factories(id,workspace_id,name,factory_code,status) VALUES($1,$3,'Outbound simulated factory A','OUT-A','active'),($2,$3,'Outbound simulated factory B','OUT-B','active')",
      [ids.a, ids.b, ids.ws],
    );
    await c.query(
      'INSERT INTO app.factory_memberships(workspace_id,factory_id,member_id) VALUES($1,$2,$3)',
      [ids.ws, ids.a, users.sales.memberId],
    );
  });
  boss = createQueue(env.API_DATABASE_URL);
  wb = createQueue(env.WORKER_DATABASE_URL);
  await boss.start();
  await wb.start();
  await check('incremental migration repeat, RLS, restricted roles and catalog map', async () => {
    command('scripts/db-migrate.mjs');
    const flags = (
      await m.query(
        "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='app.outbound_companies'::regclass",
      )
    ).rows[0];
    assert.deepEqual(flags, { relrowsecurity: true, relforcerowsecurity: true });
    for (const p of [api, worker])
      assert.deepEqual(
        (await p.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user'))
          .rows[0],
        { rolsuper: false, rolbypassrls: false },
      );
    assert.equal(
      (
        await m.query(
          "SELECT count(*)::int n FROM pg_tables WHERE schemaname='app' AND tablename='outbound_companies'",
        )
      ).rows[0].n,
      1,
    );
  });
  let r;
  await check('manual task identity, permission, safe URL and factory authorization', async () => {
    await assert.rejects(() =>
      scope('sales', (c) => createOutbound(c, boss, input({ permissionAcknowledged: false }))),
    );
    await assert.rejects(
      () =>
        scope('sales', (c) =>
          createOutbound(c, boss, input({ websiteUrls: ['http://169.254.169.254/'] })),
        ),
      /不安全/,
    );
    await assert.rejects(() =>
      scope('sales', (c) => createOutbound(c, boss, input({ factoryId: ids.b }))),
    );
    const i = input();
    r = await scope('sales', (c) => createOutbound(c, boss, i));
    assert.deepEqual(await scope('sales', (c) => createOutbound(c, boss, i)), r);
    await assert.rejects(
      () => scope('sales', (c) => createOutbound(c, boss, { ...i, limit: 2 })),
      /内容不一致/,
    );
  });
  await check(
    'actual pg-boss + offline-injected HTTP: homepage/about/products/contact, domain dedup, evidence',
    async () => {
      const result = await consume(r);
      assert.equal(result.state, 'completed');
      assert.equal(result.data_origin, 'offline_fixture');
      assert.equal(result.candidate_count, 1);
      assert.equal(result.request_count, 5);
      assert.equal(calls.length, 5);
      const candidate = result.results_snapshot.candidates[0];
      assert.equal(candidate.evidence.length, 4);
      assert(candidate.evidence.every((e) => e.extractorVersion === 'outbound-static-v1'));
      assert.equal(candidate.country, 'US');
      assert(candidate.profile.publicContact);
      const dashboard = await scope('sales', outboundDashboard);
      assert.equal(dashboard.companies.length, 1);
      ids.company = dashboard.companies[0].id;
      ids.run = r.runId;
      const detail = await scope('sales', (c) => outboundCompanyDetail(c, ids.company));
      assert.equal(detail.report.generator, 'rules');
      assert(detail.report.unknowns.includes('未进行独立注册核验'));
      assert.equal(detail.company.review_status, 'pending');
    },
  );
  await check(
    'repeated run does not duplicate company or overwrite source/review; source snapshot immutable',
    async () => {
      const second = await scope('sales', (c) => createOutbound(c, boss, input()));
      await consume(second);
      assert.equal((await scope('sales', outboundDashboard)).companies.length, 1);
      assert.equal(
        (await scope('sales', (c) => outboundCompanyDetail(c, ids.company))).company.run_id,
        r.runId,
      );
      await assert.rejects(() =>
        m.query("UPDATE app.prospecting_runs SET results_snapshot='{}' WHERE id=$1", [r.runId]),
      );
      await assert.rejects(() =>
        scope('sales', (c) =>
          c.client.query('UPDATE app.outbound_companies SET name=$1 WHERE id=$2', [
            'tampered',
            ids.company,
          ]),
        ),
      );
    },
  );
  const review = (revision, status = 'approved') => ({
    revision,
    status,
    notes: 'OFFLINE test: manual source reviewed, registration remains unknown',
    corrections: {
      name: 'Human corrected fictional fixture',
      country: '',
      address: '',
      business: '',
      buyerType: '',
      sourceUrl: 'https://example.com/',
    },
  });
  await check(
    'review CAS, actor/time, corrections separate from raw evidence, append-only audit, refresh persistence',
    async () => {
      const results = await Promise.allSettled([
        scope('sales', (c) => reviewOutboundCompany(c, ids.company, review('0'))),
        scope('sales', (c) => reviewOutboundCompany(c, ids.company, review('0', 'rejected'))),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      let d = await scope('sales', (c) => outboundCompanyDetail(c, ids.company));
      assert.equal(d.company.revision, '1');
      assert.equal(d.history.length, 1);
      assert.equal(d.company.reviewed_by, users.sales.memberId);
      assert(d.company.reviewed_at);
      assert.equal(d.candidate.name, 'Fictional Offline Fastener Fixture');
      assert.equal(d.company.corrections.name, 'Human corrected fictional fixture');
      for (const state of ['needs_info', 'rejected', 'approved']) {
        d = await scope('owner', (c) =>
          reviewOutboundCompany(c, ids.company, review(d.company.revision, state)),
        );
        assert.equal(d.company.review_status, state);
      }
      assert.equal(d.history.length, 4);
      await assert.rejects(() =>
        m.query('DELETE FROM app.audit_events WHERE aggregate_id=$1', [ids.company]),
      );
      const fresh = new pg.Pool({ connectionString: env.API_DATABASE_URL });
      try {
        assert.equal(
          (
            await withWorkspace(fresh, { id: users.sales.subject, name: 'sales' }, ids.ws, (c) =>
              outboundCompanyDetail(c, ids.company),
            )
          ).company.review_status,
          'approved',
        );
      } finally {
        await fresh.end();
      }
    },
  );
  await check(
    'cross-workspace, hidden-factory and revoked membership cannot read/review',
    async () => {
      await assert.rejects(() =>
        scope('outside', (c) => outboundCompanyDetail(c, ids.company), ids.other),
      );
      const hidden = await scope('owner', (c) =>
        createOutbound(c, boss, input({ factoryId: ids.b })),
      );
      await consume(hidden);
      const hiddenCompany = (await scope('owner', outboundDashboard)).companies.find(
        (c) => c.factory_id === ids.b,
      );
      assert(hiddenCompany);
      await assert.rejects(() => scope('sales', (c) => outboundCompanyDetail(c, hiddenCompany.id)));
      await m.query("UPDATE app.workspace_members SET status='disabled' WHERE id=$1", [
        users.sales.memberId,
      ]);
      await assert.rejects(() =>
        scope('sales', (c) => reviewOutboundCompany(c, ids.company, review('4'))),
      );
      await m.query("UPDATE app.workspace_members SET status='active' WHERE id=$1", [
        users.sales.memberId,
      ]);
    },
  );
  await check(
    'robots refusal and HTTP failure stay source feedback; no invented companies/risks',
    async () => {
      const failure = await scope('sales', (c) =>
        createOutbound(
          c,
          boss,
          input({ websiteUrls: ['https://denied.example.com/', 'https://failed.example.com/'] }),
        ),
      );
      const result = await consume(failure);
      assert.equal(result.candidate_count, 0);
      assert.equal(result.state, 'failed');
      assert(result.results_snapshot.errors.some((e) => e.code === 'ROBOTS_DISALLOWED'));
      assert(result.results_snapshot.errors.some((e) => e.code === 'HTTP_503'));
      assert(!calls.some((s) => s === 'https://denied.example.com/'));
    },
  );
  await check('automatic unavailable is a persisted failed task with no requests', async () => {
    const auto = await scope('sales', (c) =>
      createOutbound(c, boss, input({ mode: 'automatic', websiteUrls: [] })),
    );
    const result = await consume(auto, false);
    assert.equal(result.state, 'failed');
    assert.equal(result.error, 'AUTOMATIC_SEARCH_UNAVAILABLE');
    assert.equal(result.request_count, 0);
  });
  await check(
    'real official URL network attempt preserves SSRF and truthful failure/success evidence',
    async () => {
      const live = await scope('sales', (c) =>
        createOutbound(c, boss, input({ websiteUrls: ['https://www.fastenal.com/'] })),
      );
      const result = await consume(live, false);
      ids.liveRun = live.runId;
      writeFileSync(
        evidence + '/live-attempt.json',
        JSON.stringify(
          {
            at: new Date().toISOString(),
            state: result.state,
            origin: result.data_origin,
            requestCount: result.request_count,
            candidates: result.candidate_count,
            errors: result.results_snapshot.errors,
          },
          null,
          2,
        ) + '\n',
      );
      assert.equal(result.data_origin, 'live_network');
      if (result.state === 'failed') assert(result.results_snapshot.errors.length > 0);
    },
  );
  await check(
    'legacy D1 request and idempotency digest remain compatible after additive fields',
    async () => {
      const legacy = {
        commandId: randomUUID(),
        factoryId: ids.a,
        productId: null,
        provider: 'public_directory',
        directoryId: 'wikimedia-events-sg',
        country: 'SG',
        buyerType: 'event management',
        keywords: ['events', 'promotional'],
        exclusions: [],
        limit: 3,
      };
      const created = await scope('sales', (c) =>
        createResearch(c, boss, researchRequestSchema.parse(legacy), { storageRights: false }),
      );
      const persisted = await row(created.runId);
      assert.deepEqual(persisted.request, legacy);
      assert.equal(
        persisted.request_sha256,
        createHash('sha256')
          .update(JSON.stringify({ memberId: users.sales.memberId, input: legacy }))
          .digest('hex'),
      );
      assert.deepEqual(
        await scope('sales', (c) =>
          createResearch(c, boss, researchRequestSchema.parse(legacy), { storageRights: false }),
        ),
        created,
      );
      await scope('sales', (c) => cancelResearch(c, created.runId));
      const j = (await wb.fetch('d1.research', { batchSize: 100 })).find(
        (j) => j.id === created.jobId,
      );
      assert(j);
      await consumeResearchJob(worker, j.data, j.id, { storageRights: false });
      await wb.complete('d1.research', j);
    },
  );
  writeFileSync(
    '.local/outbound-test-last.json',
    JSON.stringify({ name, env, users, ids }, null, 2) + '\n',
    { mode: 0o600 },
  );
  successful = true;
} finally {
  if (boss) await boss.stop();
  if (wb) await wb.stop();
  await Promise.all([admin.end(), m.end(), api.end(), worker.end(), authPool.end()]);
  writeFileSync(
    evidence + '/integration.json',
    JSON.stringify(
      {
        at: new Date().toISOString(),
        name,
        successful,
        origin: 'offline_fixture (except explicitly recorded real network attempt)',
        checks,
      },
      null,
      2,
    ) + '\n',
  );
  const path = evidence + '/retained-test-databases.json';
  let history = [];
  try {
    history = JSON.parse(readFileSync(path));
  } catch {
    /* first run */
  }
  history.push({ name, successful, at: new Date().toISOString() });
  writeFileSync(path, JSON.stringify(history, null, 2) + '\n');
}
