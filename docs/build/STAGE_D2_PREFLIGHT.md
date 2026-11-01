# D2 前置门槛检查：未开始实施

检查时间：2026-10-29 17:20（Asia/Shanghai；证据 UTC 为 09:20）。**D1：verification_blocked；D2：not_started（前置门槛受阻）**。本文件仅记录用户本次要求的阶段门槛检查，不代表 D2 实施或自测完成，不进入 E。

## 结论与缺失门槛

根目录 AGENTS、MASTER_PROMPT、CONFIRMED_SCOPE、D2 阶段文件、DATABASE_NOTES、ACCEPTANCE_MATRIX、PROSPECTING_SPEC、UI_SPEC、PROGRESS/HANDOFF/ACCEPTANCE、D1/C/B 报告、迁移记录及相关 ADR 均已读取；同时检查真实源码、日常 PostgreSQL、Git 和运行服务。

日常库中只有原三次 `live_network` 研究：

| 地区 | run                                  | 当前结果                   | 请求数 | 候选 |
| ---- | ------------------------------------ | -------------------------- | ------ | ---- |
| SG   | 2377cd8c-ad55-4ac0-befd-fd4bf1cd04e4 | failed / SSRF_DNS_REJECTED | 1      | 0    |
| GB   | 3d7cbba8-c874-48b2-b106-a947fb1e9780 | failed / SSRF_DNS_REJECTED | 1      | 0    |
| AU   | 5955d129-a452-40d4-9335-c62c399112ba | failed / SSRF_DNS_REJECTED | 1      | 0    |

三次 review_revision 均为 0、review_decisions 均空；来源于真实研究的 lead 数为 **0**，没有后续补验成功记录。当前重新执行 Node A/AAAA 解析，en.wikipedia.org 为 198.18.0.10、www.wikidata.org 为 198.18.0.11，AAAA 均 ENODATA。调用现有 `checkedAddress` / `resolvePublic` 仍得到 `SSRF_DNS_REJECTED`；未进行外部 HTTPS 连接，未把 DNS 校验当作新增真实研究。

尚缺：两个不同目录/条件的真实研究可用结果、至少三个不同真实候选的来源抽查、一条真实候选人工确认与导入链、重复导入回到同一 lead。D1 既不是 ready_for_user_review，也未 accepted；本次有条件启动 D2 不能接受受阻 D1。因此按用户要求停止，不实施批次、联系资格、跟进、待办扩展或新增迁移。

## 实查并保留的状态

- 数据库检查使用迁移身份的显式 `REPEATABLE READ READ ONLY` 事务及 5 秒 statement_timeout，只执行 SELECT。日常库 app 45、simulation 4、auth 4、pgboss 13；15 条已应用业务迁移 0000—0014 的 hash 全部匹配文件。没有执行迁移。
- 原始 SQL 为 75,172 字节，SHA256 为 b7f72b68adce6ad161eedf66b65389cd35461ec20446a9e97fa560550c21a1fe。源码仍使用真实目录/Brave 边界、受控 DNS/固定连接；FixtureResearchProvider 仍只供显式测试注入。C 仍由统一 dispatch 调用 adapter；未增加 D2 生产入口。
- 现有 outreach_batches、outreach_batch_items、followups 表均 0 行；已有表结构不表示 D2 已实现。本次未产生批次版本、批次审批、simulation 联系资格或跟进状态/停止原因。
- Alex 为 v17 / 500 件 / 1230.00 USD，quote state=validated；原请求 awaiting_approval，原审批 pending，仍指向原 payload。实际读取原 PDF，69,753 字节及 SHA256 与原交接一致；未重新生成、批准或执行。
- API/worker 仍非 superuser、无 BYPASSRLS。消息 simulation、AI mock、企业发现 live_public_directory。没有调整网络、代理/DNS、SSRF、账号或真实渠道，没有启动真实模型、联系公司或推送部署。
- Git 分支 stage-0-bootstrap，0 commits，工程文件仍为既有未跟踪状态；没有提交、重写历史或覆盖用户改动。

## 本次验证与证据

| 命令/检查                                         | 实际退出码 | 含义                                                                                        |
| ------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------- |
| `./scripts/zu doctor --services`                  | 0          | 锁定 Node v24.22.1 / pnpm 11.25.0、Docker、日常服务 ready、原 SQL 与忽略规则正常            |
| `./scripts/zu exec node .local/d2-gate-check.mjs` | 0          | 只读数据库、迁移 hash、真实 DNS、安全校验、服务、Alex/PDF、Git 检查完成；不表示 D1 门槛通过 |

完整脱敏快照为 [evidence/d2/gate-check.json](evidence/d2/gate-check.json)。检查源码保存在 evidence/d2/gate-check-source.txt，可用 `./scripts/zu exec node --input-type=module < docs/build/evidence/d2/gate-check-source.txt` 重跑采样；其中 decision 是本次人工据实判定的停止记录，不是通用自动验收器。运行会更新该快照，不会写业务数据或创建研究任务。本机 ignored .local 副本不包含凭据，只读取现有本地配置。

一次只读源码搜索使用不存在的 outbound*.ts 路径，退出 1；后续读取实际 dispatch.ts、prospecting.ts、network.ts、providers.ts 以及相关 ADR 完成核对。没有数据库失败或恢复操作。D1 历史真实研究的失败与原退出 2 继续保留在 evidence/d1，本次没有重复运行 prospecting:live 或改写旧失败证据。

本次只增加门槛说明与证据；未修改应用代码、build-kit 或迁移。D2 的 13 项行为验证、隔离数据库/专用 worker、桌面/手机流程均**未实施、未执行**；构建、strict、lint/包边界及 A/B/C/D1 行为回归本次未重跑，前次结果仅为历史证据，不能用于宣称 D2 通过。

## 服务与后续停点

日常 [5173](http://127.0.0.1:5173/) / API 3001 / worker 3002，C 隔离样例 5273/3401/3402，D1 离线样例 5373/3501/3502：本次九个 HTTP 探针均 200，三套 API ready，保留运行。账号仍用 `./scripts/zu db:accounts` 取得本机私有文件路径，禁止把密码复制到报告。正常停止后的启动命令沿用 HANDOFF.md，不 seed 或 reset。

没有可交付的 D2 人工验收路径。后续先在真实公网解析和正常 TLS/HTTPS 可达条件下，按 D1 既有有界命令及人工来源路径补齐真实门槛；不由本次检查调整用户网络，不用离线样例替代。D1 自测门槛全部通过才记 ready_for_user_review；用户验收或届时明确启动 D2 才可按规则接受。当前停在前置受阻，不记录任何新增 accepted 或 ready_for_user_review。
