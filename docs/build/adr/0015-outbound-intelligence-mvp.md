# ADR0015：Outbound 复用研究任务与手动官网入口

2026-11-01。用户明确授权主动获客与公开资料背调的一次 MVP 增量，覆盖此前“当前阶段不启用业务发现”的阶段限制，不授权真实模型、真实触达、部署或生产配置变化。D1/D2/V 受阻门槛没有因此通过。

复用 D1 prospecting_runs、冻结 JSON 证据、pg-boss、180 秒/80 次预算、SSRF 与工厂 RLS。新增 outbound_manual / outbound_unavailable 两种 provider；本模块不调用已有商业 Brave 适配。当前无 SearXNG，且真实官网 DNS 仍返回保留地址；不新增无法解决公网读取的容器，先交付显式手动模式与真实失败状态。P1/P2 不阻塞本地 P0 验证。

新增单表 outbound_companies，唯一键为 workspace/factory/规范化域名；注册时必须引用已经终结的冻结候选。原始证据和规则事实不接受人工覆盖，人工修正独立存储；审核使用成员身份、DB 时间、CAS 版本，并在现有 append-only audit_events 同事务保留历史。没有另建 CRM 或营销联系资格。

规则报告从冻结资料生成，固定 outbound-rules-v1 标识；官网自述、推断、未知分开。只读公开静态页；每个官网最多首页加三条同 origin 链接，robots、频率、期限与响应体有界，新读取器不跨 origin 跳转。未知国家不取目标值，网页失败不作欺诈线索。

0020 仅增加 provider CHECK、公司表/约束/RLS/权限/触发器；原 SQL 与0000—0019不改。新公司表使业务表变46，历史测试按迁移清单核对数量，保留行为断言。不开启真实模型或渠道、不改 DNS/代理/SSRF。整个阶段因真实成功闭环未通过保持 verification_blocked，待网络补验后才可 ready_for_user_review。
