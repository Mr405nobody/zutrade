# 阶段 A1 身份与数据边界

只在阶段 0 已验收且用户明确启动 A1 时执行。读取总控、数据库实施说明、当前迁移状态与前阶段报告。目标是建立真实身份、42 表业务数据库、成员与工厂权限，以及后续阶段可直接调用的事务和队列基础。

## 建设任务

1. 按 DATABASE_NOTES 安装业务基线，保存原始 checksum 和版本记录；建立 Drizzle 映射，保留所有原生约束。处理基线 BEGIN/COMMIT 与迁移 runner 的唯一事务所有权。
2. 用锁定版本的官方流程生成 Better Auth 认证迁移，认证 schema 与 app schema 分离。采用本地账号密码登录，不依赖邮件服务；禁用公开注册，建立受控本地初始化与 owner 成员管理入口。
3. 解决 auth_subject 到 app_user 的可信映射、登录后可选 workspace 的发现，以及初始 workspace/owner/approver 的创建循环。明确哪些操作由一次性初始化工具负责，普通 API 不能借用迁移连接。
4. 建立 migration、API、worker 角色及最小 grants。业务运行角色不拥有表、不是 superuser、没有 BYPASSRLS；业务查询通过统一事务上下文入口，不允许把客户端 workspace_id 直接当成可信身份。
5. 通过官方流程安装 pg-boss schema、必要队列与运行 grants。API/worker 运行期间不自动持有结构修改权限。实现业务写入、outbox 和队列入队的同事务 helper，并用真实队列任务验证。
6. 实现 owner/sales 两类业务角色、有效成员检查、工厂授权、指定 approver 校验。admin/viewer 不出现在可选角色中。
7. 建立演示 seed：一个演示工作区、owner 与 sales、两家虚构工厂和差异授权。测试另建第二 workspace，以验证跨租户。seed 重复执行不抹掉已产生的业务数据。
8. 前端接真实登录、登出、当前成员和工作区；四入口展示真实会话身份与授权。账号初始化方式写入本地说明，不把随机密码提交到仓库。

## 必须验证

- 空库安装成功，重复迁移不重复执行基线；重启并保留 volume 后登录和成员数据仍在。
- Better Auth 会话失效后受保护 API 拒绝访问；客户端伪造角色或工作区不能获得权限。
- owner 与 sales 的工厂范围确实由 API 限制；受限成员不能直接调用未授权工厂接口。
- 用实际运行角色测 RLS：缺失 workspace 上下文、跨 workspace 读/写/关联、连接池复用与并发事务均按边界工作。
- auth lookup 仅能解析当前已验证会话；不能通过替换 auth_subject 获取另一个账号的成员列表。
- 在业务写入后、outbox 后、入队后注入异常，三者都回滚；成功提交后的任务才被 worker 消费。不要用 mock boss 验证此要求。
- 检查实际 42 张业务表与冻结/RLS/复合外键约束存在；认证和队列表另计。

## 人工验收路径

分别使用 owner 和 sales 登录，查看当前身份、工厂范围，尝试访问未授权工厂。登出后直接打开受保护接口应被拒绝。保留 volume 重启，原账号仍可登录。查看真实队列探针任务从入队到 worker 完成的记录。

## 交付与停点

给出初始化、迁移、seed、启动及测试命令，说明业务与认证 schema、角色和 pg-boss grants 的实际安排。保存负向测试证据。当前阶段不需要有业务消息和报价；准备好后停在 ready_for_user_review，不进入 A2。
