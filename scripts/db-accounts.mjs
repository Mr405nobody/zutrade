import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
const path = resolve('.local/a1-accounts.json');
if (!existsSync(path)) throw new Error('Run db:seed first.');
console.log(
  `Credentials are stored only in ${path} (permissions 600). Open this file locally; do not paste it into chat, reports or screenshots.`,
);

const bPath = resolve('.local/b-accounts.json');
if (existsSync(bPath))
  console.log(
    `B supply/quote demo reuses the existing Alex workspace and accounts referenced in ${bPath} (permissions 600). Open this local file for B acceptance; no account has been recreated.`,
  );

const cPath = resolve('.local/c-ui-accounts.json');
if (existsSync(cPath))
  console.log(
    'C isolated approval/cancellation/unknown samples: ' +
      cPath +
      ' (permissions 600). Main Alex still uses the B account file above.',
  );
const d1Path = resolve('.local/d1-test-last.json');
if (existsSync(d1Path))
  console.log(
    'D1 isolated offline verification accounts: ' +
      d1Path +
      ' (permissions 600). Main real research uses the B accounts above; no new daily account.',
  );
const d2Path = resolve('.local/d2-test-last.json');
if (existsSync(d2Path))
  console.log(
    'D2 isolated offline batch/followup accounts: ' +
      d2Path +
      ' (permissions 600). Daily Alex remains on B accounts; no daily approval performed.',
  );

const ePath = resolve('.local/e-test-last.json');
if (existsSync(ePath))
  console.log(
    'E isolated simulated AI review accounts: ' +
      ePath +
      ' (permissions 600), users.owner/users.sales. Open locally only. Daily Alex remains on B accounts.',
  );

const vPath = resolve('.local/v-test-last.json');
if (existsSync(vPath))
  console.log(
    'V isolated offline review accounts: ' +
      vPath +
      ' (permissions 600), users.owner/users.sales. Backup and restore materials remain private under .local.',
  );
