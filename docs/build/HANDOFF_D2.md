# ZuTrade D2 交接

## 当前停点（2026-10-29，Asia/Shanghai）

用户在首次前置检查停止后明确要求先做 D2，DNS 等部署服务器后测试。按最新授权已实施 D2，D1 仍 verification_blocked；没有把开始 D2 写成接受受阻 D1。D2 本地隔离验证完成，真实来源到批次链尚未验证，故 D2 也保持 **verification_blocked**，不进入 E。完整行为、失败恢复、证据、命令及限制见 [STAGE_D2_REPORT.md](STAGE_D2_REPORT.md)，范围变更见 ADR 0012。

- 日常服务仍 5173 / API 3001 / worker 3002，使用原库。未向日常库写 fixture、批次、跟进或新线索，未批准 Alex。
- D2 独立样例：http://127.0.0.1:5473/ ，3701/3702。来源标“离线测试数据 · 虚构公司”，不是 D1 真实验收。账号运行 `./scripts/zu db:accounts` 后只在本机打开 `.local/d2-test-last.json` 的 users.owner / users.sales。该文件含私有环境，不复制到聊天或报告。
- D2 样例停止后 `./scripts/zu ui:d2` 只重开最近保留隔离库，不 seed/reset。重新执行 test:d2 会生成新精确命名库并更新私有指针；先关闭旧 ui:d2 再重新打开，避免账号与库不一致。
- 日常库增量至 0018，app 仍 45 表，simulation 4。旧 0000—0014 与原 SQL 保留；0015—0018 说明见 MIGRATIONS.md。样例代码仍仅注册 simulation 和 mock/preset。

普通回复、报价、批次和自动跟进均经 C 网关。批次先保存草稿，再提交新不可变版本和完整审批；改账号、名单、正文、附件、计划均重新提交，不继承旧批准。跟进默认只提醒；自动模拟跟进需到单项审批区明确批准最终内容。手动接管阻挡自动动作和接管前旧计划；暂停新外发另有独立开关。改期推进 business_version，旧 job 不执行新版本。

验收的 5 步见 ACCEPTANCE.md。完成后保留服务。服务器网络补验必须另行明确执行：保留 SSRF，实际研究两个目录/条件、抽查至少三家公司、真实候选确认导入/重复导入，再从真实线索进入批次预览；当前没有上传、购买或部署授权，没有把离线样例当作真实公司来源。

以下为历史 D1 交接及首次 D2 前置检查，保留原状态和失败证据。

## D2 前置检查续记（2026-10-29 17:20，Asia/Shanghai）

用户有条件授权 D2，但实查 D1 仍为 **verification_blocked**，故 **D2 保持 not_started，未实施**。日常库只有 SG/GB/AU 原三次 live_network 研究，均 failed / SSRF_DNS_REJECTED / 0 候选，真实研究导入 lead 为 0。当前 DNS A 仍为 198.18.0.10/11，AAAA 为 ENODATA；现有安全校验实际拒绝。缺少两次真实研究的可用结果、至少三个真实候选来源抽查、真实确认导入及重复导入。没有重复创建研究、调整网络、关闭 SSRF 或使用离线名单替代。

本次只读核对迁移至 0014、app 45 / simulation 4 / auth 4 / pgboss 13；全部 15 条已应用业务迁移 hash 与文件一致。Alex 仍 v17 / 500 件 / 1230.00 USD，审批 pending、请求 awaiting_approval、原 payload 与原 PDF 字节摘要保留。日常及 C/D1 三套服务探针均 HTTP 200，API ready；继续保留运行。Git 仍 stage-0-bootstrap、0 commits、工程文件未跟踪，未提交或覆盖现有文件。

本次命令、证据与停止依据见 [STAGE_D2_REPORT.md](STAGE_D2_REPORT.md) 和 [evidence/d2/gate-check.json](evidence/d2/gate-check.json)。后续需先补齐下文 D1 真实门槛；不能以本次启动请求把受阻 D1 记 accepted。下文为 D1 原交接。

2026-10-29（Asia/Shanghai）。仅实施 D1；当前 **verification_blocked**。C 因用户本次明确启动 D1 而 accepted；未编造人工操作，未给予商业批准。历史 C 交接保留在 HANDOFF_C.md。

## 服务与账号

- 日常工作台：http://127.0.0.1:5173/ ，API/worker 3001/3002。保留运行。
- 原 C 独立样例：http://127.0.0.1:5273/ ，3401/3402，原样保留；未运行 demo:c --refresh。
- D1 独立离线验证样例：http://127.0.0.1:5373/ ，3501/3502；显示“离线测试数据”。正向样例不是真实企业发现；从此入口新建研究仍走真实网络。
- 运行 `./scripts/zu db:accounts` 取得私有文件路径。日常 Alex/D1 用 `.local/b-accounts.json`；C 用 `.local/c-ui-accounts.json`；D1 隔离样例用 `.local/d1-test-last.json` 的 users.owner/users.sales。只在本机打开，不复制密码或整个环境到聊天/报告。

日常停止后：

```sh
colima start --profile zutrade
./scripts/zu infra:up
./scripts/zu dev
```

独立样例停止后分别执行 `./scripts/zu ui:c`、`./scripts/zu ui:d1`。不 seed、不 reset、不删卷。D1 ui 命令只重新打开最近的保留隔离库；重新运行 test:d1 后，再关闭旧的 ui:d1 并重开，避免账号/数据库不匹配。

## 数据与状态

已应用 0013_prospecting、0014_prospecting_revocation，app 45 表；simulation 4、auth 4、pgboss 13 独立。已有 0000—0012 hash 保持。Drizzle catalog 映射已更新；禁止 schema push。原始 SQL 校验仍为 b7f72b68adce6ad161eedf66b65389cd35461ec20446a9e97fa560550c21a1fe。

Alex 保持 v17 / 500 件 / 1230.00 USD、原 PDF、原 payload 和 pending 审批。日常库只新增真实研究任务及审计/队列状态，无 fixture buyer/contact/lead，不改工厂事实，不发送真实消息，不调用真实模型。

研究必须选工厂，产品可选。目录为 Wikipedia 活动公司分类（SG/GB/AU），通过官方静态 API 发现企业页面与 Wikidata 实体/官网；覆盖有限，不能当完整礼品分销商数据库。关键词在目录模式中用于规则匹配。Brave 接口已实现但本地未启用，需 key、BRAVE_SEARCH_STORAGE_RIGHTS=confirmed 与 BRAVE_SEARCH_RIGHTS_REFERENCE 三者；不要求购买即可使用目录实现。凭据只放 ignored .env，不经前端返回。

终态快照冻结；审核使用独立 review_revision CAS，导入同时核对结果/审核版本和 keep 决定。并发同候选只产生同一 lead；显式选择已有 buyer 才关联，域名/名字相似只提示。公开邮箱保留为未核实来源，D1 不自动建个人或赋予营销资格。

## 联网阻塞及复验

本机 DNS A 将 en.wikipedia.org、www.wikidata.org 解析为 198.18.0.10/11（保留测试网段），AAAA 无数据；直接 HTTPS 超时。安全 transport 正确拒绝，用户明确选择保持现状。没有代理/私网绕过开关。真实 SG/GB/AU 三任务均 failed / SSRF_DNS_REJECTED / 0 候选 / 1 次预算。

需要条件：本机研究域名返回真实公网 A/AAAA，且 HTTPS 在正确 TLS 校验下可达。网络调整属于用户未要求本次执行的外部条件；不要关闭 SSRF 或给假 IP 开白名单。浏览工具读到的目录/官方资料不能代替 worker 证据。

网络可用后：先用 `./scripts/zu prospecting:live` 运行最多三个、各 3 候选的真实任务（网络门槛未满足时退出 2）。再在 UI 抽查至少三个不同候选的实际目录/官网来源和获取时间，保留原因、确认身份、导入，重复导入应回到同一 lead。来源不足如实记录并补一次有界验证。Brave 未配置路径不记实测成功。

## 验证命令

```sh
./scripts/zu test:d1
./scripts/zu test:d1:browser
./scripts/zu test:unit
./scripts/zu typecheck
./scripts/zu lint
./scripts/zu doctor --services
./scripts/zu exec node scripts/d1-audit.mjs
```

test:d1 只建精确命名隔离库、真实 pg-boss 任务和专用子进程；实际 SIGKILL 后以官方 fail/fetch 重试原任务，原 deadline、累计请求和检查点不重置。旧 worker 被 fencing 后不能覆盖终态。两种 DB 网络 gate 验证覆盖不同连接池。库全部保留，清单在 evidence/d1/retained-test-databases.json。

队列仍沿用官方显式维护 `./scripts/zu db:queue-maintain`；崩溃 active job 的自动重试需要维护推动过期队列。研究原截止不会等待队列而延长；列表读取会将到期研究冻结为 partial/failed。没有第二套 outbox 发布器。

实际证据、真实失败与恢复、限制及人工 5 步见 STAGE_D1_REPORT.md / ACCEPTANCE.md。完成独立实现后停在 D1，网络门槛补齐前不得标为 ready_for_user_review，不进入 D2。
