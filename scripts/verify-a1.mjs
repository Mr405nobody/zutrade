import {
  expectedBusinessTableCount,
  expectedBusinessTableNames,
  expectedBusinessMigrationCount,
} from './business-table-expectations.mjs';
import assert from 'node:assert/strict';
import { loadEnvFile } from 'node:process';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import {
  pg,
  drizzle,
  businessSchema,
  createAuth,
  createAuthPool,
  createQueue,
  transaction,
  resolveIdentity,
  discoverMemberships,
  withWorkspace,
  renameFactoryAndEnqueue,
  requireApprover,
  consumeIdentityJob,
  migrate,
  getTableConfig,
} from '@zutrade/db';
loadEnvFile('.env');
const root = process.cwd();
const name = `zutrade_a1_test_${randomUUID().replaceAll('-', '')}`;
const output = process.env.EVIDENCE_PATH ?? 'docs/build/evidence/a1/integration.json';
mkdirSync('docs/build/evidence/a1', { recursive: true });
const checks = [];
const children = [];
const resources = [];
async function check(label, run) {
  await run();
  checks.push({ label, result: 'passed' });
  console.log(`PASS ${label}`);
}
const adminUrl = new URL(process.env.DATABASE_URL);
adminUrl.username = process.env.POSTGRES_USER;
adminUrl.password = process.env.POSTGRES_PASSWORD;
const admin = new pg.Pool({ connectionString: adminUrl.href });
const env = {
  ...process.env,
  POSTGRES_DB: name,
  API_PORT: '3101',
  WORKER_PORT: '3102',
  WEB_PORT: '5173',
};
for (const key of [
  'DATABASE_URL',
  'MIGRATION_DATABASE_URL',
  'API_DATABASE_URL',
  'WORKER_DATABASE_URL',
  'AUTH_DATABASE_URL',
]) {
  const url = new URL(process.env[key]);
  url.pathname = '/' + name;
  env[key] = url.href;
}
const migrator = new pg.Pool({ connectionString: env.MIGRATION_DATABASE_URL });
resources.push(migrator);
const api = new pg.Pool({ connectionString: env.API_DATABASE_URL, max: 2 });
resources.push(api);
const worker = new pg.Pool({ connectionString: env.WORKER_DATABASE_URL, max: 2 });
resources.push(worker);
const authPool = createAuthPool(env.MIGRATION_DATABASE_URL);
resources.push(authPool);
let auth;
for (const p of [...resources, admin])
  p.on('error', (error) =>
    console.error(JSON.stringify({ event: 'test_pool_closed', code: error.code })),
  );
let boss;
let succeeded = false;
function command(script) {
  const r = spawnSync(process.execPath, [script], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 60000,
  });
  if (r.status !== 0)
    throw new Error(`${script} failed (exit ${r.status}): ${r.stderr.slice(0, 1000)}`);
  return r.stdout;
}
async function expectDbFailure(run, code) {
  await assert.rejects(run, (e) => !code || e.code === code);
}
const url = 'http://127.0.0.1:3101';
async function http(path, { cookie, body, method = 'GET', headers = {} } = {}) {
  return fetch(url + path, {
    method,
    headers: {
      ...headers,
      ...(cookie ? { cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json', origin: 'http://127.0.0.1:5173' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function waitFor(path) {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(url + path)).ok) return;
    } catch {
      /* service has not bound its port yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('API startup timeout');
}
function launch(path) {
  const child = spawn(process.execPath, [path], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let text = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      text += chunk.toString();
    });
  children.push({ child, logs: () => text });
  return child;
}
const fixture = {
  workspace: randomUUID(),
  otherWorkspace: randomUUID(),
  factoryA: randomUUID(),
  factoryB: randomUUID(),
  otherFactory: randomUUID(),
};
const users = {};
try {
  await admin.query(`CREATE DATABASE "${name}"`);
  await check(
    'empty PostgreSQL migration with baseline plus incremental business tables and separate auth/queue tables',
    async () => {
      command('scripts/db-provision.mjs');
      command('scripts/db-migrate.mjs');
      const counts = (
        await migrator.query(
          "SELECT schemaname,count(*)::int AS count FROM pg_tables WHERE schemaname IN ('app','auth','pgboss','infra') GROUP BY schemaname ORDER BY schemaname",
        )
      ).rows;
      assert.equal(counts.find((r) => r.schemaname === 'app').count, expectedBusinessTableCount);
      assert.equal(counts.find((r) => r.schemaname === 'auth').count, 4);
      assert.ok(counts.find((r) => r.schemaname === 'pgboss').count > 0);
      fixture.tableCounts = counts;
      assert.equal(
        (
          await migrator.query(
            "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='app' AND tablename='prospecting_runs'",
          )
        ).rows[0].n,
        expectedBusinessTableNames.includes('prospecting_runs') ? 1 : 0,
      );
    },
  );
  await check(
    'Drizzle maps all current columns and ordered foreign keys to live catalogs',
    async () => {
      const configs = Object.entries(businessSchema)
        .filter(([key]) => key !== 'app')
        .map(([, table]) => getTableConfig(table));
      assert.equal(configs.length, expectedBusinessTableCount);
      const actual = (
        await migrator.query(
          `SELECT c.relname AS tab,a.attname AS col,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS required FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid WHERE n.nspname='app' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attname`,
        )
      ).rows;
      const mapped = configs
        .flatMap((t) =>
          t.columns.map((c) => ({
            tab: t.name,
            col: c.name,
            type: c.getSQLType().replaceAll(' ', ''),
            required: c.notNull,
          })),
        )
        .sort((a, b) => a.tab.localeCompare(b.tab) || a.col.localeCompare(b.col));
      const normalized = actual
        .map((c) => ({ ...c, type: c.type.replaceAll(' ', '') }))
        .sort((a, b) => a.tab.localeCompare(b.tab) || a.col.localeCompare(b.col));
      assert.equal(mapped.length, actual.length);
      assert.deepEqual(mapped, normalized);
      const actualFks = (
        await migrator.query(
          `SELECT con.conname AS name,(SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=k.num) AS cols,(SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=con.confrelid AND a.attnum=k.num) AS refs FROM pg_constraint con WHERE con.connamespace='app'::regnamespace AND contype='f' ORDER BY name`,
        )
      ).rows;
      const mappedFks = configs
        .flatMap((t) =>
          t.foreignKeys.map((f) => ({
            name: f.getName(),
            cols: f.reference().columns.map((c) => c.name),
            refs: f.reference().foreignColumns.map((c) => c.name),
          })),
        )
        .sort((a, b) => a.name.localeCompare(b.name));
      assert.deepEqual(
        mappedFks,
        actualFks.sort((a, b) => a.name.localeCompare(b.name)),
      );
    },
  );
  await check('repeated migrations preserve table OIDs and migration rows', async () => {
    const before = (
      await migrator.query(
        "SELECT oid,relname FROM pg_class WHERE relnamespace='app'::regnamespace ORDER BY relname",
      )
    ).rows;
    command('scripts/db-migrate.mjs');
    assert.deepEqual(
      (
        await migrator.query(
          "SELECT oid,relname FROM pg_class WHERE relnamespace='app'::regnamespace ORDER BY relname",
        )
      ).rows,
      before,
    );
    assert.equal(
      (await migrator.query('SELECT count(*)::int AS n FROM infra.business_migrations')).rows[0].n,
      expectedBusinessMigrationCount,
    );
  });
  await check(
    'mid-baseline error rolls back every business table and migration success entry',
    async () => {
      // A second disposable database tests the exact baseline in one transaction. A synthetic
      // final statement failure must undo all baseline objects; the daily volume is untouched.
      const failureName = name + '_failure';
      await admin.query(`CREATE DATABASE "${failureName}"`);
      const failureUrl = new URL(env.MIGRATION_DATABASE_URL);
      failureUrl.pathname = '/' + failureName;
      await admin.query(`GRANT CREATE ON DATABASE "${failureName}" TO zutrade_migrator`);
      const p = new pg.Pool({ connectionString: failureUrl.href });
      const folder = mkdtempSync('.local/failed-migration-');
      mkdirSync(`${folder}/meta`);
      writeFileSync(
        `${folder}/0000_baseline.sql`,
        readFileSync('packages/db/migrations/business/0000_baseline.sql'),
      );
      writeFileSync(`${folder}/0001_failure.sql`, 'SELECT 1/0;');
      writeFileSync(
        `${folder}/meta/_journal.json`,
        JSON.stringify({
          version: '7',
          dialect: 'postgresql',
          entries: [
            { idx: 0, version: '7', when: 1, tag: '0000_baseline', breakpoints: false },
            { idx: 1, version: '7', when: 2, tag: '0001_failure', breakpoints: false },
          ],
        }),
      );
      try {
        await assert.rejects(() =>
          migrate(drizzle(p), { migrationsFolder: folder, migrationsSchema: 'infra' }),
        );
        assert.equal(
          (await p.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='app'")).rows[0]
            .n,
          0,
        );
        assert.equal(
          (await p.query('SELECT count(*)::int AS n FROM infra.__drizzle_migrations')).rows[0].n,
          0,
        );
      } finally {
        await p.end();
        rmSync(folder, { recursive: true });
        await admin.query(`DROP DATABASE "${failureName}"`);
      }
    },
  );
  await check(
    'all business RLS, ordered composite FKs, freeze and append-only triggers retained',
    async () => {
      assert.equal(
        (
          await migrator.query(
            "SELECT count(*)::int AS n FROM pg_class WHERE relnamespace='app'::regnamespace AND relkind='r' AND relrowsecurity AND relforcerowsecurity",
          )
        ).rows[0].n,
        expectedBusinessTableCount,
      );
      assert.ok(
        (
          await migrator.query(
            "SELECT count(*)::int AS n FROM pg_constraint WHERE connamespace='app'::regnamespace AND contype='f' AND cardinality(conkey)>1",
          )
        ).rows[0].n >= 103,
      );
      const triggers = (
        await migrator.query(
          "SELECT tgname FROM pg_trigger WHERE tgrelid IN(SELECT oid FROM pg_class WHERE relnamespace='app'::regnamespace) AND NOT tgisinternal",
        )
      ).rows.map((r) => r.tgname);
      for (const t of [
        'source_version_frozen',
        'quote_version_frozen',
        'payload_version_frozen',
        'audit_events_append_only',
        'approval_events_append_only',
        'outbox_event_content_immutable',
      ])
        assert.ok(triggers.includes(t));
    },
  );
  await check(
    'API/worker/auth roles do not own business tables, bypass RLS or possess schema CREATE',
    async () => {
      for (const [role, pool] of [
        ['zutrade_api', api],
        ['zutrade_worker', worker],
      ]) {
        const row = (
          await pool.query(
            "SELECT r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,has_schema_privilege(current_user,'app','CREATE') AS app_create,has_schema_privilege(current_user,'auth','CREATE') AS auth_create,has_schema_privilege(current_user,'pgboss','CREATE') AS boss_create,(SELECT count(*) FROM pg_class WHERE relnamespace='app'::regnamespace AND relowner=r.oid)::int AS owned FROM pg_roles r WHERE rolname=current_user",
          )
        ).rows[0];
        assert.ok(Object.values(row).every((v) => v === false || v === 0));
        await expectDbFailure(() => pool.query('CREATE TABLE app.forbidden(id int)'), '42501');
        await expectDbFailure(() => pool.query('CREATE TABLE pgboss.forbidden(id int)'), '42501');
        assert.equal((await pool.query('SELECT current_user AS role')).rows[0].role, role);
      }
    },
  );
  auth = createAuth(authPool, env.BETTER_AUTH_SECRET, 5173, 3101, true);
  for (const key of ['owner', 'sales', 'outsider', 'noMembership', 'disabled']) {
    const password = randomBytes(24).toString('hex');
    const email = `${key}@test.invalid`;
    const result = await auth.api.signUpEmail({ body: { email, password, name: key } });
    users[key] = {
      subject: result.user.id,
      name: key,
      password,
      email,
      userId: randomUUID(),
      memberId: randomUUID(),
    };
  }
  await transaction(migrator, async (c) => {
    for (const [id, label] of [
      [fixture.workspace, 'Isolated A1 workspace'],
      [fixture.otherWorkspace, 'Isolated second workspace'],
    ])
      await c.query('INSERT INTO app.workspaces(id,name) VALUES($1,$2)', [id, label]);
    for (const [key, u] of Object.entries(users)) {
      if (key === 'noMembership') continue;
      await c.query('INSERT INTO app.app_users(id,auth_subject,display_name) VALUES($1,$2,$3)', [
        u.userId,
        u.subject,
        key,
      ]);
      await c.query(
        'INSERT INTO app.workspace_members(id,workspace_id,user_id,role,status,all_factories) VALUES($1,$2,$3,$4,$5,$6)',
        [
          u.memberId,
          key === 'outsider' ? fixture.otherWorkspace : fixture.workspace,
          u.userId,
          key === 'owner' || key === 'outsider' ? 'owner' : 'sales',
          key === 'disabled' ? 'disabled' : 'active',
          key === 'owner' || key === 'outsider',
        ],
      );
    }
    await c.query('UPDATE app.workspaces SET approver_member_id=$1 WHERE id=$2', [
      users.owner.memberId,
      fixture.workspace,
    ]);
    for (const [id, ws, code] of [
      [fixture.factoryA, fixture.workspace, 'A'],
      [fixture.factoryB, fixture.workspace, 'B'],
      [fixture.otherFactory, fixture.otherWorkspace, 'C'],
    ])
      await c.query(
        "INSERT INTO app.factories(id,workspace_id,name,factory_code,status) VALUES($1,$2,$3,$3,'active')",
        [id, ws, code],
      );
    await c.query(
      'INSERT INTO app.factory_memberships(workspace_id,factory_id,member_id) VALUES($1,$2,$3)',
      [fixture.workspace, fixture.factoryA, users.sales.memberId],
    );
  });
  const verified = (u) => ({ id: u.subject, name: u.name });
  await check(
    'concurrent first identity mapping converges without a membership or owner promotion',
    async () => {
      const identities = await Promise.all(
        Array.from({ length: 8 }, () =>
          transaction(api, (c) => resolveIdentity(c, verified(users.noMembership))),
        ),
      );
      assert.equal(new Set(identities.map((u) => u.id)).size, 1);
      const memberships = await transaction(api, async (c) => {
        const u = await resolveIdentity(c, verified(users.noMembership));
        return discoverMemberships(c, u.id);
      });
      assert.deepEqual(memberships, []);
    },
  );
  await check(
    'subject bootstrap discloses only the verified subject; no workspace discovers only own active membership',
    async () => {
      await transaction(api, async (c) => {
        await c.query("SELECT set_config('app.auth_subject',$1,true)", [users.sales.subject]);
        assert.deepEqual(
          (await c.query('SELECT auth_subject FROM app.app_users ORDER BY auth_subject')).rows.map(
            (r) => r.auth_subject,
          ),
          [users.sales.subject],
        );
        const u = await resolveIdentity(c, verified(users.sales));
        const ms = await discoverMemberships(c, u.id);
        assert.equal(ms.length, 1);
        assert.equal(ms[0].user_id, u.id);
        assert.equal((await c.query('SELECT count(*)::int AS n FROM app.factories')).rows[0].n, 0);
      });
    },
  );
  await check('sales RLS and service restrict reads and writes to factory A', async () => {
    await withWorkspace(api, verified(users.sales), fixture.workspace, async (ctx) => {
      assert.deepEqual(
        (await ctx.client.query('SELECT id FROM app.factories')).rows.map((r) => r.id),
        [fixture.factoryA],
      );
      assert.equal(
        (
          await ctx.client.query('UPDATE app.factories SET name=$1 WHERE id=$2', [
            'forbidden',
            fixture.factoryB,
          ])
        ).rowCount,
        0,
      );
      const mapped = await ctx.orm
        .select({ id: businessSchema.factoriesInApp.id })
        .from(businessSchema.factoriesInApp);
      assert.deepEqual(mapped, [{ id: fixture.factoryA }]);
    });
  });
  await check(
    'cross-workspace selection, writes and composite foreign-key association are blocked',
    async () => {
      await assert.rejects(
        () => withWorkspace(api, verified(users.sales), fixture.otherWorkspace, async () => {}),
        (e) => e.status === 403,
      );
      await withWorkspace(api, verified(users.owner), fixture.workspace, async (ctx) => {
        assert.equal(
          (
            await ctx.client.query('SELECT id FROM app.factories WHERE id=$1', [
              fixture.otherFactory,
            ])
          ).rowCount,
          0,
        );
        await ctx.client.query('SAVEPOINT negative');
        await expectDbFailure(
          () =>
            ctx.client.query(
              'INSERT INTO app.factory_memberships(workspace_id,factory_id,member_id) VALUES($1,$2,$3)',
              [fixture.otherWorkspace, fixture.otherFactory, users.owner.memberId],
            ),
          '42501',
        );
        await ctx.client.query('ROLLBACK TO SAVEPOINT negative');
        await expectDbFailure(
          () =>
            ctx.client.query(
              'INSERT INTO app.factory_memberships(workspace_id,factory_id,member_id) VALUES($1,$2,$3)',
              [fixture.workspace, fixture.otherFactory, users.sales.memberId],
            ),
          '23503',
        );
        await ctx.client.query('ROLLBACK TO SAVEPOINT negative');
        await expectDbFailure(
          () =>
            ctx.client.query(
              'INSERT INTO app.factory_memberships(workspace_id,factory_id,member_id) VALUES($1,$2,$3)',
              [fixture.workspace, fixture.factoryA, users.outsider.memberId],
            ),
          '23503',
        );
        await ctx.client.query('ROLLBACK TO SAVEPOINT negative');
      });
    },
  );
  await check(
    'commit, rollback and interleaved workspace transactions leave pooled contexts empty',
    async () => {
      for (let i = 0; i < 16; i++)
        await Promise.all([
          withWorkspace(api, verified(users.owner), fixture.workspace, async (ctx) => {
            assert.equal(
              (await ctx.client.query('SELECT app.current_workspace_id() AS id')).rows[0].id,
              fixture.workspace,
            );
          }),
          withWorkspace(api, verified(users.outsider), fixture.otherWorkspace, async (ctx) => {
            assert.equal(
              (await ctx.client.query('SELECT app.current_workspace_id() AS id')).rows[0].id,
              fixture.otherWorkspace,
            );
          }),
          assert.rejects(() =>
            withWorkspace(api, verified(users.sales), fixture.workspace, async () => {
              throw new Error('intentional rollback');
            }),
          ),
        ]);
      const clients = await Promise.all([api.connect(), api.connect()]);
      try {
        for (const c of clients) {
          const state = (
            await c.query(
              "SELECT nullif(current_setting('app.workspace_id',true),'') AS workspace,nullif(current_setting('app.user_id',true),'') AS usr,nullif(current_setting('app.auth_subject',true),'') AS subject",
            )
          ).rows[0];
          assert.deepEqual(state, { workspace: null, usr: null, subject: null });
          assert.equal(
            (await c.query('SELECT count(*)::int AS n FROM app.factories')).rows[0].n,
            0,
          );
        }
      } finally {
        clients.forEach((c) => c.release());
      }
    },
  );
  await check('only active designated owner passes approver boundary', async () => {
    await withWorkspace(api, verified(users.owner), fixture.workspace, async (ctx) =>
      requireApprover(ctx),
    );
    await assert.rejects(
      () =>
        withWorkspace(api, verified(users.sales), fixture.workspace, async (ctx) =>
          requireApprover(ctx),
        ),
      (e) => e.status === 403,
    );
    await assert.rejects(
      () =>
        withWorkspace(api, verified(users.outsider), fixture.otherWorkspace, async (ctx) =>
          requireApprover(ctx),
        ),
      (e) => e.status === 403,
    );
    await assert.rejects(
      () => withWorkspace(api, verified(users.disabled), fixture.workspace, async () => {}),
      (e) => e.status === 403,
    );
  });
  await check('worker row-lock grants cannot mutate factories or members', async () => {
    await withWorkspace(worker, verified(users.owner), fixture.workspace, async (ctx) => {
      await ctx.client.query('SAVEPOINT readonly');
      for (const table of ['factories', 'workspace_members']) {
        await expectDbFailure(
          () =>
            ctx.client.query(`UPDATE app.${table} SET id=id WHERE workspace_id=$1`, [
              fixture.workspace,
            ]),
          'P0001',
        );
        await ctx.client.query('ROLLBACK TO SAVEPOINT readonly');
      }
    });
  });
  boss = createQueue(env.API_DATABASE_URL);
  await boss.start();
  await check(
    'real pg-boss failure injection after business/outbox/enqueue and actual enqueue error rolls all back',
    async () => {
      for (const point of ['business', 'outbox', 'enqueue', 'queue']) {
        const key = randomUUID();
        const before = await migrator.query('SELECT name FROM app.factories WHERE id=$1', [
          fixture.factoryA,
        ]);
        const count = (await migrator.query('SELECT count(*)::int AS n FROM app.outbox_events'))
          .rows[0].n;
        const jobs = (await migrator.query('SELECT count(*)::int AS n FROM pgboss.job')).rows[0].n;
        await assert.rejects(
          () =>
            withWorkspace(api, verified(users.sales), fixture.workspace, (ctx) =>
              renameFactoryAndEnqueue(ctx, boss, fixture.factoryA, 'rollback-' + point, key, point),
            ),
          (error) =>
            point === 'queue'
              ? /not-initialized|does not exist|not found/i.test(error.message)
              : error.message ===
                `Injected after ${point === 'business' ? 'business write' : point === 'outbox' ? 'outbox write' : 'enqueue'}`,
        );
        assert.deepEqual(
          (await migrator.query('SELECT name FROM app.factories WHERE id=$1', [fixture.factoryA]))
            .rows,
          before.rows,
        );
        assert.equal(
          (await migrator.query('SELECT count(*)::int AS n FROM app.outbox_events')).rows[0].n,
          count,
        );
        assert.equal(
          (await migrator.query('SELECT count(*)::int AS n FROM pgboss.job')).rows[0].n,
          jobs,
        );
      }
    },
  );
  await check('committed command and idempotent retry create one event and real job', async () => {
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        withWorkspace(api, verified(users.sales), fixture.workspace, (ctx) =>
          renameFactoryAndEnqueue(ctx, boss, fixture.factoryA, 'Committed probe', key),
        ),
      ),
    );
    assert.equal(new Set(results.map((r) => r.jobId)).size, 1);
    fixture.committed = results[0];
    fixture.otherCommitted = await withWorkspace(
      api,
      verified(users.outsider),
      fixture.otherWorkspace,
      (ctx) =>
        renameFactoryAndEnqueue(
          ctx,
          boss,
          fixture.otherFactory,
          'Other workspace probe',
          randomUUID(),
        ),
    );
    assert.equal(
      (
        await migrator.query('SELECT count(*)::int AS n FROM pgboss.job WHERE id=$1', [
          fixture.committed.jobId,
        ])
      ).rows[0].n,
      1,
    );
  });
  await check(
    'business row, outbox and pg-boss job share one PostgreSQL transaction ID',
    async () => {
      const row = (
        await migrator.query(
          'SELECT f.xmin::text AS business,e.xmin::text AS event,j.xmin::text AS job FROM app.factories f JOIN app.outbox_events e ON e.aggregate_id=f.id JOIN pgboss.job j ON j.id=e.pg_boss_job_id WHERE e.id=$1',
          [fixture.committed.eventId],
        )
      ).rows[0];
      assert.ok(row);
      assert.equal(row.business, row.event);
      assert.equal(row.event, row.job);
    },
  );
  await check(
    'worker validates persisted event identity and current authorization instead of job hints',
    async () => {
      await assert.rejects(() =>
        consumeIdentityJob(
          worker,
          {
            eventId: fixture.committed.eventId,
            workspaceId: fixture.otherWorkspace,
            userId: users.outsider.userId,
          },
          fixture.committed.jobId,
        ),
      );
      await assert.rejects(() =>
        consumeIdentityJob(
          worker,
          {
            eventId: fixture.committed.eventId,
            workspaceId: fixture.workspace,
            userId: users.sales.userId,
          },
          randomUUID(),
        ),
      );
      await migrator.query("UPDATE app.workspace_members SET status='disabled' WHERE id=$1", [
        users.sales.memberId,
      ]);
      await assert.rejects(() =>
        consumeIdentityJob(
          worker,
          {
            eventId: fixture.committed.eventId,
            workspaceId: fixture.workspace,
            userId: users.sales.userId,
          },
          fixture.committed.jobId,
        ),
      );
      await migrator.query("UPDATE app.workspace_members SET status='active' WHERE id=$1", [
        users.sales.memberId,
      ]);
    },
  );
  launch('apps/api/dist/main.js');
  await waitFor('/health/live');
  await check(
    'real Better Auth HTTP login; anonymous APIs and public signup rejected',
    async () => {
      assert.equal((await http('/api/me')).status, 401);
      assert.equal(
        (
          await http('/api/auth/sign-up/email', {
            method: 'POST',
            body: { email: 'evil@test.invalid', password: 'long-long-password', name: 'evil' },
          })
        ).status,
        404,
      );
      for (const key of ['owner', 'sales', 'outsider', 'noMembership', 'disabled']) {
        const u = users[key];
        const r = await http('/api/auth/sign-in/email', {
          method: 'POST',
          body: { email: u.email, password: u.password },
        });
        assert.equal(r.status, 200);
        u.cookie = r.headers
          .getSetCookie()
          .map((s) => s.split(';')[0])
          .join('; ');
        assert.ok(u.cookie.includes('zutrade.session_token'));
      }
    },
  );
  await check(
    'forged client subject, role and workspace do not elevate HTTP authorization',
    async () => {
      const cookie = users.sales.cookie;
      const headers = {
        'x-auth-subject': users.owner.subject,
        'x-role': 'owner',
        'x-workspace-id': fixture.otherWorkspace,
      };
      const me = await http('/api/me?subject=' + users.owner.subject, { cookie, headers });
      assert.equal((await me.json()).user.id, users.sales.userId);
      assert.equal(
        (await http(`/api/workspaces/${fixture.workspace}/members`, { cookie, headers })).status,
        403,
      );
      assert.equal(
        (await http(`/api/workspaces/${fixture.otherWorkspace}/factories`, { cookie, headers }))
          .status,
        403,
      );
      assert.equal(
        (
          await http(`/api/workspaces/${fixture.workspace}/factories/${fixture.factoryB}`, {
            cookie,
            headers,
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await http(`/api/workspaces/${fixture.workspace}/factories/${fixture.factoryB}`, {
            cookie,
            method: 'PATCH',
            body: { name: 'forbidden', commandId: randomUUID() },
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await http(`/api/workspaces/${fixture.workspace}/factories/${fixture.factoryA}`, {
            cookie,
            method: 'PATCH',
            body: {
              name: 'forged',
              commandId: randomUUID(),
              role: 'owner',
              workspaceId: fixture.otherWorkspace,
            },
          })
        ).status,
        400,
      );
      assert.deepEqual(
        (await (await http('/api/me', { cookie: users.noMembership.cookie })).json()).memberships,
        [],
      );
      assert.deepEqual(
        (await (await http('/api/me', { cookie: users.disabled.cookie })).json()).memberships,
        [],
      );
    },
  );
  await check(
    'owner member management revokes sales immediately; assigned approver and cross-workspace grants protected',
    async () => {
      const path = `/api/workspaces/${fixture.workspace}/members/${users.sales.memberId}`;
      const body = {
        role: 'sales',
        status: 'disabled',
        allFactories: false,
        factoryIds: [fixture.factoryA],
      };
      assert.equal(
        (await http(path, { cookie: users.sales.cookie, method: 'PATCH', body })).status,
        403,
      );
      assert.equal(
        (await http(path, { cookie: users.owner.cookie, method: 'PATCH', body })).status,
        200,
      );
      assert.equal(
        (
          await http(`/api/workspaces/${fixture.workspace}/factories`, {
            cookie: users.sales.cookie,
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await http(path, {
            cookie: users.owner.cookie,
            method: 'PATCH',
            body: { ...body, status: 'active', factoryIds: [fixture.otherFactory] },
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await http(path, {
            cookie: users.owner.cookie,
            method: 'PATCH',
            body: { ...body, status: 'active' },
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await http(`/api/workspaces/${fixture.workspace}/approver`, {
            cookie: users.owner.cookie,
            method: 'POST',
            body: { memberId: users.sales.memberId },
          })
        ).status,
        409,
      );
    },
  );
  await check('logout and expired session are rejected before identity bootstrap', async () => {
    const u = users.noMembership;
    assert.equal(
      (await http('/api/auth/sign-out', { cookie: u.cookie, method: 'POST', body: {} })).status,
      200,
    );
    assert.equal((await http('/api/me', { cookie: u.cookie })).status, 401);
    await authPool.query(
      'UPDATE auth.session SET "expiresAt"=now()-interval \'1 second\' WHERE "userId"=$1',
      [users.outsider.subject],
    );
    assert.equal((await http('/api/me', { cookie: users.outsider.cookie })).status, 401);
    const before = (await migrator.query('SELECT count(*)::int AS n FROM app.app_users')).rows[0].n;
    assert.equal(
      (await http('/api/me', { headers: { 'x-auth-subject': users.owner.subject } })).status,
      401,
    );
    assert.equal(
      (await migrator.query('SELECT count(*)::int AS n FROM app.app_users')).rows[0].n,
      before,
    );
  });
  await check(
    'committed tasks survive worker absence and are consumed by the independent restricted worker',
    async () => {
      launch('apps/worker/dist/main.js');
      for (let i = 0; i < 100; i++) {
        const done = await migrator.query(
          "SELECT id FROM app.audit_events WHERE correlation_id=$1 AND action='a1.probe-consumed'",
          [fixture.committed.eventId],
        );
        const otherDone = await migrator.query(
          "SELECT id FROM app.audit_events WHERE workspace_id=$1 AND correlation_id=$2 AND action='a1.probe-consumed'",
          [fixture.otherWorkspace, fixture.otherCommitted.eventId],
        );
        if (done.rowCount && otherDone.rowCount) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.equal(
        (
          await migrator.query(
            "SELECT count(*)::int AS n FROM app.audit_events WHERE workspace_id=$1 AND correlation_id=$2 AND action='a1.probe-consumed'",
            [fixture.otherWorkspace, fixture.otherCommitted.eventId],
          )
        ).rows[0].n,
        1,
      );
      const done = (
        await migrator.query(
          "SELECT details FROM app.audit_events WHERE correlation_id=$1 AND action='a1.probe-consumed'",
          [fixture.committed.eventId],
        )
      ).rows;
      assert.equal(done.length, 1);
      assert.equal(done[0].details.workerRole, 'zutrade_worker');
      for (let i = 0; i < 30; i++) {
        const state = (
          await migrator.query('SELECT state FROM pgboss.job WHERE id=$1', [
            fixture.committed.jobId,
          ])
        ).rows[0].state;
        if (state === 'completed') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(
        (
          await migrator.query('SELECT state FROM pgboss.job WHERE id=$1', [
            fixture.committed.jobId,
          ])
        ).rows[0].state,
        'completed',
      );
      await consumeIdentityJob(
        worker,
        {
          eventId: fixture.committed.eventId,
          workspaceId: fixture.workspace,
          userId: users.sales.userId,
        },
        fixture.committed.jobId,
      );
      assert.equal(
        (
          await migrator.query(
            "SELECT count(*)::int AS n FROM app.audit_events WHERE correlation_id=$1 AND action='a1.probe-consumed'",
            [fixture.committed.eventId],
          )
        ).rows[0].n,
        1,
      );
    },
  );
  await check(
    'worker pool contexts are empty after failed hints and concurrent workspace jobs',
    async () => {
      const clients = await Promise.all([worker.connect(), worker.connect()]);
      try {
        for (const c of clients) {
          const row = (
            await c.query(
              "SELECT nullif(current_setting('app.workspace_id',true),'') AS workspace,nullif(current_setting('app.user_id',true),'') AS usr,nullif(current_setting('app.auth_subject',true),'') AS subject",
            )
          ).rows[0];
          assert.deepEqual(row, { workspace: null, usr: null, subject: null });
          assert.equal(
            (await c.query('SELECT count(*)::int AS n FROM app.factories')).rows[0].n,
            0,
          );
        }
      } finally {
        clients.forEach((c) => c.release());
      }
    },
  );
  succeeded = true;
} catch (error) {
  console.error(error);
  checks.push({
    label: 'failure',
    result: 'failed',
    detail: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
} finally {
  for (const { child } of children) child.kill('SIGTERM');
  await Promise.all(
    children.map(
      ({ child }) =>
        new Promise((resolve) => {
          if (child.exitCode !== null) return resolve();
          child.once('exit', resolve);
          setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
          }, 5000).unref();
        }),
    ),
  );
  if (boss) await boss.stop();
  await Promise.all(resources.map((p) => p.end()));
  // Only the uniquely named, explicitly disposable test database is removed, never the demo DB.
  if (succeeded) await admin.query(`DROP DATABASE "${name}"`);
  await admin.end();
  writeFileSync(
    output,
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        database: name,
        disposable: true,
        removed: succeeded,
        tableCounts: fixture.tableCounts,
        checks,
        childErrors: children
          .map((c) =>
            c
              .logs()
              .split('\n')
              .filter((line) => /error|failed/i.test(line)),
          )
          .flat(),
      },
      null,
      2,
    ) + '\n',
  );
}
