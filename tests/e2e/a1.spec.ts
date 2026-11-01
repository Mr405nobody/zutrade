import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
const accounts = JSON.parse(readFileSync('.local/a1-accounts.json', 'utf8')) as {
  workspaceId: string;
  factories: string[];
  owner: { email: string; password: string };
  sales: { email: string; password: string };
};
for (const role of ['owner', 'sales'] as const) {
  test(`${role} 真实登录、授权工厂、队列及退出`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '登录你的工作区' })).toBeVisible();
    await page.getByLabel('邮箱', { exact: true }).fill(accounts[role].email);
    await page.getByLabel('密码', { exact: true }).fill(accounts[role].password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '消息', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '工作区与设置', exact: true }).click();
    await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: '当前工作区' })).toHaveValue(
      accounts.workspaceId,
    );
    await expect(page.getByRole('form', { name: 'DEMO-A', exact: true })).toBeVisible();
    if (role === 'owner') {
      await expect(page.getByRole('form', { name: 'DEMO-B', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: '成员与权限' })).toBeVisible();
    } else {
      await expect(page.getByRole('form', { name: 'DEMO-B', exact: true })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: '成员与权限' })).toHaveCount(0);
      const forbidden = await page.request.get(
        `/api/workspaces/${accounts.workspaceId}/factories/${accounts.factories[1]}`,
      );
      expect(forbidden.status()).toBe(404);
      const write = await page.request.patch(
        `/api/workspaces/${accounts.workspaceId}/factories/${accounts.factories[1]}`,
        {
          headers: { origin: 'http://127.0.0.1:5173' },
          data: { name: '不应写入', commandId: crypto.randomUUID() },
        },
      );
      expect(write.status()).toBe(404);
    }
    const form = page.getByRole('form', { name: 'DEMO-A', exact: true });
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        response.url().includes(`/factories/${accounts.factories[0]}`),
    );
    await form.getByRole('button', { name: '保存并验证队列' }).click();
    const response = await saved;
    expect(response.status()).toBe(200);
    const result = (await response.json()) as { eventId: string };
    await expect(
      page
        .getByText(result.eventId.slice(0, 8), { exact: true })
        .locator('..')
        .getByText('已消费', { exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await page.reload();
    await expect(page.getByRole('heading', { name: '消息', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '工作区与设置', exact: true }).click();
    await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible();
    const size = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(size.scroll).toBeLessThanOrEqual(size.viewport);
    await page.screenshot({
      path: `docs/build/evidence/a2/regression-${testInfo.project.name}-${role}.png`,
      fullPage: true,
    });
    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name === 'zutrade.session_token');
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe('Lax');
    await page.getByRole('button', { name: '退出登录' }).click();
    await expect(page.getByRole('heading', { name: '登录你的工作区' })).toBeVisible();
    expect((await page.request.get('/api/me')).status()).toBe(401);
    expect(errors).toEqual([]);
  });
}
