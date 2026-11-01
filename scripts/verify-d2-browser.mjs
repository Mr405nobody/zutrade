import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
let app;
try {
  app = spawn(process.execPath, ['scripts/d2-ui-serve.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let ready = false;
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    try {
      ready = (
        await fetch('http://127.0.0.1:5473/health/ready', { signal: AbortSignal.timeout(2000) })
      ).ok;
      if (ready) break;
    } catch {
      /* Starting services. */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) throw new Error('D2 isolated UI not ready');
  const fixture = JSON.parse(readFileSync('.local/d2-test-last.json'));
  const child = spawn(
    process.execPath,
    [
      '.local/toolchain/pnpm/node_modules/pnpm/bin/pnpm.mjs',
      'exec',
      'playwright',
      'test',
      'd2.spec.ts',
    ],
    {
      env: {
        ...process.env,
        D2_UI_BASE: 'http://127.0.0.1:5473',
        WEB_PORT: '5473',
        D2_UI_DATABASE: fixture.name,
      },
      stdio: 'inherit',
    },
  );
  process.exitCode = await new Promise((r) => child.once('exit', (code) => r(code ?? 1)));
} finally {
  if (app && app.exitCode === null) {
    const done = new Promise((r) => app.once('exit', r));
    app.kill('SIGTERM');
    await done;
  }
}
