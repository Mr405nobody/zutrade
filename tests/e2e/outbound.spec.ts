import { test, expect } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
const enabled = Boolean(process.env.OUTBOUND_UI_BASE);
const f = enabled ? JSON.parse(readFileSync('.local/outbound-test-last.json', 'utf8')) : null;
test.skip(!enabled, 'Use test:outbound:browser with retained isolated database');
test.use({ timezoneId: 'Asia/Shanghai' });
test('Outbound routes, truthful modes, rules/evidence, review/correction persistence and auth', async ({
  page,
  context,
}, info) => {
  test.setTimeout(90000);
  const evidence = 'docs/build/evidence/outbound/browser';
  mkdirSync(evidence, { recursive: true });
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await context.route('**/*', (route) =>
    ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)
      ? route.continue()
      : route.abort(),
  );
  await page.goto(process.env.OUTBOUND_UI_BASE! + '/outbound');
  await page.getByLabel('邮箱', { exact: true }).fill(f.users.sales.email);
  await page.getByLabel('密码', { exact: true }).fill(f.users.sales.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '主动获客与企业背调', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('产品关键词', { exact: true })).toHaveValue('Industrial Fasteners');
  await expect(page.getByLabel('目标国家', { exact: true })).toHaveValue('US');
  await expect(page.getByLabel('目标企业数量', { exact: true })).toHaveValue('20');
  await expect(page.getByText('离线测试数据', { exact: true })).toBeVisible();
  await page.getByLabel('发现模式', { exact: true }).selectOption('automatic');
  await page.getByRole('button', { name: '开始搜索', exact: true }).click();
  await expect(
    page.getByText('自动搜索不可用，请使用手动官网导入。', { exact: true }),
  ).toBeVisible();
  await page.getByLabel('发现模式', { exact: true }).selectOption('manual');
  await page.getByLabel('企业官网 URL', { exact: true }).fill('https://www.fastenal.com/');
  await page.getByLabel(/我已核对网站使用条件/).check();
  await page.getByRole('button', { name: '导入官网并调查', exact: true }).click();
  await expect(
    page
      .getByText('DNS 返回私网或保留地址，已安全拒绝。当前网络无法读取该官网。', { exact: true })
      .first(),
  ).toBeVisible({ timeout: 15000 });
  await page.screenshot({
    path: `${evidence}/${info.project.name}-list-network.png`,
    fullPage: true,
  });
  await page.getByRole('link', { name: '查看企业', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: '1. 企业身份调查', exact: true })).toBeVisible();
  await expect(page.getByText('未进行独立注册核验', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: '6. 证据链接与官网摘录', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: '原始网页', exact: true })).toHaveCount(4);
  await page.screenshot({ path: `${evidence}/${info.project.name}-report.png`, fullPage: true });
  await page.getByLabel('修正公司名称', { exact: true }).fill('人工修正 · Offline Fixture');
  await page
    .getByLabel('审核备注', { exact: true })
    .fill(`OFFLINE ${info.project.name}: evidence reviewed; registration unknown`);
  for (const name of ['待补充调查', '驳回', '通过']) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect(
      page.getByText(`已保存：${name === '通过' ? '已通过' : name === '驳回' ? '已驳回' : name}`, {
        exact: true,
      }),
    ).toBeVisible();
  }
  await page.reload();
  await expect(page.getByLabel('修正公司名称', { exact: true })).toHaveValue(
    '人工修正 · Offline Fixture',
  );
  await expect(page.getByText('审核人：sales', { exact: false })).toBeVisible();
  await page.getByRole('heading', { name: '人工修正与审核', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}/${info.project.name}-review.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const id = f.ids.company;
  const apiBase = `/api/workspaces/${f.ids.ws}/outbound/companies/${id}`;
  const response = await page.request.get(apiBase);
  expect(response.status()).toBe(200);
  const result = await response.json();
  expect(result.company.review_status).toBe('approved');
  expect(result.candidate.name).toBe('Fictional Offline Fastener Fixture');
  await page.getByRole('link', { name: '返回主动获客', exact: true }).click();
  await page.getByLabel('仅查看已审核通过', { exact: true }).check();
  await expect(page.getByRole('link', { name: '查看企业', exact: true })).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole('link', { name: '查看企业', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: '消息', exact: true }).click();
  await expect(page.getByRole('heading', { name: '消息', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '产品', exact: true }).click();
  await expect(page.getByRole('heading', { name: '产品与可信供给', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '找客户', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '主动获客与企业背调', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '工作区与设置', exact: true }).click();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登录你的工作区', exact: true })).toBeVisible();
  expect((await page.request.get(apiBase)).status()).toBe(401);
  await page.reload();
  await expect(page.getByRole('heading', { name: '登录你的工作区', exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
  writeFileSync(
    `${evidence}/${info.project.name}.json`,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        origin: 'offline_fixture; real URL failure independently tested',
        passed: true,
        pageErrors,
      },
      null,
      2,
    ) + '\n',
  );
});
