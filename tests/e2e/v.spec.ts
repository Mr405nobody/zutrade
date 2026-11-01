import { test, expect } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { pg } from '@zutrade/db';
const enabled = Boolean(process.env.V_UI_BASE);
const f = enabled ? JSON.parse(readFileSync('.local/v-test-last.json', 'utf8')) : null;
test.skip(!enabled, 'V needs retained isolated database via test:v:browser');
test.use({ timezoneId: 'Asia/Shanghai' });
test('V 四入口、冻结历史、移动端、失败/加载反馈、下载/SSE/失效会话', async ({
  page,
  context,
}, info) => {
  test.setTimeout(120000);
  const evidence = 'docs/build/evidence/v/browser';
  mkdirSync(evidence, { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await context.route('**/*', (route) => {
    const u = new URL(route.request().url());
    return ['127.0.0.1', 'localhost'].includes(u.hostname)
      ? route.continue()
      : route.abort('blockedbyclient');
  });
  await page.goto(process.env.V_UI_BASE!);
  await page.getByLabel('邮箱', { exact: true }).fill(f.users.sales.email);
  await page.getByLabel('密码', { exact: true }).fill(f.users.sales.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '消息', exact: true })).toBeVisible();
  const base = `/api/workspaces/${f.ids.ws}`;
  async function capture(label: string) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `${evidence}/${info.project.name}-${label}.png`,
      fullPage: true,
    });
  }
  await expect(page.locator('[data-thread-id]').first()).toBeVisible();
  for (
    let i = 0;
    i < 5 && !(await page.locator(`[data-thread-id="${f.ui.threadId}"]`).count());
    i++
  ) {
    const more = page.getByRole('button', { name: '加载更多会话', exact: true });
    if (!(await more.count())) break;
    const before = await page.locator('[data-thread-id]').count();
    await more.click();
    await expect.poll(() => page.locator('[data-thread-id]').count()).toBeGreaterThan(before);
  }
  await page.locator(`[data-thread-id="${f.ui.threadId}"]`).click();
  await page.getByRole('button', { name: /内部工作区 · 仅团队可见/ }).click();
  const ai = page.getByRole('region', { name: '模拟 AI', exact: true });
  await expect(ai).toBeVisible();
  await expect(ai.locator('[data-ai-run]').first()).toBeVisible();
  const quotes = page.getByRole('region', { name: '采购需求与内部报价', exact: true });
  await expect(quotes).toContainText('1230.00');
  const approvals = page.getByRole('region', { name: '审批与模拟执行', exact: true });
  await expect(approvals).toContainText('模拟执行完成');
  await expect(approvals.getByRole('button', { name: '批准并模拟执行', exact: true })).toHaveCount(
    0,
  );
  await capture('inbox-history');
  // Private download is a real authorized HTTP request, not a web/public path.
  const pdf = await page.request.get(`${base}/quoting/versions/${f.ids.flow.quoteId}/pdf`);
  expect(pdf.status()).toBe(200);
  expect((await pdf.body()).subarray(0, 4).toString()).toBe('%PDF');
  await page.getByRole('button', { name: '找客户', exact: true }).click();
  await expect(page.getByText(/离线测试数据/).first()).toBeVisible();
  await page.getByRole('button', { name: /研究完成 · 3 家/ }).click();
  await page.getByRole('button', { name: '核对来源', exact: true }).first().click();
  const source = page.getByRole('dialog', { name: '候选来源' });
  await expect(source).toContainText('fictional');
  await capture('offline-source');
  await page.getByRole('button', { name: '关闭来源', exact: true }).click();
  await page.getByRole('button', { name: '产品', exact: true }).click();
  await expect(page.getByRole('heading', { name: '产品与可信供给' })).toBeVisible();
  await page.getByRole('button', { name: '查看来源与价阶', exact: true }).click();
  await expect(page.getByText('2.40', { exact: false }).first()).toBeVisible();
  await capture('product');
  await page.getByRole('button', { name: '待办', exact: true }).click();
  await expect(page.getByRole('region', { name: '审批待办', exact: true })).toBeVisible();
  await capture('todo');
  // Inject a visible read failure; restore and check that retry recovers the real server response.
  await context.route('**/api/workspaces/*/supply/products', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'V_TEST_UNAVAILABLE' }),
    }),
  );
  await page.getByRole('button', { name: '产品', exact: true }).click();
  await expect(
    page.getByText(/V_TEST_UNAVAILABLE|读取.*失败|暂不可用|请求失败/).first(),
  ).toBeVisible();
  await capture('read-failure');
  await context.unroute('**/api/workspaces/*/supply/products');
  await context.route('**/api/workspaces/*/supply/products', async (route) => {
    await new Promise((r) => setTimeout(r, 800));
    await route.continue();
  });
  await page.reload();
  await page.getByRole('button', { name: '产品', exact: true }).click();
  await expect(page.getByText('正在读取产品…', { exact: true })).toBeVisible();
  await capture('loading');
  await expect(page.getByRole('button', { name: '查看来源与价阶', exact: true })).toBeVisible();
  await context.unroute('**/api/workspaces/*/supply/products');
  await page.reload();
  await page.getByRole('button', { name: '产品', exact: true }).click();
  await expect(page.getByRole('button', { name: '查看来源与价阶', exact: true })).toBeVisible();
  // Check authorization on an established SSE connection and downloads after revocation.
  const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  const ac = new AbortController();
  const stream = await fetch(`http://127.0.0.1:4101${base}/inbox/events`, {
    headers: { cookie },
    signal: ac.signal,
  });
  expect(stream.status).toBe(200);
  const reader = stream.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('connected');
  const pool = new pg.Pool({ connectionString: f.env.MIGRATION_DATABASE_URL });
  try {
    await pool.query("UPDATE app.workspace_members SET status='disabled' WHERE id=$1", [
      f.users.sales.memberId,
    ]);
    expect([403, 404]).toContain(
      (await page.request.get(`${base}/quoting/versions/${f.ids.flow.quoteId}/pdf`)).status(),
    );
    let text = '';
    const deadline = Date.now() + 8000;
    while (!text.includes('permission-lost') && Date.now() < deadline) {
      const part = await reader.read();
      if (part.done) break;
      text += new TextDecoder().decode(part.value);
    }
    expect(text).toContain('permission-lost');
    await page.reload();
    await expect(
      page.getByText(/暂无有效工作区|无工作区|没有.*工作区|未加入|权限|暂不可用|尚无/).first(),
    ).toBeVisible();
    await expect(page.getByText(/指定审批人/)).toHaveCount(0);
    await capture('permission-revoked');
  } finally {
    ac.abort();
    await pool.query("UPDATE app.workspace_members SET status='active' WHERE id=$1", [
      f.users.sales.memberId,
    ]);
    await pool.end();
  }
  await page.request.post('/api/auth/sign-out', {
    data: {},
    headers: { origin: new URL(page.url()).origin },
  });
  expect(
    (await page.request.get(`${base}/quoting/versions/${f.ids.flow.quoteId}/pdf`)).status(),
  ).toBe(401);
  const denied = await fetch(`http://127.0.0.1:4101${base}/inbox/events`, {
    headers: { cookie },
    signal: AbortSignal.timeout(4000),
  });
  expect(denied.status).toBe(401);
  await page.reload();
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  await page.getByLabel('邮箱', { exact: true }).fill(f.users.outside.email);
  await page.getByLabel('密码', { exact: true }).fill(f.users.outside.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '还没有会话', exact: true })).toBeVisible();
  await capture('empty-other-workspace');
  expect([403, 404]).toContain(
    (await page.request.get(`${base}/quoting/versions/${f.ids.flow.quoteId}/pdf`)).status(),
  );
  expect(errors).toEqual([]);
  writeFileSync(
    `${evidence}/${info.project.name}.json`,
    JSON.stringify(
      {
        viewport: info.project.name,
        fourEntries: true,
        offlineLabel: true,
        quoteHistory: '1230.00',
        privatePdf: true,
        failureRecovery: true,
        permissionRevocation: true,
        sseRevocation: true,
        signoutInvalidatesSession: true,
        externalNetwork: 'blocked',
        errors,
      },
      null,
      2,
    ) + '\n',
  );
});
