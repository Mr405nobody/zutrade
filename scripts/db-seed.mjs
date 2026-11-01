import { loadEnvFile } from 'node:process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { pg, createAuth, createAuthPool } from '@zutrade/db';
loadEnvFile('.env');
const pool = new pg.Pool({
  connectionString: process.env.MIGRATION_DATABASE_URL,
  application_name: 'zutrade-controlled-seed',
});
const authPool = createAuthPool(process.env.MIGRATION_DATABASE_URL);
const auth = createAuth(authPool, process.env.BETTER_AUTH_SECRET, 5173, 3001, true);
const file = '.local/a1-accounts.json';
mkdirSync('.local', { recursive: true, mode: 0o700 });
const hadAccountFile = existsSync(file);
if (
  !hadAccountFile &&
  (
    await authPool.query('SELECT id FROM auth."user" WHERE email = ANY($1::text[])', [
      ['owner@zutrade.test', 'sales@zutrade.test'],
    ])
  ).rowCount
) {
  await pool.end();
  await authPool.end();
  throw new Error(
    'Existing demo accounts found but private account file is missing. Refusing to invent replacement passwords or reset users. Restore the original private file.',
  );
}
const accounts = hadAccountFile
  ? JSON.parse(readFileSync(file, 'utf8'))
  : {
      workspaceId: randomUUID(),
      owner: {
        email: 'owner@zutrade.test',
        name: '演示 Owner',
        password: randomBytes(24).toString('base64url'),
      },
      sales: {
        email: 'sales@zutrade.test',
        name: '演示 Sales',
        password: randomBytes(24).toString('base64url'),
      },
    };
// Write first so interrupted seeding never loses the password that created an account.
writeFileSync(file, JSON.stringify(accounts, null, 2) + '\n', {
  mode: 0o600,
  flag: hadAccountFile ? 'w' : 'wx',
});
chmodSync(file, 0o600);
try {
  for (const key of ['owner', 'sales']) {
    const a = accounts[key];
    let row = (await authPool.query('SELECT id FROM auth."user" WHERE email=$1', [a.email]))
      .rows[0];
    if (!row) {
      const result = await auth.api.signUpEmail({
        body: { email: a.email, name: a.name, password: a.password },
      });
      row = result.user;
    }
    a.subject = row.id;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(20261028,2)');
    // The explicit well-known demo name is unique for initialization purposes under this lock.
    const existing = (
      await client.query(
        "SELECT id FROM app.workspaces WHERE id=$1 OR name='ZuTrade 演示工作区（虚构）' ORDER BY (id=$1) DESC,created_at LIMIT 1",
        [accounts.workspaceId],
      )
    ).rows[0];
    if (existing) accounts.workspaceId = existing.id;
    await client.query(
      'INSERT INTO app.workspaces(id,name) VALUES($1,$2) ON CONFLICT(id) DO NOTHING',
      [accounts.workspaceId, 'ZuTrade 演示工作区（虚构）'],
    );
    for (const key of ['owner', 'sales']) {
      const a = accounts[key];
      await client.query(
        'INSERT INTO app.app_users(auth_subject,display_name) VALUES($1,$2) ON CONFLICT(auth_subject) DO NOTHING',
        [a.subject, a.name],
      );
      const user = (
        await client.query('SELECT id FROM app.app_users WHERE auth_subject=$1', [a.subject])
      ).rows[0];
      a.userId = user.id;
      await client.query(
        'INSERT INTO app.workspace_members(workspace_id,user_id,role,all_factories) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,user_id) DO NOTHING',
        [accounts.workspaceId, user.id, key, key === 'owner'],
      );
      a.memberId = (
        await client.query(
          'SELECT id FROM app.workspace_members WHERE workspace_id=$1 AND user_id=$2',
          [accounts.workspaceId, user.id],
        )
      ).rows[0].id;
    }
    // Never overwrite an existing approver or ACL. Only initialize a brand-new workspace.
    if (!existing)
      await client.query('UPDATE app.workspaces SET approver_member_id=$1 WHERE id=$2', [
        accounts.owner.memberId,
        accounts.workspaceId,
      ]);
    const factories = [];
    for (const [code, name] of [
      ['DEMO-A', '青禾布艺工厂 A（虚构）'],
      ['DEMO-B', '远山包装工厂 B（虚构）'],
    ]) {
      const inserted = await client.query(
        'INSERT INTO app.factories(workspace_id,factory_code,name,status) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,factory_code) DO NOTHING RETURNING id',
        [accounts.workspaceId, code, name, 'active'],
      );
      const f = (
        await client.query(
          'SELECT id FROM app.factories WHERE workspace_id=$1 AND factory_code=$2',
          [accounts.workspaceId, code],
        )
      ).rows[0];
      factories.push(f.id);
      if (code === 'DEMO-A' && inserted.rowCount)
        await client.query(
          'INSERT INTO app.factory_memberships(workspace_id,factory_id,member_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [accounts.workspaceId, f.id, accounts.sales.memberId],
        );
    }
    accounts.factories = factories;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  writeFileSync(file, JSON.stringify(accounts, null, 2) + '\n', { mode: 0o600 });
  console.log(
    'Controlled demo seed completed; existing profiles, names, memberships and business rows retained. Accounts: .local/a1-accounts.json (600).',
  );
} finally {
  await pool.end();
  await authPool.end();
}
