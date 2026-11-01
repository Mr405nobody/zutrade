// V recovery exercises retained isolated data only; never replaces source DB or files.
import assert from 'node:assert/strict';
import { pg, withWorkspace, assertRuntimeRole, createQueue } from '@zutrade/db';
import { quoteVersionDetail, downloadQuotePdf, saveFollowup } from '@zutrade/domain';
import { LocalPrivateObjectStore } from '@zutrade/storage';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  cpSync,
  readdirSync,
  chmodSync,
  statSync,
  createWriteStream,
} from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';
const f = JSON.parse(readFileSync('.local/v-test-last.json'));
if (!/^zutrade_v_test_[a-f0-9]{32}$/.test(f.name)) throw new Error('V isolated source required');
const ev = 'docs/build/evidence/v';
mkdirSync(ev, { recursive: true });
const root = mkdtempSync(resolve('.local/v-recovery-'));
chmodSync(root, 0o700);
const backup = root + '/backup',
  restored = root + '/restore/private';
mkdirSync(backup, { mode: 0o700 });
const checks = [],
  stages = [];
const hash = (b) => createHash('sha256').update(b).digest('hex');
const adminUrl = new URL(f.env.DATABASE_URL);
adminUrl.username = f.env.POSTGRES_USER;
adminUrl.password = f.env.POSTGRES_PASSWORD;
const admin = new pg.Pool({ connectionString: adminUrl.href });
admin.on('error', () => {});
const newName = 'zutrade_v_restore_' + randomUUID().replaceAll('-', '');
const emptyName = 'zutrade_v_empty_' + randomUUID().replaceAll('-', '');
const envFor = (name) => {
  const e = { ...f.env, POSTGRES_DB: name };
  for (const k of [
    'DATABASE_URL',
    'MIGRATION_DATABASE_URL',
    'API_DATABASE_URL',
    'WORKER_DATABASE_URL',
    'AUTH_DATABASE_URL',
    'SIMULATION_DATABASE_URL',
  ]) {
    const u = new URL(e[k]);
    u.pathname = '/' + name;
    e[k] = u.href;
  }
  return e;
};
function command(script, env = f.env, args = []) {
  const r = spawnSync(process.execPath, [script, ...args], {
    env,
    encoding: 'utf8',
    timeout: 60000,
  });
  stages.push({ script, args, exitCode: r.status });
  assert.equal(r.status, 0, script + ' failed: ' + r.stderr?.slice(0, 1500));
  return r.stdout;
}
async function snapshot(url) {
  const p = new pg.Pool({ connectionString: url });
  try {
    const tables = (
      await p.query("SELECT tablename FROM pg_tables WHERE schemaname='app' ORDER BY tablename")
    ).rows;
    const result = {};
    for (const { tablename: t } of tables) {
      if (!/^[a-z_]+$/.test(t)) throw new Error('Invalid catalog identifier');
      const rows = (
        await p.query(`SELECT to_jsonb(t) AS row FROM app.${t} t ORDER BY to_jsonb(t)::text`)
      ).rows;
      result[t] = { count: rows.length, sha256: hash(JSON.stringify(rows)) };
    }
    const jobs = (
      await p.query(
        "SELECT id,name,data,start_after,state FROM pgboss.job WHERE name='d2.followup' AND state='created' ORDER BY id",
      )
    ).rows;
    return { tables: result, futureJobs: jobs };
  } finally {
    await p.end();
  }
}
async function waitReady() {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    try {
      if (
        (await fetch('http://127.0.0.1:5673/health/ready', { signal: AbortSignal.timeout(1000) }))
          .ok
      )
        return;
    } catch {
      /* starting */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('V services not ready');
}
let app,
  successful = false,
  container;
const log = createWriteStream('.local/logs/v-recovery.log', { flags: 'a', mode: 0o600 });
async function start() {
  app = spawn(process.execPath, ['scripts/v-ui-serve.mjs'], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout.pipe(log, { end: false });
  app.stderr.pipe(log, { end: false });
  await waitReady();
}
async function stop() {
  if (!app || app.exitCode !== null) return;
  const done = new Promise((r) => app.once('exit', r));
  app.kill('SIGTERM');
  await done;
  app = null;
}
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(dir + '/' + e.name) : [dir + '/' + e.name],
  );
}
function manifest(dir) {
  return files(dir)
    .sort()
    .map((p) => ({
      path: relative(dir, p),
      bytes: statSync(p).size,
      sha256: hash(readFileSync(p)),
    }));
}
let dbStopped = false;
try {
  // Add one explicit isolated reminder using the current context, after earlier stop/revocation tests.
  const preparePool = new pg.Pool({ connectionString: f.env.API_DATABASE_URL });
  const prepareQueue = createQueue(f.env.API_DATABASE_URL);
  try {
    await prepareQueue.start();
    const reminder = await withWorkspace(
      preparePool,
      { id: f.users.sales.subject, name: 'sales' },
      f.ids.ws,
      (c) =>
        saveFollowup(
          c,
          prepareQueue,
          {
            commandId: randomUUID(),
            followupId: null,
            expectedVersion: null,
            threadId: f.ui.threadId,
            opportunityId: f.ui.opportunityId,
            ownerMemberId: f.users.sales.memberId,
            quoteVersionId: null,
            purpose: 'V 恢复验证：当前有效的人工提醒',
            internalDraft: 'V_PRIVATE_RECOVERY_REMINDER',
            mode: 'manual',
            localTime: new Date(Date.now() + 86400000).toISOString().slice(0, 16),
            timeZone: 'UTC',
            disambiguation: 'reject',
            subject: 'V reminder',
            body: '',
          },
          new LocalPrivateObjectStore(f.env.PRIVATE_DATA_DIR),
        ),
    );
    f.ids.flow.recoveryFollowupId = reminder.id;
    writeFileSync('.local/v-test-last.json', JSON.stringify(f, null, 2) + '\n', { mode: 0o600 });
  } finally {
    await prepareQueue.stop();
    await preparePool.end();
  }
  await start();
  const response = await fetch('http://127.0.0.1:4101/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', origin: 'http://127.0.0.1:5673' },
    body: JSON.stringify({ email: f.users.sales.email, password: f.users.sales.password }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers
    .getSetCookie()
    .map((x) => x.split(';')[0])
    .join('; ');
  await new Promise((r) => setTimeout(r, 2500)); // let already completed test jobs be acknowledged
  await stop();
  const before = await snapshot(f.env.MIGRATION_DATABASE_URL);
  assert.ok(
    before.tables.messages.count > 0 &&
      before.tables.thread_reads.count > 0 &&
      before.tables.ai_runs.count > 0,
  );
  assert.ok(before.futureJobs.length > 0);
  const systemBefore = (await admin.query('SELECT system_identifier FROM pg_control_system()'))
    .rows[0].system_identifier;
  container = execFileSync(
    'docker',
    [
      'ps',
      '--filter',
      'label=com.docker.compose.project=zutrade',
      '--filter',
      'label=com.docker.compose.service=postgres',
      '-q',
    ],
    { encoding: 'utf8' },
  ).trim();
  assert.match(container, /^[a-f0-9]{12,64}$/);
  const volumeBefore = JSON.parse(
    execFileSync('docker', ['inspect', container], { encoding: 'utf8' }),
  )[0]
    .Mounts.filter((m) => m.Type === 'volume')
    .map((m) => ({ Name: m.Name, Destination: m.Destination }));
  command('scripts/infra.mjs', process.env, ['stop']);
  dbStopped = true;
  command('scripts/infra.mjs', process.env, ['start']);
  dbStopped = false;
  assert.deepEqual(await snapshot(f.env.MIGRATION_DATABASE_URL), before);
  assert.equal(
    (await admin.query('SELECT system_identifier FROM pg_control_system()')).rows[0]
      .system_identifier,
    systemBefore,
  );
  const volumeAfter = JSON.parse(
    execFileSync('docker', ['inspect', container], { encoding: 'utf8' }),
  )[0]
    .Mounts.filter((m) => m.Type === 'volume')
    .map((m) => ({ Name: m.Name, Destination: m.Destination }));
  assert.deepEqual(volumeAfter, volumeBefore);
  await start();
  assert.equal((await fetch('http://127.0.0.1:4101/api/me', { headers: { cookie } })).status, 200);
  await new Promise((r) => setTimeout(r, 1500));
  await stop();
  assert.deepEqual(await snapshot(f.env.MIGRATION_DATABASE_URL), before);
  checks.push({
    label:
      'web/API/worker 与同一数据库容器保留 volume 重启；全部 app 行摘要、已读、来源、冻结审批、AI、未来 job 与原会话一致',
    result: 'passed',
    systemIdentifier: systemBefore,
    volumeBefore,
    volumeAfter,
    tables: before.tables,
    futureJobs: before.futureJobs.length,
  });
  // All V writers are stopped. The dump and private bytes share this quiescent point.
  const dump = execFileSync(
    'docker',
    [
      'exec',
      container,
      'sh',
      '-c',
      'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U "$POSTGRES_USER" -Fc "$1"',
      'v-dump',
      f.name,
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  writeFileSync(backup + '/database.dump', dump, { mode: 0o600 });
  cpSync(f.env.PRIVATE_DATA_DIR, backup + '/private', {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  for (const p of files(backup)) chmodSync(p, 0o600);
  const objects = manifest(backup + '/private');
  writeFileSync(
    backup + '/manifest.json',
    JSON.stringify({ source: f.name, dumpSha256: hash(dump), objects }, null, 2),
    { mode: 0o600 },
  );
  await admin.query(`CREATE DATABASE "${newName}"`);
  const restoredEnv = envFor(newName);
  restoredEnv.PRIVATE_DATA_DIR = restored;
  const restore = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      container,
      'sh',
      '-c',
      'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -U "$POSTGRES_USER" --exit-on-error -d "$1"',
      'v-restore',
      newName,
    ],
    { input: dump, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
  );
  assert.equal(restore.status, 0, 'pg_restore failed: ' + restore.stderr?.slice(0, 1000));
  cpSync(backup + '/private', restored, { recursive: true, errorOnExist: true, force: false });
  assert.deepEqual(manifest(restored), objects);
  assert.deepEqual(await snapshot(restoredEnv.MIGRATION_DATABASE_URL), before);
  const runtime = new pg.Pool({ connectionString: restoredEnv.API_DATABASE_URL });
  try {
    await assertRuntimeRole(runtime);
    const store = new LocalPrivateObjectStore(restored);
    await withWorkspace(
      runtime,
      { id: f.users.sales.subject, name: 'sales' },
      f.ids.ws,
      async (c) => {
        const q = await quoteVersionDetail(c, f.ids.flow.quoteId);
        assert.equal(q.snapshot.totalAmount, '1230.00');
        await downloadQuotePdf(c, f.ids.flow.quoteId, store);
        const pdf = (
          await c.client.query('SELECT * FROM app.quote_pdf_artifacts WHERE quote_version_id=$1', [
            f.ids.flow.quoteId,
          ])
        ).rows[0];
        await store.readVerified({
          key: pdf.object_key,
          sha256: pdf.pdf_sha256,
          byteLength: Number(pdf.byte_length),
        });
        const frozen = (
          await c.client.query('SELECT * FROM app.outbound_payload_versions WHERE id=$1', [
            f.ids.flow.payloadId,
          ])
        ).rows[0];
        assert.ok(frozen.snapshot_sha256);
        assert.ok(frozen.body_text);
      },
    );
  } finally {
    await runtime.end();
  }
  assert.deepEqual(await snapshot(f.env.MIGRATION_DATABASE_URL), before);
  checks.push({
    label:
      'pg_dump/pg_restore 到独立新库和目录；全部 app 数据、报价版本/冻结正文与私有附件摘要一致，runtime 可授权下载，原数据未覆盖',
    result: 'passed',
    database: newName,
    dumpSha256: hash(dump),
    dumpBytes: dump.length,
    objectCount: objects.length,
    objects,
  });
  await admin.query(`CREATE DATABASE "${emptyName}"`);
  const emptyEnv = envFor(emptyName);
  command('scripts/db-provision.mjs', emptyEnv);
  command('scripts/db-migrate.mjs', emptyEnv);
  const ep = new pg.Pool({ connectionString: emptyEnv.MIGRATION_DATABASE_URL });
  try {
    assert.equal(
      (await ep.query('SELECT count(*)::int n FROM infra.business_migrations')).rows[0].n,
      20,
    );
    assert.equal((await ep.query('SELECT count(*)::int n FROM app.workspaces')).rows[0].n, 0);
  } finally {
    await ep.end();
  }
  // Boot an empty current-schema system on distinct ports, no implicit seed/reset.
  const emptyApi = spawn(process.execPath, ['apps/api/dist/main.js'], {
    env: { ...emptyEnv, API_PORT: '4201', WORKER_PORT: '4202', WEB_PORT: '5773' },
    stdio: 'ignore',
  });
  const emptyWorker = spawn(process.execPath, ['apps/worker/dist/main.js'], {
    env: { ...emptyEnv, API_PORT: '4201', WORKER_PORT: '4202', WEB_PORT: '5773' },
    stdio: 'ignore',
  });
  try {
    const deadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        ready = (
          await fetch('http://127.0.0.1:4201/health/ready', { signal: AbortSignal.timeout(1000) })
        ).ok;
        if (ready) break;
      } catch {
        /*starting*/
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(ready, 'Empty current-schema API/worker readiness');
    assert.equal((await fetch('http://127.0.0.1:4201/api/me')).status, 401);
  } finally {
    for (const c of [emptyApi, emptyWorker]) {
      const done = new Promise((r) => c.once('exit', r));
      c.kill('SIGTERM');
      await done;
    }
  }
  checks.push({
    label: '另一个真正空库执行全部迁移及队列初始化，API/worker 实际启动且未登录返回401',
    result: 'passed',
    database: emptyName,
  });
  writeFileSync(
    '.local/v-recovery-last.json',
    JSON.stringify(
      {
        root,
        backup,
        restored,
        source: f.name,
        restoredDatabase: newName,
        emptyDatabase: emptyName,
        env: restoredEnv,
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  successful = true;
} finally {
  await stop();
  if (dbStopped) command('scripts/infra.mjs', process.env, ['start']);
  await admin.end();
  log.end();
  writeFileSync(
    ev + '/recovery.json',
    JSON.stringify(
      {
        observedAt: new Date().toISOString(),
        successful,
        sourceDatabase: f.name,
        restoreDatabase: newName,
        emptyDatabase: emptyName,
        checks,
        stages,
        privateMaterials: '.local/v-recovery-last.json (local only)',
      },
      null,
      2,
    ) + '\n',
  );
}
