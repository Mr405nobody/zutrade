import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { pg } from '@zutrade/db';
interface ObservedSnapshot {
  requirements: { quantity: string };
  totalAmount: string;
}

interface Accounts {
  workspaceId: string;
  factories: string[];
  owner: { email: string; password: string };
}
interface QuotingView {
  opportunities: {
    id: string;
    row_version: string;
    requirements_revision: string;
    quote: { current_version_id: string } | null;
    requirements: Record<string, unknown>;
    versions: { id: string }[];
  }[];
}
const accounts = JSON.parse(readFileSync('.local/a2-browser-accounts.json', 'utf8')) as Accounts;
const evidence = 'docs/build/evidence/b/browser';
const specs = {
  fabric: '12oz',
  dimensions: '35×40cm',
  color: 'Natural',
  printing: 'Single colour / single side logo',
};
async function login(page: Page) {
  page.setDefaultTimeout(10000);
  await page.goto('/');
  await page.getByLabel('邮箱', { exact: true }).fill(accounts.owner.email);
  await page.getByLabel('密码', { exact: true }).fill(accounts.owner.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '消息', exact: true })).toBeVisible();
  const ws = page.getByRole('combobox', { name: '消息工作区' });
  if (await ws.count()) await ws.selectOption(accounts.workspaceId);
}
async function post(page: Page, path: string, data: unknown) {
  const response = await page.request.post(path, {
    data,
    headers: { Origin: new URL(page.url()).origin },
  });
  expect(response.status(), `POST ${path}`).toBe(201);
  return (await response.json()) as Record<string, unknown>;
}
async function withPost(page: Page, suffix: string, action: () => Promise<unknown>) {
  const response = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith(suffix),
  );
  await action();
  return await response;
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test('B 真实供给、500/800 报价历史、PDF、缺项、冲突与失效', async ({ page }, info) => {
  test.setTimeout(180000);
  mkdirSync(evidence, { recursive: true });
  const run = `${info.project.name}-${randomUUID().slice(0, 8)}`;
  const base = `/api/workspaces/${accounts.workspaceId}`;
  const observed: Record<string, unknown> = {
    project: info.project.name,
    run,
    startedAt: new Date().toISOString(),
  };
  const errors: string[] = [];
  let restorePath = '';
  let originalRequirements: Record<string, unknown> | undefined;
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await login(page);
    const productsResponse = await post(page, `${base}/supply/products`, {
      factoryId: accounts.factories[0],
      sku: `B-UI-${run}`,
      name: 'CT-01 棉布袋（独立浏览器模拟样例）',
      unitCode: 'piece',
      configuration: {},
    });
    const productId = String(productsResponse.id);
    observed.productId = productId;
    await page.getByRole('button', { name: '产品', exact: true }).click();
    await expect(page.getByRole('heading', { name: '产品与可信供给' })).toBeVisible();
    const card = page.locator('.commerce-card').filter({
      has: page.getByText(`B-UI-${run} · CT-01 棉布袋（独立浏览器模拟样例）`, { exact: true }),
    });
    await card.getByRole('button', { name: '查看来源与价阶' }).click();
    await card.getByText('上传新来源文件', { exact: true }).click();
    const upload = card.locator('form').filter({ has: page.locator('input[type=file]') });
    await upload.getByLabel('来源标题', { exact: true }).fill(`模拟工厂确认单 ${run}`);
    const until = new Date(Date.now() + 20 * 86400000);
    const localUntil = new Date(until.getTime() - until.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
    await upload.getByLabel('有效截止时间（本地时区）', { exact: true }).fill(localUntil);
    await upload.getByLabel('文件', { exact: true }).setInputFiles({
      name: 'supply.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(
        `SIMULATION ${run}\nCT-01 12oz 35×40cm Natural, single colour / single side logo. 500-999 pieces USD2.40 each; setup USD30; 20 business days after artwork/sample and deposit confirmation. Freight, tax, samples excluded. No six-week arrival commitment.`,
      ),
    });
    const sourceResponse = await withPost(page, '/sources', () =>
      upload.getByRole('button', { name: '保存来源版本' }).click(),
    );
    expect(sourceResponse.status()).toBe(201);
    let source = (await sourceResponse.json()) as { id: string; source_document_id: string };
    const sourceV1 = source.id;
    const sourceBytesV1 = await (
      await page.request.get(`${base}/supply/sources/${sourceV1}/file`)
    ).body();
    observed.sourceVersionId = source.id;
    await expect(
      card.locator('.commerce-source strong').filter({ hasText: `模拟工厂确认单 ${run}` }),
    ).toBeVisible();
    await upload
      .getByLabel('来源版本归属', { exact: true })
      .selectOption(source.source_document_id);
    await upload.getByLabel('文件', { exact: true }).setInputFiles({
      name: 'supply-v2.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(
        `SIMULATION revision 2 ${run}: same confirmed supply; archival source retained.`,
      ),
    });
    const sourceRevisionResponse = await withPost(page, '/sources', () =>
      upload.getByRole('button', { name: '保存来源版本' }).click(),
    );
    expect(sourceRevisionResponse.status()).toBe(201);
    const sourceRevision = (await sourceRevisionResponse.json()) as {
      id: string;
      source_document_id: string;
      version_no: number;
    };
    expect(sourceRevision.version_no).toBe(2);
    expect(sourceRevision.source_document_id).toBe(source.source_document_id);
    source = sourceRevision;
    observed.sourceV1 = sourceV1;
    observed.sourceVersionId = source.id;
    expect(
      (await (await page.request.get(`${base}/supply/sources/${sourceV1}/file`)).body()).equals(
        sourceBytesV1,
      ),
    ).toBe(true);
    await post(page, `${base}/supply/products/${productId}/prices`, {
      sourceVersionId: source.id,
      locator: '确认单第 1 段',
      excerpt: `模拟 500—999 件 USD 2.40/件，设置费 USD30；${run}`,
      scopeKey: 'default',
      applicability: {},
      validUntil: new Date(localUntil).toISOString(),
      qtyMin: '500',
      qtyMax: '1000',
      unitCode: 'piece',
      currencyCode: 'USD',
      unitPrice: '2.40',
      setupFee: '30',
      value: {
        seller: { name: '中文工厂（模拟）' },
        specifications: specs,
        production: {
          days: 20,
          dayKind: 'business',
          startConditions: 'artwork/sample approval and deposit confirmation',
        },
        discountBoundary: { basis: 'product_subtotal', maxPercent: '5' },
        sampleTerms: 'Samples quoted separately.',
        exclusions: ['Freight excluded', 'Taxes excluded', 'Samples quoted separately'],
        simulation: true,
      },
    });
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(card.getByText('资料已确认', { exact: true }).first()).toBeVisible();
    await noOverflow(page);
    await page.screenshot({ path: `${evidence}/${info.project.name}-supply.png`, fullPage: true });

    await page.getByRole('button', { name: '消息', exact: true }).click();
    const initialThreadsResponse = await page.request.get(`${base}/inbox/threads`);
    const initialThreads = (await initialThreadsResponse.json()) as {
      items: { id: string; contact_name: string; factories: { id: string }[] }[];
    };
    let threadId = initialThreads.items.find(
      (t) =>
        t.contact_name === 'Alex Morgan' && t.factories.some((f) => f.id === accounts.factories[0]),
    )?.id;
    if (!threadId) {
      const receipt = await post(page, `${base}/inbox/simulation`, {
        eventId: `b-ui-${run}`,
        providerMessageId: `b-ui-${run}`,
        identity: 'alex.morgan@northstar-events.example',
        displayName: 'Alex Morgan',
        body: '500 cotton bags please, arrive in six weeks.',
        occurredAt: new Date().toISOString(),
        factoryId: accounts.factories[0],
      });
      await expect
        .poll(
          async () => {
            const response = await page.request.get(`${base}/inbox/simulation`);
            const receipts = (await response.json()) as {
              id: string;
              state: string;
              normalized_thread_id: string | null;
            }[];
            const found = receipts.find((r) => r.id === receipt.id);
            if (found?.normalized_thread_id) threadId = found.normalized_thread_id;
            return found?.state;
          },
          { timeout: 25000 },
        )
        .toBe('processed');
    }
    observed.threadId = threadId;
    await page.getByRole('button', { name: '刷新会话列表' }).click();
    await page.locator('.thread-item').filter({ hasText: 'Alex Morgan' }).first().click();
    await page.getByRole('button', { name: /内部工作区 · 仅团队可见/ }).click();
    const quote = page.getByRole('region', { name: '采购需求与内部报价' });
    await expect(quote.getByRole('heading', { name: '采购需求与内部报价' })).toBeVisible();
    const quotingBase = `${base}/quoting/threads/${threadId}`;
    const workspaceResponse = await page.request.get(quotingBase);
    expect(workspaceResponse.status()).toBe(200);
    const workspace = (await workspaceResponse.json()) as QuotingView;
    const oldVersion = workspace.opportunities[0]!.row_version;
    originalRequirements = workspace.opportunities[0]!.requirements;
    restorePath = `${quotingBase}/opportunities/${workspace.opportunities[0]!.id}/requirements`;
    async function editQuantity(quantity: string, initial = false) {
      await quote.getByRole('button', { name: /整理采购需求|编辑需求/ }).click();
      if (initial) {
        await quote.getByLabel('产品', { exact: true }).selectOption(productId);
        await quote.getByLabel('面料', { exact: true }).fill(specs.fabric);
        await quote.getByLabel('尺寸', { exact: true }).fill(specs.dimensions);
        await quote.getByLabel('颜色', { exact: true }).fill(specs.color);
        await quote.getByLabel('印刷配置', { exact: true }).fill(specs.printing);
        await quote.getByLabel('目的地', { exact: true }).fill('United Kingdom');
        await quote.getByLabel('用途', { exact: true }).fill('Event bags');
        await quote.getByLabel('买家要求日期 / 原始时间要求').fill('Arrive in six weeks');
        await quote.getByLabel('内部备注（不进入预览或 PDF）').fill(`PRIVATE-COST-${run}`);
      }
      await quote.getByLabel('采购数量', { exact: true }).fill(quantity);
      const response = await withPost(page, '/requirements', () =>
        quote.getByRole('button', { name: '保存采购需求', exact: true }).click(),
      );
      expect(response.status()).toBe(201);
    }
    async function generate() {
      const response = await withPost(page, '/versions', () =>
        quote.getByRole('button', { name: '生成内部报价预览', exact: true }).click(),
      );
      expect(response.status()).toBe(201);
      return (await response.json()) as {
        id: string;
        blocked?: boolean;
        snapshot?: ObservedSnapshot;
      };
    }
    await editQuantity('500', true);
    const v1 = await generate();
    observed.v1 = v1.id;
    await expect(quote.locator('.quote-summary')).toContainText('USD 1230.00');
    await expect(quote.getByText('尚未获得外发审批', { exact: true })).toBeVisible();
    await expect(quote.getByRole('article', { name: '英文报价预览' })).not.toContainText(
      `PRIVATE-COST-${run}`,
    );
    await quote.getByRole('button', { name: '生成此版本 PDF', exact: true }).click();
    await expect(quote.getByRole('link', { name: '下载此版本 PDF' })).toBeVisible({
      timeout: 20000,
    });
    const pdf1 = await page.request.get(`${base}/quoting/versions/${v1.id}/pdf`);
    expect(pdf1.status()).toBe(200);
    const pdfBytes = await pdf1.body();
    const pdfAgain = await page.request.get(`${base}/quoting/versions/${v1.id}/pdf`);
    expect((await pdfAgain.body()).equals(pdfBytes)).toBe(true);
    observed.pdfV1Sha256 = createHash('sha256').update(pdfBytes).digest('hex');
    await quote.locator('.quote-summary').scrollIntoViewIfNeeded();
    await noOverflow(page);
    await page.screenshot({
      path: `${evidence}/${info.project.name}-quote500.png`,
      fullPage: true,
    });
    await editQuantity('800');
    const v2 = await generate();
    observed.v2 = v2.id;
    await expect(quote.locator('.quote-summary')).toContainText('USD 1950.00');
    const oldDetail = await page.request.get(`${base}/quoting/versions/${v1.id}`);
    const oldSnapshot = ((await oldDetail.json()) as { snapshot: ObservedSnapshot }).snapshot;
    expect(oldSnapshot.requirements.quantity).toBe('500');
    expect(oldSnapshot.totalAmount).toBe('1230.00');
    await quote
      .locator('.quote-version-tabs button')
      .filter({ hasText: 'USD 1230.00' })
      .first()
      .click();
    await expect(quote.locator('.quote-summary')).toContainText('USD 1230.00');
    await expect(quote.getByText('报价需要重核', { exact: true })).toBeVisible();
    await quote
      .locator('.quote-version-tabs button')
      .filter({ hasText: 'USD 1950.00' })
      .first()
      .click();
    await expect(quote.locator('.quote-summary')).toContainText('USD 1950.00');

    // Persisted failure fixture only changes this independent test artifact's processing state.
    // Actual failing-store behavior is separately covered by database/service integration tests.
    const pool = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
    try {
      await pool.query(
        "UPDATE app.quote_pdf_artifacts SET state='failed',error_code='PDF_GENERATION_FAILED' WHERE workspace_id=$1 AND quote_version_id=$2 AND state='pending'",
        [accounts.workspaceId, v2.id],
      );
    } finally {
      await pool.end();
    }
    observed.pdfFailureFixture =
      'persisted failed processing state on independent test version; no simulated IO claim';
    await quote.getByRole('button', { name: '刷新依据', exact: true }).click();
    await expect(quote.getByText('PDF 生成失败', { exact: true })).toBeVisible();
    await page.screenshot({
      path: `${evidence}/${info.project.name}-pdf-failed.png`,
      fullPage: true,
    });
    await quote.getByRole('button', { name: '重试 PDF 生成', exact: true }).click();
    await expect(quote.getByRole('link', { name: '下载此版本 PDF' })).toBeVisible({
      timeout: 20000,
    });
    await editQuantity('499');
    const blocked = await generate();
    expect(blocked.blocked).toBe(true);
    await expect(
      quote.getByRole('alert').filter({ hasText: '没有适用的已确认有效价阶' }),
    ).toBeVisible();
    await page.screenshot({
      path: `${evidence}/${info.project.name}-missing-evidence.png`,
      fullPage: true,
    });
    await editQuantity('800');
    await quote.getByRole('button', { name: '编辑需求' }).click();
    await quote.getByLabel('采购数量', { exact: true }).fill('500');
    await page.route(
      `**/quoting/threads/${threadId}/opportunities/*/requirements`,
      async (route) => {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        await route.continue({
          postData: JSON.stringify({ ...body, expectedVersion: oldVersion }),
        });
      },
      { times: 1 },
    );
    const conflict = await withPost(page, '/requirements', () =>
      quote.getByRole('button', { name: '保存采购需求', exact: true }).click(),
    );
    expect(conflict.status()).toBe(409);
    await expect(quote.getByRole('alert').filter({ hasText: '版本冲突' })).toBeVisible();
    await page.screenshot({
      path: `${evidence}/${info.project.name}-conflict.png`,
      fullPage: true,
    });
    await post(page, `${base}/supply/sources/${source.id}/withdraw`, {
      reason: `独立测试来源失效 ${run}`,
    });
    await quote.getByRole('button', { name: '刷新依据', exact: true }).click();
    await expect(quote.getByRole('alert').filter({ hasText: '来源资料已撤回' })).toBeVisible();
    await quote.getByRole('button', { name: '收起需求' }).click();
    await noOverflow(page);
    await page.screenshot({
      path: `${evidence}/${info.project.name}-invalidated.png`,
      fullPage: true,
    });
    await page.reload();
    await page.locator('.thread-item').filter({ hasText: 'Alex Morgan' }).first().click();
    await page.getByRole('button', { name: /内部工作区 · 仅团队可见/ }).click();
    await expect(
      quote.locator('.quote-version-tabs button').filter({ hasText: 'USD 1230.00' }).first(),
    ).toBeVisible();
    await expect(
      quote.locator('.quote-version-tabs button').filter({ hasText: 'USD 1950.00' }).first(),
    ).toBeVisible();
    const pdfPersisted = await page.request.get(`${base}/quoting/versions/${v1.id}/pdf`);
    expect((await pdfPersisted.body()).equals(pdfBytes)).toBe(true);
    await noOverflow(page);
    expect(errors).toEqual([]);
    observed.result = 'passed';
  } finally {
    if (restorePath && originalRequirements?.productId && originalRequirements.quantity) {
      const response = await page.request.get(
        restorePath.replace(/\/opportunities\/[^/]+\/requirements$/, ''),
      );
      if (response.ok()) {
        const current = (await response.json()) as QuotingView;
        const saved = await page.request.post(restorePath, {
          data: {
            expectedVersion: current.opportunities[0]!.row_version,
            requirements: originalRequirements,
          },
          headers: { Origin: new URL(page.url()).origin },
        });
        observed.restoredOriginalRequirements = saved.status() === 201;
        expect(saved.status(), 'restore independent browser workspace requirements').toBe(201);
      }
    }
    observed.finishedAt = new Date().toISOString();
    observed.pageErrors = errors;
    writeFileSync(
      `${evidence}/${info.project.name}-browser.json`,
      `${JSON.stringify(observed, null, 2)}\n`,
    );
  }
});
