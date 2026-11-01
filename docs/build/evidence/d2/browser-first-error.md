# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: d2.spec.ts >> D2 桌面与手机：逐人预览、明确审批、实际结果、跟进、冲突及重登持久化
- Location: tests/e2e/d2.spec.ts:7:1

# Error details

```
Test timeout of 120000ms exceeded.
```

```
Error: locator.fill: Test timeout of 120000ms exceeded.
Call log:
  - waiting for getByRole('region', { name: '触达批次', exact: true }).getByLabel('最终正文', { exact: true })

```

# Page snapshot

```yaml
- generic [ref=e3]:
  - banner [ref=e4]:
    - link "ZuTrade 首页" [ref=e5] [cursor=pointer]:
      - /url: /
      - generic [ref=e6]: Z
      - strong [ref=e7]: ZuTrade
    - generic [ref=e9]: 模拟消息工作台
    - generic [ref=e10]:
      - generic [ref=e11]: D2 · 批次与跟进
      - button "工作区与设置" [ref=e12] [cursor=pointer]:
        - generic [ref=e16]: owner
  - generic [ref=e17]:
    - navigation "主导航" [ref=e18]:
      - button "消息" [ref=e19] [cursor=pointer]
      - button "找客户" [ref=e23] [cursor=pointer]
      - button "产品" [ref=e28] [cursor=pointer]
      - button "待办" [ref=e33] [cursor=pointer]
      - button "身份、工厂、成员与健康检查" [ref=e39] [cursor=pointer]:
        - generic [ref=e43]: 工作区
    - generic [ref=e44]:
      - main [ref=e45]:
        - generic [ref=e46]:
          - generic [ref=e47]:
            - generic [ref=e48]: PUBLIC COMPANY RESEARCH
            - heading "找客户" [level=1] [ref=e49]
            - paragraph [ref=e50]: 选择代表工厂，读取公开目录，再逐项核对公司身份与来源。
          - generic [ref=e51]: 企业发现 · 真实网络
        - generic [ref=e52]:
          - complementary [ref=e53]:
            - generic [ref=e54]:
              - heading "新建研究" [level=2] [ref=e55]
              - generic [ref=e59]:
                - text: 代表工厂
                - combobox "代表工厂" [ref=e60]:
                  - option "选择工厂"
                  - option "D2-A · D2 simulated factory A" [selected]
                  - option "D2-B · D2 simulated factory B"
              - generic [ref=e61]:
                - text: 代表产品
                - combobox "代表产品" [ref=e62]:
                  - option "工厂级研究（未指定产品）" [selected]
                  - option "D2-CT-01 · D2 isolated cotton bag"
              - generic [ref=e63]:
                - text: 发现方式
                - combobox "发现方式" [ref=e64]:
                  - option "公开目录 · 无需搜索账号" [selected]
                  - option "Brave 关键词搜索 · 未启用" [disabled]
              - paragraph [ref=e65]: 关键词搜索未启用：需要本地凭据及明确的结果留存权。公开目录无需搜索服务账号。
              - generic [ref=e66]:
                - text: 公开目录
                - combobox "公开目录" [ref=e67]:
                  - option "Wikimedia · 新加坡活动公司" [selected]
                  - option "Wikimedia · 英国活动公司"
                  - option "Wikimedia · 澳大利亚活动公司"
              - paragraph [ref=e68]:
                - text: 新加坡活动管理公司百科分类；覆盖有限，不代表完整行业名录
                - link "查看公开目录" [ref=e69] [cursor=pointer]:
                  - /url: https://en.wikipedia.org/wiki/Category:Event_management_companies_of_Singapore
              - generic [ref=e74]:
                - text: 买家类型
                - textbox "买家类型" [ref=e75]: event management
              - generic [ref=e76]:
                - text: 业务关键词（逗号分隔）
                - textbox "业务关键词（逗号分隔）" [ref=e77]: events, promotional
              - generic [ref=e78]:
                - text: 排除词（逗号分隔）
                - textbox "排除词（逗号分隔）" [ref=e79]
              - generic [ref=e80]:
                - text: 候选上限
                - spinbutton "候选上限" [ref=e81]: "20"
              - paragraph [ref=e82]: 默认 20 家 · 最多 50 家 · 总请求 80 次 · 固定 180 秒。目录模式按所选名录发现，关键词用于证据匹配，不执行全网关键词搜索。
              - button "开始真实研究" [ref=e83] [cursor=pointer]
            - generic [ref=e84]:
              - heading "最近研究" [level=2] [ref=e85]
              - button "SG · events 研究完成 · 3 家 10/29/2026, 06:05 PM" [ref=e86] [cursor=pointer]:
                - strong [ref=e87]: SG · events
                - generic [ref=e88]: 研究完成 · 3 家
                - generic [ref=e89]: 10/29/2026, 06:05 PM
          - generic [ref=e90]:
            - generic [ref=e91]:
              - generic [ref=e92]:
                - heading "研究完成" [level=2] [ref=e93]
                - paragraph [ref=e94]: SG · events · 公开目录
              - button "重新研究" [ref=e95] [cursor=pointer]
            - generic [ref=e96]:
              - generic [ref=e97]: 离线测试数据
              - generic [ref=e98]: 3 家候选 · 累计 10/80 次请求
              - generic [ref=e99]: 开始 10/29/2026, 06:05 PM
              - generic [ref=e100]: 截止 10/29/2026, 06:08 PM
            - paragraph [ref=e101]: 得分只表示规则符合度。目录/摘要待复核；未知所在地、联系人及营销许可保持未知。
            - generic [ref=e102]:
              - article [ref=e103]:
                - generic [ref=e104]:
                  - heading "D1 Offline Events 1 (fictional test)" [level=3] [ref=e105]
                  - paragraph [ref=e106]: Fictional event management and promotional merchandise company for offline tests
                  - generic [ref=e107]: SG · d1-1.example.org
                - generic [ref=e108]:
                  - strong [ref=e109]: 40 分
                  - generic [ref=e110]: 已保留
                  - generic [ref=e111]: 已导入线索
                  - generic [ref=e112]: 可能已有记录 · 请核对
                  - button "核对来源" [ref=e113] [cursor=pointer]
              - article [ref=e114]:
                - generic [ref=e115]:
                  - heading "D1 Offline Events 2 (fictional test)" [level=3] [ref=e116]
                  - paragraph [ref=e117]: Fictional event management and promotional merchandise company for offline tests
                  - generic [ref=e118]: SG · d1-2.example.org
                - generic [ref=e119]:
                  - strong [ref=e120]: 40 分
                  - generic [ref=e121]: 已保留
                  - generic [ref=e122]: 已导入线索
                  - generic [ref=e123]: 可能已有记录 · 请核对
                  - button "核对来源" [ref=e124] [cursor=pointer]
              - article [ref=e125]:
                - generic [ref=e126]:
                  - heading "D1 Offline Events 3 (fictional test)" [level=3] [ref=e127]
                  - paragraph [ref=e128]: Fictional event management and promotional merchandise company for offline tests
                  - generic [ref=e129]: SG · d1-3.example.org
                - generic [ref=e130]:
                  - strong [ref=e131]: 40 分
                  - generic [ref=e132]: 已保留
                  - generic [ref=e133]: 已导入线索
                  - generic [ref=e134]: 可能已有记录 · 请核对
                  - button "核对来源" [ref=e135] [cursor=pointer]
            - group [ref=e136]:
              - generic "来源错误与研究身份" [ref=e137]
      - region "触达批次" [ref=e138]:
        - heading "线索与触达批次" [level=2] [ref=e139]
        - paragraph [ref=e140]: 消息仅 simulation · AI mock。研究线索不自动获得真实渠道联系资格。
        - heading "已确认研究线索" [level=3] [ref=e141]
        - article [ref=e142]:
          - strong [ref=e143]: D1 Offline Events 3 (fictional test)
          - paragraph [ref=e144]: 离线测试数据 · 虚构公司 · 公司身份已人工核对；个人身份未核实
          - group [ref=e145]:
            - generic "来源与联系方式资格" [ref=e146]
          - generic [ref=e147]:
            - generic [ref=e148]:
              - checkbox "加入逐人名单" [checked] [ref=e149]
              - text: 加入逐人名单
            - button "停止模拟联系" [ref=e150] [cursor=pointer]
        - article [ref=e151]:
          - strong [ref=e152]: D1 Offline Events 2 (fictional test)
          - paragraph [ref=e153]: 离线测试数据 · 虚构公司 · 公司身份已人工核对；个人身份未核实
          - group [ref=e154]:
            - generic "来源与联系方式资格" [ref=e155]
          - generic [ref=e156]:
            - generic [ref=e157]:
              - checkbox "加入逐人名单" [ref=e158]
              - text: 加入逐人名单
            - button "停止模拟联系" [ref=e159] [cursor=pointer]
        - article [ref=e160]:
          - strong [ref=e161]: D1 Offline Events 1 (fictional test)
          - paragraph [ref=e162]: 离线测试数据 · 虚构公司 · 公司身份已人工核对；个人身份未核实
          - group [ref=e163]:
            - generic "来源与联系方式资格" [ref=e164]
          - generic [ref=e165]:
            - generic [ref=e166]:
              - checkbox "加入逐人名单" [ref=e167]
              - text: 加入逐人名单
            - button "停止模拟联系" [ref=e168] [cursor=pointer]
        - group [ref=e169]:
          - generic "批次草稿 · 桌面支持完整编辑" [ref=e170]
          - generic [ref=e171]:
            - generic [ref=e172]:
              - text: 批次名称
              - textbox "批次名称" [ref=e173]: D2 UI desktop 1793268390176
            - generic [ref=e174]:
              - text: IANA 时区
              - textbox "IANA 时区" [ref=e175]: Asia/Shanghai
            - generic [ref=e176]:
              - text: 计划开始
              - textbox "计划开始" [ref=e177]: 2026-10-29T18:05
            - generic [ref=e178]:
              - text: 截止时间
              - textbox "截止时间" [ref=e179]: 2026-10-29T19:06
            - generic [ref=e180]:
              - text: 逐项间隔（毫秒，至少1000）
              - spinbutton "逐项间隔（毫秒，至少1000）" [ref=e181]: "1000"
          - group "第 1 项 · D1 Offline Events 3 (fictional test)" [ref=e182]:
            - generic [ref=e184]:
              - text: 最终主题
              - textbox "最终主题" [active] [ref=e185]: D2 UI exact subject
            - generic [ref=e186]:
              - text: 最终正文
              - textbox "最终正文" [ref=e187]: Hello D1 Offline Events 3 (fictional test) team, We represent D2 simulated factory A. May we share product information if relevant to your work? Internal simulation. No prior purchase interest is assumed.
            - generic [ref=e188]:
              - text: 引用报价版本（可选）
              - textbox "引用报价版本（可选）" [ref=e189]
            - text: 引用报价时，最终正文及附件由已校验报价生成，提交后的逐人预览为准。
          - button "保存批次草稿" [ref=e190] [cursor=pointer]
          - button "新建草稿" [ref=e191] [cursor=pointer]
        - heading "批次与不可变版本" [level=3] [ref=e192]
        - article [ref=e193]:
          - strong [ref=e194]: D2 离线隔离批次 · 草稿
          - paragraph [ref=e195]: 实际逐项汇总：awaiting_approval 1
          - generic [ref=e196]:
            - button "编辑草稿／建立新版本" [ref=e197] [cursor=pointer]
            - button "提交完整版本审批" [ref=e198] [cursor=pointer]
            - button "预览 v1 · 待审批" [ref=e199] [cursor=pointer]
        - article [ref=e200]:
          - strong [ref=e201]: D2 离线隔离批次 · 已停止
          - paragraph [ref=e202]: 实际逐项汇总：unknown · 须核对 1
          - generic [ref=e203]:
            - button "编辑草稿／建立新版本" [ref=e204] [cursor=pointer]
            - button "提交完整版本审批" [ref=e205] [cursor=pointer]
            - button "预览 v1 · 已撤销" [ref=e206] [cursor=pointer]
        - article [ref=e207]:
          - strong [ref=e208]: D2 离线隔离批次 · 已完成
          - paragraph [ref=e209]: 实际逐项汇总：模拟完成 1
          - generic [ref=e210]:
            - button "编辑草稿／建立新版本" [ref=e211] [cursor=pointer]
            - button "提交完整版本审批" [ref=e212] [cursor=pointer]
            - button "预览 v1 · 已批准" [ref=e213] [cursor=pointer]
        - article [ref=e214]:
          - strong [ref=e215]: D2 离线隔离批次 · 已完成
          - paragraph [ref=e216]: 实际逐项汇总：模拟完成 1
          - generic [ref=e217]:
            - button "编辑草稿／建立新版本" [ref=e218] [cursor=pointer]
            - button "提交完整版本审批" [ref=e219] [cursor=pointer]
            - button "预览 v1 · 已批准" [ref=e220] [cursor=pointer]
        - article [ref=e221]:
          - strong [ref=e222]: D2 离线隔离批次 · 已停止
          - paragraph [ref=e223]: 实际逐项汇总：已停止 1
          - generic [ref=e224]:
            - button "编辑草稿／建立新版本" [ref=e225] [cursor=pointer]
            - button "提交完整版本审批" [ref=e226] [cursor=pointer]
            - button "预览 v1 · 已撤销" [ref=e227] [cursor=pointer]
        - article [ref=e228]:
          - strong [ref=e229]: D2 离线隔离批次 · 已完成
          - paragraph [ref=e230]: 实际逐项汇总：模拟完成 2
          - generic [ref=e231]:
            - button "编辑草稿／建立新版本" [ref=e232] [cursor=pointer]
            - button "提交完整版本审批" [ref=e233] [cursor=pointer]
            - button "预览 v1 · 已批准" [ref=e234] [cursor=pointer]
        - article [ref=e235]:
          - strong [ref=e236]: D2 v2 · 草稿
          - paragraph [ref=e237]: 实际逐项汇总：已停止 1；awaiting_approval 2
          - generic [ref=e238]:
            - button "编辑草稿／建立新版本" [ref=e239] [cursor=pointer]
            - button "提交完整版本审批" [ref=e240] [cursor=pointer]
            - button "预览 v2 · 待审批" [ref=e241] [cursor=pointer]
            - button "预览 v1 · 已失效" [ref=e242] [cursor=pointer]
```

# Test source

```ts
  1   | import { test, expect } from '@playwright/test';
  2   | import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
  3   | const enabled = Boolean(process.env.D2_UI_BASE);
  4   | const fixture = enabled ? JSON.parse(readFileSync('.local/d2-test-last.json', 'utf8')) : null;
  5   | test.skip(!enabled, 'D2 requires retained isolated PostgreSQL via test:d2:browser');
  6   | test.use({ timezoneId: 'Asia/Shanghai' });
  7   | test('D2 桌面与手机：逐人预览、明确审批、实际结果、跟进、冲突及重登持久化', async ({
  8   |   page,
  9   | }, info) => {
  10  |   test.setTimeout(120000);
  11  |   const evidence = 'docs/build/evidence/d2/browser';
  12  |   mkdirSync(evidence, { recursive: true });
  13  |   const errors: string[] = [];
  14  |   page.on('pageerror', (e) => errors.push(e.message));
  15  |   await page.goto(process.env.D2_UI_BASE!);
  16  |   await page.getByLabel('邮箱', { exact: true }).fill(fixture.users.owner.email);
  17  |   await page.getByLabel('密码', { exact: true }).fill(fixture.users.owner.password);
  18  |   await page.getByRole('button', { name: '登录', exact: true }).click();
  19  |   await page.getByRole('button', { name: '找客户', exact: true }).click();
  20  |   const panel = page.getByRole('region', { name: '触达批次', exact: true });
  21  |   await expect(panel.getByText(/离线测试数据 · 虚构公司/).first()).toBeVisible();
  22  |   await panel.getByRole('checkbox', { name: '加入逐人名单' }).first().check();
  23  |   const name = 'D2 UI ' + info.project.name + ' ' + Date.now();
  24  |   await panel.getByLabel('批次名称', { exact: true }).fill(name);
  25  |   const wall = await page.evaluate(() => {
  26  |     const d = new Date(Date.now() - 60000);
  27  |     return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  28  |   });
  29  |   await panel.getByLabel('计划开始', { exact: true }).fill(wall);
  30  |   await panel.getByLabel('最终主题', { exact: true }).fill('D2 UI exact subject');
  31  |   await panel
  32  |     .getByLabel('最终正文', { exact: true })
> 33  |     .fill('SIMULATION: owner reviews this exact recipient and content.');
      |      ^ Error: locator.fill: Test timeout of 120000ms exceeded.
  34  |   await panel.getByRole('button', { name: '保存批次草稿', exact: true }).click();
  35  |   await expect(panel.getByText('草稿已保存；提交完整版本后才申请 owner 审批。')).toBeVisible();
  36  |   const card = panel
  37  |     .locator('.d2-card')
  38  |     .filter({ has: page.getByText(name, { exact: false }) })
  39  |     .filter({ has: page.getByRole('button', { name: '提交完整版本审批', exact: true }) });
  40  |   await card.getByRole('button', { name: '提交完整版本审批', exact: true }).click();
  41  |   await card.getByRole('button', { name: '预览 v1 · 待审批', exact: true }).click();
  42  |   const preview = panel.getByRole('article', { name: '批次逐人最终预览' });
  43  |   await expect(preview.getByText('D2 UI exact subject', { exact: true })).toBeVisible();
  44  |   await expect(
  45  |     preview.getByText('SIMULATION: owner reviews this exact recipient and content.', {
  46  |       exact: true,
  47  |     }),
  48  |   ).toBeVisible();
  49  |   await expect(preview.getByText(/模拟账号：/)).toBeVisible();
  50  |   await page.screenshot({ path: `${evidence}/${info.project.name}-preview.png`, fullPage: true });
  51  |   await preview.getByRole('button', { name: '批准完整批次并模拟执行', exact: true }).click();
  52  |   await expect(panel.getByText('批次已排队，逐项状态以实际网关结果为准。')).toBeVisible();
  53  |   await expect(card).toContainText('模拟完成 1', { timeout: 15000 });
  54  |   await page.reload();
  55  |   await page.getByRole('button', { name: '找客户', exact: true }).click();
  56  |   await expect(page.getByText(name, { exact: false }).first()).toBeVisible();
  57  |   await page.getByRole('button', { name: '待办', exact: true }).click();
  58  |   await page.getByRole('button', { name: '打开关联会话', exact: true }).first().click();
  59  |   await expect(page.getByRole('button', { name: /内部工作区/ })).toBeVisible();
  60  |   await page.getByRole('button', { name: /内部工作区/ }).click();
  61  |   const followup = page.getByRole('region', { name: '跟进计划', exact: true });
  62  |   await followup.getByText('新增跟进（默认只提醒）', { exact: true }).click();
  63  |   await followup.getByLabel('目标', { exact: true }).fill('D2 UI reminder ' + info.project.name);
  64  |   await followup
  65  |     .getByLabel('内部草稿', { exact: true })
  66  |     .fill('Internal only; not external content.');
  67  |   await followup.getByRole('button', { name: '保存计划版本', exact: true }).click();
  68  |   await expect(followup.getByText('跟进提醒已保存。')).toBeVisible();
  69  |   // Actual DST error feedback from the server, with no plan created.
  70  |   await followup.getByLabel('本地到期时间', { exact: true }).fill('2027-03-14T02:30');
  71  |   await followup.getByLabel('IANA 时区', { exact: true }).fill('America/New_York');
  72  |   await followup.getByRole('button', { name: '保存计划版本', exact: true }).click();
  73  |   await expect(followup.getByRole('alert').filter({ hasText: '不存在' })).toBeVisible();
  74  |   await page.screenshot({
  75  |     path: `${evidence}/${info.project.name}-followup-error.png`,
  76  |     fullPage: true,
  77  |   });
  78  |   await page.getByRole('button', { name: '工作区与设置', exact: true }).click();
  79  |   await page.getByRole('button', { name: '退出登录', exact: true }).click();
  80  |   await page.getByLabel('邮箱', { exact: true }).fill(fixture.users.owner.email);
  81  |   await page.getByLabel('密码', { exact: true }).fill(fixture.users.owner.password);
  82  |   await page.getByRole('button', { name: '登录', exact: true }).click();
  83  |   await page.getByRole('button', { name: '待办', exact: true }).click();
  84  |   await expect(
  85  |     page.getByText('D2 UI reminder ' + info.project.name, { exact: false }).first(),
  86  |   ).toBeVisible();
  87  |   expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  88  |   expect(errors).toEqual([]);
  89  |   await page.screenshot({ path: `${evidence}/${info.project.name}-retained.png`, fullPage: true });
  90  |   writeFileSync(
  91  |     `${evidence}/${info.project.name}.json`,
  92  |     JSON.stringify(
  93  |       {
  94  |         observedAt: new Date().toISOString(),
  95  |         database: process.env.D2_UI_DATABASE,
  96  |         viewport: info.project.name,
  97  |         origin: 'offline_fixture',
  98  |         errors,
  99  |       },
  100 |       null,
  101 |       2,
  102 |     ) + '\n',
  103 |   );
  104 | });
  105 | 
```