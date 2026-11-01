# ADR 0003：身份发现、SQL 事务与受限队列运行

日期：2026-10-28（Asia/Shanghai）。状态：A1 采用，等待用户阶段验收。

## 迁移的唯一事务边界

保留原始 SQL 字节及 SHA256 `b7f72b68adce6ad161eedf66b65389cd35461ec20446a9e97fa560550c21a1fe`。实际读取 Drizzle 0.45.4 `pg-core/dialect.js` 与 `node-postgres/session.js`：runner 将全部待执行 SQL 和迁移成功行放进同一事务；迁移日志表自身的创建在此前执行。基线副本只移除已核实的第 64 行 `BEGIN;` 和最后的 `COMMIT;`，转换脚本按行位置、内容和原始 hash 验证；不全局替换 PL/pgSQL 内的 BEGIN。`db:migrate` 每次验证副本与原件的精确差异及已执行迁移 hash，并用会话 advisory lock 串行迁移。失败不会记录成功版本。

业务迁移依次为 0000_baseline、0001_identity_boundary、0002_worker_rowlocks。认证另有 auth 迁移日志；pg-boss 由其官方版本表管理。没有 schema push、reset、自动删卷或 D1 增表。

Drizzle Kit 0.31.11 pull 的原始报告把 FK 统计成 723，实际 PostgreSQL `pg_constraint` 为 139，生成的部分索引操作符顺序也不可信。因此不采用该输出作为正式映射。`scripts/db-map.mjs` 以 pg_catalog 的列、类型、可空性及 `WITH ORDINALITY` 顺序读取真实约束，生成 42 表、574 列、139 个 FK（98 个复合 FK）与 162 个 CHECK 的 Drizzle 映射。bigint 用 bigint 模式、numeric 保留精度并返回字符串。集成测试独立逐列、逐外键对比真实数据库。触发器、索引、RLS、授权和 SQL 迁移仍为权威；不从 ORM 反推 DDL。

## 认证与发现顺序

Better Auth 与官方 CLI `auth` 均锁定 1.7.14。采用内置 PostgreSQL/Kysely 适配器和官方 `auth generate` 输出 SQL；迁移连接在 auth 的 search_path 下执行未经改写的生成文件。schema 创建包装是单独的认证迁移。运行认证连接仅可读写 auth，业务角色没有 auth 表权限。

本地邮箱密码登录，HTTP handler 只开放 sign-in/email、sign-out、get-session、ok。配置同时 `disableSignUp=true`，不开放公共注册、邀请或邮件发送。受控本地 seed 临时构造允许服务端 signUpEmail 的实例，绝不挂载它的 HTTP handler；密码走 Better Auth 自身哈希流程。会话每次查数据库，关闭 cookie session cache；HttpOnly、SameSite=Lax cookie 通过 Vite 同源代理传递。仅 loopback HTTP 的本地用途。

受保护请求先 `auth.api.getSession`，只有其 user.id 可成为 auth_subject。事务先设置已验证 subject，窄 SELECT 策略解析自己的 app_user；唯一 auth_subject + INSERT ON CONFLICT 使并发首次映射收敛。不带业务权限的首次映射不会产生 workspace、member 或 owner。

随后设置 app.user_id，自身 SELECT-only 成员策略发现本人有效成员；workspaces 的发现策略只依赖成员，成员策略不反向依赖工作区，避免递归。客户端 workspace ID 只是选择意图，先匹配本人有效成员及有效工作区，才设置 app.workspace_id，再锁定并重检成员。API body 使用 strict 契约；不读取客户端声明的 subject 或 role。普通资料更新不能改 auth_subject。

## 数据库身份与工厂边界

管理员仅用于检查数据库、创建独立测试数据库及配置命名角色；不作为 API/worker 的业务连接。

- zutrade_migrator：NOSUPERUSER、NOBYPASSRLS，拥有 app/auth/pgboss 及迁移对象，可显式执行初始化；app 的 controlled_initialization 策略仅授此身份。
- zutrade_api：业务 SELECT、受限列更新、成员 ACL 管理及事件/审计写入；pg-boss SELECT 和 job/job_common INSERT。
- zutrade_worker：业务 SELECT、追加消费审计；pg-boss SELECT 和 job/job_common DML。
- zutrade_auth：仅 auth schema 的认证 DML。

API/worker 不拥有 app 表、不具有 app/pgboss CREATE、superuser、BYPASSRLS、CREATEDB 或 CREATEROLE；启动时再次查询并拒绝提升后的业务身份。配置也要求各自命名角色和 127.0.0.1:55432。现有阶段 0 的健康角色和 DATABASE_URL 保留。

工厂查询和修改都核查有效成员及 all_factories/factory_memberships，工厂表另加 restrictive RLS。成员权限变更持有目标成员更新锁，业务操作持有该成员共享锁，防止同一操作与停用/授权撤销交错放行。仅 owner 可管理成员和指定审批人；不能在此入口修改本人权限、停用/降级当前审批人，审批人必须是有效 app_user 对应的有效 owner。

PostgreSQL 的 SELECT FOR SHARE 要求至少一个 UPDATE 列权限。0002 仅给 worker 成员/工厂的 id 列锁权限，并用 current_user 条件触发器禁止 worker 实际 UPDATE；这不赋予修改成员或工厂的功能。成员角色限制为 owner/sales。后续表的工厂披露规则仍须按所属阶段服务实现，不能仅依赖租户 RLS。

## 单事务事件与真实队列

pg-boss 12.38.0 官方 start/migration 与 createQueue 只由迁移命令执行。运行实例设置 migrate=false、createSchema=false；不在启动时升级、建队列或获得结构权限。当前唯一队列 `a1.identity-probe`。

工厂改名命令在一个 PoolClient 事务内完成业务更新、outbox INSERT、`boss.send(...,{db:{executeSql:client.query}})`、事件任务链接和追加审计。没有第二套 outbox 发布器。真实 PostgreSQL 的 xmin 对比及四个失败注入点证明三者共享事务。命令 UUID 幂等锁和唯一事件键防止重复创建任务。

并发验证曾发现 SHARE 升级 UPDATE 死锁，现改为先取命令 advisory lock，再直接以 FOR UPDATE 取得目标工厂。真正的 pg-boss job_common 分区需要独立 INSERT grant；已补最小授权，未给 API 队列表结构权限。

worker 从任务提示定位后，重新验证当前成员、账号、工作区、持久事件、任务 ID、actor 和工厂权限；不把任务参数当成 owner 授权。消费结果追加审计，事件 ID advisory lock 使重试保持幂等。双工作区任务由受限 worker 并发处理，事务上下文均局部设置并在提交/回滚后清空。

运行实例关闭自动 supervisor、调度和 DDL 维护。`db:queue-maintain` 使用受控迁移身份运行 pg-boss 自身 supervise；显式 `--retry-failed-probes` 只重试 A1 队列的失败任务。未来启用定时任务或扩大队列前，需在相应阶段评估维护节奏与 grants，不给 worker 永久 DDL。

官方依据：[Better Auth PostgreSQL](https://better-auth.com/docs/adapters/postgresql)、[官方 CLI](https://better-auth.com/docs/concepts/cli)、[Express handler 与 body parser 顺序](https://better-auth.com/docs/integrations/express)、[pg-boss 事务适配](https://pgboss.io/api/adapters)、[PostgreSQL RLS](https://www.postgresql.org/docs/18/ddl-rowsecurity.html)。安装版本源码与实际 PostgreSQL 结果为本次实现核对依据。
