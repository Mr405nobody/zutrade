// Explicit isolated fixture: real-channel eligibility states, no real addresses or sends.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pg, withWorkspace } from '@zutrade/db';
import { createSimulationContact, setSimulationPermission } from '@zutrade/domain';
const f = JSON.parse(readFileSync('.local/d2-test-last.json'));
if (!new URL(f.env.MIGRATION_DATABASE_URL).pathname.startsWith('/zutrade_d2_test_'))
  throw new Error('D2 isolated database required');
const migration = new pg.Pool({ connectionString: f.env.MIGRATION_DATABASE_URL }),
  api = new pg.Pool({ connectionString: f.env.API_DATABASE_URL });
const scope = (role, fn) =>
  withWorkspace(api, { id: f.users[role].subject, name: role }, f.ids.ws, fn);
try {
  const lead = (await migration.query('SELECT buyer_id FROM app.leads WHERE id=$1', [f.leads[2]]))
      .rows[0],
    pointId = randomUUID();
  await migration.query(
    "INSERT INTO app.contact_points(id,workspace_id,buyer_id,lead_id,kind,namespace,normalized_value,source_evidence) VALUES($1,$2,$3,$4,'email','email',$5,$6)",
    [
      pointId,
      f.ids.ws,
      lead.buyer_id,
      f.leads[2],
      'unverified-' + randomUUID() + '@d2-fixture.example',
      JSON.stringify({
        origin: 'offline_test_fixture',
        identityStatus: 'unverified',
        notARealContact: true,
      }),
    ],
  );
  for (const [purpose, status, stop] of [
    ['service', 'unknown', false],
    ['outreach', 'denied', true],
  ])
    await migration.query(
      "INSERT INTO app.contact_permissions(workspace_id,contact_point_id,channel_kind,purpose,status,do_not_contact,evidence) VALUES($1,$2,'email',$3,$4,$5,$6)",
      [
        f.ids.ws,
        pointId,
        purpose,
        status,
        stop,
        JSON.stringify({ origin: 'offline_test_fixture' }),
      ],
    );
  const read = async () =>
    (
      await migration.query(
        'SELECT * FROM app.contact_permissions WHERE contact_point_id=$1 ORDER BY purpose',
        [pointId],
      )
    ).rows;
  const before = await read();
  const demo = await scope('owner', (c) =>
    createSimulationContact(c, {
      commandId: randomUUID(),
      leadId: f.leads[2],
      accountId: f.accounts[0],
      simulationAuthorized: true,
    }),
  );
  await scope('sales', (c) => setSimulationPermission(c, demo.pointId, false));
  await assert.rejects(() => scope('sales', (c) => setSimulationPermission(c, demo.pointId, true)));
  await scope('owner', (c) => setSimulationPermission(c, demo.pointId, true));
  assert.deepEqual(await read(), before);
  assert.equal(
    (await migration.query('SELECT verified_at FROM app.contact_points WHERE id=$1', [pointId]))
      .rows[0].verified_at,
    null,
  );
  writeFileSync(
    'docs/build/evidence/d2/eligibility.json',
    JSON.stringify(
      {
        observedAt: new Date().toISOString(),
        database: f.name,
        origin: 'offline_test_fixture',
        checks: [
          'Simulation grant/revoke/regrant preserves existing real-email unknown and denied/do_not_contact rows byte-for-byte as JSON',
          'Sales cannot restore simulation qualification; current designated owner can',
          'Public-format email remains unverified',
        ],
        passed: true,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS real-channel unknown/denied/opt-out unchanged; owner-only simulation regrant; email unverified.',
  );
} finally {
  await migration.end();
  await api.end();
}
