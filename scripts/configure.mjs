import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';

if (!existsSync('.env')) {
  const admin = randomBytes(24).toString('hex');
  const runtime = randomBytes(24).toString('hex');
  const template = readFileSync('.env.example', 'utf8')
    .replaceAll('replace-with-generated-local-secret', admin)
    .replaceAll('replace-with-another-generated-local-secret', runtime);
  writeFileSync('.env', template, { mode: 0o600, flag: 'wx' });
  console.log('Generated .env with independent local secrets; existing files are preserved.');
}
for (const path of ['data', 'data/private', '.local/logs']) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}
