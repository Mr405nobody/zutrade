import assert from 'node:assert/strict';
import { loadEnvFile } from 'node:process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
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
  createFactDraft,
  publishFact,
  generateQuote,
  saveRequirements,
  quoteVersionDetail,
  generateQuotePdf,
  downloadQuotePdf,
  quotePdfStatus,
  injectSimulation,
  consumeInboundJob,
  requireThread,
  createReply,
  consumeDeliveryJob,
} from '@zutrade/domain';
import { LocalPrivateObjectStore } from '@zutrade/storage';
loadEnvFile('.env');
const evidence = process.env.EVIDENCE_DIR ?? 'docs/build/evidence/b';
mkdirSync(evidence, { recursive: true });
const name = 'zutrade_b_test_' + randomUUID().replaceAll('-', '');
const env = {
  ...process.env,
  POSTGRES_DB: name,
  API_PORT: '3301',
  WORKER_PORT: '3302',
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
const root = mkdtempSync(resolve('.local/b-test-'));
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
let tid, oid, p, s, price, v1, v2;
const fixed = new Date('2030-01-01T08:00:00Z');
const until = '2030-02-01T08:00:00Z';
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
async function gen(extra = {}, clock = fixed) {
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
const base = 'http://127.0.0.1:3301';
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
  const auth = createAuth(ap, env.BETTER_AUTH_SECRET, 5173, 3301, true);
  for (const role of ['owner', 'sales', 'outside']) {
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
          role === 'owner' ? 'owner' : 'sales',
          role === 'owner',
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
  await check(
    'real supply publication is owner-only, draft evidence precedes freeze; source and price immutable',
    async () => {
      p = await scope('sales', (c) =>
        createProduct(c, {
          factoryId: f.a,
          sku: 'CT-01',
          name: 'CT-01 棉布袋（模拟）',
          unitCode: 'piece',
          configuration: { simulation: true },
        }),
      );
      const bytes = Buffer.from(
        'SIMULATION price and production confirmation, not a real supplier.',
      );
      const obj = await store.putImmutable(bytes);
      s = await scope('sales', (c) =>
        createSource(c, p.id, {
          title: '模拟来源',
          kind: 'simulation',
          contentSha256: obj.sha256,
          contentType: 'text/plain',
          contentSize: bytes.length,
          objectKey: obj.key,
          extractedSnapshot: { simulation: true },
          validUntil: until,
        }),
      );
      const input = {
        sourceVersionId: s.id,
        locator: 'Sheet section 1',
        excerpt: 'USD 2.40 + setup 30, production 20 business days, exclusions.',
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
      };
      await assert.rejects(
        () => scope('sales', (c) => publishPrice(c, p.id, input)),
        (e) => e.status === 403,
      );
      price = await scope('owner', (c) => publishPrice(c, p.id, input));
      await rejectSql(
        'UPDATE app.source_versions SET extracted_snapshot=\'{"tampered":true}\' WHERE id=$1',
        [s.id],
      );
      await rejectSql('UPDATE app.price_rules SET unit_price=1 WHERE id=$1', [price.id]);
      const draft = await scope('sales', (c) =>
        createFactDraft(c, p.id, {
          sourceVersionId: s.id,
          locator: 'Section2',
          excerpt: 'Proposed terms',
          factKey: 'other_terms',
          scopeKey: 'default',
          value,
          applicability: {},
          validUntil: until,
          disclosure: 'internal',
        }),
      );
      await assert.rejects(
        () => scope('sales', (c) => publishFact(c, draft.id)),
        (e) => e.status === 403,
      );
    },
  );
  requirements = {
    productId: p.id,
    quantity: '500',
    unitCode: 'piece',
    specifications: value.specifications,
    destination: 'United Kingdom',
    purpose: 'Events',
    requestedTiming: 'Arrival in six weeks',
    language: 'en',
    pendingItems: [],
    internalNote: 'INTERNAL_COST_1.25_SECRET',
  };
  await check(
    '500=1230 with complete frozen snapshot; 800=1950 new version preserves v1 requirements, evidence, identities',
    async () => {
      await save();
      v1 = await gen();
      assert.equal(v1.snapshot.totalAmount, '1230.00');
      assert.equal(v1.snapshot.requirements.quantity, '500');
      assert.equal(v1.snapshot.committedArrivalDate, null);
      assert.equal(v1.snapshot.production.days, 20);
      assert.equal(v1.snapshot.production.dayKind, 'business');
      assert.equal(v1.snapshot.lines.length, 2);
      assert.ok(!JSON.stringify(v1.snapshot).includes('INTERNAL_COST'));
      assert.equal(v1.snapshot.validUntil, '2030-01-08T08:00:00.000Z');
      await save({ quantity: '800' });
      v2 = await gen();
      assert.equal(v2.snapshot.totalAmount, '1950.00');
      const old = await scope('sales', (c) => quoteVersionDetail(c, v1.id));
      assert.equal(old.snapshot.totalAmount, '1230.00');
      assert.equal(old.snapshot.requirements.quantity, '500');
      assert.deepEqual(old.snapshot.evidence, v1.snapshot.evidence);
      await m.query("UPDATE app.products SET name='Changed product' WHERE id=$1", [p.id]);
      await m.query("UPDATE app.factories SET name='Changed factory' WHERE id=$1", [f.a]);
      const historical = await scope('sales', (c) => quoteVersionDetail(c, v1.id));
      assert.equal(historical.snapshot.seller.name, value.seller.name);
      assert.ok(historical.snapshot.lines[0].description.includes('棉布袋'));
    },
  );
  await check(
    'frozen version and children reject direct update/delete/append, logical quote parent advances',
    async () => {
      for (const sql of [
        'UPDATE app.quote_versions SET total_amount=1 WHERE id=$1',
        'DELETE FROM app.quote_versions WHERE id=$1',
        'UPDATE app.quote_lines SET line_amount=1 WHERE quote_version_id=$1',
        'DELETE FROM app.quote_lines WHERE quote_version_id=$1',
        "UPDATE app.quote_evidence SET usage_key='tampered' WHERE quote_version_id=$1",
        'DELETE FROM app.quote_evidence WHERE quote_version_id=$1',
      ])
        await rejectSql(sql, [v1.id]);
      await rejectSql(
        `INSERT INTO app.quote_lines(workspace_id,factory_id,quote_version_id,position,line_kind,description,quantity,unit_code,unit_price,line_amount) VALUES($1,$2,$3,99,'other_fee','x',1,'piece',1,1)`,
        [f.ws, f.a, v1.id],
      );
      await rejectSql(
        `INSERT INTO app.quote_evidence(workspace_id,factory_id,quote_version_id,fact_version_id,usage_key) VALUES($1,$2,$3,$4,'append')`,
        [f.ws, f.a, v1.id, price.fact_version_id],
      );
      assert.equal(
        (await m.query('SELECT current_version_id FROM app.quotes WHERE id=$1', [v1.quote_id]))
          .rows[0].current_version_id,
        v2.id,
      );
    },
  );
  await check(
    'no-op and internal notes preserve requirements revision; material change invalidates with explicit reasons',
    async () => {
      const before = await opp();
      await save({ quantity: '800', internalNote: 'Changed internal note only' });
      const after = await opp();
      assert.equal(after.requirements_revision, before.requirements_revision);
      const same = await scope('sales', (c) =>
        saveRequirements(c, tid, oid, {
          expectedVersion: after.row_version,
          requirements: after.requirements,
        }),
      );
      assert.equal(same.row_version, after.row_version);
      await save({ quantity: '500' });
      const detail = await scope('sales', (c) => quoteVersionDetail(c, v2.id));
      assert.ok(detail.availability.reasons.includes('采购需求已实质变化'));
    },
  );
  await check(
    '499/500/999/1000 and noninteger boundaries, wrong specification, no zero unknown costs, discount proposal retained',
    async () => {
      for (const q of ['499', '1000', '500.5']) {
        await save({ quantity: q });
        const r = await gen();
        assert.equal(r.blocked, true);
        assert.ok(r.pendingItems.length);
      }
      await save({ quantity: '999' });
      assert.equal((await gen()).snapshot.totalAmount, '2427.60');
      await save({ quantity: '500', specifications: { ...value.specifications, color: 'Black' } });
      assert.equal((await gen()).blocked, true);
      await save();
      const over = await gen({ discount: { kind: 'percent', value: '6', reason: 'Buyer asks' } });
      assert.equal(over.blocked, true);
      const good = await gen({
        discount: { kind: 'percent', value: '5', reason: 'Published boundary' },
      });
      assert.equal(good.snapshot.totalAmount, '1170.00');
      assert.ok(!JSON.stringify(good.snapshot).includes('Published boundary'));
      assert.equal(good.snapshot.discount.basis, 'product_subtotal');
      assert.equal(good.snapshot.lines[2].amount, '60.00');
      assert.ok(
        good.snapshot.lines.every((l) => !['shipping', 'tax', 'sample_fee'].includes(l.kind)),
      );
    },
  );
  await check(
    'expiry, missing confirmed basis, cross-factory products and authorization-capped validity fail closed',
    async () => {
      await save();
      assert.equal((await gen({}, new Date('2030-02-02T08:00:00Z'))).blocked, true);
      await m.query('UPDATE app.factories SET authority_valid_until=$2 WHERE id=$1', [
        f.a,
        '2030-01-03T08:00:00Z',
      ]);
      const capped = await gen();
      assert.equal(capped.snapshot.validUntil, '2030-01-03T08:00:00.000Z');
      assert.ok(capped.snapshot.validityReasons[0].includes('shortened'));
      await m.query('UPDATE app.factories SET authority_valid_until=$2 WHERE id=$1', [
        f.a,
        '2029-12-01T08:00:00Z',
      ]);
      assert.equal((await gen()).blocked, true);
      await m.query('UPDATE app.factories SET authority_valid_until=NULL WHERE id=$1', [f.a]);
      const draftProduct = await scope('sales', (c) =>
        createProduct(c, {
          factoryId: f.a,
          sku: 'NO-BASIS',
          name: 'No confirmed basis',
          unitCode: 'piece',
          configuration: {},
        }),
      );
      await save({ productId: draftProduct.id });
      assert.equal((await gen()).blocked, true);
      const hidden = await scope('owner', (c) =>
        createProduct(c, {
          factoryId: f.b,
          sku: 'OTHER',
          name: 'Other factory',
          unitCode: 'piece',
          configuration: {},
        }),
      );
      await assert.rejects(
        () => save({ productId: hidden.id }),
        (e) => e.status === 422,
      );
      await save();
    },
  );
  await check(
    'same command returns original; changed content and two concurrent next versions conflict without history overwrite',
    async () => {
      const o = await opp();
      const current = (
        await m.query('SELECT current_version_id FROM app.quotes WHERE opportunity_id=$1', [oid])
      ).rows[0].current_version_id;
      const cmd = {
        commandId: randomUUID(),
        expectedVersion: o.row_version,
        expectedCurrentVersionId: current,
      };
      const first = await scope('sales', (c) => generateQuote(c, tid, oid, cmd, fixed));
      assert.equal(
        (await scope('sales', (c) => generateQuote(c, tid, oid, cmd, fixed))).id,
        first.id,
      );
      await assert.rejects(
        () =>
          scope('sales', (c) =>
            generateQuote(
              c,
              tid,
              oid,
              { ...cmd, discount: { kind: 'percent', value: '1', reason: 'Changed' } },
              fixed,
            ),
          ),
        (e) => e.status === 409,
      );
      const common = {
        expectedVersion: (await opp()).row_version,
        expectedCurrentVersionId: first.id,
      };
      const results = await Promise.allSettled([
        scope('sales', (c) =>
          generateQuote(c, tid, oid, { ...common, commandId: randomUUID() }, fixed),
        ),
        scope('sales', (c) =>
          generateQuote(c, tid, oid, { ...common, commandId: randomUUID() }, fixed),
        ),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409);
    },
  );
  await check(
    'transaction failure after first quote line rolls back version, lines, evidence, current pointer and manifest',
    async () => {
      await m.query(
        `CREATE FUNCTION app.b_test_fail_line() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.position=1 AND current_setting('app.b_test_failure',true)='on' THEN RAISE EXCEPTION 'injected line failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER b_test_line BEFORE INSERT ON app.quote_lines FOR EACH ROW EXECUTE FUNCTION app.b_test_fail_line()`,
      );
      const before = (await m.query('SELECT count(*)::int n FROM app.quote_versions')).rows[0].n;
      const current = (
        await m.query('SELECT current_version_id FROM app.quotes WHERE opportunity_id=$1', [oid])
      ).rows[0].current_version_id;
      await assert.rejects(() =>
        scope('sales', async (c) => {
          await c.client.query("SET LOCAL app.b_test_failure='on'");
          return generateQuote(
            c,
            tid,
            oid,
            {
              commandId: randomUUID(),
              expectedVersion: (await opp()).row_version,
              expectedCurrentVersionId: current,
            },
            fixed,
          );
        }),
      );
      assert.equal(
        (await m.query('SELECT count(*)::int n FROM app.quote_versions')).rows[0].n,
        before,
      );
      assert.equal(
        (await m.query('SELECT current_version_id FROM app.quotes WHERE opportunity_id=$1', [oid]))
          .rows[0].current_version_id,
        current,
      );
      assert.equal(
        (
          await m.query(
            'SELECT count(*)::int n FROM app.quote_lines l LEFT JOIN app.quote_versions v ON v.id=l.quote_version_id WHERE v.id IS NULL',
          )
        ).rows[0].n,
        0,
      );
      await m.query(
        'DROP TRIGGER b_test_line ON app.quote_lines; DROP FUNCTION app.b_test_fail_line()',
      );
    },
  );
  await check(
    'PDF actual I/O failure persists failed, explicit retry publishes immutable manifest, duplicate downloads identical',
    async () => {
      const bad = {
        putImmutable: async () => {
          throw new Error('disk failure');
        },
        readVerified: async () => {
          throw new Error('disk failure');
        },
      };
      const failed = await scope('sales', (c) => generateQuotePdf(c, v1.id, bad));
      assert.equal(failed.state, 'failed');
      assert.equal(
        (
          await m.query('SELECT state FROM app.quote_pdf_artifacts WHERE quote_version_id=$1', [
            v1.id,
          ])
        ).rows[0].state,
        'failed',
      );
      const ready = await scope('sales', (c) => generateQuotePdf(c, v1.id, store));
      assert.equal(ready.state, 'ready');
      assert.notEqual(ready.pdf_sha256, v1.snapshot_sha256);
      const a = await scope('sales', (c) => downloadQuotePdf(c, v1.id, store));
      const b = await scope('sales', (c) => downloadQuotePdf(c, v1.id, store));
      assert.deepEqual(a.bytes, b.bytes);
      assert.equal(createHash('sha256').update(a.bytes).digest('hex'), ready.pdf_sha256);
      writeFileSync(evidence + '/api-v1.pdf', a.bytes);
      const parallel = await Promise.all([
        scope('sales', (c) => generateQuotePdf(c, v2.id, store)),
        scope('sales', (c) => generateQuotePdf(c, v2.id, store)),
      ]);
      assert.equal(parallel[0].id, parallel[1].id);
      await rejectSql("UPDATE app.quote_pdf_artifacts SET object_key='tampered' WHERE id=$1", [
        ready.id,
      ]);
    },
  );
  await check(
    'PDF missing/corrupt object reports error and never silently rerenders historical artifact',
    async () => {
      const a = await scope('sales', (c) => downloadQuotePdf(c, v2.id, store));
      const key = a.manifest.object_key;
      const path = resolve(env.PRIVATE_DATA_DIR, key.slice(0, 2), key);
      await writeFile(path, Buffer.from('corrupt'));
      const status = await scope('sales', (c) => quotePdfStatus(c, v2.id, store));
      assert.equal(status.state, 'failed');
      await assert.rejects(
        () => scope('sales', (c) => downloadQuotePdf(c, v2.id, store)),
        (e) => e.status === 409,
      );
      await assert.rejects(
        () => scope('sales', (c) => generateQuotePdf(c, v2.id, store)),
        (e) => e.status === 409,
      );
      assert.equal(
        (
          await m.query(
            'SELECT pdf_sha256 FROM app.quote_pdf_artifacts WHERE quote_version_id=$1',
            [v2.id],
          )
        ).rows[0].pdf_sha256,
        a.manifest.pdf_sha256,
      );
    },
  );
  await check(
    'HTTP login, strict ownership, owner-only publication, file content sniff, API and frozen preview/PDF agree',
    async () => {
      await launch();
      for (const role of Object.keys(users)) {
        const r = await http('/api/auth/sign-in/email', role, {
          email: users[role].email,
          password: users[role].password,
        });
        assert.equal(r.status, 200);
        users[role].cookie = r.headers
          .getSetCookie()
          .map((x) => x.split(';')[0])
          .join('; ');
      }
      const path = `/api/workspaces/${f.ws}`;
      assert.equal((await http(path + '/quoting/threads/' + tid, 'sales')).status, 200);
      assert.equal((await http(path + '/quoting/versions/' + v1.id, 'none')).status, 401);
      assert.equal((await http(path + '/quoting/versions/' + v1.id, 'outside')).status, 403);
      assert.equal(
        (await http(path + '/quoting/versions/' + v1.id + '/pdf', 'outside')).status,
        403,
      );
      assert.equal(
        (await http(path + '/supply/facts/' + price.fact_version_id + '/publish', 'sales', {}))
          .status,
        403,
      );
      const detail = await (await http(path + '/quoting/versions/' + v1.id, 'sales')).json();
      assert.equal(detail.snapshot.totalAmount, '1230.00');
      const pdf = await http(path + '/quoting/versions/' + v1.id + '/pdf', 'sales');
      assert.equal(pdf.status, 200);
      assert.equal(
        createHash('sha256')
          .update(Buffer.from(await pdf.arrayBuffer()))
          .digest('hex'),
        detail.pdf.pdf_sha256,
      );
      const invalid = await http(path + '/supply/products/' + p.id + '/sources', 'sales', {
        title: 'bad',
        contentBase64: Buffer.from('<script>bad</script>').toString('base64'),
        validUntil: until,
      });
      assert.equal(invalid.status, 415);
      const upload = await http(path + '/supply/products/' + p.id + '/sources', 'sales', {
        title: 'new document pending',
        contentBase64: Buffer.from('SIMULATION pending source').toString('base64'),
        validUntil: until,
      });
      assert.equal(upload.status, 201);
      const source = await upload.json();
      assert.equal(
        (await http(path + '/supply/sources/' + source.id + '/file', 'sales')).status,
        200,
      );
      assert.equal(
        (await http(path + '/supply/sources/' + source.id + '/file', 'none')).status,
        401,
      );
    },
  );
  await check(
    'mixed thread and removed factory authorization deny bare quote/source IDs; disabled members deny API',
    async () => {
      const o = await opp();
      const mixed = randomUUID();
      await transaction(m, async (c) => {
        await c.query(
          `INSERT INTO app.opportunities(id,workspace_id,factory_id,buyer_id,primary_contact_id,owner_member_id,title) VALUES($1,$2,$3,$4,$5,$6,'mixed')`,
          [mixed, f.ws, f.b, o.buyer_id, o.primary_contact_id, users.owner.memberId],
        );
        await c.query(
          'INSERT INTO app.opportunity_threads(workspace_id,opportunity_id,thread_id) VALUES($1,$2,$3)',
          [f.ws, mixed, tid],
        );
      });
      const path = `/api/workspaces/${f.ws}`;
      for (const tail of [
        '/quoting/versions/' + v1.id,
        '/quoting/versions/' + v1.id + '/pdf',
        '/supply/sources/' + s.id + '/file',
      ])
        assert.equal((await http(path + tail, 'sales')).status, 404);
      await m.query('DELETE FROM app.opportunity_threads WHERE opportunity_id=$1', [mixed]);
      await m.query('DELETE FROM app.factory_memberships WHERE member_id=$1', [
        users.sales.memberId,
      ]);
      assert.equal((await http(path + '/supply/products/' + p.id, 'sales')).status, 404);
      await m.query(
        'INSERT INTO app.factory_memberships(workspace_id,factory_id,member_id) VALUES($1,$2,$3)',
        [f.ws, f.a, users.sales.memberId],
      );
      await m.query("UPDATE app.workspace_members SET status='disabled' WHERE id=$1", [
        users.sales.memberId,
      ]);
      assert.equal((await http(path + '/quoting/versions/' + v1.id + '/pdf', 'sales')).status, 403);
      await m.query("UPDATE app.workspace_members SET status='active' WHERE id=$1", [
        users.sales.memberId,
      ]);
    },
  );
  await check(
    'requirements edit and source withdrawal serialize with quote generation using row/product locks',
    async () => {
      const held = await m.connect();
      await held.query('BEGIN');
      await held.query('SELECT * FROM app.opportunities WHERE id=$1 FOR UPDATE', [oid]);
      const old = await opp();
      const q = (
        await m.query('SELECT current_version_id FROM app.quotes WHERE opportunity_id=$1', [oid])
      ).rows[0].current_version_id;
      const waiting = scope('sales', (c) =>
        generateQuote(
          c,
          tid,
          oid,
          {
            commandId: randomUUID(),
            expectedVersion: old.row_version,
            expectedCurrentVersionId: q,
          },
          fixed,
        ),
      );
      await waitFor(
        async () =>
          Number(
            (
              await admin.query(
                "SELECT count(*) FROM pg_stat_activity WHERE datname=$1 AND application_name='zutrade-b-test' AND wait_event_type='Lock'",
                [name],
              )
            ).rows[0].count,
          ) > 0,
        'requirements row wait',
      );
      await held.query(
        'UPDATE app.opportunities SET requirements_revision=requirements_revision+1 WHERE id=$1',
        [oid],
      );
      await held.query('COMMIT');
      held.release();
      await assert.rejects(
        () => waiting,
        (e) => e.status === 409,
      );
      const current = await gen();
      assert.ok(current.id);
      const revoker = await api.connect();
      await revoker.query('BEGIN');
      await revoker.query(
        "SELECT set_config('app.workspace_id',$1,true),set_config('app.user_id',$2,true)",
        [f.ws, users.owner.userId],
      );
      await revoker.query("SELECT pg_advisory_xact_lock(hashtextextended('b-product:'||$1,0))", [
        p.id,
      ]);
      await revoker.query(
        "UPDATE app.source_versions SET revoked_at=now(),revocation_reason='concurrent withdrawal' WHERE id=$1",
        [s.id],
      );
      const generating = gen();
      await waitFor(
        async () =>
          Number(
            (
              await admin.query(
                "SELECT count(*) FROM pg_stat_activity WHERE datname=$1 AND application_name='zutrade-b-test' AND wait_event_type='Lock'",
                [name],
              )
            ).rows[0].count,
          ) > 0,
        'source lock wait',
      );
      await revoker.query('COMMIT');
      revoker.release();
      assert.equal((await generating).blocked, true);
      const stale = await scope('sales', (c) => quoteVersionDetail(c, current.id));
      assert.ok(stale.availability.reasons.some((x) => x.includes('来源')));
    },
  );
  await check(
    'API restart preserves sources, requirements, histories and saved PDF bytes; A2 template gateway still operates',
    async () => {
      const count = (await m.query('SELECT count(*)::int n FROM app.quote_versions')).rows[0].n;
      await stop();
      await launch();
      assert.equal(
        (await http(`/api/workspaces/${f.ws}/quoting/versions/${v1.id}/pdf`, 'owner')).status,
        200,
      );
      assert.equal(
        (await m.query('SELECT count(*)::int n FROM app.quote_versions')).rows[0].n,
        count,
      );
      const reply = await scope('owner', async (c) =>
        createReply(c, boss, tid, {
          commandId: randomUUID(),
          templateId: 'destination',
          contextRevision: (await requireThread(c, tid)).context_revision,
        }),
      );
      await consumeDeliveryJob(
        worker,
        { eventId: reply.eventId, workspaceId: f.ws, userId: users.owner.userId },
        reply.jobId,
      );
      assert.equal(
        (await m.query('SELECT state FROM app.outbound_requests WHERE id=$1', [reply.requestId]))
          .rows[0].state,
        'simulated',
      );
    },
  );
  success = true;
} finally {
  await stop();
  writeFileSync(evidence + '/integration-processes.txt', logs);
  if (boss) await boss.stop();
  for (const pool of [m, api, worker, ap]) await pool.end();
  if (success) {
    await admin.query(`DROP DATABASE "${name}"`);
    await rm(root, { recursive: true, force: true });
  }
  await admin.end();
  writeFileSync(
    evidence + '/integration.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        stage: 'B',
        passed: success,
        disposableDatabaseRemoved: success,
        ...(!success ? { failedDatabase: name } : {}),
        checks,
      },
      null,
      2,
    ) + '\n',
  );
}
