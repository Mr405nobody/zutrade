// Explicit one-time B handoff preparation. Daily startup and db:seed never call this.
import { loadEnvFile } from 'node:process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pg, withWorkspace } from '@zutrade/db';
import {
  saveRequirements,
  generateQuote,
  generateQuotePdf,
  quoteVersionDetail,
} from '@zutrade/domain';
import { LocalPrivateObjectStore } from '@zutrade/storage';
loadEnvFile('.env');
const accounts = JSON.parse(readFileSync('.local/b-accounts.json', 'utf8'));
const pool = new pg.Pool({ connectionString: process.env.API_DATABASE_URL });
const scope = (run) =>
  withWorkspace(
    pool,
    { id: accounts.owner.subject, name: accounts.owner.name ?? 'B 演示 owner' },
    accounts.workspaceId,
    run,
  );
try {
  const prepared = await scope(async (c) => {
    const old = (
      await c.client.query(
        "SELECT aggregate_id FROM app.audit_events WHERE workspace_id=$1 AND action='b.demo-prepared' ORDER BY occurred_at LIMIT 1",
        [accounts.workspaceId],
      )
    ).rows[0];
    if (old) return { versionId: old.aggregate_id, created: false };
    const rows = (
      await c.client.query(
        `SELECT o.*,t.id AS thread_id,p.id AS product_id FROM app.opportunities o JOIN app.opportunity_threads ot ON ot.workspace_id=o.workspace_id AND ot.opportunity_id=o.id JOIN app.threads t ON t.workspace_id=ot.workspace_id AND t.id=ot.thread_id JOIN app.contact_points cp ON cp.workspace_id=t.workspace_id AND cp.id=t.primary_contact_point_id JOIN app.products p ON p.workspace_id=o.workspace_id AND p.factory_id=o.factory_id AND p.sku='CT-01' WHERE o.workspace_id=$1 AND cp.normalized_value='alex.morgan@northstar-events.example' AND cp.namespace='zutrade-simulation' ORDER BY o.created_at,o.id`,
        [accounts.workspaceId],
      )
    ).rows;
    if (rows.length !== 1)
      throw new Error('B handoff requires one existing CT-01/Alex opportunity relation.');
    const o = rows[0];
    const requirements = {
      productId: o.product_id,
      quantity: '500',
      unitCode: 'piece',
      specifications: {
        fabric: '12oz',
        dimensions: '35×40cm',
        color: 'Natural',
        printing: 'Single colour / single side logo',
      },
      destination: 'United Kingdom (buyer requirement, freight not included)',
      purpose: 'Events',
      requestedTiming: 'Buyer requested arrival within six weeks; not committed.',
      language: 'en',
      pendingItems: ['Confirm destination details and separate freight quote.'],
      internalNote: '模拟演示；需通过阶段 C 独立商业审批后方可外发。',
    };
    const saved = await saveRequirements(c, o.thread_id, o.id, {
      expectedVersion: o.row_version,
      requirements,
    });
    const current = (
      await c.client.query(
        'SELECT current_version_id FROM app.quotes WHERE workspace_id=$1 AND opportunity_id=$2',
        [accounts.workspaceId, o.id],
      )
    ).rows[0];
    const version = await generateQuote(c, o.thread_id, o.id, {
      commandId: randomUUID(),
      expectedVersion: saved.row_version,
      expectedCurrentVersionId: current?.current_version_id ?? null,
    });
    if (version.blocked)
      throw new Error('Confirmed demo supply unavailable: ' + version.pendingItems.join('; '));
    await c.client.query(
      "INSERT INTO app.audit_events(workspace_id,actor_member_id,actor_kind,action,aggregate_type,aggregate_id,details) VALUES($1,$2,'member','b.demo-prepared','quote',$3,$4)",
      [
        accounts.workspaceId,
        c.member.id,
        version.id,
        JSON.stringify({ oneTime: true, threadId: o.thread_id, productId: o.product_id }),
      ],
    );
    return { versionId: version.id, threadId: o.thread_id, productId: o.product_id, created: true };
  });
  const store = new LocalPrivateObjectStore(
    resolve(process.env.PRIVATE_DATA_DIR ?? 'data/private'),
  );
  const pdf = await scope((c) => generateQuotePdf(c, prepared.versionId, store));
  const detail = await scope((c) => quoteVersionDetail(c, prepared.versionId));
  if (pdf.state !== 'ready' || !detail.availability.available)
    throw new Error('Demo PDF or current quote unavailable.');
  const result = {
    ...prepared,
    totalAmount: detail.snapshot.totalAmount,
    quantity: detail.snapshot.requirements.quantity,
    availability: detail.availability,
    pdf: { state: pdf.state, pdf_sha256: pdf.pdf_sha256 },
    validUntil: detail.snapshot.validUntil,
  };
  writeFileSync('docs/build/evidence/b/demo-ready.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  await pool.end();
}
