# 2026-11-01 登录与 Git 更新

用户明确授权更新日常 Alex 工作区原 owner 登录，并上传当前代码。登录凭据已在本机私有 `.local/b-accounts.json` 及关联引用更新；HTTP和真实页面登录/原owner身份均验证通过，账号值不写入Git。取账号仍用 `./scripts/zu db:accounts`，不要重新seed。登录表单支持既有短密码，新密码默认策略未放宽。详见 LOGIN_UPDATE_2026-11-01.md。Outbound/D1/D2/V的联网受阻状态不变，未accepted；本次上传不代表部署。

# 当前交接：Outbound Intelligence MVP

2026-11-01（Asia/Shanghai）。本次用户授权的主动获客＋企业背调增量本地工作完成，**verification_blocked**：真实官网取得资料→真实公司报告→审核→刷新成功链仍未通过。自动搜索不可用；不能将离线样例或DNS拒绝测试视为真实获客成功。D1/D2/V门槛不变。

- 日常入口 http://127.0.0.1:5173/outbound ，沿用原账号；已备份并迁移0020，旧45表全部行数/摘要一致。源码更新先 `./scripts/zu build`，再 `./scripts/zu start`；数据库停止时 `./scripts/zu infra:start`。不要seed/reset/删卷。
- 隔离入口 http://127.0.0.1:5773/outbound ，停止后 `./scripts/zu ui:outbound`。账号只在 `.local/outbound-test-last.json` 的users.owner/users.sales，公司始终标离线测试数据；新任务使用真实网络。
- `./scripts/zu test:outbound` 每次新建并保留隔离库、更新上述样例指针；`test:outbound:browser` 验证桌面/390px，同一隔离公司会新增审核历史。运行前停止ui:outbound，避免端口4201/4202/5773冲突。真实官网失败检查目前依赖本机DNS现状，网络恢复后应更新浏览器的成功预期。
- 备份位置仅存 `.local/outbound-upgrade-last.json`，本次没有恢复演练。V回归的新私有指针另存 `.local/outbound-regression-v-last.json`，V原指针已恢复；未将回归中的模拟业务审批应用到日常Alex。
- 下一步仅补本阶段真实网络成功链：在用户授权且公网可达的环境保持SSRF，提交有权读取的官网、核对来源、审核并刷新。全部关键门槛通过后先ready_for_user_review，用户验收前不得accepted。SearXNG/本地模型改进另按范围授权，不自动实施。

完整架构/文件/功能/数据库/命令/失败/限制见 STAGE_OUTBOUND_REPORT.md；准确退出码见 evidence/outbound/verification-summary.json；人工路径见 ACCEPTANCE.md。未提交、推送、部署或启用真实触达。

---

以下保留前序 V 交接记录。

# ZuTrade V 本地交付交接

2026-10-30（Asia/Shanghai）。本次授权的V本地集成、升级/重启/独立恢复、界面、安全与文档工作已完成。**V保持verification_blocked**：真实联网研究及真实来源到批次/完整V链尚待补验，不能写ready_for_user_review或accepted。用户已明确验收E，核对实际交付/最终证据后记accepted；D1/D2继续verification_blocked。顺序调整见ADR0014，未部署/采购/调代理/关闭SSRF/启用真实模型或消息。

## 当前入口与账号

- 日常 http://127.0.0.1:5173 ，API/worker3001/3002。`./scripts/zu doctor --services`检查，停止后 `./scripts/zu infra:start`、`./scripts/zu start`。源码更新先build。原Alex仍v17/500件/USD1230、原PDF、冻结payload及pending审批；没有替用户批准。
- V http://127.0.0.1:5673 ，API/worker4101/4102。停止后 `./scripts/zu ui:v`，只重新打开最近独立样例，无seed/reset。`./scripts/zu db:accounts`只输出私有文件路径；在本机打开 `.local/v-test-last.json` 的users.owner/users.sales。该文件还含私有环境，不复制到聊天/报告。
- V使用zutrade_v_test_随机隔离库及独立private目录，来源origin=offline_fixture，虚构公司/内部模拟身份始终标注，未成为真实获客结果。`.local/v-test-last.json`的ids.flow保存同一研究/lead/thread/opportunity/AI/quote/request/approval/payload/followup标识供本机核对。
- 历史C/D1/D2/E分别5273/5373/5473/5573，私有指针未覆盖。原E交接保留HANDOFF_E.md；前序阶段报告/失败记录仍在。

## 验证命令与影响

```sh
./scripts/zu build
./scripts/zu typecheck
./scripts/zu lint
./scripts/zu test:unit
./scripts/zu test:v
./scripts/zu test:v:browser
./scripts/zu test:v:recovery
./scripts/zu exec node scripts/v-restore-guard.mjs
./scripts/zu exec node scripts/v-security-audit.mjs
```

先关闭ui:v，按顺序执行，不并行争用5673/4101/4102。test:v每次新建并保留精确命名隔离库，更新V指针；旧失败库清单保留。browser只访问本机，实际撤销/恢复V销售权限、退出会话以测试下载/SSE与显示，不涉及日常成员。它可能正确取消旧计划；recovery通过正常领域命令新增一条当前有效隔离人工提醒再备份，以验证未完成任务。

recovery会暂时stop/start整个项目的原PostgreSQL容器，所有本地样例短暂失连接；保留同一volume/系统标识，停止/重启V应用，无日常seed/reset。它复制隔离全库与对象到新库/新目录，绝不覆盖原数据。运行v-restore-guard后，恢复库中的测试提醒因撤权正确取消；这是在一致性核对完成之后的独立恢复负测，原库不变。需要重新跑guard时先重新跑recovery生成新的恢复副本，不能期望已取消计划重新生效。

最新备份、恢复目录/数据库/私有环境由 `.local/v-recovery-last.json` 指示，数据库custom dump、private副本与manifest在其backup下。目录/文件保持私有并Git忽略；含auth/模拟账本，不要分享。离线备份不是在线一致性备份，尚无跨机器或生产RPO/RTO演练。

## 实际结果和实现变化

V六组隔离集成、两视口浏览器、三组重启/恢复/空库启动、恢复后任务撤权、93单元及最终工程检查的准确命令/退出码见evidence/v/verification-summary.json。复用的高风险前序证据逐项映射V_MATRIX.md，没有把复用写成新执行。新增规模观察为35会话/91消息/3离线候选/2跟进；恢复准备另加一条提醒。

仅修复无有效成员时误显示“指定审批人”的空值比较，以及顶部遗留E阶段标签。无领域协议变更，无新增迁移。原SQL75,172字节及0000—0019保持；app45/auth4/simulation4/pgboss13，API/worker受限，45app表FORCE RLS。安全审计包括敏感配置忽略、私有下载授权、SSE撤权与退出失效、审计留存、模拟模式与既有SSRF边界。

本机列表部分为硬上限、缺完整历史分页；AI/待办逐对象校验有查询增长，SSE按可见会话生成摘要；前端单包>500kB提示保留。没有生产负载/吞吐量结论。仅Chrome桌面与390px模拟手机，实体手机/其他浏览器/服务器部署未验证。

## 下一步与停止点

本轮只等待用户审阅本地工作，不执行真实渠道试点。完整补验步骤见FUTURE_INTEGRATIONS.md：保持SSRF，在获授权且服务器网络可用时，完成两次不同真实研究、至少三家真实来源抽查、确认/重复导入，再接真实来源lead到D2模拟批次和V完整链。补齐证据后仍只能按全部门槛先ready_for_user_review，等待用户验收。当前D1/D2/V都不能accepted。

交付物：README；docs/PRODUCT_MANUAL.md；docs/ARCHITECTURE_ACTUAL.md；STAGE_V_REPORT.md；V_MATRIX.md；MIGRATIONS.md；ADR0014；ACCEPTANCE.md；FUTURE_INTEGRATIONS.md。保留原Git全工程未跟踪状态，没有自动提交、推送或覆盖用户改动。
