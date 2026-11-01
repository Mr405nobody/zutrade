import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

interface BrowserAccounts {
  workspaceId: string;
  factories: string[];
  owner: { email: string; password: string };
  sales: { email: string; password: string };
}
interface ThreadList {
  items: { id: string; contact_name: string; unread_count: number; control_mode: string }[];
}
const accounts = JSON.parse(
  readFileSync('.local/a2-browser-accounts.json', 'utf8'),
) as BrowserAccounts;
const evidence = 'docs/build/evidence/a2';

async function login(page: Page, role: 'owner' | 'sales') {
  page.setDefaultTimeout(10000);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '登录你的工作区' })).toBeVisible();
  await page.getByLabel('邮箱', { exact: true }).fill(accounts[role].email);
  await page.getByLabel('密码', { exact: true }).fill(accounts[role].password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '消息', exact: true })).toBeVisible();
  const workspace = page.getByRole('combobox', { name: '消息工作区' });
  if (await workspace.count()) await workspace.selectOption(accounts.workspaceId);
}
async function apiThreads(page: Page, base: string): Promise<ThreadList> {
  const response = await page.request.get(`${base}/threads`);
  expect(response.status()).toBe(200);
  return (await response.json()) as ThreadList;
}
async function assertNoOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.viewport);
}
async function postWithUi(page: Page, suffix: string, action: () => Promise<unknown>) {
  const response = page.waitForResponse(
    (result) => result.request().method() === 'POST' && result.url().endsWith(suffix),
    { timeout: 15000 },
  );
  await action();
  return response;
}

test('A2 真实消息闭环、双账号协作、版本冲突与断线恢复', async ({ page, browser }, testInfo) => {
  test.setTimeout(150000);
  mkdirSync(evidence, { recursive: true });
  const project = testInfo.project.name;
  const base = `/api/workspaces/${accounts.workspaceId}/inbox`;
  const suffix = `${project}-${Date.now()}`;
  const note = `仅团队可见：核对棉布袋需求 ${suffix}`;
  const draft = `内部草稿：价格与交期尚未经工厂确认 ${suffix}`;
  const realtimeNote = `双窗口实时协作备注 ${suffix}`;
  const errors: string[] = [];
  const observed: Record<string, unknown> = { project, startedAt: new Date().toISOString() };
  page.on('pageerror', (error) => errors.push(error.message));
  let salesContext: BrowserContext | undefined;
  try {
    await login(page, 'owner');
    const initial = await apiThreads(page, base);
    observed.initialEmpty = initial.items.length === 0;
    if (initial.items.length === 0) {
      await expect(page.getByRole('heading', { name: '还没有会话', exact: true })).toBeVisible();
      await page.screenshot({ path: `${evidence}/${project}-empty.png`, fullPage: true });
    }
    await page.getByRole('button', { name: '注入模拟买家消息', exact: true }).click();
    await page.getByLabel('归属工厂', { exact: true }).selectOption(accounts.factories[0]!);
    const injected = await postWithUi(page, '/simulation', () =>
      page.getByRole('button', { name: '注入 Alex 询盘', exact: true }).click(),
    );
    expect(injected.status()).toBe(201);
    const receipt = (await injected.json()) as { id: string; state: string };
    expect(receipt.id).toBeTruthy();
    observed.receiptId = receipt.id;
    let normalizedMessageId = '';
    let normalizedThreadId = '';
    await expect
      .poll(
        async () => {
          const response = await page.request.get(`${base}/simulation`);
          expect(response.status()).toBe(200);
          const receipts = (await response.json()) as {
            id: string;
            state: string;
            normalized_message_id: string | null;
            normalized_thread_id: string | null;
          }[];
          const item = receipts.find((item) => item.id === receipt.id);
          if (item?.state === 'processed') {
            normalizedMessageId = item.normalized_message_id ?? '';
            normalizedThreadId = item.normalized_thread_id ?? '';
          }
          return item?.state;
        },
        { timeout: 25000 },
      )
      .toBe('processed');
    await expect(
      page.locator('.thread-item').filter({ hasText: 'Alex Morgan' }).first(),
    ).toBeVisible({ timeout: 25000 });
    const replay = await postWithUi(page, '/simulation', () =>
      page.getByRole('button', { name: '重放同一事件（验证幂等）', exact: true }).click(),
    );
    expect(replay.status()).toBe(201);
    expect(((await replay.json()) as { id: string }).id).toBe(receipt.id);
    await page.getByRole('button', { name: '注入模拟买家消息', exact: true }).click();
    const list = await apiThreads(page, base);
    const threadId = list.items.find((t) => t.contact_name === 'Alex Morgan')!.id;
    observed.threadId = threadId;
    expect(threadId).toBe(normalizedThreadId);
    expect(normalizedMessageId).toBeTruthy();
    observed.normalizedMessageId = normalizedMessageId;
    // Restore only this dedicated test thread if an earlier failed run stopped after takeover.
    const starting = (await (await page.request.get(`${base}/threads/${threadId}`)).json()) as {
      thread: { control_mode: string; row_version: string };
    };
    if (starting.thread.control_mode === 'human') {
      const recovered = await page.request.post(`${base}/threads/${threadId}/release`, {
        headers: { origin: new URL(page.url()).origin },
        data: { expectedVersion: starting.thread.row_version },
      });
      expect(recovered.status()).toBe(201);
    }
    await page.locator('.thread-item').filter({ hasText: 'Alex Morgan' }).first().click();
    await expect(page.getByRole('heading', { name: 'Alex Morgan', exact: true })).toBeVisible();
    await expect(
      page.locator(`[data-message-id="${normalizedMessageId}"] .message-bubble`),
    ).toContainText('500 cotton tote bags');
    await expect
      .poll(
        async () =>
          (await apiThreads(page, base)).items.find((t) => t.id === threadId)?.unread_count,
      )
      .toBe(0);

    await page.getByRole('button', { name: /内部工作区 · 仅团队可见/ }).click();
    await page.getByLabel('内部备注', { exact: true }).fill(note);
    expect(
      (
        await postWithUi(page, '/notes', () =>
          page.getByRole('button', { name: '添加内部备注', exact: true }).click(),
        )
      ).status(),
    ).toBe(201);
    await expect(page.locator('.team-note').filter({ hasText: note })).toBeVisible();
    await page.getByText('内部自由文本草稿（不能外发）', { exact: true }).click();
    await page.getByLabel('内部自由文本草稿', { exact: true }).fill(draft);
    expect(
      (
        await postWithUi(page, '/drafts', () =>
          page.getByRole('button', { name: '保存内部草稿', exact: true }).click(),
        )
      ).status(),
    ).toBe(201);
    await expect(page.locator('.internal-draft').filter({ hasText: draft })).toBeVisible();
    const buyerHistory = await page.request.get(`${base}/threads/${threadId}/messages`);
    expect(buyerHistory.status()).toBe(200);
    const buyerHistoryText = JSON.stringify(await buyerHistory.json());
    expect(buyerHistoryText).not.toContain(note);
    expect(buyerHistoryText).not.toContain(draft);
    await page.getByRole('button', { name: /内部工作区 · 仅团队可见/ }).click();

    await page.getByLabel('受控澄清回复', { exact: true }).selectOption('use');
    const reply = await postWithUi(page, '/reply', () =>
      page.getByRole('button', { name: '模拟发送', exact: true }).click(),
    );
    expect(reply.status()).toBe(201);
    const request = (await reply.json()) as { requestId: string };
    expect(request.requestId).toBeTruthy();
    observed.outboundRequestId = request.requestId;
    await expect(page.locator(`[data-request-id="${request.requestId}"]`)).toHaveClass(
      /state-simulated/,
      { timeout: 25000 },
    );
    await expect(
      page.locator('.message-bubble').filter({ hasText: 'how you plan to use the product' }).last(),
    ).toBeVisible();
    await page.locator('.message-row.outbound').last().scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${evidence}/${project}-simulated-reply.png`, fullPage: true });
    const persistedDetail = await page.request.get(`${base}/threads/${threadId}`);
    const detailBeforeControl = (await persistedDetail.json()) as {
      thread: { row_version: string };
      outbound_requests: { id: string; body: string; status: string }[];
    };
    expect(
      detailBeforeControl.outbound_requests.find((r) => r.id === request.requestId)?.status,
    ).toBe('simulated');
    expect(JSON.stringify(detailBeforeControl.outbound_requests)).not.toContain(note);
    expect(JSON.stringify(detailBeforeControl.outbound_requests)).not.toContain(draft);

    salesContext = await browser.newContext({
      viewport: testInfo.project.use.viewport ?? { width: 1440, height: 1000 },
      isMobile: testInfo.project.use.isMobile ?? false,
      hasTouch: testInfo.project.use.hasTouch ?? false,
      baseURL: testInfo.project.use.baseURL ?? 'http://127.0.0.1:5173',
    });
    const sales = await salesContext.newPage();
    sales.on('pageerror', (error) => errors.push(error.message));
    await login(sales, 'sales');
    const beforeRead = (await apiThreads(sales, base)).items.find((t) => t.id === threadId);
    expect(Number(beforeRead?.unread_count)).toBeGreaterThan(0);
    observed.salesUnreadBeforeOpen = beforeRead?.unread_count;
    await sales.locator('.thread-item').filter({ hasText: 'Alex Morgan' }).first().click();
    await expect(sales.getByRole('heading', { name: 'Alex Morgan', exact: true })).toBeVisible();
    await expect
      .poll(
        async () =>
          (await apiThreads(sales, base)).items.find((t) => t.id === threadId)?.unread_count,
      )
      .toBe(0);
    await sales.getByRole('button', { name: /内部工作区 · 仅团队可见/ }).click();
    await expect(sales.locator('.team-note').filter({ hasText: note })).toBeVisible();
    await expect(sales.locator(`[data-request-id="${request.requestId}"]`)).toHaveClass(
      /state-simulated/,
    );
    await page.getByRole('button', { name: /内部工作区 · 仅团队可见/ }).click();
    await page.getByLabel('内部备注', { exact: true }).fill(realtimeNote);
    expect(
      (
        await postWithUi(page, '/notes', () =>
          page.getByRole('button', { name: '添加内部备注', exact: true }).click(),
        )
      ).status(),
    ).toBe(201);
    await expect(sales.locator('.team-note').filter({ hasText: realtimeNote })).toBeVisible({
      timeout: 15000,
    });

    const takeover = await postWithUi(page, '/takeover', () =>
      page.getByRole('button', { name: '人工接管', exact: true }).click(),
    );
    expect(takeover.status()).toBe(201);
    await expect(page.getByRole('button', { name: '释放接管', exact: true })).toBeVisible();
    await expect(sales.locator('.thread-context')).toContainText('已人工接管', { timeout: 15000 });
    await expect(
      sales.getByText('收到新消息或接管状态已变化。请核对最新会话，再确认本条回复。', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(sales.getByRole('button', { name: '模拟发送', exact: true })).toBeDisabled();

    await page.route(
      `**/inbox/threads/${threadId}/release`,
      async (route) => {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        await route.continue({
          postData: JSON.stringify({
            ...body,
            expectedVersion: detailBeforeControl.thread.row_version,
          }),
        });
      },
      { times: 1 },
    );
    const conflict = await postWithUi(page, '/release', () =>
      page.getByRole('button', { name: '释放接管', exact: true }).click(),
    );
    expect(conflict.status()).toBe(409);
    await expect(page.locator('.inbox-alert').filter({ hasText: '版本或幂等冲突' })).toContainText(
      '版本或幂等冲突',
    );
    await page.screenshot({ path: `${evidence}/${project}-version-conflict.png`, fullPage: true });
    const released = await postWithUi(page, '/release', () =>
      page.getByRole('button', { name: '释放接管', exact: true }).click(),
    );
    expect(released.status()).toBe(201);
    await expect(sales.locator('.thread-context')).toContainText('AI 未启用', { timeout: 15000 });
    await sales.getByRole('button', { name: '已核对，使用最新上下文', exact: true }).click();
    await expect(sales.getByRole('button', { name: '模拟发送', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: /内部工作区 · 仅团队可见/ }).click();
    await assertNoOverflow(page);
    await assertNoOverflow(sales);
    await page.screenshot({ path: `${evidence}/${project}-owner.png`, fullPage: true });
    await sales.locator('.team-note').filter({ hasText: realtimeNote }).scrollIntoViewIfNeeded();
    await sales.screenshot({ path: `${evidence}/${project}-sales.png`, fullPage: true });

    await page.context().setOffline(true);
    await expect(
      page.getByText('实时连接已断开，正在重连；恢复后将重新查询数据库。', { exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: `${evidence}/${project}-offline.png`, fullPage: true });
    await page.context().setOffline(false);
    await expect(
      page.getByText('实时连接已断开，正在重连；恢复后将重新查询数据库。', { exact: true }),
    ).toHaveCount(0, { timeout: 20000 });
    await page.reload();
    await expect(page.getByRole('heading', { name: '消息', exact: true })).toBeVisible();
    await page.locator('.thread-item').filter({ hasText: 'Alex Morgan' }).first().click();
    await expect(page.locator(`[data-request-id="${request.requestId}"]`)).toHaveClass(
      /state-simulated/,
    );
    await page.getByRole('button', { name: /内部工作区 · 仅团队可见/ }).click();
    await expect(page.locator('.team-note').filter({ hasText: note })).toBeVisible();
    await page.getByText('内部自由文本草稿（不能外发）', { exact: true }).click();
    await expect(page.locator('.internal-draft').filter({ hasText: draft })).toBeVisible();
    await assertNoOverflow(page);
    expect(errors).toEqual([]);
    observed.result = 'passed';
  } finally {
    await page.context().setOffline(false);
    await salesContext?.close();
    observed.finishedAt = new Date().toISOString();
    observed.pageErrors = errors;
    writeFileSync(`${evidence}/${project}-browser.json`, `${JSON.stringify(observed, null, 2)}\n`);
  }
});
