# 历史：E 原交接（当前状态以 HANDOFF.md 为准）

E 已于2026-10-30经用户明确验收记 accepted。以下保留原交接文本。

# ZuTrade E 交接

2026-10-29（Asia/Shanghai）。当前 E **ready_for_user_review**，等待用户验收，不进入 V，不自动 accepted。用户本次明确授权提前实施 E；D1/D2 的真实 DNS、真实研究及真实来源到批次链仍留待服务器网络可用后补验，两阶段继续 verification_blocked，没有被接受。范围与技术决定见 [ADR 0013](adr/0013-e-preset-ai-and-stage-order.md)。

E 已验证可重放 preset AI、五类建议、版本/证据/校验运行记录、采用/修改/拒绝、owner 审核模板、受控 FAQ 统一网关和失效屏障。完整证据、实际失败与恢复、限制见 [E 报告](STAGE_E_REPORT.md)，支持表达见 [场景目录](E_SCENARIOS.md)。E 本次 21 组 PostgreSQL 集成、93 单元、桌面/手机 2 项及 OS 禁止出站网络验证通过；B14/C23/D2 21 组回归通过。原 D2 交接原文保留在 [HANDOFF_D2.md](HANDOFF_D2.md)。

## 启动与账号

- [E 独立人工验收](http://127.0.0.1:5573/)：Web 5573、API 3901、worker 3902，使用已保留的独立 PostgreSQL 数据库、私有文件与模拟接收账本。停止后在工程根运行 `./scripts/zu ui:e`；不重新 seed，不 reset。`test:e` 每次创建新精确命名隔离库并更新 E 私有指针；先关闭旧 ui:e 再重开。
- 运行 `./scripts/zu db:accounts`，仅在本机打开 `.local/e-test-last.json` 的 `users.owner` / `users.sales`。文件含私有环境，不复制到聊天或报告。owner 审核 FAQ 模板和业务报价，sales 可处理授权工厂的建议、草稿、需求和提醒。
- [日常工作台](http://127.0.0.1:5173/) 使用原库，API/worker 3001/3002。原 Alex 账号仍在 `.local/b-accounts.json`；v17 / 500 件 / USD1230、原 PDF、冻结 payload、pending 审批保留。E 未向日常库写入 AI 样例或替用户批准业务。停止后 `./scripts/zu dev`，沿用原锁定工具链和数据卷。
- 历史 C/D1/D2 样例仍分别是 5273/5373/5473；它们保留前序阶段的数据库与验证用途，E 验收使用 5573，不把历史离线研究当作真实获客结果。

## 日常操作与边界

消息 → 选择没有接管的材质问题会话 → 内部工作区 → 模拟 AI。owner 可展开“场景调试”，通过现有模拟入站收据注入目录中的问题；等待买家消息实际出现后再生成建议。普通问答、需求提取、资料检索、报价输入和跟进建议各有类型，未知表达只转人工。

固定业务时钟用于重放，不决定真实资料/审批有效期。跟进输出日期只作场景建议，采用时必须另选未来时间和 IANA 时区。FAQ 仅审核过的材质/尺寸模板与允许值；同一消息/模板版本最多一个外发身份。新消息、需求/事实/权限变化、30分钟超时、未处理收据和接管会阻挡旧建议或自动动作。拒绝/修改只能阻挡尚未领取的动作，C 的 claimed 撤销截止、在途与 unknown 语义继续适用。

采用数量建议仅保存需求；继续用原采购需求区域生成确定性报价、PDF、最终内容与 owner 审批。修改只存独立内部草稿。资料请求采用后建立人工待确认任务，跟进建议采用后保存人工提醒。AI 没有事实发布、批准、真实检索或发送能力。

## 数据与验证入口

仅追加 `0019_mock_ai`，复用 ai_runs，无新增 app 表；app45 / simulation4，完整映射662列、159FK（115复合）、200CHECK。原始 SQL 与已执行0000—0018 hash 保持。正式 e.ai 队列与业务/outbox 入队使用同一事务，不新增调度器。

```sh
./scripts/zu build
./scripts/zu typecheck
./scripts/zu lint
./scripts/zu test:unit
./scripts/zu test:e
./scripts/zu exec node scripts/verify-e-offline.mjs
./scripts/zu test:e:browser
```

offline 验证读取 test:e 留下的本机输入和数据库预期，用 macOS sandbox-exec 禁止子进程全部出站网络，连接探针实际 EPERM 后仍完成相同输出；不修改系统网络、代理或 SSRF。浏览器测试仅阻断浏览器非本机请求，访问本机 API/数据库；trace 留在 ignored test-results，不复制含登录操作的 trace 到构建证据。

全部保留测试库的精确名称、成功/失败记录在 evidence/e/retained-test-databases.json；没有清空日常库或删除卷。最终命令/退出码见 evidence/e/verification-summary.json。当前仅本机 Chrome 桌面1440×1000和手机390×844；未验证实体手机、其他浏览器、服务器部署和真实模型。

D1/D2 后续仍需保持 SSRF 防护，完成两个不同目录/条件的真实研究、至少三家真实来源抽查、真实确认导入与重复导入，再接真实来源到批次链。没有部署、代理修改或真实触达授权。E 完成后停止等待验收。
