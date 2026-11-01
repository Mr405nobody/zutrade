import { loadEnvFile } from 'node:process';
import { readFileSync, copyFileSync, existsSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pg, transaction, withWorkspace } from '@zutrade/db';
import { createProduct, createSource, publishPrice, lockSupplyProduct } from '@zutrade/domain';
import { LocalPrivateObjectStore } from '@zutrade/storage';
loadEnvFile('.env');
const accountFile = process.env.B_SEED_ACCOUNTS ?? '.local/b-accounts.json';
if (!process.env.B_SEED_ACCOUNTS && !existsSync(accountFile)) {
  const existing = '.local/a2-browser-accounts.json';
  if (!existsSync(existing))
    throw new Error(
      'Restore existing A2 Alex test account reference before seeding B. No new account or workspace is created.',
    );
  copyFileSync(existing, accountFile);
  chmodSync(accountFile, 0o600);
}
const accounts = JSON.parse(readFileSync(accountFile, 'utf8'));
const init = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
const runtime = new pg.Pool({ connectionString: process.env.API_DATABASE_URL });
try {
  const target = await transaction(init, async (c) => {
    const rows = (
      await c.query(
        `SELECT DISTINCT o.id AS opportunity_id,o.factory_id,t.id AS thread_id,f.name FROM app.threads t JOIN app.contact_points cp ON cp.workspace_id=t.workspace_id AND cp.id=t.primary_contact_point_id JOIN app.channel_accounts ca ON ca.workspace_id=t.workspace_id AND ca.id=t.channel_account_id JOIN app.opportunity_threads ot ON ot.workspace_id=t.workspace_id AND ot.thread_id=t.id JOIN app.opportunities o ON o.workspace_id=ot.workspace_id AND o.id=ot.opportunity_id JOIN app.factories f ON f.workspace_id=o.workspace_id AND f.id=o.factory_id WHERE t.workspace_id=$1 AND cp.normalized_value='alex.morgan@northstar-events.example' AND cp.namespace='zutrade-simulation' AND ca.provider='zutrade-mock' AND ca.external_account_key='a2-inbox' ORDER BY o.id`,
        [accounts.workspaceId],
      )
    ).rows;
    const factories = [...new Set(rows.map((r) => r.factory_id))];
    if (factories.length !== 1)
      throw new Error(
        'B seed requires one explicit authorized factory from Alex existing intake relationship; no factory guessed or new conversation created.',
      );
    return rows[0];
  });
  const result = await withWorkspace(
    runtime,
    { id: accounts.owner.subject, name: accounts.owner.name ?? '演示 Owner' },
    accounts.workspaceId,
    async (c) => {
      await c.client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
        `${accounts.workspaceId}:b-initial-seed`,
      ]);
      const existing = (
        await c.client.query(
          `SELECT id FROM app.products WHERE workspace_id=$1 AND factory_id=$2 AND sku='CT-01'`,
          [accounts.workspaceId, target.factory_id],
        )
      ).rows[0];
      if (existing) return { productId: existing.id, created: false };
      const product = await createProduct(c, {
        factoryId: target.factory_id,
        sku: 'CT-01',
        name: 'CT-01 棉布袋（模拟）',
        unitCode: 'piece',
        configuration: { simulation: true },
      });
      await lockSupplyProduct(c, product.id);
      const now = new Date();
      const validUntil = new Date(now.getTime() + 30 * 86400000).toISOString();
      const text = `SIMULATION ONLY / 仅为模拟资料，非真实供应商确认\nSeller: ${target.name}\nCT-01 cotton tote bag: 12oz, 35×40cm, Natural, Single colour / single side logo.\nUnit piece. Quantity [500, 1000): USD 2.40 each. One setup fee USD 30 per applicable quotation.\nProduction: 20 business days after artwork/sample approval and deposit confirmation.\nShipping and tax excluded. Samples quoted separately. No six-week arrival commitment.\nOwner published discount boundary: product subtotal only, up to 5%.\nRecorded ${now.toISOString()}; valid until ${validUntil}.\n`;
      const bytes = Buffer.from(text);
      const store = new LocalPrivateObjectStore(
        resolve(process.env.PRIVATE_DATA_DIR ?? 'data/private'),
      );
      const object = await store.putImmutable(bytes);
      const source = await createSource(c, product.id, {
        title: 'CT-01 模拟供给说明 v1',
        kind: 'simulation',
        contentSha256: createHash('sha256').update(bytes).digest('hex'),
        contentType: 'text/plain',
        contentSize: bytes.byteLength,
        objectKey: object.key,
        extractedSnapshot: { simulation: true, text },
        validUntil,
      });
      const value = {
        seller: { name: target.name },
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
        sampleTerms: 'Samples are quoted separately.',
        exclusions: [
          'Shipping is excluded and must be quoted separately.',
          'Taxes are excluded and must be confirmed separately.',
          'Samples are quoted separately.',
          'No committed arrival date. A request for arrival in six weeks remains unconfirmed.',
        ],
        simulation: true,
      };
      const price = await publishPrice(c, product.id, {
        sourceVersionId: source.id,
        locator: 'CT-01 simulated supply sheet / full statement',
        excerpt: text,
        scopeKey: 'default',
        qtyMin: '500',
        qtyMax: '1000',
        unitCode: 'piece',
        currencyCode: 'USD',
        unitPrice: '2.40',
        setupFee: '30',
        validUntil,
        value,
        applicability: value.specifications,
      });
      return {
        productId: product.id,
        sourceVersionId: source.id,
        priceRuleId: price.id,
        created: true,
      };
    },
  );
  console.log(
    JSON.stringify({
      stage: 'B',
      ...result,
      threadId: target.thread_id,
      opportunityId: target.opportunity_id,
      note: 'Simulation only. Existing seed rows and all prior revisions remain unchanged.',
    }),
  );
} finally {
  await runtime.end();
  await init.end();
}
