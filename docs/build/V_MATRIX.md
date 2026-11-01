# V 验收矩阵与证据复用

2026-10-30。对照 build-kit/specs/ACCEPTANCE_MATRIX.md。复用意味着前序最终成功证据仍有效，本次没有重新执行该场景；表内明确区分。本次改动为V验收/恢复脚本、文档及两处界面文字/空成员判断，不修改领域状态机或已执行迁移。

| 最终12项             | 本次/既有实际证据                                                                                                                                                            | 判定与范围                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1 事务回滚/队列一致  | e/regression/c/integration.json：批准/事件/enqueue回滚；d2/integration.json：四点回滚、幂等批准；e/integration.json：AI enqueue回滚                                          | 复用通过，真实PG/pg-boss，不是mock数据库                      |
| 2 租户/连接池隔离    | a1/integration.json、a2/integration.json：池交错/回滚/跨工作区/完整工厂集合；V security-audit.json 与browser两视口：角色/RLS、越权PDF/撤权/SSE                               | 既有隔离通过+本次权限集成通过                                 |
| 3 旧快照/证据失效    | e/integration.json：500/800旧报价、来源撤回、AI失效；e/regression/c/integration.json；V integration.json：冻结UPDATE拒绝、改需求保留旧金额/PDF                               | 复用及本次通过                                                |
| 4 原始入站屏障       | a2/failure-recovery.json、d2/integration.json、e/integration.json：失败/未标准化收据仍挡发送                                                                                 | 复用通过，未解除屏障冒充恢复                                  |
| 5 claim/撤销竞态     | c/integration.json、e/regression/c/integration.json：claim前后截止；d2/integration.json：批次claim后撤销；e/integration.json：FAQ claim后接管                                | 复用通过，不声称领取队列就是领取发送权                        |
| 6 双worker/旧执行权  | d2/integration.json 的 crashes 记录（两个专用进程争同一持久job）；c/integration.json：双消费者、迟到写回/租约                                                                | 复用通过，未声称两个进程同时持有相同queue lease               |
| 7 接受后丢响应/强杀  | c/integration.json 中的 crashes 记录：claim后/独立模拟账本接受后SIGKILL、幂等/非幂等、unknown核对                                                                            | 复用通过；没有真实服务方接受                                  |
| 8 重复入站/乱序回执  | a2/integration.json及c/integration.json：持久去重、回执降级拒绝；E重复FAQ身份                                                                                                | 复用通过，simulation不升级真实delivered/read                  |
| 9 跟进停止/恢复      | d2/integration.json：实际worker强杀、到期恢复/停止；V integration.json：改期旧版本与实际到期新回复取消；recovery.json/restore-job-guard.json：保留任务、恢复后当前撤权仍生效 | 复用+本次通过                                                 |
| 10 检索故障/恶意来源 | d1/integration.json：离线SSRF/跳转/限流/预算/崩溃重启/审核CAS；unit.txt网络负向；D1真实三次SSRF_DNS_REJECTED历史                                                             | 安全/离线负向通过；真实发现成功与来源抽查仍受阻，不是整体通过 |
| 11 附件/内部资料     | e/regression/c/integration.json：缺失/篡改字节/冻结/权限；V integration.json排除内部备注；browser桌面/手机PDF鉴权；recovery.json字节摘要                                     | 复用+本次通过                                                 |
| 12 持久化/备份恢复   | V recovery.json：全部45 app表行摘要、同volume/系统标识、会话/未来job、独立全库和私有对象恢复；restore-job-guard.json：恢复未到期不执行、当前撤权停止、原库不变               | 本次通过，仅本机独立库/目录，未验证跨机器/生产恢复            |

以上路径均相对 docs/build/evidence。原有阶段报告保留真实失败与恢复，不能因为复用把旧负测改成新执行。人工操作与新证据见 STAGE_V_REPORT.md、ACCEPTANCE.md。D1/D2/V真实关键门槛仍受阻，V保持verification_blocked。
