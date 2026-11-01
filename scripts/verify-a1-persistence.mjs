import assert from 'node:assert/strict';
import { loadEnvFile } from 'node:process';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pg } from '@zutrade/db';
loadEnvFile('.env');
const accounts = JSON.parse(readFileSync('.local/a1-accounts.json', 'utf8'));
const pool = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
pool.on('error', () => {});
const adminUrl = new URL(process.env.DATABASE_URL);
adminUrl.username = process.env.POSTGRES_USER;
adminUrl.password = process.env.POSTGRES_PASSWORD;
const admin = new pg.Pool({ connectionString: adminUrl.href });
admin.on('error', () => {});
const base = `http://127.0.0.1:${process.env.API_PORT}`;
const origin = `http://127.0.0.1:${process.env.WEB_PORT}`;
async function login(role) {
  const response = await fetch(base + '/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', origin },
    body: JSON.stringify({ email: accounts[role].email, password: accounts[role].password }),
  });
  assert.equal(response.status, 200);
  return response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}
async function me(cookie) {
  const response = await fetch(base + '/api/me', { headers: { cookie } });
  assert.equal(response.status, 200);
  return response.json();
}
async function profile(cookie, name) {
  const response = await fetch(base + '/api/me', {
    method: 'PATCH',
    headers: { cookie, origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: name }),
  });
  assert.equal(response.status, 200);
}
function run(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.equal(result.status, 0, `${script} ${args.join(' ')} failed`);
  return result.stdout;
}
async function snapshot() {
  return {
    users: (
      await pool.query('SELECT id,auth_subject,display_name,status FROM app.app_users ORDER BY id')
    ).rows,
    members: (
      await pool.query(
        'SELECT id,workspace_id,user_id,role,status,all_factories FROM app.workspace_members ORDER BY id',
      )
    ).rows,
    factories: (
      await pool.query(
        'SELECT id,workspace_id,name,factory_code,status FROM app.factories ORDER BY id',
      )
    ).rows,
    workspaces: (
      await pool.query('SELECT id,name,approver_member_id FROM app.workspaces ORDER BY id')
    ).rows,
    auth: (await pool.query('SELECT id,email FROM auth."user" ORDER BY id')).rows,
  };
}
const checks = [];
let original, cookie;
let stopped = false;
try {
  cookie = await login('owner');
  const initial = await me(cookie);
  original = initial.user.display_name;
  const changed = original + ' · 持久化验收';
  await profile(cookie, changed);
  const before = await snapshot();
  const systemBefore = (await admin.query('SELECT system_identifier FROM pg_control_system()'))
    .rows[0].system_identifier;
  run('scripts/db-migrate.mjs');
  run('scripts/db-seed.mjs');
  assert.deepEqual(await snapshot(), before);
  checks.push({
    label:
      'repeat migration and seed preserve existing edited profile, membership and factory rows',
    result: 'passed',
  });
  // The named daily volume remains attached. Stop/start the same container without rebuild/reset/seed.
  run('scripts/infra.mjs', ['stop']);
  stopped = true;
  run('scripts/infra.mjs', ['start']);
  stopped = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(base + '/health/ready');
      if (r.ok) break;
    } catch {
      /* wait for restart */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.equal((await fetch(base + '/health/ready')).status, 200);
  const after = await snapshot();
  assert.deepEqual(after, before);
  const systemAfter = (await admin.query('SELECT system_identifier FROM pg_control_system()'))
    .rows[0].system_identifier;
  assert.equal(systemAfter, systemBefore);
  assert.equal((await me(cookie)).user.display_name, changed);
  for (const role of ['owner', 'sales']) {
    const accountCookie = await login(role);
    const identity = await me(accountCookie);
    assert.equal(identity.memberships[0].role, role);
    await fetch(base + '/api/auth/sign-out', {
      method: 'POST',
      headers: { cookie: accountCookie, origin, 'Content-Type': 'application/json' },
      body: '{}',
    });
  }
  checks.push({
    label:
      'preserved-volume database restart retains accounts, memberships, edited profile and active session; both accounts log in again',
    result: 'passed',
  });
  await profile(cookie, original);
  await fetch(base + '/api/auth/sign-out', {
    method: 'POST',
    headers: { cookie, origin, 'Content-Type': 'application/json' },
    body: '{}',
  });
  writeFileSync(
    'docs/build/evidence/a1/persistence.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        systemBefore,
        systemAfter,
        volume: 'zutrade_postgres_data',
        checks,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS repeated migration/seed and preserved-volume restart; test profile edit restored.',
  );
} finally {
  if (stopped) run('scripts/infra.mjs', ['start']);
  if (original && cookie) {
    try {
      await profile(cookie, original);
    } catch {
      /* best effort if session was already revoked */
    }
  }
  await pool.end();
  await admin.end();
}
