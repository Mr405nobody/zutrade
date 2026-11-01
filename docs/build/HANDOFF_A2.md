# ZuTrade A2 交接

更新时间：2026-10-28（Asia/Shanghai）。A1 已由用户本次明确验收，accepted。当前仅 A2，最终状态见 PROGRESS；B 及后续未启动。

## 继续运行

工程根目录 `/Users/warren/Desktop/ZuTrade`，Colima profile `zutrade`，PostgreSQL 18.6，端口 55432。保留原持久卷、账号、随机密码和 `.env`。工具链只能从 `./scripts/zu` 进入。

已在本机应用业务增量 0003/0004。当前 web/API/worker 端口为 5173/3001/3002；构建后的开发 watch 进程保持运行。打开 [消息工作台](http://127.0.0.1:5173)。若服务已停止，日常启动：

```sh
colima start --profile zutrade
./scripts/zu infra:up
./scripts/zu dev
```

已有数据库升级时执行 `./scripts/zu build`、`./scripts/zu db:migrate` 后再启动。不要重新初始化、reset、删卷或覆盖私有文件。独立终端运行也可分别 `./scripts/zu dev:web`、`./scripts/zu dev:api`、`./scripts/zu dev:worker`（先 build）。已有端口被占用时沿用原运行服务，不重复启动。

账号取得方法仍为 `./scripts/zu db:accounts`，在本机打开其指示的 `.local/a1-accounts.json`。owner/sales 的随机密码只存该私有文件，不写入报告或 Git。浏览器自动检查另用 `.local/a2-browser-accounts.json` 与独立测试工作区，不改变日常 DEMO-A/B 权限或数据。

## A2 的真实路径

owner 登录后默认进入消息。点「注入模拟买家消息」，选 DEMO-A 后点「注入 Alex 询盘」。API 根据已验证成员确定 workspace，并创建/沿用本工作区的 `zutrade-mock / a2-inbox` 专用 simulation 账号；浏览器不传账号或授权模式。原始收据、outbox 和 pg-boss job 同事务提交，独立 worker 标准化到联系人、最小 intake 商机、会话与 messages。重放同一事件复用收据，不同内容会 409；同 provider message 不重复投影。无法确定渠道身份的收据停在待确认，继续保留账号屏障。

点会话阅读；内部工作区按需打开，备注与草稿明确「仅团队可见」。受控回复只允许服务端固定版本「数量、用途、目的地」三种模板。自由文本保持既有 request draft + 未冻结 payload；没有 messages、冻结或队列。接管/释放以服务端 CAS 确认为准。assisted 仅是协作模式，AI 未启用。

模板发送经统一 Delivery 服务：权限/完整工厂集合/最新上下文 → request 与冻结 payload → 同事务 outbox + pg-boss → worker 重验并原子 claim → 事务外 MockAdapter → attempt 与 simulated 消息。UI 以数据库结果显示「模拟执行完成」，不表示真实送达。owner 也没有商业承诺发送旁路。

负责人、认领不授予会话读取权。未分配会话只给 owner；含 A/B 的线程对仅 A sales 完全不可读。详情、列表、摘要/未读、备注、消息、草稿、发送与 SSE 使用同一完整集合授权。SSE 每 2 秒重新验证会话/成员/ACL；只返回变化提示，不含正文或其他工厂计数。重连从数据库恢复；消息用 ingest_seq 游标，不用买家时间推进已读。

## 队列与异常恢复

普通 queued 任务在 worker 停止期间保留；恢复 worker 即继续处理，无需 seed。API 重启和 SSE 断线不丢历史。

```sh
./scripts/zu db:queue-maintain
./scripts/zu db:queue-maintain --retry-failed-inbox
```

维护命令使用受控迁移身份调用 pg-boss 官方 supervise/retry；runtime 仍无 DDL、BYPASSRLS 或表 owner 权限。显式重试仅复用 a2.inbound/a2.delivery 的失败 job，不创建第二个业务身份；每队列最多扫描 1,000 / 重试 100。修正身份或底层故障后才有意义。pending/retry/dead 收据 processed_at 为空时始终保留屏障；不能直接手动清除屏障来恢复发送。A2 不提供模糊身份的合并/核对产品界面，需后续完善。

blocked 发送保留明确原因；应核对最新上下文/权限后发起新的受控命令。claimed/dispatching 的旧任务重试保守进入 unknown，不自动重发；C 再完成独立模拟接收账本与正式核对流程。此阶段未验证非幂等渠道强杀全时序，不能写成已通过。

## 验证入口与模块

- `./scripts/zu test:a2`：独立真实 PG 数据库、真实 API/worker，验证消息/授权/发送/恢复；成功仅删除自己本轮精确命名测试库。
- `./scripts/zu test:a2:inbound`：独立 PG 的系统作用域、原始收据、失败投影与官方重试检查。
- `./scripts/zu test:a2:browser`：准备独立测试工作区，使用本机 Chrome 运行 1440 / 390 视口的真实 UI 检查，服务需已运行。
- `./scripts/zu typecheck`、`./scripts/zu lint`、`./scripts/zu test:unit`、`./scripts/zu build`。

`packages/domain` 中 inbox / inbound / delivery 分离；`packages/channels` 只注册 MockAdapter。API 的 InboxController 复用 Better Auth 和事务 helper，worker 消费两个 A2 真实队列。DB 仍 42 张业务表；0003 添加接管人和收据归属/投影字段，0004 补窄作用域及冻结目标锁权限。原始 SQL hash 不变，冻结触发器、FORCE RLS 与复合 FK 保留。Drizzle 映射更新为 579 列、144 FK（103 复合）。无 prospecting_runs。

实际结果、失败与恢复、截图和限制见 [STAGE_A2_REPORT.md](STAGE_A2_REPORT.md) 与 evidence/a2；A1 历史证据保留。工作区文件原先均为 untracked，未配置作者、提交或推送。不要覆盖用户文件或重写 Git 历史。完成 A2 后停在 ready_for_user_review，不能自动 accepted 或进入 B。
