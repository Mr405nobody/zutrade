import { spawn } from 'node:child_process';
let app;
try {
  app = spawn(process.execPath, ['scripts/outbound-ui-serve.mjs'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    try {
      ready = (
        await fetch('http://127.0.0.1:5773/health/ready', { signal: AbortSignal.timeout(2000) })
      ).ok;
      if (ready) break;
    } catch {
      /* service starting */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!ready) throw new Error('Outbound isolated UI not ready');
  const child = spawn(
    process.execPath,
    [
      '.local/toolchain/pnpm/node_modules/pnpm/bin/pnpm.mjs',
      'exec',
      'playwright',
      'test',
      'outbound.spec.ts',
    ],
    {
      env: { ...process.env, OUTBOUND_UI_BASE: 'http://127.0.0.1:5773', WEB_PORT: '5773' },
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
