# 数据库与权限实施要求

适用范围：零正式工程；Mac + Docker；只完成本地首版；每次执行一个阶段并等待用户验收。AI 为可重复 preset，买家收发为 MockAdapter；公司发现与公开资料读取是真实网络行为。本文是实施要求和验收清单，不是可直接执行的伪代码。

## A1：42 表基线、Drizzle 与事务包装

- 参考文件：`zutrade-schema-v1.sql`，75,172 字节，SHA256 `b7f72b68adce6ad161eedf66b65389cd35461ec20446a9e97fa560550c21a1fe`。原件只读保存；校验不符时先定位差异，不悄悄更新期望值。
- 基线有外层 `BEGIN;`（第 64 行）与末尾 `COMMIT;`。先核实锁定版本 Drizzle runner 的实际事务行为。若 runner 已包事务，生成迁移副本时仅移除这两个已确认的顶层包装，保留函数、DO 块、触发器及所有 SQL 内容；禁止全局替换 BEGIN/COMMIT。保留可复现的转换和差异校验，不能把内层 COMMIT 交给外层 runner 后假定仍然原子。
- 迁移与迁移日志应由同一明确的事务边界管理。新数据库执行一次；重复执行迁移命令不得重建已有表。已有库通过后续增量迁移演进。
- Drizzle 映射以 SQL 的真实列名、精度、可空性、复合键为准；不能用 ORM 自动推送覆盖自定义约束、RLS 和触发器。认证与 pg-boss 的表由其锁定版本官方流程管理，另计数量。
- 验收：Docker PostgreSQL 18 全量建库；业务表恰为 42 张；对比重要约束/策略/触发器；中途失败不留下半套业务表或错误成功日志；再次运行迁移无破坏。既有 PGlite 结果不能代替这一步。

## A1：auth_subject 映射与未选 workspace 的 RLS 循环

现有策略依赖 `app.user_id` 或 `app.workspace_id`，不能直接假定登录后即可查询映射、列出成员资格。采用正常 runtime 角色加窄范围 SELECT 策略解决，不开全局 BYPASSRLS。

1. 服务端先通过 Better Auth 的真实会话验证取得可信 `auth_subject`；不能使用客户端自行声称的 subject/user/role。
2. 在身份解析事务内设置事务局部的已验证 subject 上下文。以增量迁移增加仅匹配该 subject 的 `app_users` 自身读取策略；必要时收紧映射写入策略。先得到规范 `app_user.id`，再设置事务局部 `app.user_id`。普通资料接口不能修改 auth_subject。
3. 首次登录可创建不带业务权限的用户映射；并发首次登录依据唯一 auth_subject 收敛到同一 user ID。禁止把“第一个登录的人”自动升为 owner。
4. 增加 `workspace_members` 的 SELECT-only 自身成员资格策略，使 workspace 尚未选择时也能读取本人活跃成员记录；需要显示工作区名称时，给 workspaces 增加通过本人活跃成员资格的 SELECT-only 策略。策略依赖应单向，不能形成相互递归。
5. 客户端提交 workspace ID 只是选择意图。服务端确认本人活跃成员资格后才建立业务事务的 workspace 上下文。无成员返回空列表；禁止先设置任意 workspace 再利用宽范围读取反推权限。
6. 新增身份发现策略不能是 FOR ALL，也不能扩大成员增删改权限。开发 owner/sales 由显式本地 seed 建立；审批仍只允许活跃且被指定的 owner。

验收：没有 workspace 上下文也能完成自己的身份解析和成员发现；无成员账号看不到业务；外来 workspace ID 被拒绝；过期会话不触发身份引导；并发首次登录不生成两份映射；连接池在提交、回滚及跨用户交替请求后不残留上下文。

## A1/A2/C：运行身份、pg-boss 与发送协议

- 迁移/初始化角色与 API、worker runtime 分离。后者不拥有业务表、不是 superuser、没有 BYPASSRLS；`app`、`auth`、队列 schema 各授必要权限。pg-boss 初始化/升级走受控迁移身份，不为方便启动给 worker 永久 DDL 或 owner 权限；配置方式核对安装版本官方接口。
- API、worker 均在真实业务事务内使用参数化的事务局部上下文设置。后台任务的 workspace/member 参数只用于定位；重新读取事件和目标对象、校验归属、当前成员权限与工厂访问范围。不能把 worker 当作万能 owner。成员发起任务重新核验该成员；已授权入站处理/FAQ 等系统任务按可信账号与当前策略限定范围，记录系统 actor，不能伪造 owner 身份，也不要求买家 webhook 拥有成员会话。
- 业务变化、outbox 事件身份与 pg-boss enqueue 必须使用同一个 PostgreSQL 事务连接；不能在 Drizzle 事务中另从池取得一个 pg-boss 连接。outbox 不再建设独立发布、lease 或 retry 调度器。
- 验收：注入 enqueue 前后异常，业务、事件、任务共同回滚；重复命令不重复创建外发；两个工作区任务并发执行互不串租户；重启 worker 不丢失已提交任务。
- C 阶段统一网关检查最终冻结内容、审批、事实、需求、联系资格和接管状态。webhook 收据与 claim 共用账号锁；未标准化入站屏障阻止旧自动发送。提交 claimed 是撤销截止，领取 pg-boss job 不是领取发送权。
- 并发撤销、双 worker、回执乱序、接收成功但响应丢失都要验收。unknown 不盲目重发；失去领取权的旧 worker 不得继续发送。A2 若先实现普通模拟回复，也必须经过同一网关入口，商业承诺先拒绝或留待 C。

C 阶段的 Mock 接收账本使用隔离的 simulation schema 与独立连接，接收提交不参与 app 业务投影事务，以复现远端已接受而本地未写回的情况。它由本地模拟设施管理，不计入 app 的 42/43 张业务表；普通 API 业务角色无修改权限。幂等/非幂等能力按场景准确实现，跨 worker 和重启保留记录。过期 claimed 没有服务方幂等保证时进入核对，不因队列 lease 到期自动生成第二次发送权。

## A2 会话工厂归属

A2 已需建立最小 intake opportunity 与 opportunity_threads，才能按工厂判断会话权限；B 再补详细采购需求。threads 没有独立 factory_id，未归属会话先由 owner 分配。读取完整会话历史需要对全部关联工厂可见，列表、摘要、SSE、备注和附件采用同一判断；新增商机关联或授权变化时重新验证订阅。不要仅凭一个可见商机放行混合线程。

## D1 最小增量 42 到 43 张业务表

只新增 `prospecting_runs`，并给 leads 增加可空 `prospecting_run_id`、`prospecting_candidate_key`。不改写基线，不把搜索任务伪装成 ai_runs，不把买家研究写成工厂确认事实。

### 任务表要求

- 正式列保存 workspace、factory、发起成员、provider/发现模式、状态、幂等键、请求摘要、结果版本、计数、任务关联、开始/结束时间及错误。用复合 FK 约束租户、工厂和成员归属；搜索前明确代表哪家工厂。
- 正式区分搜索 API 与公开目录发现。请求配置与结果快照使用有结构校验的 JSON；每批候选上限、单项摘录长度、总快照体积、抓取页数和超时都设硬上限。默认 20 条、硬上限 50 条，单项摘录及 512 KiB 总快照体积限制见 PROSPECTING_SPEC。
- 候选 key 在本次 run 内稳定；结果版本用于拒绝过期导入。终态快照保留，重新搜索生成新 run，不覆盖已导入线索当时的证据。
- results_snapshot 在终态冻结；review_decisions 独立保存每个 candidate 的保留/排除、理由、操作者和时间，配独立 review_revision/CAS 与追加审计。更新审核决定不能改变来源证据；导入必须检查当前审核版本及决定。
- first_started_at、固定 deadline、累计请求计数和检查点持久化到 run。跳转、重试及 HEAD/GET 均计预算；每次请求前原子占用预算，多个 worker 和重启共享同一上限。终态/到期后不继续写结果。
- 每项保留来源 URL、最终 URL、获取时间、标题、摘录/允许保存的证据、摘要哈希及读取状态。搜索摘要、官网已读取、人工确认要区分；不能从搜索词推断公司所在地或采购意愿。
- Brave 等 provider 按实际套餐/条款确认允许持久化的内容；没有存储许可时不能默认保留全部返回数据。目录 URL 模式仍须真实读取和校验。凭据/网络失败显示失败或部分完成，不用种子公司替代成功结果。
- 新表显式增加 RLS、运行角色授权、必要索引和审计；基线中的建表后循环不会自动保护未来新增表。

### 线索导入要求

- leads 两个新字段必须同时为空或同时非空；以 `(workspace_id, factory_id, prospecting_run_id)` 复合关联任务，并对 workspace/run/candidate key 建唯一约束。
- 导入服务只接受 run ID、candidate key、预期结果版本及必要人工选择，从数据库读取真实快照；不相信客户端重传的公司名和证据 JSON。
- 导入时同时核查最新审核决定及版本；被排除或证据版本不匹配的候选拒绝导入，返回冲突/状态原因。
- 现有 leads 的 buyer_id/factory_id 非空：原始候选先存在 run；确认身份后创建或关联 buyer，再建 lead。模糊名称/相似域名只能给合并建议，不能自动认定同一实体。
- 买家/联系人/线索创建与来源复制同事务。并发重复导入同一候选必须返回同一 lead，不能留下多余 buyer/contact。公开联系方式不自动写为允许联系；真实公司上的模拟沟通仍明显标注模拟。
- 验收：真实网络搜索或目录发现并显示可打开来源；零结果、部分失败、重试、越权 run、候选篡改和双击导入均有明确结果。没有真实成功证据就不能宣称 D1 真实发现验收通过。

阶段依赖：A1 先提供身份、数据库及队列事务；B 提供已确认供给；C 提供统一授权发送；D1 才启用真实发现与受控抓取，D2 使用其真实候选但只模拟外联；E 仍是 preset AI；V 对完整链路验收。每次完成一个阶段后停下交由用户验收。


## 官方核对资料

- PostgreSQL RLS：https://www.postgresql.org/docs/18/ddl-rowsecurity.html
- pg-boss ORM 事务适配：https://pgboss.io/api/adapters
- Better Auth 安装与 schema：https://www.better-auth.com/docs/installation

这些链接用于核对实际安装版本；既有基线已经做过数据库约束检查，但本工程的角色、身份发现增量策略和事务集成仍需按阶段 A1 验证。
