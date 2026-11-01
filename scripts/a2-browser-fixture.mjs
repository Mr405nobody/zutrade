import { loadEnvFile } from 'node:process';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { pg, createAuth, createAuthPool, transaction } from '@zutrade/db';
loadEnvFile('.env');
const file = '.local/a2-browser-accounts.json';
const p = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
const authPool = createAuthPool(process.env.MIGRATION_DATABASE_URL);
const auth = createAuth(authPool, process.env.BETTER_AUTH_SECRET, 5173, 3001, true);
const a = existsSync(file)
  ? JSON.parse(readFileSync(file))
  : {
      workspaceId: randomUUID(),
      factories: [randomUUID(), randomUUID()],
      owner: {
        email: `a2-owner-${randomUUID()}@zutrade.test`,
        password: randomBytes(24).toString('base64url'),
      },
      sales: {
        email: `a2-sales-${randomUUID()}@zutrade.test`,
        password: randomBytes(24).toString('base64url'),
      },
    };
writeFileSync(file, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 });
chmodSync(file, 0o600);
try {
  for (const role of ['owner', 'sales']) {
    let u = (await authPool.query('SELECT id FROM auth."user" WHERE email=$1', [a[role].email]))
      .rows[0];
    if (!u)
      u = (
        await auth.api.signUpEmail({
          body: { email: a[role].email, password: a[role].password, name: `A2 测试 ${role}` },
        })
      ).user;
    a[role].subject = u.id;
  }
  await transaction(p, async (c) => {
    await c.query('INSERT INTO app.workspaces(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING', [
      a.workspaceId,
      'A2 浏览器独立测试工作区（虚构）',
    ]);
    for (const role of ['owner', 'sales']) {
      await c.query(
        'INSERT INTO app.app_users(auth_subject,display_name) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [a[role].subject, `A2 测试 ${role}`],
      );
      const u = (
        await c.query('SELECT id FROM app.app_users WHERE auth_subject=$1', [a[role].subject])
      ).rows[0];
      await c.query(
        'INSERT INTO app.workspace_members(workspace_id,user_id,role,all_factories) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [a.workspaceId, u.id, role, role === 'owner'],
      );
      a[role].memberId = (
        await c.query('SELECT id FROM app.workspace_members WHERE workspace_id=$1 AND user_id=$2', [
          a.workspaceId,
          u.id,
        ])
      ).rows[0].id;
    }
    for (const [i, id] of a.factories.entries())
      await c.query(
        "INSERT INTO app.factories(id,workspace_id,factory_code,name,status) VALUES($1,$2,$3,$4,'active') ON CONFLICT DO NOTHING",
        [id, a.workspaceId, i === 0 ? 'A2-A' : 'A2-B', `测试工厂 ${i === 0 ? 'A' : 'B'}（虚构）`],
      );
    await c.query(
      'INSERT INTO app.factory_memberships(workspace_id,factory_id,member_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [a.workspaceId, a.factories[0], a.sales.memberId],
    );
  });
  writeFileSync(file, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 });
  console.log(
    'Independent A2 browser workspace ready; private accounts retained at .local/a2-browser-accounts.json. Daily demo workspace untouched.',
  );
} finally {
  await p.end();
  await authPool.end();
}
