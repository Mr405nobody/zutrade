import { readFileSync } from 'node:fs';
// Incremental SQL remains authoritative. The baseline is still the original 42;
// future explicitly added app tables do not invalidate prior-stage regressions.
const folder = 'packages/db/migrations/business';
const journal = JSON.parse(readFileSync(`${folder}/meta/_journal.json`));
export const expectedBusinessTableNames = [
  ...new Set(
    journal.entries.flatMap(({ tag }) =>
      [
        ...readFileSync(`${folder}/${tag}.sql`, 'utf8').matchAll(
          /CREATE\s+TABLE\s+app\.([a-z_][a-z_0-9]*)\s*\(/gi,
        ),
      ].map((match) => match[1]),
    ),
  ),
].sort();
export const expectedBusinessTableCount = expectedBusinessTableNames.length;
export const baselineBusinessTableCount = [
  ...readFileSync('zutrade-build-kit/references/zutrade-schema-v1.sql', 'utf8').matchAll(
    /CREATE\s+TABLE\s+app\.([a-z_][a-z_0-9]*)\s*\(/gi,
  ),
].length;

export const expectedBusinessMigrationCount = journal.entries.length;
