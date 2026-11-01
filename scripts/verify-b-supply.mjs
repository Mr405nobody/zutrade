import assert from 'node:assert/strict';
import { loadEnvFile } from 'node:process';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pg, transaction, withWorkspace } from '@zutrade/db';
import {
  createProduct,
  createSource,
  createFactDraft,
  publishFact,
  publishPrice,
  withdrawSource,
  productDetail,
  withdrawFact,
} from '@zutrade/domain';
loadEnvFile('.env');
const name = `zutrade_b_supply_${randomUUID().replaceAll('-', '')}`;
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
const m = new pg.Pool({ connectionString: env.MIGRATION_DATABASE_URL });
const api = new pg.Pool({ connectionString: env.API_DATABASE_URL, max: 6 });
const checks = [];
let success = false;
const clock = Date.now();
const realNow = Date.now;
Date.now = () => clock;
const until = new Date(clock + 20 * 86400000).toISOString();
const sourceTemplate = {
  title: '模拟来源',
  kind: 'simulation',
  contentSha256: createHash('sha256').update('simulation').digest('hex'),
  contentType: 'text/plain',
  contentSize: 10,
  extractedSnapshot: { simulation: true },
  validUntil: until,
};
const value = {
  seller: { name: '测试模拟工厂' },
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
  exclusions: ['Shipping excluded.', 'Tax excluded.'],
  simulation: true,
};
const ids = { ws: randomUUID(), factory: randomUUID(), hidden: randomUUID() };
const users = Object.fromEntries(
  ['owner', 'sales'].map((role) => [role, { id: `b-supply-${role}-${randomUUID()}`, name: role }]),
);
const run = (role, cb) => withWorkspace(api, users[role], ids.ws, cb);
const rejected = (cb, status) => assert.rejects(cb, (e) => e.status === status);
async function check(label, cb) {
  await cb();
  checks.push({ label, result: 'passed' });
  console.log('PASS ' + label);
}
let p, s, base, rule;
try {
  await admin.query(`CREATE DATABASE "${name}"`);
  for (const script of ['scripts/db-provision.mjs', 'scripts/db-migrate.mjs']) {
    const r = spawnSync(process.execPath, [script], { env, encoding: 'utf8', timeout: 60000 });
    if (r.status !== 0) throw new Error(`${script} failed: ${r.stderr.slice(0, 700)}`);
  }
  await transaction(m, async (c) => {
    await c.query('INSERT INTO app.workspaces(id,name) VALUES($1,$2)', [
      ids.ws,
      'B Supply isolated',
    ]);
    for (const [role, u] of Object.entries(users)) {
      const user = (
        await c.query(
          'INSERT INTO app.app_users(auth_subject,display_name) VALUES($1,$2) RETURNING id',
          [u.id, u.name],
        )
      ).rows[0];
      const member = (
        await c.query(
          'INSERT INTO app.workspace_members(workspace_id,user_id,role,all_factories) VALUES($1,$2,$3,$4) RETURNING id',
          [ids.ws, user.id, role, role === 'owner'],
        )
      ).rows[0];
      u.memberId = member.id;
    }
    for (const f of [ids.factory, ids.hidden])
      await c.query(
        "INSERT INTO app.factories(id,workspace_id,name,factory_code,status) VALUES($1::uuid,$2,'模拟工厂',$1::text,'active')",
        [f, ids.ws],
      );
    await c.query(
      'INSERT INTO app.factory_memberships(workspace_id,factory_id,member_id) VALUES($1,$2,$3)',
      [ids.ws, ids.factory, users.sales.memberId],
    );
  });
  await check(
    'sales source upload and fact draft remain unconfirmed; owner publication is separate',
    async () => {
      p = await run('sales', (c) =>
        createProduct(c, {
          factoryId: ids.factory,
          sku: 'TEST',
          name: '测试模拟产品',
          unitCode: 'piece',
          configuration: {},
        }),
      );
      s = await run('sales', (c) => createSource(c, p.id, sourceTemplate));
      base = {
        sourceVersionId: s.id,
        locator: 'full statement',
        excerpt: 'Simulation supply statement',
        scopeKey: 'default',
        value,
        applicability: value.specifications,
        validUntil: until,
        qtyMin: '500',
        qtyMax: '1000',
        unitCode: 'piece',
        currencyCode: 'USD',
        unitPrice: '2.40',
        setupFee: '30',
      };
      const draft = await run('sales', (c) =>
        createFactDraft(c, p.id, { ...base, factKey: 'supply', disclosure: 'buyer_visible' }),
      );
      assert.equal(draft.state, 'draft');
      assert.equal(draft.frozen_at, null);
      await rejected(() => run('sales', (c) => publishFact(c, draft.id)), 403);
      const pub = await run('owner', (c) => publishFact(c, draft.id));
      assert.equal(pub.state, 'published');
      assert.ok(pub.frozen_at);
      await rejected(() => run('sales', (c) => publishPrice(c, p.id, base)), 403);
    },
  );
  await check(
    'owner price publication freezes complete evidence and immutable numeric rule',
    async () => {
      rule = await run('owner', (c) => publishPrice(c, p.id, base));
      assert.equal(rule.unit_price, '2.400000');
      const fv = (
        await m.query('SELECT * FROM app.fact_versions WHERE id=$1', [rule.fact_version_id])
      ).rows[0];
      assert.equal(fv.state, 'published');
      assert.ok(fv.verified_by_member_id);
      for (const sql of [
        "UPDATE app.source_versions SET content_type='bogus' WHERE id=$1",
        'DELETE FROM app.source_versions WHERE id=$1',
      ])
        await assert.rejects(() => m.query(sql, [s.id]));
      await assert.rejects(() =>
        m.query('DELETE FROM app.fact_evidence WHERE fact_version_id=$1', [fv.id]),
      );
      await assert.rejects(() =>
        m.query('UPDATE app.price_rules SET unit_price=99 WHERE id=$1', [rule.id]),
      );
    },
  );
  await check(
    'compatible applicability and concurrent overlap publications reject ambiguity',
    async () => {
      await rejected(
        () =>
          run('owner', (c) =>
            publishPrice(c, p.id, {
              ...base,
              scopeKey: 'other',
              qtyMin: '600',
              qtyMax: '900',
              applicability: {},
            }),
          ),
        409,
      );
      const results = await Promise.allSettled([
        run('owner', (c) =>
          publishPrice(c, p.id, { ...base, scopeKey: 'new1', qtyMin: '1000', qtyMax: '1200' }),
        ),
        run('owner', (c) =>
          publishPrice(c, p.id, { ...base, scopeKey: 'new2', qtyMin: '1000', qtyMax: '1200' }),
        ),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(
        results.filter((r) => r.status === 'rejected' && r.reason.status === 409).length,
        1,
      );
    },
  );
  await check('same-transaction overlap rejects and rolls back both candidate rules', async () => {
    await rejected(
      () =>
        run('owner', async (c) => {
          await publishPrice(c, p.id, {
            ...base,
            scopeKey: 'same-tx-1',
            qtyMin: '3000',
            qtyMax: '4000',
          });
          await publishPrice(c, p.id, {
            ...base,
            scopeKey: 'same-tx-2',
            qtyMin: '3500',
            qtyMax: '4500',
          });
        }),
      409,
    );
    assert.equal(
      (
        await m.query(
          'SELECT count(*)::int n FROM app.price_rules WHERE workspace_id=$1 AND qty_min>=3000',
          [ids.ws],
        )
      ).rows[0].n,
      0,
    );
  });
  await check(
    'price update creates new frozen fact and preserves superseded amount and evidence',
    async () => {
      const replacement = await run('owner', (c) =>
        publishPrice(c, p.id, { ...base, unitPrice: '2.50' }),
      );
      assert.notEqual(replacement.id, rule.id);
      assert.equal(
        (await m.query('SELECT state FROM app.fact_versions WHERE id=$1', [rule.fact_version_id]))
          .rows[0].state,
        'superseded',
      );
      assert.equal(
        (await m.query('SELECT unit_price FROM app.price_rules WHERE id=$1', [rule.id])).rows[0]
          .unit_price,
        '2.400000',
      );
    },
  );
  await check('source versions use CAS, retain frozen history and block old evidence', async () => {
    const d = (
      await m.query('SELECT * FROM app.source_documents WHERE id=$1', [s.source_document_id])
    ).rows[0];
    const next = await run('sales', (c) =>
      createSource(c, p.id, {
        ...sourceTemplate,
        sourceDocumentId: d.id,
        expectedVersion: d.row_version,
      }),
    );
    assert.equal(next.version_no, 2);
    await rejected(
      () =>
        run('sales', (c) =>
          createSource(c, p.id, {
            ...sourceTemplate,
            sourceDocumentId: d.id,
            expectedVersion: d.row_version,
          }),
        ),
      409,
    );
    await rejected(
      () => run('owner', (c) => publishPrice(c, p.id, { ...base, qtyMin: '2000', qtyMax: '3000' })),
      409,
    );
    s = next;
    base = { ...base, sourceVersionId: next.id };
  });
  await check('withdrawn source cannot be revived by uploading new version', async () => {
    await run('owner', (c) => withdrawSource(c, s.id, 'isolated test withdrawal'));
    const d = (
      await m.query('SELECT * FROM app.source_documents WHERE id=$1', [s.source_document_id])
    ).rows[0];
    await rejected(
      () =>
        run('sales', (c) =>
          createSource(c, p.id, {
            ...sourceTemplate,
            sourceDocumentId: d.id,
            expectedVersion: d.row_version,
          }),
        ),
      409,
    );
    await rejected(
      () => run('owner', (c) => publishPrice(c, p.id, { ...base, qtyMin: '2000', qtyMax: '3000' })),
      409,
    );
    await rejected(
      () => run('sales', (c) => withdrawFact(c, rule.fact_version_id, 'forbidden')),
      403,
    );
  });
  await check('factory RLS prevents direct unauthorized product and source discovery', async () => {
    const hidden = await run('owner', (c) =>
      createProduct(c, {
        factoryId: ids.hidden,
        sku: 'HIDDEN',
        name: '隐藏',
        unitCode: 'piece',
        configuration: {},
      }),
    );
    await rejected(() => run('sales', (c) => productDetail(c, hidden.id)), 404);
    const rows = await run('sales', (c) =>
      c.client.query('SELECT id FROM app.products WHERE id=$1', [hidden.id]),
    );
    assert.equal(rows.rowCount, 0);
  });
  success = true;
} finally {
  Date.now = realNow;
  mkdirSync('docs/build/evidence/b', { recursive: true });
  writeFileSync(
    'docs/build/evidence/b/supply-integration.json',
    JSON.stringify(
      { database: name, isolated: true, clock: new Date(clock).toISOString(), success, checks },
      null,
      2,
    ) + '\n',
  );
  await api.end();
  await m.end();
  if (success) await admin.query(`DROP DATABASE "${name}"`);
  else console.error('Failed supply test database retained: ' + name);
  await admin.end();
}
