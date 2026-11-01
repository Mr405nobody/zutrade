import assert from 'node:assert/strict';
import { loadEnvFile } from 'node:process';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pg } from '@zutrade/db';
import { LocalPrivateObjectStore } from '@zutrade/storage';
loadEnvFile('.env');
const accounts = JSON.parse(readFileSync('.local/b-accounts.json', 'utf8'));
const tables = [
  'products',
  'source_documents',
  'source_versions',
  'facts',
  'fact_versions',
  'fact_evidence',
  'price_rules',
  'opportunities',
  'opportunity_threads',
  'quotes',
  'quote_versions',
  'quote_lines',
  'quote_evidence',
  'quote_pdf_artifacts',
  'buyers',
  'contacts',
  'threads',
  'messages',
  'team_notes',
  'workspace_members',
];
const pool = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
const store = new LocalPrivateObjectStore(resolve(process.env.PRIVATE_DATA_DIR ?? 'data/private'));
async function snapshot() {
  const state = {};
  for (const table of tables) {
    const rows = (
      await pool.query(`SELECT * FROM app.${table} WHERE workspace_id=$1 ORDER BY id`, [
        accounts.workspaceId,
      ])
    ).rows;
    state[table] = {
      rows: rows.length,
      sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    };
  }
  const files = (
    await pool.query(
      "SELECT object_key,pdf_sha256,byte_length FROM app.quote_pdf_artifacts WHERE workspace_id=$1 AND state='ready' ORDER BY id",
      [accounts.workspaceId],
    )
  ).rows;
  for (const file of files)
    await store.readVerified({
      key: file.object_key,
      sha256: file.pdf_sha256,
      byteLength: Number(file.byte_length),
    });
  return { tables: state, pdfObjects: files.length };
}
function infra(action) {
  const result = spawnSync(process.execPath, ['scripts/infra.mjs', action], {
    encoding: 'utf8',
    timeout: 45000,
  });
  if (result.status !== 0) throw new Error('infra ' + action + ' failed');
  return result.stdout;
}
let stopped = false;
try {
  const before = await snapshot();
  if (before.pdfObjects < 1) throw new Error('Need a real saved PDF before persistence check');
  infra('stop');
  stopped = true;
  infra('start');
  stopped = false;
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch {
      if (Date.now() > deadline) throw new Error('DB restart did not recover');
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const after = await snapshot();
  assert.deepEqual(after, before);
  writeFileSync(
    'docs/build/evidence/b/persistence.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        method:
          'Actual Colima zutrade PostgreSQL container stop/start, existing volume retained; no seed or migration between snapshots.',
        ...after,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS retained-volume restart: complete B and A2 relationship snapshots and every saved PDF object preserved.',
  );
} finally {
  if (stopped) infra('start');
  await pool.end();
}
