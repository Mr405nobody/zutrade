// Bounded real network check. Does not use offline injection or approve business actions.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const base = 'http://127.0.0.1:5173',
  accounts = JSON.parse(readFileSync('.local/b-accounts.json'));
const response = await fetch(base + '/api/auth/sign-in/email', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: base },
  body: JSON.stringify({ email: accounts.owner.email, password: accounts.owner.password }),
  signal: AbortSignal.timeout(10000),
});
if (!response.ok) throw new Error('Existing local owner login failed');
const cookie = response.headers
  .getSetCookie()
  .map((s) => s.split(';')[0])
  .join('; ');
async function api(path, body) {
  const r = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { cookie, ...(body ? { 'content-type': 'application/json', origin: base } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error('Local API returned ' + r.status);
  return r.json();
}
const prefix = `/api/workspaces/${accounts.workspaceId}`;
const products = await api(prefix + '/supply/products');
const product = products.items.find((p) => p.sku === 'CT-01');
if (!product) throw new Error('Existing CT-01 product required; no initialization performed');
const evidence = 'docs/build/evidence/d1';
mkdirSync(evidence, { recursive: true });
const runs = [];
for (const [country, directoryId] of [
  ['SG', 'wikimedia-events-sg'],
  ['GB', 'wikimedia-events-gb'],
  ['AU', 'wikimedia-events-au'],
]) {
  const created = await api(prefix + '/prospecting/runs', {
    commandId: randomUUID(),
    factoryId: product.factory_id,
    productId: product.id,
    provider: 'public_directory',
    directoryId,
    country,
    buyerType: 'event management',
    keywords: ['events', 'promotional'],
    exclusions: [],
    limit: 3,
  });
  const until = Date.now() + 195000;
  let detail;
  while (Date.now() < until) {
    detail = await api(prefix + '/prospecting/runs/' + created.runId);
    if (detail.run.finished_at) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  runs.push(detail);
  console.log(
    JSON.stringify({
      runId: created.runId,
      country,
      state: detail.run.state,
      error: detail.run.error,
      candidates: detail.run.candidate_count,
      requests: detail.run.request_count,
    }),
  );
}
writeFileSync(
  evidence + '/live-check.json',
  JSON.stringify(
    {
      observedAt: new Date().toISOString(),
      provider: 'PublicDirectoryProvider',
      origin: 'live_network',
      runs,
      verification:
        runs.filter((r) => r.run.candidate_count > 0).length >= 2
          ? 'sources_available'
          : 'verification_blocked',
      sourceSpotChecks: [],
      leadImport: 'not_executed_no_real_candidates',
    },
    null,
    2,
  ) + '\n',
);
if (runs.filter((r) => r.run.candidate_count > 0).length < 2) process.exitCode = 2;
