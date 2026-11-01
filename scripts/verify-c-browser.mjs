import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pg, withWorkspace, createQueue } from '@zutrade/db';
import {
  createProduct,
  createSource,
  publishPrice,
  injectSimulation,
  consumeInboundJob,
  requireThread,
  saveRequirements,
  generateQuote,
  generateQuotePdf,
  prepareOutbound,
  decideApproval,
  consumeDeliveryJob,
} from '@zutrade/domain';
import { LocalPrivateObjectStore } from '@zutrade/storage';
const session = JSON.parse(readFileSync('.local/c-test-session.json', 'utf8'));
if (!session.database.startsWith('zutrade_c_test_'))
  throw new Error('C UI requires the retained isolated C test database');
const env = { ...session.env, WEB_PORT: '5273', C_UI_BASE: 'http://127.0.0.1:5273' };
const api = new pg.Pool({ connectionString: env.API_DATABASE_URL }),
  m = new pg.Pool({ connectionString: env.MIGRATION_DATABASE_URL }),
  worker = new pg.Pool({ connectionString: env.WORKER_DATABASE_URL });
const boss = createQueue(env.API_DATABASE_URL),
  wb = createQueue(env.WORKER_DATABASE_URL);
const store = new LocalPrivateObjectStore(env.PRIVATE_DATA_DIR),
  ws = session.workspaceId;
const scope = (role, run) =>
  withWorkspace(api, { id: session.users[role].subject, name: role }, ws, run);
const children = [];
let logs = '';
async function waitFor(fn, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Timeout ' + label);
}
async function newThread(label) {
  const suffix = randomUUID().slice(0, 8),
    contactName = `C-UI ${label} ${suffix}`,
    identity = `c-ui-${label}-${suffix}@c.example`;
  const receipt = await scope('owner', (c) =>
    injectSimulation(c, boss, {
      eventId: randomUUID(),
      providerMessageId: randomUUID(),
      identity,
      displayName: contactName,
      body: 'C-UI 独立审批验收样例（模拟）',
      occurredAt: new Date().toISOString(),
      factoryId: session.factories[0],
    }),
  );
  const e = (
    await m.query('SELECT * FROM app.outbox_events WHERE aggregate_id=$1', [receipt.receiptId])
  ).rows[0];
  await consumeInboundJob(worker, { eventId: e.id, workspaceId: ws }, e.pg_boss_job_id);
  const t = (
    await m.query('SELECT normalized_thread_id FROM app.inbound_events WHERE id=$1', [
      receipt.receiptId,
    ])
  ).rows[0].normalized_thread_id;
  return { threadId: t, identity, contactName };
}
async function free(label) {
  const t = await newThread(label);
  const r = await scope('sales', async (c) =>
    prepareOutbound(
      c,
      {
        commandId: randomUUID(),
        contextRevision: (await requireThread(c, t.threadId)).context_revision,
        kind: 'human_reply',
        quoteVersionId: null,
        body: `Final owner-reviewed response: ${label}.`,
      },
      t.threadId,
      store,
    ),
  );
  return { ...t, ...r };
}
async function decide(r, decision = 'approve') {
  const a = (await m.query('SELECT * FROM app.approvals WHERE id=$1', [r.approvalId])).rows[0];
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
        decision,
        reason: 'C-UI independent fixture',
      },
      store,
    ),
  );
}
async function quote(label, product) {
  const t = await newThread(label);
  const o = (
    await m.query(
      'SELECT o.* FROM app.opportunities o JOIN app.opportunity_threads ot ON ot.opportunity_id=o.id WHERE ot.thread_id=$1',
      [t.threadId],
    )
  ).rows[0];
  const saved = await scope('sales', (c) =>
    saveRequirements(c, t.threadId, o.id, {
      expectedVersion: o.row_version,
      requirements: {
        productId: product.id,
        quantity: '800',
        unitCode: 'piece',
        specifications: product.value.specifications,
        destination: 'UK',
        purpose: 'Events',
        requestedTiming: 'six weeks requested, uncommitted',
        language: 'en',
        pendingItems: [],
        internalNote: 'C_UI_INTERNAL_COST_SECRET',
      },
    }),
  );
  const clock = (await m.query('SELECT clock_timestamp() now')).rows[0].now;
  const q = await scope('sales', (c) =>
    generateQuote(
      c,
      t.threadId,
      o.id,
      {
        commandId: randomUUID(),
        expectedVersion: saved.row_version,
        expectedCurrentVersionId: null,
      },
      clock,
    ),
  );
  if (!q.id) throw new Error('C UI quote not generated');
  const pdf = await scope('sales', (c) => generateQuotePdf(c, q.id, store));
  return { ...t, quoteVersionId: q.id, pdf };
}
function launch(args) {
  const c = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const s of [c.stdout, c.stderr]) s.on('data', (b) => (logs += b));
  children.push(c);
  return c;
}
try {
  await boss.start();
  await wb.start();
  const value = (await m.query('SELECT terms FROM app.price_rules ORDER BY created_at LIMIT 1'))
    .rows[0].terms;
  const p = await scope('owner', (c) =>
    createProduct(c, {
      factoryId: session.factories[0],
      sku: 'C-UI-' + randomUUID().slice(0, 8),
      name: 'C-UI 独立模拟棉布袋',
      unitCode: 'piece',
      configuration: {},
    }),
  );
  const bytes = Buffer.from(
    'C-UI new independent simulated confirmation USD2.40 + setup30, 20 business days, scope exclusions.',
  );
  const obj = await store.putImmutable(bytes),
    until = new Date(Date.now() + 20 * 86400000).toISOString();
  const source = await scope('owner', (c) =>
    createSource(c, p.id, {
      title: 'C-UI 独立模拟依据',
      kind: 'simulation',
      contentSha256: obj.sha256,
      contentType: 'text/plain',
      contentSize: bytes.length,
      objectKey: obj.key,
      extractedSnapshot: { simulation: true },
      validUntil: until,
    }),
  );
  await scope('owner', (c) =>
    publishPrice(c, p.id, {
      sourceVersionId: source.id,
      locator: 'C-UI confirmation',
      excerpt: bytes.toString(),
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
  p.value = value;
  const fixtures = {};
  for (const project of ['desktop', 'mobile']) {
    const main = await quote(project + '-quote', p),
      reject = await free(project + '-reject'),
      conflict = await free(project + '-conflict'),
      cancel = await free(project + '-cancel'),
      expired = await free(project + '-expired');
    await decide(expired, 'reject');
    const a = (await m.query('SELECT * FROM app.approvals WHERE id=$1', [expired.approvalId]))
      .rows[0];
    const expiredPayload = randomUUID();
    await m.query(
      'INSERT INTO app.outbound_payload_versions(id,workspace_id,factory_id,outbound_request_id,version_no,thread_context_revision,policy_version,language_code,body_text,subject,body_html,sender_snapshot,recipients_snapshot,attachment_manifest,channel_payload,snapshot_sha256,frozen_at) SELECT $2,workspace_id,factory_id,outbound_request_id,2,thread_context_revision,policy_version,language_code,body_text,subject,body_html,sender_snapshot,recipients_snapshot,attachment_manifest,channel_payload,snapshot_sha256,frozen_at FROM app.outbound_payload_versions WHERE id=$1',
      [expired.payloadId, expiredPayload],
    );
    expired.payloadId = expiredPayload;
    await m.query(
      "UPDATE app.outbound_requests SET current_payload_version_id=$2,state='awaiting_approval',stop_reason=NULL WHERE id=$1",
      [expired.requestId, expiredPayload],
    );
    await m.query(
      `INSERT INTO app.approvals(workspace_id,outbound_request_id,payload_version_id,snapshot_sha256,requested_by_member_id,created_at,expires_at) VALUES($1,$2,$3,$4,$5,now()-interval '2 hours',now()-interval '1 hour')`,
      [ws, expired.requestId, expired.payloadId, a.snapshot_sha256, session.users.sales.memberId],
    );
    const lost = await free(project + '-lost-response');
    await m.query(
      'UPDATE app.channel_accounts SET configuration=$2 WHERE id=(SELECT channel_account_id FROM app.threads WHERE id=$1)',
      [
        lost.threadId,
        JSON.stringify({
          mock: { idempotent: false, guaranteeSeconds: 86400, scenario: 'lost_response' },
        }),
      ],
    );
    const j = await decide(lost);
    await consumeDeliveryJob(
      worker,
      { eventId: j.eventId, workspaceId: ws, userId: session.users.sales.userId },
      j.jobId,
      { store, simulationUrl: env.SIMULATION_DATABASE_URL },
    );
    await m.query(
      "UPDATE app.channel_accounts SET configuration='{}' WHERE id=(SELECT channel_account_id FROM app.threads WHERE id=$1)",
      [lost.threadId],
    );
    const badPdf = await quote(project + '-pdf-error', p);
    const bad = await scope('sales', async (c) =>
      prepareOutbound(
        c,
        {
          commandId: randomUUID(),
          kind: 'quote',
          quoteVersionId: badPdf.quoteVersionId,
          contextRevision: (await requireThread(c, badPdf.threadId)).context_revision,
        },
        badPdf.threadId,
        store,
      ),
    );
    await writeFile(
      resolve(env.PRIVATE_DATA_DIR, badPdf.pdf.object_key.slice(0, 2), badPdf.pdf.object_key),
      Buffer.from('C-UI isolated corrupt object; not a valid PDF'),
    );
    const lateSample = await free(project + '-late-cancel');
    const lateJob = await decide(lateSample);
    await consumeDeliveryJob(
      worker,
      { eventId: lateJob.eventId, workspaceId: ws, userId: session.users.sales.userId },
      lateJob.jobId,
      {
        store,
        simulationUrl: env.SIMULATION_DATABASE_URL,
        afterClaim: () => decide(lateSample, 'revoke'),
      },
    );
    const late = { request_id: lateSample.requestId, identity: lateSample.identity },
      unknown = late;
    fixtures[project] = {
      main,
      reject,
      conflict,
      cancel,
      expired,
      lost,
      badPdf: { ...badPdf, ...bad },
      late,
      unknown,
    };
  }
  mkdirSync('docs/build/evidence/c/browser', { recursive: true });
  writeFileSync(
    '.local/c-ui-accounts.json',
    JSON.stringify(
      {
        workspaceId: ws,
        owner: { email: session.users.owner.email, password: session.users.owner.password },
        sales: { email: session.users.sales.email, password: session.users.sales.password },
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  writeFileSync(
    '.local/c-ui-fixture.json',
    JSON.stringify({ workspaceId: ws, users: session.users, fixtures, env }, null, 2) + '\n',
    { mode: 0o600 },
  );
  while (true) {
    const jobs = await wb.fetch('a2.delivery', { batchSize: 100 });
    if (!jobs.length) break;
    for (const j of jobs) await wb.complete('a2.delivery', j.id);
  }
  launch(['apps/api/dist/main.js']);
  launch(['apps/worker/dist/main.js']);
  launch([
    'apps/web/node_modules/vite/bin/vite.js',
    '--config',
    'apps/web/vite.config.ts',
    'apps/web',
  ]);
  await waitFor(async () => {
    try {
      return (
        (await fetch('http://127.0.0.1:3401/health/live')).ok && (await fetch(env.C_UI_BASE)).ok
      );
    } catch {
      return false;
    }
  }, 'C isolated API/web');
  const runner = launch(['node_modules/@playwright/test/cli.js', 'test', 'c.spec.ts']);
  const code = await new Promise((resolve) => runner.once('exit', resolve));
  if (code !== 0) throw new Error('C UI verification failed; see browser evidence');
  console.log(
    'C desktop/mobile verification passed in isolated database; daily Alex and services untouched.',
  );
} finally {
  for (const c of children) {
    if (c.exitCode === null && c.signalCode === null) c.kill('SIGTERM');
  }
  await Promise.all(
    children.map((c) =>
      c.exitCode !== null || c.signalCode !== null
        ? Promise.resolve()
        : new Promise((r) => c.once('exit', r)),
    ),
  );
  await boss.stop();
  await wb.stop();
  for (const pool of [api, m, worker]) await pool.end();
  writeFileSync('docs/build/evidence/c/browser/processes.txt', logs);
}
