import { loadEnvFile } from 'node:process';
import { writeFileSync } from 'node:fs';
import { pg, withWorkspace } from '@zutrade/db';
import { readFileSync } from 'node:fs';
import { quoteVersionDetail } from '@zutrade/domain';
loadEnvFile('.env');
const p = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
try {
  const rows = (
    await p.query(
      "SELECT datname FROM pg_database WHERE datname LIKE 'zutrade_b_test_%' OR datname LIKE 'zutrade_b_supply_%' ORDER BY datname",
    )
  ).rows;
  writeFileSync(
    'docs/build/evidence/b/retained-test-databases.json',
    JSON.stringify(
      {
        purpose:
          'Exact B failure database inventory; retained for debugging, never fuzzy-deleted. Successful current test databases removed by their exact name.',
        databases: rows.map((r) => r.datname),
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await p.end();
}
const accounts = JSON.parse(readFileSync('.local/b-accounts.json', 'utf8'));
const ready = JSON.parse(readFileSync('docs/build/evidence/b/demo-ready.json', 'utf8'));
const runtime = new pg.Pool({ connectionString: process.env.API_DATABASE_URL });
try {
  const result = await withWorkspace(
    runtime,
    { id: accounts.owner.subject, name: 'B demo' },
    accounts.workspaceId,
    (c) => quoteVersionDetail(c, ready.versionId),
  );
  if (!result.availability.available || result.snapshot.totalAmount !== '1230.00')
    throw new Error('Demo state changed');
  console.log('Current CT-01 demo remains available with frozen USD 1230.00.');
} finally {
  await runtime.end();
}
