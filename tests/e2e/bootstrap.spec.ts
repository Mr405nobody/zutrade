import { expect, test } from '@playwright/test';

// Database stop/restart evidence belongs to the accepted earlier stage. This
// regression checks the current health UI and a real browser-side API outage.
test('当前健康设置、四入口与 API 断路恢复', async ({ page }, testInfo) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '登录你的工作区' })).toBeVisible();
  for (const entry of ['消息', '找客户', '产品', '待办']) {
    await page.getByRole('button', { name: entry, exact: true }).click();
    await expect(page.getByRole('button', { name: entry, exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
  }
  await page.getByRole('button', { name: '工作区与设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '本地服务状态', exact: true })).toBeVisible();
  for (const component of ['PostgreSQL', 'Worker']) {
    await expect(
      page
        .getByRole('article', { name: `${component} 健康状态` })
        .getByText('可用', { exact: true }),
    ).toBeVisible({ timeout: 15000 });
  }
  expect((await page.request.get('/health/ready')).status()).toBe(200);
  await page.screenshot({
    path: `docs/build/evidence/a2/regression-${testInfo.project.name}-healthy.png`,
    fullPage: true,
  });
  const size = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(size.scroll).toBeLessThanOrEqual(size.viewport);

  await page.route('**/health/**', (route) => route.abort('failed'));
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  for (const component of ['PostgreSQL', 'Worker']) {
    await expect(
      page
        .getByRole('article', { name: `${component} 健康状态` })
        .getByText('未就绪', { exact: true }),
    ).toBeVisible({ timeout: 18000 });
    await expect(
      page
        .getByRole('article', { name: `${component} 健康状态` })
        .getByText('连接中断或状态已过期，请检查服务', { exact: true }),
    ).toBeVisible();
  }
  await page.screenshot({
    path: `docs/build/evidence/a2/regression-${testInfo.project.name}-api-unavailable.png`,
    fullPage: true,
  });
  await page.unroute('**/health/**');
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  for (const component of ['PostgreSQL', 'Worker']) {
    await expect(
      page
        .getByRole('article', { name: `${component} 健康状态` })
        .getByText('可用', { exact: true }),
    ).toBeVisible({ timeout: 15000 });
  }
  await page.reload();
  await expect(page.getByRole('heading', { name: '本地服务状态', exact: true })).toBeVisible();
  await expect(
    page.getByRole('article', { name: 'PostgreSQL 健康状态' }).getByText('可用', { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
