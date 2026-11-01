# ADR 0010：独立、持久的 simulation 渠道

日期：2026-10-29（Asia/Shanghai）。阶段 C，采用。

`zutrade_simulation` 是单独的非 superuser、非 BYPASSRLS、非 owner 运行角色，独立凭据只在本机被忽略的配置中。adapter 使用独立连接池，不复用 app 事务。普通 API/worker 数据库角色没有 simulation schema 访问权限；业务不使用 migration 连接执行。

simulation schema 有四个基础设施表，不计入 app 业务表数：

1. `invocations` 在调用开始时独立 commit，记录 account、request、稳定 key、payload 摘要、token、能力/场景和时间。延迟期间或接受事务中进程退出，也不会把已发生的调用漏记为零。
2. `acceptances` 表示模拟渠道实际接受副作用，保存确切规范化内容、实际核验附件摘要/大小及首次调用 token，独立 commit。
3. `calls` 保存已形成结论的调用结果，关联 invocation；区分 accepted/reused/rejected/conflict。一次 invocation 可能因进程中断而尚无结果。
4. `callbacks` 追加 accepted/delayed/rejected 等观察，用于重复和乱序回调验证。它不把模拟升级为真实送达。

这些记录不可改删。旧 C 数据升级时仅把已存在的完成调用事实补入 invocation 表，保存原身份和时间，不更改既有接受事实。日常启动不 seed/reset，记录跨进程重启保留。

能力按账号的受控测试场景声明：normal、明确 reject、delay、callbacks、lost_response，分别支持或不支持 provider idempotency。Mock 不读取 app 的审批、claim、取消或成员权限替网关兜底。幂等模式同 account/key 串行，同内容复用已存在接受，同键异内容或已过保证期明确冲突；非幂等模式每次真实调用都会产生新的接受，不按 business key 偷偷去重。调用数从 invocations 统计，副作用数从 acceptances 统计。

lookup 只能证明查到的接受事实；空结果为 inconclusive，不能证明未发送。核对和 callback 投影使用同一 request 与 payload，不制造第二条买家消息。模拟账本不是买家、业务审批或 pg-boss 的第二主库。

C 的实际测试在专用进程的 afterClaim 与 afterAccepted IPC 同步点执行 SIGKILL，恢复进程重新 fetch 原 pg-boss job，检查调用数/接受数与同一 provider key。另有两个专用 worker 争同一请求、旧 worker 失去 token 后恢复及最后检查后撤销的实际验证。普通抛异常只用于事务回滚，未被称为进程强杀证据。
