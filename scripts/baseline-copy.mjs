import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const original = readFileSync('zutrade-build-kit/references/zutrade-schema-v1.sql');
const hash = createHash('sha256').update(original).digest('hex');
if (hash !== 'b7f72b68adce6ad161eedf66b65389cd35461ec20446a9e97fa560550c21a1fe')
  throw new Error('Original SQL checksum mismatch');
const lines = original.toString('utf8').split('\n');
if (lines[63] !== 'BEGIN;' || lines.at(-2) !== 'COMMIT;' || lines.at(-1) !== '')
  throw new Error('Unexpected outer transaction markers');
// Only the two verified top-level lines; preserve every other byte, including PL/pgSQL BEGINs.
const converted = lines.filter((_, i) => i !== 63 && i !== lines.length - 2).join('\n');
const path = 'packages/db/migrations/business/0000_baseline.sql';
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== converted) throw new Error('Baseline copy drift');
} else writeFileSync(path, converted);
console.log('Original checksum and exact two-line transformation verified.');
