# ADR 0004：消息授权、入站屏障与受控发送

日期：2026-10-28（Asia/Shanghai）。阶段 A2，采用。

A1 已由用户明确验收。沿用同一 PostgreSQL 18.6 实例、42 张业务表和非特权 API/worker 角色。基线 SQL 保持原样；新增 0003/0004 增量迁移，不增加 D1 表。

完整会话授权由数据库 `app.can_read_thread(workspace_id,thread_id)` 统一实现。该窄范围 SECURITY DEFINER 函数以完整 opportunity_threads/opportunities 集合判断，避免工厂 RLS 过滤后误认为全部可见。无关联或存在未分配 factory 的会话仅 owner 可见；其余会话要求全部关联工厂授权。列表、消息、备注、已读、草稿、发送命令和 SSE 重查共用这一判断。负责人和接管人不授予访问权。

接收原始收据与出站 claim 都先锁 channel_accounts 行，再锁目标 thread。收据 processed_at 为空即屏障；重试或 dead 不能清除。系统入站任务使用验证持久事件与队列身份的限定入口，不借用 owner user_id；审计 actor_kind=system。线程写入持有线程行锁后才 INSERT 消息，消息分页和 read 推进也取同一行锁，使 ingest_seq 分配与事务提交在同线程内有序；时间较早但迟到的消息仍产生新的游标。

row_version 用于负责人、接管、工厂分配的 CAS；context_revision 仅由入站、接管/释放及归属变更推进。备注和已读不更新线程上下文。human 模式允许有权成员在最新上下文创建新的受控人工回复；assisted 仅表达模式，未启用 AI。

普通发送只接受服务端固定版本 quantity/use/destination 模板，无自由文本参数。intent=human_reply，authorization_mode=member_send，均由服务端决定。自由文本使用既有 outbound_requests draft + 未冻结 payload 保存为内部草稿，没有队列或买家消息；普通模板路径不能发送草稿。业务请求、冻结 payload、outbox 和 pg-boss 入队使用同一个事务连接。

worker 重读权限、资格、渠道状态、上下文、屏障和冻结快照，原子提交 claim 后在事务外执行唯一 simulation MockAdapter。结果使用 simulated。claimed/dispatching 重复任务采取保守 unknown/阻塞处理，不承诺未验证的强杀恢复。C 再实现独立模拟接收账本与完整 unknown 核对。

SSE 只发变化提示，不发正文、摘要或全局计数；每次采样重新验证 Better Auth 会话、成员、ACL 及完整会话关联。客户端断线后重新查询数据库，使用 ingest_seq 补查。变更提示无进程内历史依赖。

官方核对：[PostgreSQL 行锁](https://www.postgresql.org/docs/18/explicit-locking.html)、[pg-boss 事务适配](https://pgboss.io/api/adapters)、[SSE 重连与事件格式](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)。安装版本源码与真实数据库验证为最终依据。
