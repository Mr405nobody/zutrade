# 阶段 D1：真实寻找海外公司

日期：2026-10-29（Asia/Shanghai）。状态：**verification_blocked**。用户明确授权只实施 D1，并明确选择保持当前 fake-IP 网络现状。C 原为 ready_for_user_review，按本次明确启动下一阶段记录 accepted；没有编造人工验收操作，没有替用户批准 Alex 报价。本次不进入 D2。

## 已交付的独立实现

“找客户”四入口内可选代表工厂、产品、目录/关键词方式、地区、买家类型、关键词、排除词和上限。真实 worker 读取来源并保存研究状态，候选可打开来源抽屉、查看时间/摘录/字段定位/发现链/摘要范围/规则依据、保留或排除、确认身份后导入。桌面/390px 手机均验证。目录中的关键词仅用于匹配，不伪装成全网搜索。未知信息保持未知，规则分不是采购概率。

统一 ResearchProvider 包含 PublicDirectoryProvider、正式 BraveSearchProvider、仅显式测试注入的 FixtureResearchProvider。运行时无 fixture fallback，HTTP 契约不接受 fixture。目录配置不是公司名单：本次响应中的 categorymembers 页面和 Wikidata 实体链接才是候选来源。当前交付 SG/GB/AU 的活动管理公司百科分类；覆盖有限，不代表全部礼品代理或促销品分销商。

终态结果冻结，审核决定独立 CAS/审计。导入只接受 run/key/版本与人工选择，正文从服务器快照读取；锁工作区及 run，再创建或显式关联 buyer、复制来源并建 lead，同 run/candidate 并发只产生一条。没有真实联系人时只建公司线索，公开邮箱仅存研究证据，不创建 verified/allowed contact point，不写工厂 facts。同名/同规范域名只提示已有记录，不自动合并。

消息仍 simulation，AI 仍 mock/preset；没有真实消息、真实模型、批次或跟进生产者。

## 数据、预算与网络

开工实查 app 44 表、simulation 4 表、迁移至 0012，Alex 为 v17 / 500 件 / 1230.00 USD。仅 0013 新增 prospecting_runs 和 leads 两字段，0014 补精确失权终止入口；app 45 表、simulation 仍 4 表。复合 FK、候选唯一、研究/线索工厂 RLS、最小列授权、审计和索引均落实。业务研究/outbox/pg-boss 同事务，真实三点失败注入全部共同回滚。完整 Drizzle catalog 映射已更新。原 SQL hash 和 0000—0012 已应用 hash 保持。

默认 20、硬上限 50 候选；目录最多 5 页，每公司最多实体/robots/官网三种页面资源；全 run 80 HTTP 请求，GET/HEAD/重试/每跳均占额度。默认并发 2、每主机 1，并使用数据库 session advisory gate 跨进程约束。每请求 10 秒、最多 3 跳、压缩前后各 2 MiB、研究固定 180 秒、重试最多 2 次。429 遵守 Retry-After；长等待直接报告，不抢先重试。

首次开始/原 deadline/累计计数/检查点持久化，实际请求前原子占用预算。真正的队列 retry_count 才允许新执行 token；每次请求前后及保存时重新检查当前 actor、工厂、状态、deadline/token。终态冻结，取消或失去执行权后旧执行者不能覆盖结果。目录和搜索的在途页也有检查点；重新研究新建 run。

SSRF 验证协议、标准端口、URL 凭据、特殊 IPv4/IPv6/映射/保留段、完整 A/AAAA 与每跳。原生 HTTPS 固定已验证 lookup 地址、保留 Host/SNI 和证书校验，agent=false，无第二次任意 DNS。无私网/代理绕过开关。静态读取不执行网页脚本/表单，先检查 robots，外部页不携带 cookie/内部认证/Brave key。key 只发固定正式 endpoint，搜索不跟随跳转。证据记录真实 UTC、来源和最终 URL、读取状态、必要摘录、字段依据、完整解压响应字节 hash/hash_scope 和版本。失败证据没有正文 hash；失败官网不显示“已读取”。512 KiB 快照预留 jsonb 开销，截断明确记录。

方案、版本与官方依据见 ADR 0011。锁定新增依赖 Cheerio 1.2.0、ipaddr.js 2.2.0（MIT）；未升级既有技术栈，公开导出/ESM/strict 和浏览器边界检查保留。

## 真实联网执行：未通过

本机系统 DNS 与 Node resolve4 都把公网域名返回为 **198.18.0.x**：en.wikipedia.org=198.18.0.10、www.wikidata.org=198.18.0.11；AAAA 为 ENODATA。固定公开 URL 的直接 HTTPS 探测也超时。198.18/15 是保留测试网段，安全 transport 在连接前拒绝。用户明确选择“保持现状，联网受阻如实记录”，故没有调整代理/VPN、改 DNS、硬编码公网 IP 或增加绕过开关。

`./scripts/zu prospecting:live` 在主工作区、既有 CT-01 工厂/产品、真实 worker 依次执行：

| 目录                        | 实际 UTC 开始时间        | run                                  | 请求预算 | 结果                                |
| --------------------------- | ------------------------ | ------------------------------------ | -------- | ----------------------------------- |
| SG 活动公司                 | 2026-10-29T08:40:25.749Z | 2377cd8c-ad55-4ac0-befd-fd4bf1cd04e4 | 1/80     | failed / SSRF_DNS_REJECTED / 0 候选 |
| GB 活动公司                 | 2026-10-29T08:40:26.709Z | 3d7cbba8-c874-48b2-b106-a947fb1e9780 | 1/80     | failed / SSRF_DNS_REJECTED / 0 候选 |
| AU 活动公司（补充有界验证） | 2026-10-29T08:40:27.721Z | 5955d129-a452-40d4-9335-c62c399112ba | 1/80     | failed / SSRF_DNS_REJECTED / 0 候选 |

完整结果与完成时间在 evidence/d1/live-check.json；live-third.txt 对应退出 **2**（门槛未满足）。候选来源抽查 **0 家**，真实候选导入及重复导入 **未执行**，没有填造数据。首次尝试在真实 API 上发现产品列错误，第二次碰到 watch 构建重启，恢复后才得到上述三个完整真实失败任务；这些都保留日志。

浏览工具实际读到了 [英国分类](https://en.wikipedia.org/wiki/Category:Event_management_companies_of_the_United_Kingdom)、[澳大利亚分类](https://en.wikipedia.org/wiki/Category:Event_management_companies_of_Australia)、[数据访问与 API 资料](https://www.wikidata.org/wiki/Wikidata:Data_access)及 [CC0](https://www.wikidata.org/wiki/Wikidata:Licensing)；这些仅用于来源/接口/许可核对，**不是本机 worker 实际可读或发现成功的证明**。BPMA 目录虽可经浏览工具阅读，其条款限制自动读取/留存，未作为默认 provider。没有将该名单写入产品。

Brave 没有配置本地凭据/所需留存权，界面明确“关键词搜索未启用”。正式适配以执行时 [GET 官方文档](https://api-dashboard.search.brave.com/api-reference/web/search/get)和 [当前条款](https://api-dashboard.search.brave.com/documentation/resources/terms-of-service)核对；离线请求参数、摘要/来源分级和密钥隔离有测试，实际 Brave 账号/计划/联网成功 **未验证**。

所需条件是本机研究域名返回真实公网地址，并能以正常 TLS 校验读取公开来源。网络恢复后仍须补齐两次真实研究、至少三家来源抽查、一条真实确认→lead 路径及重复导入，才可能进入 ready_for_user_review。用户本次未减少这些门槛。

## 实际离线与 PostgreSQL 验证

离线测试使用显式注入的虚构目录响应，研究保存 origin=offline_fixture，正向界面明确显示“离线测试数据”；不进入日常主库。真实网络测试单独执行、单独报告。

- D1 真实 PostgreSQL/pg-boss **16 组**：RLS、成员/工厂/跨 workspace、产品归属、strict 请求、篡改 key、旧结果/审核版本、排除拒绝、三点事务回滚、6 次并发重复导入、跨 run 重复建议/显式 buyer 关联、历史证据/SQL 冻结、零/拒绝/部分/429、取消、80 次预算、失权终止、固定截止、旧执行者和跨独立连接池网络 gate。
- 实际专用 worker **SIGKILL** 后，以官方 fail/fetch 重试同 job，retry_count 推进；恢复时原 deadline 不变，已有 4 次请求/候选 cursor=1，最后 10 次请求、3 候选、execution_version=2。保存了 PID/IPC/终止信号、原 job 与恢复领取；不是抛异常冒充强杀。另让旧进程暂停后由新执行者完成，再恢复旧进程，结果与计数未被覆盖。
- 最终单元 **85 项通过**。单元测试覆盖特殊 IP、混合 A/AAAA、逐跳重绑定、元数据跳转、原生 HTTPS 调用参数中的固定 lookup/Host/SNI/TLS、跳转/HEAD/预算、MIME、gzip/deflate/br 解压体积、10 秒超时、429 Retry-After/最多重试、并发、静态解析/不执行指令、语义 URL、robots、Brave 权限/正式参数、fixture 不降级。
- Chrome **2 项**：1440×1000 与 390×844，来源抽屉、保留/排除原因、确认、重复导入、已排除按钮禁用、真实网络受阻显示、无横向溢出。截图在 evidence/d1/browser/。只代表本机浏览器视口，不代表实体手机/其他浏览器。

回归均独立隔离数据库：C 23 组、B 14 组、A1 23 组、A2 19 组、原始入站 11 组通过，日志分别在 regression/。C 使用 3601/3602，避免碰原 3401/3402 样例；没有再跑会改变 Alex 上下文的日常浏览器演示。实际审批/冻结/PDF/模拟发送路径在隔离库回归，不等于批准日常 Alex。

最终构建、strict、lint/边界、单元、D1、浏览器、重复迁移、doctor 和敏感信息检查的准确命令/退出码见 **evidence/d1/verification-summary.json**。先前失败日志保留，最终文件不将尚未通过的联网门槛写为通过。

## 真实失败与恢复记录

- 开工 SQL 探查先后误用 currency/status 列名，实际查询失败；按真实 schema 改为 currency_code/state，再取得基线，没有写数据库。原始目录 HTTPS 探测超时，之后确认 fake-IP，未放宽 SSRF。
- 初次 patch 上下文/顺序不匹配、fixture 脚本括号与格式问题实际失败；修正后构建/测试。首次 strict 构建发现 domain 未声明 drizzle-orm，改用 db 的公开 drizzle 导出；检查点联合类型显式收窄。
- 首轮单元用原生 AbortSignal.timeout，fake timer 不接管导致两项超时；改为可取消 AbortController/定时器，生产的 10 秒上限不变，测试恢复通过。
- 首次真实 API 创建带产品的任务查错 products.status，返回 500；改为真实 products.state，并补产品归属测试。构建 watch 重启期间第二次登录失败；等待真实 readiness 后第三次成功提交三个任务，均按 DNS 边界正确失败。
- lint 发现 unused/control-regex/空 catch/冗余赋值和格式问题，逐项修正；保留 lint-first/second/third 与最终记录。早期回归 B 日志目录与并行创建竞争，重建精确证据目录后重跑通过。
- 截图实查发现历史列表过长会让右侧候选滚出视口，改独立滚动/手机定位并重新验证；失败官网标题也改为“官网来源 · 未读取成功”，避免假已读。
- 初次最终审计用 JSON 对象键顺序直接比较迁移记录，误报改变；改比较每条 created_at/hash 对，真实旧迁移没有变化，复核通过。

所有测试库保留精确名称清单，没有宽泛删库/删卷、schema push、seed 覆盖、自动提交、推送、部署、购买服务、申请账号或联系真实公司。

## 使用与停点

主工作台 [5173](http://127.0.0.1:5173/)，原 C 样例 [5273](http://127.0.0.1:5273/)，D1 隔离离线样例 [5373](http://127.0.0.1:5373/)。账号取得用 `./scripts/zu db:accounts`，私有文件仅本机打开。日常 stop 后 `./scripts/zu dev`；隔离样例 `./scripts/zu ui:d1`，不重新 seed。人工 5 步见 ACCEPTANCE.md，运行和故障恢复见 HANDOFF.md。

Alex 原 v17 / 500 / 1230.00 USD、PDF/payload 与 pending 审批保留；没有替用户批准。服务保留运行后停止工作。D1 **verification_blocked**，不自行 ready_for_user_review/accepted，不进入 D2。

补充准确回归命令（均退出 0）：

```sh
EVIDENCE_DIR=docs/build/evidence/d1/regression/c C_API_PORT=3601 C_WORKER_PORT=3602 ./scripts/zu test:c
EVIDENCE_DIR=docs/build/evidence/d1/regression/b ./scripts/zu test:b
EVIDENCE_DIR=docs/build/evidence/d1/regression/a2 ./scripts/zu test:a2
EVIDENCE_PATH=docs/build/evidence/d1/regression/a1.json ./scripts/zu test:integration
./scripts/zu test:a2:inbound
```

最终 required checks 的退出码均为 0；初次汇总 lint=1（审计脚本中未使用的三元表达式）及恢复后的结果分别保留在 verification-summary.json 的 initialChecks/checks 与 final-lint.txt/verified-lint.txt。没有把真实联网检查的退出 2 改写为成功。
