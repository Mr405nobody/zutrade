import { spawn } from 'node:child_process';
let app;
try {
  app = spawn(process.execPath, ['scripts/d1-ui-serve.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const until = Date.now() + 12000;
  let ready = false;
  while (Date.now() < until) {
    try {
      ready = (
        await fetch('http://127.0.0.1:5373/health/ready', { signal: AbortSignal.timeout(2000) })
      ).ok;
      if (ready) break;
    } catch {
      /* service startup */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) throw new Error('D1 isolated services failed to start');
  const child = spawn(
    process.execPath,
    [
      '.local/toolchain/pnpm/node_modules/pnpm/bin/pnpm.mjs',
      'exec',
      'playwright',
      'test',
      'd1.spec.ts',
    ],
    {
      env: { ...process.env, D1_UI_BASE: 'http://127.0.0.1:5373', WEB_PORT: '5373' },
      stdio: 'inherit',
    },
  );
  process.exitCode = await new Promise((r) => child.once('exit', (code) => r(code ?? 1)));
} finally {
  if (app && app.exitCode === null) {
    const stopped = new Promise((r) => app.once('exit', r));
    app.kill('SIGTERM');
    await stopped;
  }
}
