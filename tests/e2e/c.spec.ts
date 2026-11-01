import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import type { OutboundView } from '@zutrade/contracts';
interface Sample {
  threadId: string;
  identity: string;
  contactName: string;
  requestId: string;
  payloadId: string;
  approvalId: string;
  quoteVersionId: string;
}
interface Fixture {
  main: Sample;
  reject: Sample;
  conflict: Sample;
  cancel: Sample;
  expired: Sample;
  lost: Sample;
  badPdf: Sample;
  late: { identity: string; request_id: string };
  unknown: { identity: string; request_id: string };
}
const enabled = Boolean(process.env.C_UI_BASE);
const session = enabled
  ? (JSON.parse(readFileSync('.local/c-ui-fixture.json', 'utf8')) as {
      workspaceId: string;
      users: Record<string, { email: string; password: string }>;
      fixtures: Record<string, Fixture>;
    })
  : null;
test.skip(!enabled, 'C browser suite uses its dedicated isolated database via test:c:browser');
const evidence = 'docs/build/evidence/c/browser';
async function login(page: Page, role: string) {
  await page.goto('/');
  if (await page.getByLabel('邮箱', { exact: true }).count()) {
    await page.getByLabel('邮箱', { exact: true }).fill(session!.users[role]!.email);
    await page.getByLabel('密码', { exact: true }).fill(session!.users[role]!.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
  }
  await expect(page.getByRole('heading', { name: '消息', exact: true })).toBeVisible();
}
async function openThread(page: Page, sample: Sample) {
  await page.getByRole('button', { name: '消息', exact: true }).click();
  if (await page.getByRole('button', { name: '返回会话列表' }).isVisible())
    await page.getByRole('button', { name: '返回会话列表' }).click();
  await expect(page.locator('.thread-item').first()).toBeVisible();
  const item = page.locator('.thread-item').filter({ hasText: sample.contactName });
  for (let i = 0; i < 20 && !(await item.count()); i++) {
    const more = page.getByRole('button', { name: '加载更多会话' });
    if (!(await more.count())) break;
    const before = await page.locator('.thread-item').count();
    await more.click();
    await expect.poll(() => page.locator('.thread-item').count()).toBeGreaterThan(before);
  }
  await item.click();
  const toggle = page.getByRole('button', { name: /内部工作区 · 仅团队可见/ });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(page.getByRole('region', { name: '审批与模拟执行', exact: true })).toBeVisible();
}
async function tasks(page: Page, identity: string) {
  await page.getByRole('button', { name: '待办', exact: true }).click();
  const row = page.locator('.approval-row').filter({ hasText: identity });
  await expect(row).toBeVisible();
  await row.click();
  return page.getByRole('article', { name: '最终外发内容预览' });
}
async function post(page: Page, path: string, data: unknown) {
  return page.request.post(path, { data, headers: { Origin: new URL(page.url()).origin } });
}
async function capture(page: Page, name: string, project: string) {
  await page.screenshot({ path: `${evidence}/${project}-${name}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test('C 桌面/手机：精确审批、PDF、拒绝、过期、旧页面冲突、取消与 unknown 核对', async ({
  page,
}, info) => {
  test.setTimeout(240000);
  page.setDefaultTimeout(15000);
  mkdirSync(evidence, { recursive: true });
  const f = session!.fixtures[info.project.name]!,
    base = `/api/workspaces/${session!.workspaceId}/dispatch`;
  const observed: Record<string, unknown> = {
    project: info.project.name,
    startedAt: new Date().toISOString(),
    isolatedDatabase: true,
  };
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('Failed to load resource'))
      errors.push(message.text());
  });
  await login(page, 'sales');
  await openThread(page, f.main);
  const panel = page.getByRole('region', { name: '审批与模拟执行', exact: true });
  await panel.getByText('准备最终内容并提交审批', { exact: true }).click();
  const prepareResponse = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/prepare'),
  );
  await panel.getByRole('button', { name: '提交当前报价审批', exact: true }).click();
  const prepared = await prepareResponse;
  expect(prepared.status()).toBe(201);
  const r = (await prepared.json()) as { requestId: string; payloadId: string };
  observed.quoteRequest = r;
  await expect(panel.getByRole('button', { name: '批准并模拟执行', exact: true })).toHaveCount(0);
  await capture(page, 'sales-submit', info.project.name);
  await post(page, '/api/auth/sign-out', {});
  await page.reload();
  await login(page, 'owner');
  let preview = await tasks(page, f.main.identity);
  await expect(preview).toContainText('1950.00');
  await expect(preview).toContainText(f.main.identity);
  await expect(preview).toContainText('Production');
  const pdfResponse = page.waitForResponse(
    (res) => res.url().endsWith('/pdf') && res.request().method() === 'GET',
  );
  const popup = page.waitForEvent('popup');
  await preview.getByRole('button', { name: '查看已保存 PDF', exact: true }).click();
  const pdf = await pdfResponse;
  expect(pdf.status()).toBe(200);
  const pdfPage = await popup;
  await pdfPage.waitForURL((url) => url.protocol === 'blob:');
  const bytes = Buffer.from(
    await page.evaluate(
      async (url) => Array.from(new Uint8Array(await (await fetch(url)).arrayBuffer())),
      pdfPage.url(),
    ),
  );
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(pdf.headers()['x-content-sha256']);
  await pdfPage.close();
  await capture(page, 'owner-preview', info.project.name);
  const approveResponse = page.waitForResponse(
    (res) => res.request().method() === 'POST' && res.url().endsWith('/decision'),
  );
  await preview.getByRole('button', { name: '批准并模拟执行', exact: true }).click();
  expect((await approveResponse).status()).toBe(201);
  await expect(page.locator('.approval-row').filter({ hasText: f.main.identity })).toContainText(
    '模拟执行完成',
    { timeout: 20000 },
  );
  await capture(page, 'simulated', info.project.name);
  const sent = (await (await page.request.get(`${base}/threads/${f.main.threadId}`)).json()) as {
    items: OutboundView[];
  };
  const sentRecord = sent.items.find((x) => x.request.id === r.requestId)!;
  expect(sentRecord.attempts).toHaveLength(1);
  expect(sentRecord.payload.attachment_manifest).toHaveLength(1);
  observed.completed = sentRecord.request;
  preview = await tasks(page, f.reject.identity);
  await preview.getByLabel('审批说明', { exact: true }).fill('Please clarify the final text.');
  await preview.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(page.locator('.approval-row').filter({ hasText: f.reject.identity })).toContainText(
    '已拒绝',
  );
  await capture(page, 'rejected', info.project.name);
  preview = await tasks(page, f.expired.identity);
  await expect(preview).toContainText('审批已过期');
  await expect(preview.getByRole('button', { name: '批准并模拟执行', exact: true })).toHaveCount(0);
  await capture(page, 'expired', info.project.name);
  preview = await tasks(page, f.conflict.identity);
  const old = (await (await page.request.get(`${base}/threads/${f.conflict.threadId}`)).json()) as {
    items: OutboundView[];
  };
  const original = old.items.find((x) => x.request.id === f.conflict.requestId)!;
  const thread = (await (
    await page.request.get(
      `/api/workspaces/${session!.workspaceId}/inbox/threads/${f.conflict.threadId}`,
    )
  ).json()) as { thread: { context_revision: string } };
  const revision = await post(page, `${base}/threads/${f.conflict.threadId}/prepare`, {
    commandId: randomUUID(),
    kind: 'human_reply',
    quoteVersionId: null,
    body: 'Version two requires a new owner review.',
    contextRevision: thread.thread.context_revision,
    requestId: original.request.id,
    expectedVersion: original.request.row_version,
  });
  expect(revision.status()).toBe(201);
  const conflictResponse = page.waitForResponse(
    (res) => res.request().method() === 'POST' && res.url().endsWith('/decision'),
  );
  await preview.getByRole('button', { name: '批准并模拟执行', exact: true }).click();
  expect((await conflictResponse).status()).toBe(409);
  await expect(page.getByRole('alert').filter({ hasText: '版本冲突' })).toBeVisible();
  await capture(page, 'version-conflict', info.project.name);
  await preview.getByRole('button', { name: '重新查看最新版本', exact: true }).click();
  await expect(preview).toContainText('Version two');
  await preview.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(
    page.locator('.approval-row').filter({ hasText: f.conflict.identity }),
  ).toContainText('已拒绝');
  preview = await tasks(page, f.cancel.identity);
  await preview.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.approval-row').filter({ hasText: f.cancel.identity })).toContainText(
    '领取前已撤销',
  );
  await capture(page, 'cancel-before-claim', info.project.name);
  preview = await tasks(page, f.late.identity);
  await expect(preview).toContainText('取消申请已记录');
  await expect(preview).toContainText('不能承诺本次撤回');
  await capture(page, 'cancel-after-claim', info.project.name);
  await preview.getByRole('button', { name: '核对渠道接收记录', exact: true }).click();
  await expect(page.locator('.approval-row').filter({ hasText: f.late.identity })).toContainText(
    '结果未知',
  );
  await expect(preview).toContainText('没有查到记录不能证明未发送');
  await capture(page, 'unknown-not-found', info.project.name);
  preview = await tasks(page, f.lost.identity);
  await expect(preview).toContainText('结果尚未确定');
  await preview.getByRole('button', { name: '核对渠道接收记录', exact: true }).click();
  await expect(page.locator('.approval-row').filter({ hasText: f.lost.identity })).toContainText(
    '模拟执行完成',
    { timeout: 20000 },
  );
  await capture(page, 'unknown-reconciled', info.project.name);
  preview = await tasks(page, f.badPdf.identity);
  const badResponse = page.waitForResponse(
    (res) => res.url().endsWith('/pdf') && res.request().method() === 'GET',
  );
  await preview.getByRole('button', { name: '查看已保存 PDF', exact: true }).click();
  expect((await badResponse).status()).toBe(409);
  await expect(page.getByRole('alert').filter({ hasText: 'PDF 异常' })).toBeVisible();
  await capture(page, 'pdf-error', info.project.name);
  const invalidResponse = page.waitForResponse(
    (res) => res.url().endsWith('/decision') && res.request().method() === 'POST',
  );
  await preview.getByRole('button', { name: '批准并模拟执行', exact: true }).click();
  expect((await invalidResponse).status()).toBe(409);
  await expect(page.locator('.approval-row').filter({ hasText: f.badPdf.identity })).toContainText(
    '审批已失效',
  );
  expect(errors).toEqual([]);
  observed.browserErrors = errors;
  observed.completedAt = new Date().toISOString();
  writeFileSync(`${evidence}/${info.project.name}.json`, JSON.stringify(observed, null, 2) + '\n');
});
