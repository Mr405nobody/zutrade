import { test, expect } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
const enabled = Boolean(process.env.D2_UI_BASE);
const fixture = enabled ? JSON.parse(readFileSync('.local/d2-test-last.json', 'utf8')) : null;
test.skip(!enabled, 'D2 requires retained isolated PostgreSQL via test:d2:browser');
test.use({ timezoneId: 'Asia/Shanghai' });
test('D2 桌面与手机：逐人预览、明确审批、实际结果、跟进、冲突及重登持久化', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const evidence = 'docs/build/evidence/d2/browser';
  mkdirSync(evidence, { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(process.env.D2_UI_BASE!);
  await page.getByLabel('邮箱', { exact: true }).fill(fixture.users.owner.email);
  await page.getByLabel('密码', { exact: true }).fill(fixture.users.owner.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '找客户', exact: true }).click();
  const panel = page.getByRole('region', { name: '触达批次', exact: true });
  await expect(panel.getByText(/离线测试数据 · 虚构公司/).first()).toBeVisible();
  const leadCard = panel.locator(`[data-lead-id="${fixture.leads[0]}"]`);
  await leadCard
    .getByRole('combobox', { name: /模拟账号/ })
    .selectOption(fixture.contacts[0].threadId);
  await leadCard.getByRole('checkbox', { name: '加入逐人名单' }).check();
  const name = 'D2 UI ' + info.project.name + ' ' + Date.now();
  await panel.getByLabel('批次名称', { exact: true }).fill(name);
  const wall = await page.evaluate(() => {
    const d = new Date(Date.now() - 60000);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  });
  await panel.getByLabel('计划开始', { exact: true }).fill(wall);
  await panel.getByLabel('最终主题', { exact: true }).fill('D2 UI exact subject');
  await panel
    .getByRole('textbox', { name: '最终正文', exact: true })
    .fill('SIMULATION: owner reviews this exact recipient and content.');
  await panel.getByRole('button', { name: '保存批次草稿', exact: true }).click();
  await expect(panel.getByText('草稿已保存；提交完整版本后才申请 owner 审批。')).toBeVisible();
  const card = panel
    .locator('.d2-card')
    .filter({ has: page.getByText(name, { exact: false }) })
    .filter({ has: page.getByRole('button', { name: '提交完整版本审批', exact: true }) });
  await card.getByRole('button', { name: '提交完整版本审批', exact: true }).click();
  await card.getByRole('button', { name: '预览 v1 · 待审批', exact: true }).click();
  const preview = panel.getByRole('article', { name: '批次逐人最终预览' });
  await expect(preview.getByText('D2 UI exact subject', { exact: true })).toBeVisible();
  await expect(
    preview.getByText('SIMULATION: owner reviews this exact recipient and content.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(preview.getByText(/模拟账号：/)).toBeVisible();
  await page.screenshot({ path: `${evidence}/${info.project.name}-preview.png`, fullPage: true });
  await preview.getByRole('button', { name: '批准完整批次并模拟执行', exact: true }).click();
  await expect(panel.getByText('批次已排队，逐项状态以实际网关结果为准。')).toBeVisible();
  await expect(card).toContainText('模拟完成 1', { timeout: 15000 });
  await page.reload();
  await page.getByRole('button', { name: '找客户', exact: true }).click();
  await expect(page.getByText(name, { exact: false }).first()).toBeVisible();
  await page.getByRole('button', { name: '待办', exact: true }).click();
  await page.getByRole('button', { name: '打开关联会话', exact: true }).first().click();
  await expect(page.getByRole('button', { name: /内部工作区/ })).toBeVisible();
  await page.getByRole('button', { name: /内部工作区/ }).click();
  const followup = page.getByRole('region', { name: '跟进计划', exact: true });
  await followup.getByText('新增跟进（默认只提醒）', { exact: true }).click();
  await followup.getByLabel('目标', { exact: true }).fill('D2 UI reminder ' + info.project.name);
  await followup
    .getByRole('textbox', { name: '内部草稿', exact: true })
    .fill('Internal only; not external content.');
  await followup.getByRole('button', { name: '保存计划版本', exact: true }).click();
  await expect(followup.getByText('跟进提醒已保存。')).toBeVisible();
  // Actual DST error feedback from the server, with no plan created.
  await followup.getByLabel('本地到期时间', { exact: true }).fill('2027-03-14T02:30');
  await followup.getByLabel('IANA 时区', { exact: true }).fill('America/New_York');
  await followup.getByRole('button', { name: '保存计划版本', exact: true }).click();
  await expect(followup.getByRole('alert').filter({ hasText: '不存在' })).toBeVisible();
  await page.screenshot({
    path: `${evidence}/${info.project.name}-followup-error.png`,
    fullPage: true,
  });
  await page.getByRole('button', { name: '工作区与设置', exact: true }).click();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByLabel('邮箱', { exact: true }).fill(fixture.users.owner.email);
  await page.getByLabel('密码', { exact: true }).fill(fixture.users.owner.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '待办', exact: true }).click();
  await expect(
    page.getByText('D2 UI reminder ' + info.project.name, { exact: false }).first(),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: `${evidence}/${info.project.name}-retained.png`, fullPage: true });
  writeFileSync(
    `${evidence}/${info.project.name}.json`,
    JSON.stringify(
      {
        observedAt: new Date().toISOString(),
        database: process.env.D2_UI_DATABASE,
        viewport: info.project.name,
        origin: 'offline_fixture',
        errors,
      },
      null,
      2,
    ) + '\n',
  );
});
