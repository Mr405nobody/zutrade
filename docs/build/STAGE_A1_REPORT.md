# 阶段 A1：身份与数据边界报告

日期：2026-10-28（Asia/Shanghai）。状态：**ready_for_user_review**。阶段 0 的用户验收已记录为 accepted；A1 未获用户验收。本次不进入 A2。

## 已完成的实际功能

- 真实 Better Auth 本地邮箱密码登录、退出和数据库会话校验；无公开注册、邀请邮件或首位登录者提升 owner。登录后显示本人有效成员与可选择的工作区；无成员账号只得到空成员列表。
- 演示工作区、owner/sales、初始指定 approver、两家明确虚构的工厂。owner 可访问 A/B 并管理成员状态、角色和工厂授权；sales 仅 A。前后端均使用真实权限，工厂表还加了 restrictive RLS；改 URL、伪造 role/subject/workspace 均不能绕过。
- 42 表原始基线与完整 Drizzle 映射；139 个 FK（98 个复合 FK）、162 个 CHECK、冻结与追加审计触发器及 42 表 FORCE RLS 保留。没有 D1 的 prospecting_runs。
- 独立 auth 4 表、pgboss 13 表，infra 两张迁移记录表另计。Better Auth/CLI 均为 1.7.14；pg-boss 沿用 12.38.0，Drizzle 0.45.4。原始 SQL 仍为 75,172 字节及规定 SHA256。
- migrator、API、worker、auth 四个数据库身份分离。API/worker 非 owner、非 superuser、无 BYPASSRLS、无 app/pgboss CREATE；启动时拒绝提升后的业务角色。所有业务上下文使用参数化 SET LOCAL，并在真实事务内先验证身份、成员后选择工作区。
- “保存并验证队列”是实际工厂改名命令：同一 PoolClient 中更新业务、插入 outbox、真实 pg-boss 入队并追加审计。独立受限 worker 重新检查事件、当前成员和工厂范围，消费后追加幂等审计，前端显示对应任务“已消费”。没有消息、报价或外发行为。
- 显示名称可保存，真实持久化；重复迁移/seed 不覆盖已编辑资料、成员状态/授权或已有业务。保留卷重启后，账号、成员、会话和工厂仍在。

## 主要实现与迁移

`packages/db` 新增认证配置、身份/事务入口、工厂权限、同事务队列 helper 和完整映射；API 提供 me/profile、授权工厂、成员管理、指定审批人与个人验证任务接口；worker 实际消费 A1 队列；web 使用同源代理和 HttpOnly session cookie。

业务迁移 0000_baseline、0001_identity_boundary、0002_worker_rowlocks；认证 0000_auth_schema、0001_better_auth；pg-boss 官方 start/migrate/createQueue 由受控身份执行。SQL 的最外层 BEGIN/COMMIT 只在副本中精准移除，由 Drizzle runner 统一持有 SQL 与版本记录事务。详见 MIGRATIONS.md 与 ADR 0003。

Drizzle Kit pull 的 FK 统计/部分输出与真实目录不符，因此正式映射从 pg_catalog 按列序生成；集成测试独立验证全部 574 列的类型/可空性及所有复合外键顺序。未用 schema push 修改数据库以匹配 ORM。

## 启动、迁移与账号

工作目录 `/Users/warren/Desktop/ZuTrade`，本机已经完成初始化。日常只需：

```sh
colima start --profile zutrade
./scripts/zu infra:up
./scripts/zu dev
```

新环境或真正的新数据库：

```sh
./scripts/zu setup
./scripts/zu infra:up
./scripts/zu build
./scripts/zu db:provision
./scripts/zu db:migrate
./scripts/zu db:seed
./scripts/zu dev
```

现有环境仅缺 A1 配置时可单独执行 `./scripts/zu db:configure`。setup/configure 保留已有值。migrate/seed 可重复执行；provision 不做管理员业务 DML。

页面 [127.0.0.1:5173](http://127.0.0.1:5173)，API/worker 3001/3002，数据库 55432，原 Colima profile 和命名卷均保留。运行 `./scripts/zu db:accounts`，在本机打开 `.local/a1-accounts.json`（600）取得 owner/sales 邮箱与各自随机密码；本报告不存密码。若私有文件遗失，不通过重复 seed 自动重置已有密码。

## 实际执行的验证

| 验证                                       | 实际命令或操作                                                                      | 结果与退出码                                                                                                | 证据                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 工具链与既有工程                           | 复用阶段 0 的配置/忽略/持久卷证据，补 Node 实际版本、原始 SQL hash 与数据库对象查询 | Node 24.22.1、锁定 pnpm 11.25.0；开工前无 app/auth/queue 对象；保留既有文件                                 | 阶段 0 证据与最终 audit                                                             |
| 空库、重复迁移和失败原子性                 | `./scripts/zu test:integration`，独立真实 PG18 disposable DB                        | 通过，0；表 OID 不变，真实 Drizzle 迁移在基线后失败时 0 个 app 表、0 个成功版本行                           | [集成结果](evidence/a1/integration.json)、[终端](evidence/a1/integration-final.txt) |
| 完整 Drizzle 映射与原生结构                | 同上；独立读取 live catalogs 对比                                                   | 全部 574 列与 139 个有序 FK 一致；98 复合 FK，42 FORCE RLS，关键触发器存在                                  | 同上、[映射统计](evidence/a1/catalog-mapping.json)                                  |
| 身份、成员、工厂、跨工作区、池隔离         | 同上；真实 auth HTTP 与 API/worker 受限连接                                         | 本人发现、并发首次映射、无成员、停用、指定 approver、跨租户读写/关联、提交/回滚/交错事务均通过              | 集成结果                                                                            |
| 会话过期与客户端伪造                       | 同上；真正退出和数据库过期 session，伪造 headers/body/URL                           | 401/403/404/400 正确；失效会话不执行映射引导；公众注册关闭                                                  | 集成结果                                                                            |
| 同事务与 pg-boss                           | 同上；业务后、outbox 后、真实 enqueue 后、实际入队错误 4 点失败注入                 | 三者共同回滚；成功业务/outbox/job xmin 相同；并发相同命令只建一个 event/job；两工作区任务由真实 worker 消费 | 集成结果                                                                            |
| 成员管理及 worker 再授权                   | 同上；停用 sales、越权授权、篡改任务 hints、错误 job ID、停用发起成员               | 拒绝；恢复授权后任务可实际消费，重复处理不重复消费审计，worker 池无遗留上下文                               | 集成结果                                                                            |
| 保留 volume 与 seed 不覆盖                 | `./scripts/zu verify:persistence`                                                   | 通过，0；资料编辑后重复 migrate/seed 不变；真实停止/启动原容器后账号、成员、会话和资料保留                  | [持久化](evidence/a1/persistence.json)、[终端](evidence/a1/persistence.txt)         |
| 数据库身份、schema 分开计数、原件/凭据安全 | `./scripts/zu exec node scripts/a1-audit.mjs`                                       | 通过，0；无候选文件或日志匹配本地密码，忽略规则及文件权限正确                                               | [审计](evidence/a1/repository-database-audit.json)                                  |
| 真实队列失败恢复                           | `./scripts/zu db:queue-maintain --retry-failed-probes`                              | 通过，0；此前权限调试造成的 7 个失败探针原身份重试，保留失败历史日志                                        | [恢复](evidence/a1/queue-recovery.txt)、最终队列状态见 audit                        |
| 构建、strict 类型、lint/边界、单元         | `build`、`typecheck`、`lint`、`test:unit`                                           | 全部通过，0；私有对象单元 4/4                                                                               | build-final.txt、typecheck.txt、lint-final.txt、unit.txt                            |
| 浏览器登录、工厂权限、退出及故障恢复       | `./scripts/zu test:e2e`，本机 Chrome，1440×1000 / 390×844                           | 6/6 回归通过，0；另以本次新 event ID 验证 4/4 登录/消费/退出通过，0；无 pageerror 和横向溢出                | browser-verified.txt / browser-exact-job.txt，桌面/手机截图                         |

真实集成共 23 项检查，通过后自动移除本轮随机测试数据库；日常演示数据未被清空。PostgreSQL 系统标识重启前后均为 `7701697112392880170`，与阶段 0 一致。截图已实际查看：[owner](evidence/a1/desktop-owner.png)、[sales 手机](evidence/a1/mobile-sales.png)。截图不替代数据库/HTTP 负向结果。

## 真实失败与恢复

- 初次新增依赖时 pnpm 因新引入 esbuild 构建脚本被忽略而退出 1；把原有四个允许构建依赖明确写成 pnpm 11 allowBuilds 后安装成功。没有替换项目 Node/pnpm 或关闭严格 peer。早期 db/API 构建还暴露 ORM 客户端类型与导出类型问题，修复后严格构建通过；保留 build-initial.txt。
- 初次并发幂等测试出现 SHARE 升级 UPDATE 死锁（integration-first.txt）。调整为先命令锁、再工厂 FOR UPDATE；没有关闭事务或数据库锁。
- 第二次遇到真实 pg-boss 分区 job_common INSERT 权限不足（integration-second.txt）；补该队列表 INSERT，而未给 API DDL。
- 第三次真实 worker 消费因成员/工厂 SELECT FOR SHARE 需要 UPDATE 列权限而失败（integration-third.txt）。新增 0002 最小锁权限及拒绝实际 UPDATE 的触发器后恢复。第一次浏览器 4 项因此等不到消费而失败，见 browser-first.txt；修复后全部通过。
- 一轮测试本体已通过，但清理 disposable DB 时空闲连接错误未被监听，进程退出 1（integration-fourth.txt）；补安全错误监听并改为关闭池后普通 DROP。最终验证正常退出，日志没有连接密码。
- 最初 lint 的无用导入/空 catch 与文档格式错误已修复，保留 lint-first/second.txt。没有删除真实失败记录或把失败标成通过。

## 人工验收

完整 5 步及可直接点击的工厂 B 越权链接见 [ACCEPTANCE.md](ACCEPTANCE.md)：owner 登录看 A/B 与成员；改名并观察本次任务消费；sales 登录只看 A 且直接访问 B 被后端拒绝；owner 暂停/恢复 sales；退出后 API 401、重启仍能登录。每步都有明确预期。

## 未实现、未验证与环境限制

- A1 当前无已知关键建设缺口或环境阻塞；状态为 ready_for_user_review，等待用户验收。未在第二台 Mac、x64、Docker Desktop 或真实手机硬件重复验证；浏览器手机视口已覆盖。
- pg-boss 自动 supervisor/调度及 DDL 维护在普通运行身份关闭。受控维护命令可用；本次验证 queued 任务在 worker 缺席后消费，未做 active lease 中强杀进程、所有过期/长期留存时序。这是已实现基础的验证边界，不宣称完整发送协议容错已完成。
- 新增账号通过受控本地 seed，UI 管理已有成员；未建设外发邀请或公众注册，符合本阶段本地初始化要求。没有一般用途的在线账号创建/密码找回或生产部署安全验收。
- 后续范围均未建设：A2 消息/网关、B 供给报价、C 商业审批发送、D1 真正企业发现、D2 跟进、E AI。现有 42 表包含未来结构，并不表示这些功能已实现。无真实发送、模型或业务发现。
- Git 作者身份仍未配置；未猜测身份、修改全局 Git、提交或推送。工作区原文件与用户修改保留。早期失败隔离测试库仅用于排查，不混入演示数据；不按模糊名称删除用户数据库。

## 续接与停止

同一工程、分支、配置和持久卷继续；详细命令与最小授权策略见 HANDOFF 和 ADR 0003。阶段 0 为 accepted；本阶段自测只可记 ready_for_user_review。等待用户验收，不自动执行 A2。
