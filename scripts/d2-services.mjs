import { writeFileSync } from 'node:fs';
const result = await Promise.all(
  [
    ['daily', 5173, 3001, 3002],
    ['d2', 5473, 3701, 3702],
    ['c-history', 5273, 3401, 3402],
    ['d1-history', 5373, 3501, 3502],
  ].map(async ([name, web, api, worker]) => ({
    name,
    probes: await Promise.all(
      [
        [web, '/'],
        [api, '/health/ready'],
        [worker, '/health/live'],
      ].map(async ([port, path]) => {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          signal: AbortSignal.timeout(5000),
        });
        const body =
          path === '/'
            ? { zutrade: (await response.text()).includes('<title>ZuTrade') }
            : await response.json();
        if (!response.ok) process.exitCode = 1;
        return { port, path, status: response.status, body };
      }),
    ),
  })),
);
writeFileSync(
  'docs/build/evidence/d2/services-final.json',
  JSON.stringify({ observedAt: new Date().toISOString(), result }, null, 2) + '\n',
);
console.log('Sampled daily, D2 and historical services; no private configuration output.');
