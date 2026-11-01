import { test, expect } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
const enabled = Boolean(process.env.D1_UI_BASE);
const session = enabled ? JSON.parse(readFileSync('.local/d1-test-last.json', 'utf8')) : null;
test.skip(!enabled, 'D1 requires retained isolated test database via test:d1:browser');
const evidence = 'docs/build/evidence/d1/browser';
test('D1 桌面/手机：来源、保留、排除、导入幂等、真实网络错误', async ({ page }, info) => {
  test.setTimeout(120000);
  mkdirSync(evidence, { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(process.env.D1_UI_BASE!);
  await page.getByLabel('邮箱', { exact: true }).fill(session.users.sales.email);
  await page.getByLabel('密码', { exact: true }).fill(session.users.sales.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '找客户', exact: true }).click();
  await expect(page.getByRole('heading', { name: '找客户', exact: true })).toBeVisible();
  await expect(page.getByText(/关键词搜索未启用/)).toBeVisible();
  await page.locator(`[data-run-id="${session.runId}"]`).click();
  await expect(page.getByText('离线测试数据', { exact: true })).toBeVisible();
  await expect(page.locator('.candidate-card')).toHaveCount(3);
  await page.screenshot({
    path: `${evidence}/${info.project.name}-candidates.png`,
    fullPage: true,
  });
  await page.locator('.candidate-card').first().getByRole('button', { name: '核对来源' }).click();
  const drawer = page.getByRole('dialog', { name: '候选来源' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText(/目录证据 · 待复核/).first()).toBeVisible();
  await expect(drawer.getByText(/官网已读取/).first()).toBeVisible();
  await drawer
    .getByLabel('审核原因', { exact: true })
    .fill('浏览器离线测试：已核对虚构来源，不能作为真实发现证据');
  await drawer.getByRole('button', { name: '保留候选', exact: true }).click();
  await expect(drawer.getByText(/候选已保留，请确认公司身份后导入/)).toBeVisible();
  await drawer.getByLabel('我已打开来源，核对公司身份及买家关联选择').check();
  await drawer.getByRole('button', { name: /再次导入/ }).click();
  await expect(drawer.getByText(/线索已保存/)).toBeVisible();
  await page.screenshot({
    path: `${evidence}/${info.project.name}-source-review.png`,
    fullPage: true,
  });
  await drawer.getByRole('button', { name: '关闭来源' }).click();
  await page.locator('.candidate-card').nth(1).getByRole('button', { name: '核对来源' }).click();
  await drawer
    .getByLabel('审核原因', { exact: true })
    .fill('浏览器离线排除：虚构测试公司，保留原研究证据');
  await drawer.getByRole('button', { name: '排除候选', exact: true }).click();
  await expect(drawer.getByText(/已排除：浏览器离线排除/)).toBeVisible();
  await expect(drawer.getByRole('button', { name: '确认身份并导入', exact: true })).toBeDisabled();
  await page.screenshot({ path: `${evidence}/${info.project.name}-excluded.png`, fullPage: true });
  await drawer.getByRole('button', { name: '关闭来源' }).click();
  // A new normal runtime task must use live network, not the offline fixture transport.
  await page.getByRole('button', { name: '开始真实研究', exact: true }).click();
  await expect(page.getByRole('heading', { name: '研究失败', exact: true })).toBeVisible({
    timeout: 25000,
  });
  await expect(page.getByText(/DNS 返回了私网或保留地址/)).toBeVisible();
  await page.screenshot({
    path: `${evidence}/${info.project.name}-live-blocked.png`,
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  writeFileSync(
    `${evidence}/${info.project.name}.json`,
    JSON.stringify(
      {
        observedAt: new Date().toISOString(),
        viewport: info.project.name,
        origin: 'offline_fixture_for_positive_path; live_network_for_blocked_path',
        errors,
      },
      null,
      2,
    ) + '\n',
  );
});
