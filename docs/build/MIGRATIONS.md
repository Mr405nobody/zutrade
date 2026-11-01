# 迁移记录

## E 已实施增量（2026-10-29）

仅追加 `0019_mock_ai`：给原 ai_runs 增加命令、成员、场景ID/版本、业务时钟、实际耗时、自动FAQ意图及独立采用/修改/拒绝结果；工厂与完整会话 restrictive RLS；输入/终态冻结；preset token为null约束；精确持久任务/撤权入口和最小API/worker授权。复用原业务/outbox/pg-boss事务注册 e.ai 队列；FAQ继续走 a2.delivery 网关。未新增 app 表。

实际 app45 / simulation4，完整catalog映射662列、159FK（115复合）、200CHECK。日常初次与重复迁移均退出0，原0000—0018 hash与原始SQL保持。E运行数据只在独立测试库，未日常seed/reset/schema push或删卷；证据见 evidence/e/migrate-first.txt、migrate-repeat.txt、daily-preservation.json、catalog-mapping.json。D1/D2真实网络门槛延期不构成接受，见ADR0013。

## D2 已实施增量（2026-10-29）

用户最新指示先实施 D2、服务器 DNS 后测试，覆盖了首次前置检查的实施停点；D1 仍受阻。日常库已通过原迁移入口应用以下增量，未重写任何已应用 SQL：

| 迁移                            | 内容                                                                                                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0015_outreach_followup          | 复用原批次/版本/items/审批/followups；联系点来源与 lead 关联、独立 simulation 资格；批次草稿、账号/批次持久节奏；跟进业务版本、内部草稿、计划快照与当前执行人；工厂/完整会话 RLS、冻结及版本保护、精确任务元数据和撤权停止入口 |
| 0016_demo_thread_initialization | 真实 RLS 验证发现 INSERT 时尚无 thread 关联；只允许当前指定 owner 初始化绑定已确认研究线索的内部模拟会话，限未建立关联的初始化窗口；关联后仍检查全部工厂                                                                       |
| 0017_pacing_result_cutoff       | 通过 C 精确结果 token 在结果写回时延后账号和批次下次领取时间；处理 claim 后进程停顿；不授予发送权或绕过业务授权                                                                                                                |
| 0018_followup_execution_history | 跟进状态随真实网关 claim/dispatch/终态投影，追加完整执行历史；取消申请与迟到接受仍保留真实结果                                                                                                                                 |

app **45**、simulation **4**，无新增 app 表；完整 catalog 映射为 652 列、158 FK（114 复合）、196 CHECK。新建 d2.followup 队列，业务版本/outbox/startAfter 入队使用同一事务连接；没有第二套调度器。日常库重复 migrate 与原 SQL/hash 检查见 evidence/d2。未执行日常 seed/reset、schema push、清库或卷操作。以下保留历史迁移记录。

## 历史：首次 D2 前置检查（2026-10-29）

本次未满足 D1 前置门槛，D2 未实施，**无新增或执行迁移**。17:20（Asia/Shanghai）在日常库 READ ONLY 事务核对：业务记录为 0000—0014，共 15 条，全部 hash 与现有文件一致；app 45、simulation 4、auth 4、pgboss 13 表。原始 SQL 仍为 75,172 字节及下述 SHA256。没有运行 migrate、schema push、seed、reset 或卷操作。准确证据见 evidence/d2/gate-check.json。

阶段 0 只有首次空卷的基础健康角色初始化，无业务迁移。A1 开工前使用实际连接查询 `pg_class/pg_namespace`，未发现业务、认证或队列对象；没有假定空库后重置数据。

原始 `zutrade-build-kit/references/zutrade-schema-v1.sql` 保持 75,172 字节和 SHA256 `b7f72b68adce6ad161eedf66b65389cd35461ec20446a9e97fa560550c21a1fe`。

| 迁移                            | 内容                                                                                            | 管理方式                                             |
| ------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| business/0000_baseline          | 原始 42 表、约束、冻结、审计和 RLS；仅移除外层两行事务包装                                      | Drizzle 0.45.4，同事务记录 infra.business_migrations |
| business/0001_identity_boundary | 已验证 subject、自身成员发现、受控初始化策略、owner/sales 限制、工厂 restrictive RLS 与运行授权 | 增量 SQL                                             |
| business/0002_worker_rowlocks   | worker 的行锁最小列权限，条件触发器拒绝实际更新成员/工厂                                        | 增量 SQL；修复真实消费发现的权限不足                 |
| auth/0000_auth_schema           | auth schema 与迁移事务局部 search_path                                                          | 独立 infra.auth_migrations                           |
| auth/0001_better_auth           | 官方 CLI auth 1.7.14 生成，原样保留                                                             | 官方生成 SQL + Drizzle 事务执行                      |
| pgboss                          | 12.38.0 官方 schema、版本升级和 a1.identity-probe 队列初始化                                    | 官方 PgBoss.start/createQueue；受控迁移身份          |

所有表所有者为 zutrade_migrator，非 superuser、非 BYPASSRLS；API 与 worker 使用独立运行身份。管理员仅配置角色、schema、隔离测试库和读取系统标识，不替代业务连接。业务 FORCE RLS 保留，迁移身份有明确命名的初始化策略。

Drizzle runner 拥有唯一业务 SQL 事务边界；`scripts/baseline-copy.mjs --check` 复核原件及精确的两行差异。真实空库验证中，基线后的错误使所有 app 表和迁移成功行一起回滚；重复 migrate 保留表 OID。migration 命令也核验数据库里已执行记录的文件 hash。当前准确 hash 与队列版本见 `evidence/a1/repository-database-audit.json`。

认证 4 表、队列 13 表、infra 2 张日志表单独统计，不计入 42 表。未添加 D1 的 prospecting_runs。`scripts/db-map.mjs` 建立 574 列、139 FK（98 复合 FK）、162 CHECK 的完整 Drizzle 映射；真实集成测试核对列类型/可空性和复合外键顺序。索引、冻结触发器、RLS 和权限仍以 SQL 为准。

seed 仅受控创建演示 workspace、两个账号/成员、指定 approver 和两家虚构工厂；ON CONFLICT DO NOTHING，不覆盖已有名称、角色、状态、授权或业务记录。账号密码只在 `.local/a1-accounts.json`。重复 seed 与保留卷重启的真实证据见 `evidence/a1/persistence.json`。

没有删卷、schema push、启动 reset 或日常数据清空。新环境准确顺序见 HANDOFF.md。后续改变只能新增迁移。

## A2 增量

2026-10-28：`0003_inbox` 增加 threads.takeover_member_id 与 inbound_events 的 requested_factory_id、initiated_by_member_id、normalized_thread_id、normalized_message_id，共五列/五个复合 FK；42 张业务表保持。新增完整关联集合会话授权、受限系统任务/结果入口、账号屏障函数、关联变更锁与上下文失效触发器。

`0004_inbox_scope_hardening` 修复异 provider 非 UUID scope 的字符串比较，限定入站系统读范围，补 worker 冻结快照行锁权限，加入仅验证持久发送任务后可阻塞 ready/queued 请求的窄函数。所有新 SD 入口撤销 PUBLIC；begin/block 仅 worker 可执行。

0003 在本机应用后保持与 infra hash 一致；后续修复仅新增0004，未改已应用版本。原始基线字节保持；完整Drizzle映射现为579列、144个FK（103复合）、162个CHECK。精确已应用hash、角色、表数与原件校验见 evidence/a2/repository-database-audit.json。

## D1 增量（2026-10-29）

开工实际核对 app 44 表、simulation 4 表，业务至 0012；旧“42→43”仅为历史基线，未删除 B/C 表。D1 后 app **45** 表，simulation 仍 4 表。

| 迁移                        | 内容                                                                                                                                                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0013_prospecting            | 唯一新增 app.prospecting_runs；复合 workspace/factory/member FK、幂等身份、请求/执行/结果/独立审核版本、固定 deadline、累计预算、检查点、终态冻结、RLS/最小列权限、索引；leads 两个关联字段、成对约束、复合 FK、候选唯一与历史证据保护 |
| 0014_prospecting_revocation | 精确持久 event/job 入口仅允许 worker 将失去当前成员/工厂授权的任务停止；system 审计，不授予无范围读取或结果写入能力                                                                                                                    |

pg-boss 正式初始化新增 d1.research 队列，retryLimit=2、原任务重试、expireInSeconds=200、heartbeatSeconds=20；业务 run 自己固定 180 秒，队列期限不能延长业务预算。HTTP 并发使用 session advisory gate，不新增调度表或第二套发布器。

本机增量与重复 migrate 均按现有 Drizzle 事务/日志运行；独立 D1/A1/B/C 回归库亦从空库应用完整迁移。0000—0012 已应用 hash 保持，原始 SQL 未变；实际目录、FK/映射及权限审计见 evidence/d1。没有 schema push、启动 reset、清库或删除日常卷。

## V 本地验收（2026-10-30）

无新增迁移，无日常schema改动。校验原始SQL及0000—0019现有文件/数据库hash一致；未修改build-kit或任何已执行迁移。

- 隔离zutrade_v_test_库用原0000—0018初始化认证/成员/工厂/产品/来源，再运行正常db-migrate升级0019。原数据、表OID和重复迁移均保留。专用v-migrate-pre-e只接受V隔离库，临时迁移副本在ignored .local，不改源文件或日常迁移日志。
- 另一zutrade_v_empty_空库执行正常全部20条业务迁移、独立auth迁移和官方pg-boss初始化；API/worker实际启动/ready，未登录401。
- 备份在新zutrade_v_restore_库恢复，app45/auth4/simulation4/pgboss13边界不变；受限runtime可读原报价/PDF。备份与环境指针私有，不进Git。各次精确库名见evidence/v/integration.json、retained-test-databases.json、recovery.json及私有恢复指针。

D1/D2真实联网延期不更改schema验收依据或阶段接受状态。完整证据和真实失败恢复见STAGE_V_REPORT.md。

## 2026-11-01：0020 Outbound Intelligence

新增 `0020_outbound_intelligence.sql`：扩展研究provider CHECK；增加 `outbound_companies` 及复合FK、workspace/factory/domain唯一、FORCE RLS、来源身份冻结/审核版本和成员保护、列级授权。无schema push，原42表基线与0000—0019不改。当前46 app表/676列/162FK（117复合）/208CHECK；auth/pg-boss不变。

真实空库/重复迁移与ORM对照通过。日常备份后迁移，旧45表行数/内容摘要一致，新表0行；见 evidence/outbound/daily-upgrade.json。私有备份位置仅 `.local/outbound-upgrade-last.json`，无reset/seed/删卷。本次未恢复演练。
