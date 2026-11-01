// D2 read-only daily audit. No approval, seed, migration or network change.
import { loadEnvFile } from 'node:process';
import { pg } from '@zutrade/db';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
loadEnvFile('.env');
const pool = new pg.Pool({
  connectionString: process.env.MIGRATION_DATABASE_URL,
  options: '-c default_transaction_read_only=on',
});
const evidence = 'docs/build/evidence/d2';
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(dir + '/' + e.name) : [dir + '/' + e.name],
  );
}
try {
  const demo = JSON.parse(readFileSync('docs/build/evidence/c/demo-ready.json'));
  const quote = (
    await pool.query(
      'SELECT id,version_no,total_amount,currency_code,state FROM app.quote_versions WHERE id=$1',
      [demo.quoteVersionId],
    )
  ).rows[0];
  const approval = (
    await pool.query('SELECT id,state,payload_version_id FROM app.approvals WHERE id=$1', [
      demo.approvalId,
    ])
  ).rows[0];
  const request = (
    await pool.query(
      'SELECT id,state,current_payload_version_id FROM app.outbound_requests WHERE id=$1',
      [demo.requestId],
    )
  ).rows[0];
  const snapshot = (
    await pool.query('SELECT snapshot_sha256 FROM app.outbound_payload_versions WHERE id=$1', [
      demo.payloadId,
    ])
  ).rows[0];
  const before = JSON.parse(readFileSync('docs/build/evidence/d1/baseline.json'));
  const original = readFileSync('zutrade-build-kit/references/zutrade-schema-v1.sql');
  const migrations = (
    await pool.query('SELECT hash,created_at FROM infra.business_migrations ORDER BY created_at')
  ).rows;
  if (
    JSON.stringify(migrations.slice(0, 13).map((r) => [r.created_at, r.hash])) !==
    JSON.stringify(before.migrations.map((r) => [r.created_at, r.hash]))
  )
    throw new Error('Prior applied migration identities changed');
  const gate = JSON.parse(readFileSync(evidence + '/gate-check.json'));
  if (
    !gate.migrations.every(
      (old, index) =>
        old.hash === migrations[index]?.hash && old.created_at === migrations[index]?.created_at,
    )
  )
    throw new Error('Prior D1 migration identities changed');
  const quantities = (
    await pool.query(
      "SELECT quantity::text FROM app.quote_lines WHERE quote_version_id=$1 AND line_kind='product' ORDER BY position",
      [demo.quoteVersionId],
    )
  ).rows.map((r) => r.quantity);
  const pdf = (
    await pool.query(
      'SELECT object_key,pdf_sha256,byte_length FROM app.quote_pdf_artifacts WHERE quote_version_id=$1',
      [demo.quoteVersionId],
    )
  ).rows[0];
  const bytes = readFileSync(
    resolve(
      process.env.PRIVATE_DATA_DIR ?? 'data/private',
      pdf.object_key.slice(0, 2),
      pdf.object_key,
    ),
  );
  if (
    createHash('sha256').update(bytes).digest('hex') !== demo.pdfSha256 ||
    pdf.pdf_sha256 !== demo.pdfSha256 ||
    bytes.length !== Number(pdf.byte_length) ||
    quantities.length !== 1 ||
    Number(quantities[0]) !== 500
  )
    throw new Error('Original Alex quantity/PDF changed');
  if (
    quote.version_no !== 17 ||
    quote.total_amount !== '1230.000000' ||
    approval.state !== 'pending' ||
    request.current_payload_version_id !== demo.payloadId
  )
    throw new Error('Original Alex handoff changed');
  const candidates = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean);
  const secrets = [
    process.env.BRAVE_SEARCH_API_KEY,
    process.env.BETTER_AUTH_SECRET,
    process.env.POSTGRES_PASSWORD,
  ];
  for (const k of [
    'MIGRATION_DATABASE_URL',
    'API_DATABASE_URL',
    'WORKER_DATABASE_URL',
    'AUTH_DATABASE_URL',
    'SIMULATION_DATABASE_URL',
  ])
    secrets.push(decodeURIComponent(new URL(process.env[k]).password));
  for (const p of [
    '.local/a1-accounts.json',
    '.local/b-accounts.json',
    '.local/c-ui-accounts.json',
    '.local/d1-test-last.json',
    '.local/d2-test-last.json',
  ]) {
    const o = JSON.parse(readFileSync(p));
    const collect = (v) => {
      if (v && typeof v === 'object')
        for (const [k, x] of Object.entries(v)) {
          if (k === 'password' && typeof x === 'string') secrets.push(x);
          else collect(x);
        }
    };
    collect(o);
  }
  const scan = [
    ...new Set([...candidates, ...files('apps/web/dist'), ...files('.local/logs')]),
  ].filter((p) => statSync(p).isFile());
  const matches = scan.filter((p) => {
    const b = readFileSync(p);
    return secrets.filter(Boolean).some((s) => b.includes(Buffer.from(s)));
  });
  const data = {
    observedAt: new Date().toISOString(),
    tables: (
      await pool.query(
        "SELECT schemaname,count(*)::int count FROM pg_tables WHERE schemaname IN('app','simulation','auth','pgboss') GROUP BY 1 ORDER BY 1",
      )
    ).rows,
    migrations,
    previousMigrationHashesUnchanged: true,
    alex: {
      quote,
      approval,
      request,
      snapshot,
      productQuantities: quantities,
      pdf: { sha256: pdf.pdf_sha256, byteLength: bytes.length, matchesOriginalBytes: true },
      businessApproval: 'pending; no business approval performed',
    },
    originalSql: {
      bytes: original.length,
      sha256: createHash('sha256').update(original).digest('hex'),
    },
    networkResolution:
      'D1 observations retained; real network validation deferred by user, no SSRF or Clash change',
    dailyD2Rows: (
      await pool.query(
        'SELECT (SELECT count(*) FROM app.outreach_batches)::int batches,(SELECT count(*) FROM app.followups)::int followups,(SELECT count(*) FROM app.leads WHERE prospecting_run_id IS NOT NULL)::int researchLeads',
      )
    ).rows[0],
    secretScan: { files: scan.length, matches },
    runtimeRoles: (
      await pool.query(
        "SELECT rolname,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname IN('zutrade_api','zutrade_worker') ORDER BY rolname",
      )
    ).rows,
  };
  writeFileSync(evidence + '/final-audit.json', JSON.stringify(data, null, 2) + '\n');
  if (matches.length)
    throw new Error(
      'Secret scan found matching paths; inspect local audit without printing secrets',
    );
  console.log(
    'D2 audit: migration identities, original SQL and Alex v17/pending retained; secret scan passed.',
  );
} finally {
  await pool.end();
}
