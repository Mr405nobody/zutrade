# Outbound Intelligence MVP 交付报告

日期：2026-11-01（Asia/Shanghai）。范围：本次用户单独授权的“主动获客＋企业公开资料背调”增量，不进入其他建设阶段。

**状态：verification_blocked。** 代码、本地隔离功能验证与浏览器路径已完成；本机真实官网仍被保留地址 DNS 阻断，真实官网提取到人工审核的整条成功链尚未通过，不能写 ready_for_user_review 或 accepted。D1/D2/V 原有受阻状态保留。用户没有验收本阶段。

## 1. 实际架构扫描

- 工程为 ESM、strict TypeScript、pnpm workspace。锁定 Node 24.22.1、pnpm 11.25.0，只经 `./scripts/zu` 执行。源码位于 apps/web、api、worker；共享 domain、db、contracts、prospecting、channels、ai、storage、ui、config。
- 浏览器：React 19.3.1、Vite 8.3.5、Tailwind 4.3.3、已有 shadcn 来源 Button、Lucide、TanStack Query。原应用用四入口本地状态切换，没有引入路由框架；本次为 `/outbound` 和 `/outbound/companies/:id` 加入可刷新入口，旧研究与模拟批次保留 `/prospecting` 入口。
- 后端：NestJS 12.3.2；独立 worker；PostgreSQL 18.6、Drizzle、node-postgres；pg-boss 12.38.0 是唯一任务系统。研究任务业务、outbox、enqueue 共事务。已有请求预算、检查点、取消、固定期限、执行 fencing、重试和审计，直接复用。
- 认证：Better Auth；auth subject 映射业务用户；当前有效 owner/sales 与工厂授权由服务端读取。业务/API/worker 角色不拥有业务表、无 superuser/BYPASSRLS；所有业务表 FORCE RLS。没有另建登录或权限系统。
- 原有模型包含 workspace、factory、buyer、contact/contact_point、lead、thread、opportunity、product、供给来源、quote、approval、followup。D1 已有 prospecting_runs 与冻结候选/证据；本次不改报价、商业审批、模拟发送或 CRM 模型。
- AI 为 MockAIProvider/preset，没有已启用真实模型；检查本机 Ollama 11434 不可达。本次报告和查询扩展均为规则生成，没有调用模型。
- 网页解析已有 Cheerio 1.2.0、Node HTTP/HTTPS、ipaddr.js；复用 DNS 全答案检查、地址 pinning、TLS、重定向验证及响应体上限。不运行网页 JavaScript，不另建 Python 服务。Playwright 仅用于测试。
- Compose 与运行容器只有 PostgreSQL；未发现 SearXNG 配置或运行服务。公司官网/Wikipedia 本机 DNS 返回 198.18.x.x 保留地址，安全读取正确拒绝。没有改变代理、DNS 或 SSRF；没有新增 Docker 组件。
- 测试为 Vitest、真实 Docker PG 集成与 Chrome Playwright。开工时 PostgreSQL 健康，日常 web/API/worker 未运行。Git 全工程原为 untracked；没有自动提交、推送、重写历史或部署。

## 2. 最小改动与实际文件

复用研究、队列、证据和审计；只新增一张公司名单表，不按建议重新建立四套相似表。

| 层           | 新增/修改文件                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 契约         | 新增 packages/contracts/src/outbound.ts；修改 prospecting.ts、index.ts                                                                                                                                        |
| 读取与报告   | 新增 packages/prospecting/src/outbound.ts；修改 index.ts、network.ts                                                                                                                                          |
| 领域         | 新增 packages/domain/src/outbound.ts；修改 prospecting.ts、index.ts                                                                                                                                           |
| API          | 新增 apps/api/src/outbound-controller.ts；修改 main.ts                                                                                                                                                        |
| 界面         | 新增 apps/web/src/outbound.tsx；修改 main.tsx、styles.css                                                                                                                                                     |
| 数据         | 新增 packages/db/migrations/business/0020_outbound_intelligence.sql；修改迁移 journal、生成的 packages/db/src/schema.ts                                                                                       |
| 测试与启动   | 新增 scripts/verify-outbound.mjs、outbound-ui-serve.mjs、verify-outbound-browser.mjs、outbound-daily-upgrade.mjs；tests/unit/outbound.test.ts、tests/e2e/outbound.spec.ts；修改 package.json、db-accounts.mjs |
| 必要回归适配 | scripts/verify-d1.mjs、verify-v.mjs 从历史固定数量改为按迁移清单核对当前表/迁移数量，保留原权限、升级与业务断言                                                                                               |
| 交接         | README.md、docs/build/PROGRESS.md、HANDOFF.md、ACCEPTANCE.md、SCOPE.md、MIGRATIONS.md、本报告、ADR0015、evidence/outbound                                                                                     |

旧 D1 研究命令继续使用原请求字段与摘要规则，防止升级后重复提交被误判为内容变更。

没有新增依赖；原始 build-kit SQL、参考资料及 0000—0019 的 SQL 字节保持。完整命令/退出码见 evidence/outbound/verification-summary.json。

## 3. 实际实现

- 搜索表单默认 Industrial Fasteners / United States / Distributor / 20；代表工厂必选，沿用现有权限。英文查询用词汇规则生成，并明确“尚未执行搜索”。
- 自动搜索不可用时，用户仍可建立真实持久任务；worker 将其终结为 AUTOMATIC_SEARCH_UNAVAILABLE、0 次请求，不提供假结果。手动模式明确要求实际官网 URL 及公开事实摘录使用权限确认。
- 手动 URL 规范化到站点根地址，移除路径/跟踪参数；忽略 www、大小写去重。URL 先静态检查，worker 再检查所有 A/AAAA、保留/私网地址、响应大小和跳转。新读取器拒绝跨 origin 跳转，用户可核对最终官网后重新提交。
- 先检查 robots.txt，再读取首页及从首页找到的 About/Products/Contact 链接，最多四页；只跟同 origin 静态页面。不猜路径、不执行脚本、不绕验证码/登录/反爬。robots 缺失 404 按规则处理，其他读取错误/不支持格式保留失败；尊重规则及有界 Crawl-delay，过长则停止。
- 官网事实来自 Organization JSON-LD、站点名称/描述及可见文本字面匹配。国家不会从用户目标补全；未取到名称/地址/类型时保留未知。产品扩展仅含 fastener、bolts、nuts 等简单规则；明确不匹配的国家、排除词或未取得产品依据的网站不会进入名单。
- 已采集资料和搜索条件分开：研究快照保存输入、来源 URL、实际 UTC、必要摘录、正文 SHA256、定位依据与来源状态；公司名单只引用冻结候选。官网自述不等于独立主体核实。
- 规则报告包含身份、产品与市场匹配、潜在价值推断、已取得的不一致线索、未知事项、证据和建议。没有虚构采购记录、信用分、采购负责人或私人联系方式；注册、信用、付款、诉讼、实控人、制裁状态如实列为未核实/未执行。读取失败不成为欺诈风险。
- 公司按 workspace＋factory＋规范化域名唯一。重复任务保留各次研究证据，公司行保留首次来源，不覆盖人工结论。通过/驳回/待补充调查均落库；审核版本 CAS、实际成员、DB 时间、备注、独立人工修正和追加式审计同事务保存。已通过名单可筛选查看。
- 最多 20 个输入域名、80 次累计请求、全局并发 2、每 host 1；新读取器至少间隔 1 秒，单请求 10 秒、任务 180 秒、响应体 2 MiB。预算/期限/检查点跨重试保留。数量不足不凑齐，部分结果与逐条失败可查看。

## 4. 尚未实现、搜索与外部 API

**本次自动搜索来源不可用，没有实现全自动获客。** SearXNG 未安装/接入；现有 Brave 适配保留在旧研究入口，但本模块绝不启用或调用商业搜索 API。没有新增任何付费/API Key 服务、云模型或真实消息发送。

实际外部请求仅为人工提交的公开官网/robots HTTP 读取。真实 Fastenal 官网尝试在 DNS 检查时失败，未获取正文、未生成候选；见 live-attempt.json。隔离测试的 Fictional Offline Fastener Fixture 始终标记 offline_fixture，不能当成真实发现或真实公司。

没有独立注册查询、专业信用/制裁库、法律诉讼查询、邮件群发、WhatsApp、自动报价、订单、复杂 CRM、多 Agent 框架或新微服务。

## 5. 数据库变更与已有数据

0020 仅扩展 prospecting_runs.provider 的 CHECK，增加 `app.outbound_companies`（14 列）及索引、复合 FK、FORCE RLS、历史保护与列级授权。已有 prospecting_runs 保存任务/候选/证据，audit_events 保存人工审核历史；不重复建设 campaigns/evidence/reviews 主库。当前 46 app 表、676 列、162 FK（117 复合）、208 CHECK；原 42 表基线不变。

真实空库迁移、重复迁移和 ORM 对照通过。日常库升级前在 ignored 私有目录生成 pg_dump 与私有对象副本；备份位置仅记录于 `.local/outbound-upgrade-last.json`。0020 升级后旧 45 表逐表行数及内容摘要全部一致，新表为空。没有 seed/reset、删卷或代替日常 owner 批准。此次备份没有另做恢复演练，不把前序 V 的恢复证据当成本次执行。

## 6. 实际验证与真实失败

- 全工程 build、typecheck、lint 及边界检查通过；构建仍有前端单包大于 500 kB 提示，未进行性能优化或声称生产负载达标。
- Vitest 102 项通过；新增规则/事实边界、权限确认、URL 去重、SSRF、跨 origin 跳转、脚本文本排除与目标国家不补全检查。
- Outbound 10 组真实 PG/pg-boss 集成通过。成功采集数据为显式离线 HTTP 注入；其中另有一条真实官网网络尝试，结果是失败，不将其记为真实成功。
- A1 数据库/认证/租户/工厂权限回归 23 组、D1 任务/预算/强杀/并发回归 16 组、V 离线研究→AI→USD1230报价/PDF→owner审批→模拟网关/跟进/四入口/分页回归 6 组通过。
- Chrome 1440×1000 与 390×844 两个视口浏览器测试通过；检查真实网络失败反馈、固定路由、证据、三状态审核、人工修正、刷新、旧消息/产品入口、退出后 401，无页面脚本异常；实际查看了截图。不等同实体手机或其他浏览器验证。
- 保留真实失败：浏览器首次用错产品标题断言；第二次测试直接 sign-out 未携带浏览器 Origin，未实际退出；改为产品内退出操作后通过。V 首次仍断言 20 条迁移，新增 0020 后实际 21；改为迁移清单数量并保留原有带数据升级断言，复测通过。这些是测试适配错误，未修改认证安全或削弱权限。
- `doctor --services` 开工退出 1，原因是日常 API 未运行；数据库/工具链/原 SQL 摘要均正常。启动后重新检查，结果见最终记录。

所有测试使用独立数据库，不清理用户日常数据。失败库与结果保留，账号、连接字符串、trace 只保留在 .local，报告不放密码。

## 7. 启动与人工操作

日常库已完成增量迁移。日后修改源码或新环境按以下顺序（无需重新 seed）：

```sh
./scripts/zu infra:start
./scripts/zu build
./scripts/zu db:migrate
./scripts/zu start
```

日常入口 http://127.0.0.1:5173/outbound；沿用原工作区账号。`./scripts/zu db:accounts` 只输出私有账号文件路径，账号仅在本机打开。

本地功能演示另用 `./scripts/zu ui:outbound` 打开 http://127.0.0.1:5773/outbound，账号位于 `.local/outbound-test-last.json` 的 users.owner/users.sales。该样例公司全部是离线测试数据；从该入口新建的任务仍走真实网络，绝不自动回落测试数据。

1. 登录后打开“找客户”，核对默认产品、美国、Distributor、20。当前应明确显示自动搜索不可用。
2. 选择代表工厂和手动导入，输入有权读取的真实企业官网，确认公开资料使用条件，点击“导入官网并调查”。当前本机应看到真实 DNS 安全拒绝、0 家及失败来源；网络条件恢复后才可能取得真实资料。
3. 在隔离样例点击“查看企业”，核对四个实际测试来源摘录、调查时间、规则生成标识、未进行独立注册核验与其他未知事项。不得把样例当真实获客。
4. 填人工修正/审核备注，依次检查待补充调查、驳回或通过；应看到真实审核人、时间、版本与历史，原始来源不变。
5. 返回名单，筛选已通过并刷新/退出重登，应保留审核结果。真实网络恢复后，需对真实企业重复 2—5 步，才能完成尚未通过的真实闭环验收。

## 8. 当前限制与下一阶段建议

先在可正常解析和直达公开网站的已授权环境，保持 SSRF 完成真实官网读取、证据核对、去重、审核与刷新验证；再考虑本地 SearXNG 的实际可用性和条款。无需云端模型或付费搜索来完成手动 P0。

当前使用简单词汇/结构化数据规则，不具备语义理解，存在漏召回与误匹配，需要人工审核；静态页不能读取依赖 JS 的内容。跨 origin 跳转保守拒绝。最多四页不代表全面调查。没有独立注册/信用/制裁核验。同主体多域名不自动合并，首次公司来源不自动换成更新任务。名单/任务/审核历史分别限 100/30/30，不是完整历史分页。

参考实现依据：[Node DNS](https://nodejs.org/api/dns.html)、[robots RFC9309](https://www.rfc-editor.org/rfc/rfc9309.html)、[SearXNG JSON 格式配置](https://docs.searxng.org/admin/settings/settings_search.html)。这些仅用于核对接口/规则，不代表运行环境已接通对应来源。
