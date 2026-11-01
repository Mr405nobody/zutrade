import { test, expect } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
const enabled = Boolean(process.env.E_UI_BASE),
  fixture = enabled ? JSON.parse(readFileSync('.local/e-test-last.json', 'utf8')) : null;
test.skip(!enabled, 'E requires retained isolated PostgreSQL via test:e:browser');
test.use({ timezoneId: 'Asia/Shanghai', actionTimeout: 10000 });
test('E 模拟 AI：重放、来源、修改/拒绝、FAQ、转人工、新回复失效及重登', async ({ page }, info) => {
  test.setTimeout(150000);
  const evidence = 'docs/build/evidence/e/browser';
  mkdirSync(evidence, { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // All non-loopback browser network is disabled for this verification.
  await page.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    return ['127.0.0.1', 'localhost'].includes(host)
      ? route.continue()
      : route.abort('internetdisconnected');
  });
  await page.goto(process.env.E_UI_BASE!);
  await page.getByLabel('邮箱', { exact: true }).fill(fixture.users.owner.email);
  await page.getByLabel('密码', { exact: true }).fill(fixture.users.owner.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '消息', exact: true }).click();
  // Select by persisted thread identity through the real UI list, without reading any password in a trace output.
  while (
    !(await page.locator(`[data-thread-id="${fixture.ui.threadId}"]`).count()) &&
    (await page.getByRole('button', { name: '加载更多会话' }).count())
  )
    await page.getByRole('button', { name: '加载更多会话' }).click();
  const threads = page.locator(`[data-thread-id="${fixture.ui.threadId}"]`);
  await expect(threads).toBeVisible();
  await threads.click();
  await page.getByRole('button', { name: /内部工作区/ }).click();
  const panel = page.getByRole('region', { name: '模拟 AI', exact: true });
  await expect(panel).toBeVisible();
  await panel.getByText('适用场景与固定业务时钟', { exact: true }).click();
  await expect(
    panel.locator('code').filter({ hasText: 'What material is CT-01 made of?' }),
  ).toBeVisible();
  await panel.getByText('适用场景与固定业务时钟', { exact: true }).click();
  async function latestRun() {
    return panel.locator('[data-ai-run]').first();
  }
  async function generate() {
    const before = await panel.locator('[data-ai-run]').count();
    const old = before ? await (await latestRun()).getAttribute('data-ai-run') : null;
    await panel.getByRole('button', { name: '生成模拟建议', exact: true }).click();
    await expect
      .poll(async () => await (await latestRun()).getAttribute('data-ai-run'))
      .not.toBe(old);
    const runId = await (await latestRun()).getAttribute('data-ai-run');
    const r = panel.locator(`[data-ai-run="${runId}"]`);
    await expect(r.getByText(/建议已生成|需转人工/).first()).toBeVisible({ timeout: 15000 });
    return r;
  }
  await panel.getByText('场景调试 · 注入模拟买家消息', { exact: true }).click();
  async function injectScenario(text: string) {
    const before = await page.request.get(
      `/api/workspaces/${fixture.ids.ws}/inbox/threads/${fixture.ui.threadId}/messages`,
    );
    const previous = (await before.json()).items
      .filter((x: { direction: string }) => x.direction === 'inbound')
      .at(-1)?.id;
    await panel.getByRole('combobox', { name: '预设入站场景', exact: true }).selectOption(text);
    await panel.getByRole('button', { name: '注入所选场景买家消息', exact: true }).click();
    await expect
      .poll(async () => {
        const r = await page.request.get(
          `/api/workspaces/${fixture.ids.ws}/inbox/threads/${fixture.ui.threadId}/messages`,
        );
        const last = (await r.json()).items
          .filter((x: { direction: string }) => x.direction === 'inbound')
          .at(-1);
        return last?.id !== previous && last?.body === text;
      })
      .toBe(true);
  }
  await injectScenario('What material is CT-01 made of?');
  const first = await generate();
  await first.getByText('输入引用与输出校验', { exact: true }).click();
  const firstId = await first.getAttribute('data-ai-run');
  await expect(first).toContainText('The confirmed material of CT-01 is 12oz.');
  await first
    .getByText(/事实来源 ·/)
    .first()
    .click();
  await expect(first).toContainText(fixture.sourceId);
  await page.screenshot({ path: `${evidence}/${info.project.name}-evidence.png`, fullPage: true });
  const second = await generate();
  await expect(second).toContainText('The confirmed material of CT-01 is 12oz.');
  await second.getByRole('button', { name: '修改为内部草稿', exact: true }).click();
  await second
    .getByRole('textbox', { name: '修改 AI 建议', exact: true })
    .fill('E browser internal draft ' + info.project.name);
  await second.getByRole('button', { name: '保存修改草稿', exact: true }).click();
  await expect(second).toContainText('已处理：modify');
  const third = await generate();
  await third.getByRole('button', { name: '拒绝建议', exact: true }).click();
  await expect(third).toContainText('已处理：reject');
  await panel
    .getByRole('checkbox', { name: '条件满足时通过统一网关自动模拟 FAQ', exact: true })
    .check();
  const faq = await generate();
  await expect(
    faq.getByText('The confirmed material of CT-01 is 12oz.', { exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const r = await page.request.get(
        `/api/workspaces/${fixture.ids.ws}/inbox/threads/${fixture.ui.threadId}`,
      );
      const d = await r.json();
      return d.outbound_requests.some(
        (x: { status: string; body: string }) =>
          x.status === 'simulated' && x.body === 'The confirmed material of CT-01 is 12oz.',
      );
    })
    .toBe(true);
  await page.screenshot({ path: `${evidence}/${info.project.name}-faq.png`, fullPage: true });
  await injectScenario('Can you guarantee arrival within six weeks?');
  await expect
    .poll(async () => {
      const r = await page.request.get(
        `/api/workspaces/${fixture.ids.ws}/ai/threads/${fixture.ui.threadId}`,
      );
      const d = await r.json();
      return d.runs.find((x: { id: string }) => x.id === firstId)?.current;
    })
    .toBe(false);
  const arrival = await generate();
  await expect(arrival).toContainText('需转人工');
  await expect(arrival).toContainText('六周到货未获确认');
  await page.screenshot({
    path: `${evidence}/${info.project.name}-needs-human.png`,
    fullPage: true,
  });
  await panel
    .getByRole('checkbox', { name: '条件满足时通过统一网关自动模拟 FAQ', exact: true })
    .uncheck();
  await injectScenario('What material is CT-01 made of?');
  await page.reload();
  await page.locator(`[data-thread-id="${fixture.ui.threadId}"]`).click();
  await page.getByRole('button', { name: /内部工作区/ }).click();
  await expect(panel.locator(`[data-ai-run="${firstId}"]`)).toContainText('旧建议失效');
  // Refresh and re-login use retained DB history; no seed or reset.
  await page.getByRole('button', { name: '工作区与设置', exact: true }).click();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByLabel('邮箱', { exact: true }).fill(fixture.users.sales.email);
  await page.getByLabel('密码', { exact: true }).fill(fixture.users.sales.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '消息', exact: true }).click();
  await page.locator(`[data-thread-id="${fixture.ui.threadId}"]`).click();
  await page.getByRole('button', { name: /内部工作区/ }).click();
  await expect(panel.getByRole('button', { name: '审核并启用 FAQ 模板', exact: true })).toHaveCount(
    0,
  );
  await expect(panel.locator('[data-ai-run]').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(errors).toEqual([]);
  writeFileSync(
    `${evidence}/${info.project.name}.json`,
    JSON.stringify(
      {
        viewport: info.project.name,
        threadId: fixture.ui.threadId,
        firstRun: firstId,
        faqRun: await faq.getAttribute('data-ai-run'),
        replay: true,
        sources: true,
        modify: true,
        reject: true,
        faq: true,
        needsHuman: true,
        stale: true,
        relogin: true,
        externalNetwork: 'blocked',
        errors,
      },
      null,
      2,
    ) + '\n',
  );
});
