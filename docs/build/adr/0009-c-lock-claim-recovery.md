# ADR 0009：工作区串行化、撤销截止与恢复

日期：2026-10-29（Asia/Shanghai）。阶段 C，采用。

## 锁与时钟

小团队采用较粗的事务 advisory lock：`c-workspace:<workspace UUID>`。成员建立工作区上下文之前先取此锁，再重新读取成员资格；所有现有 API 的成员/工厂撤权、指定 owner 变化、需求变更、资料发布/撤回、会话接管及创建/审批命令均经过这个 helper。系统入站标准化、精确队列任务元数据入口和 provider 结果入口也先加入同一协议。

顺序为工作区锁 → 成员当前资格 → 渠道账号 → thread / request / approval / 商机 / 产品等已有行锁。由于同工作区事务已串行，内部既有 B 产品锁与 A2 行锁不会形成同工作区循环。不同工作区仍可并发。网络调用及较重文件读取不占 claim 事务。受控测试的直接 fixture/撤权事务显式遵守工作区锁；任意数据库管理员直接写 SQL 不作为产品命令支持。

原始入站接收继续取得账号行锁，commit 后未处理收据构成全账号屏障；标准化重试或 dead 均不清除。只有受限 system worker 以原 event/job 身份成功执行实际标准化，才设置 processed_at。没有删除收据、假成功或屏障豁免按钮。

业务到期检查采用取得锁后的 `clock_timestamp()`，避免 Mac 与 Colima PostgreSQL 的时钟差和长时间等待时 transaction `now()` 过旧。B 的同一 `quoteAvailability` 被复用，并默认读取数据库时钟；测试可显式传入固定业务时钟。原 B 摘要和冻结内容不变。

## 三个事实与执行 token

pg-boss fetch 只是领取任务。短业务事务核对目标 payload、发起成员/工厂权限、当前指定 owner、账号 simulation 身份、收件人及服务联系资格/抑制、会话和需求、B 当前报价/依据、完整摘要/附件/审批、入站屏障和既有执行状态后，才原子设置 claimed、dispatch_claimed_at、dispatch_payload_version_id、dispatch_token 并建立 prepared attempt。claimed 的 commit 是撤销截止点。

本次目标版本不能随着 current pointer 改变。网络调用在 commit 之后。调用前再检查 token、取消申请及当前业务权限/依据，设置 dispatching/started；写回时再次比较 token。检查之后与外部调用之间仍有窗口，token 不能撤回已经在途的远端调用。

领取前撤销使请求 cancelled；领取后仅写 cancel_requested 与 revocation_too_late，不宣称本次成功撤回。接管也对已有在途动作记录取消申请；在最后检查之前尽可能停止，越过最后检查后仍可能被渠道接受。新人工报价在 human 模式允许，自动 FAQ/跟进/旧计划没有因 created_by 非空而获得人工身份。

## 事务、重试和 unknown

批准结果、审批事件、请求 queued、outbox 和 pg-boss send 共用原业务事务连接。测试在审批、业务、outbox、enqueue 四点注入失败，全部共同回滚。没有新增 outbox 发布器、重试队列或租约调度器。

重复任务看到未过期的 claimed 不抢占正常执行。pg-boss 重试或显式核对看到过期执行时，通过受限 fencing 函数更换 token、保留原 attempt 并置 unknown；pg-boss lease 到期本身不能授予第二个业务发送身份。同一尚有效 pg-boss attempt 的重复调用默认保留 90 秒内的正常 claim；真实基础设施 retry 从持久 pg-boss retry_count 识别，立即进入 fencing/核对，不能因原 claim 比 queue lease 晚建立而漏掉恢复。测试实际 SIGKILL 后以官方 fail 保留原 job，再由恢复进程重新 fetch（retry_count 递增），没有注入“任务已完成”或缩短业务时钟。

non-idempotent 模式不自动再发，没查到记录仍 unknown。idempotent 模式只在首 claim 固定的保证期限内、内容不变、无取消申请、重新核验当前全部授权/附件后，复用同一 provider key 与 payload 建立下一 attempt。提供方能力/保证期限在首次 claim 固定，不能事后延长或从无幂等升级为有幂等。模拟提供方同键异内容冲突，过期后拒绝继续依赖原保证；不自动生成新 key。

核对始终查询独立 provider 账本，追加操作者或 system actor、证据来源、provider identity/key、payload、attempt 关联、结论和时间。owner 再授权不等于未发送证明。可停止后续尝试并继续保留 unknown；没有无保护的“再发一遍”。

## 迟到事实与权限变化

旧 token 不能发起新调用或覆盖当前状态。若已越过最后检查，迟到的实际接收事实通过受限 provider evidence 入口追加，再由独立账本核对投影到同一请求。成员或工厂权限失效会阻挡新的调用，不会丢弃已经发生的接收。

结果入口只接受持久 outbox/event/job 与相应 request/attempt，建立精确 system/provider RLS 上下文；不是万能 owner。重复/乱序 callback 保留观察，确认接受不倒退，消息依 request 唯一键只创建一次。模拟请求和消息继续受 SQL CHECK 约束，不能升级为 submitted/delivered/read。

完整强杀、旧 worker 恢复、最后检查窗口和双进程证据见 `evidence/c/integration.json` 的 crashes 和 snapshotEvidence。
