import { writeFileSync } from 'node:fs';
const samples = [];
for (const [name, web, api, worker] of [
  ['daily', 5173, 3001, 3002],
  ['e', 5573, 3901, 3902],
]) {
  const probes = [];
  for (const [port, path] of [
    [web, '/'],
    [api, '/health/ready'],
    [worker, '/health/ready'],
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(5000),
    });
    const body =
      path === '/'
        ? { zutrade: (await response.text()).includes('<title>ZuTrade') }
        : await response.json();
    probes.push({ port, path, status: response.status, body });
    if (!response.ok) process.exitCode = 1;
  }
  samples.push({ name, probes });
}
writeFileSync(
  'docs/build/evidence/e/services-final.json',
  JSON.stringify({ observedAt: new Date().toISOString(), samples }, null, 2) + '\n',
);
console.log('Daily and E services sampled; no private configuration printed.');
