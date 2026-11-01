// One-time handoff: use Alex's actual current valid quote, never restore old history.
import { loadEnvFile } from 'node:process';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pg, withWorkspace } from '@zutrade/db';
import {
  requireThread,
  requireQuoteVersion,
  generateQuotePdf,
  prepareOutbound,
} from '@zutrade/domain';
import { LocalPrivateObjectStore } from '@zutrade/storage';
loadEnvFile('.env');
const a = JSON.parse(readFileSync('.local/b-accounts.json', 'utf8')),
  pool = new pg.Pool({ connectionString: process.env.API_DATABASE_URL });
const scope = (role, run) =>
  withWorkspace(pool, { id: a[role].subject, name: role }, a.workspaceId, run);
try {
  const config = await scope('owner', async (c) => ({
    approver: c.member.approver_member_id,
    owner: c.member.id,
    owners: (
      await c.client.query(
        "SELECT id FROM app.workspace_members WHERE workspace_id=$1 AND role='owner' AND status='active'",
        [a.workspaceId],
      )
    ).rows,
  }));
  if (!config.approver) {
    if (config.owners.length !== 1)
      throw new Error('Choose a designated owner in Workspace settings before preparing the demo.');
    const login = await fetch('http://127.0.0.1:3001/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:5173' },
      body: JSON.stringify({ email: a.owner.email, password: a.owner.password }),
    });
    if (!login.ok) throw new Error('Owner local authentication failed');
    const cookie = login.headers
      .getSetCookie()
      .map((x) => x.split(';')[0])
      .join('; ');
    const response = await fetch(`http://127.0.0.1:3001/api/workspaces/${a.workspaceId}/approver`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:5173', cookie },
      body: JSON.stringify({ memberId: config.owner }),
    });
    if (!response.ok) throw new Error('Normal designated-owner command failed');
  }
  const store = new LocalPrivateObjectStore(
    resolve(process.env.PRIVATE_DATA_DIR ?? 'data/private'),
  );
  const result = await scope('sales', async (c) => {
    const previous = (
      await c.client.query(
        "SELECT details FROM app.audit_events WHERE workspace_id=$1 AND action='c.demo-prepared' ORDER BY occurred_at DESC LIMIT 1",
        [a.workspaceId],
      )
    ).rows[0];
    if (previous && !process.argv.includes('--refresh'))
      return { ...previous.details, reused: true };
    const rows = (
      await c.client.query(
        `SELECT q.current_version_id,t.id AS thread_id FROM app.threads t JOIN app.contact_points cp ON cp.workspace_id=t.workspace_id AND cp.id=t.primary_contact_point_id JOIN app.opportunity_threads ot ON ot.workspace_id=t.workspace_id AND ot.thread_id=t.id JOIN app.quotes q ON q.workspace_id=ot.workspace_id AND q.opportunity_id=ot.opportunity_id WHERE t.workspace_id=$1 AND cp.namespace='zutrade-simulation' AND cp.normalized_value='alex.morgan@northstar-events.example'`,
        [a.workspaceId],
      )
    ).rows;
    if (rows.length !== 1) throw new Error('Expected one current Alex quote relation');
    const ref = rows[0],
      q = await requireQuoteVersion(c, ref.current_version_id);
    if (!q.availability.available)
      throw new Error(
        'Current Alex quote requires normal B confirmation/versioning before C: ' +
          q.availability.reasons.join('; '),
      );
    const pdf = await generateQuotePdf(c, q.id, store);
    if (pdf.state !== 'ready') throw new Error('Saved current PDF unavailable');
    const existing = previous
      ? (
          await c.client.query(
            'SELECT * FROM app.outbound_requests WHERE workspace_id=$1 AND id=$2',
            [a.workspaceId, previous.details.requestId],
          )
        ).rows[0]
      : null;
    if (existing?.dispatch_claimed_at)
      throw new Error(
        'Existing demo has been claimed; refresh requires a new explicit business request.',
      );
    const prepared = await prepareOutbound(
      c,
      {
        commandId: randomUUID(),
        kind: 'quote',
        ...(existing ? { requestId: existing.id, expectedVersion: existing.row_version } : {}),
        quoteVersionId: q.id,
        contextRevision: (await requireThread(c, ref.thread_id)).context_revision,
      },
      ref.thread_id,
      store,
    );
    const details = {
      workspaceId: a.workspaceId,
      threadId: ref.thread_id,
      quoteVersionId: q.id,
      quoteVersion: q.version_no,
      quantity: q.snapshot.requirements.quantity,
      totalAmount: q.snapshot.totalAmount,
      validUntil: q.snapshot.validUntil,
      pdfSha256: pdf.pdf_sha256,
      ...prepared,
      businessApproval: 'pending; no auto approval',
    };
    await c.client.query(
      "INSERT INTO app.audit_events(workspace_id,actor_member_id,actor_kind,action,aggregate_type,aggregate_id,details) VALUES($1,$2,'member','c.demo-prepared','outbound_request',$3,$4)",
      [a.workspaceId, c.member.id, prepared.requestId, JSON.stringify(details)],
    );
    return details;
  });
  writeFileSync(
    'docs/build/evidence/c/demo-ready.json',
    JSON.stringify({ checkedAt: new Date().toISOString(), ...result }, null, 2) + '\n',
  );
  console.log(JSON.stringify(result));
} finally {
  await pool.end();
}
