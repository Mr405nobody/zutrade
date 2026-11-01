# 阶段 D2：触达批次与跟进

2026-10-29（Asia/Shanghai）。**verification_blocked：本地实现及隔离验证完成，真实来源链按用户要求延期。** D1 仍 verification_blocked，未接受；D2 未 accepted，不进入 E。

## 授权与实际范围

首次前置检查确认 fake-IP 阻塞后停止，原报告保留在 STAGE_D2_PREFLIGHT.md，原证据为 evidence/d2/gate-check.json。用户随后明确指示“现在直接做d2的步骤 dns等部署服务器后再进行测试”，据此提前实施 D2，见 ADR 0012。没有把下一阶段指令当作对受阻 D1 的接受，没有上传、部署、改 Clash/DNS、关闭 SSRF 或注册真实服务。

本轮正向验证从 D1 的显式离线研究 transport 开始，实际经过持久研究、审核、导入、模拟身份、批次和跟进。origin=offline_fixture，均在精确命名隔离库，不写入日常库，不计为真实公司发现。真实网络→来源抽查→确认导入→批次预览仍待服务器网络满足后补验。

## 业务实现

“找客户”在原四入口内承接已确认线索、独立模拟身份和批次。桌面支持名单、逐人主题/正文、账号、引用报价、开始时间、时区、节奏与截止编辑；手机支持查看、审批和必要操作。“消息”内部区增加跟进计划；“待办”聚合批次和原单项审批、联系方式核对、到期提醒、原始入站失败、发送失败/阻挡及 unknown，可打开业务对象并执行实际操作。

联系方式出处、公司身份确认、个人身份核实、真实联系资格和内部 simulation 授权分别表达。没有真实联系人时，仅创建明确名为“内部演示身份（非真实联系人）”的 contact，保持 unverified，不编造采购负责人、邮箱、电话或采购意愿。独立模拟 contact point 使用 zutrade-simulation namespace、具体 account scope、internal-demo 身份和 internal_demo 来源，关联原 lead/buyer；不覆盖真实点。

仅当前指定 owner 首次授予或重新授予内部模拟资格；有权成员可停止模拟联系。service/outreach 的 allowed 只写 channel_kind=simulation。停止会取消旧未领取请求、对在途记录取消申请并推进会话上下文；以后重新授权不复活旧动作。额外隔离测试建立 email 的 unknown、denied/do_not_contact 行，simulation 授权/撤销/重授后逐行 JSON 不变，verified_at 仍空。测试地址为 .example 虚构值，没有实际外发。

批次复用 outreach_batches / versions / items / approvals。先保存持久 draft，提交时建立新的不可变版本及逐人 outbound_request / payload；名单、计划和每项 payload ID/摘要纳入批次摘要，复合 FK 精确绑定。冻结后不能增删改 items。审批命令固定已查看 versionId、snapshotSha256、approval.row_version；只有当前有效且被 workspace 指定的 owner 可批准。相同幂等命令复用原结果，异内容冲突。

批准、审批事件、逐项 queued、outbox 与 pg-boss 入队同事务。改成员、正文、身份、账号、附件、商业条件或执行授权计划，必须提交新版本重审；旧批准失效，不继承。新草稿不原地改旧快照。在途或 unknown 风险不能靠新 request ID 绕过。模板仅引用已有公司/工厂名称，不声称采购意向；人工编辑在审批前完成。引用报价时由 B 冻结字段生成完整商业正文并绑定原 PDF，不从内部草稿、研究摘要、成本或其他工厂资料拼接外发。

所有逐人请求仍走 C 的 consumeDeliveryJob / validatePayload / 唯一 adapter.send。D2 增加 approved_batch / automatic_followup 的明确来源、版本、当前资格及审批检查，无直调 adapter 旁路。pg-boss startAfter 持久唤醒，claim 事务核对 scheduled_at、账号和批次 next_claim_at。早到/竞争任务复用同一 request、payload、provider key 延期。同账号在途阻挡后续领取；实际结果写回由 C 精确 result token 再延后账号/批次节奏，覆盖 claim 后进程停顿窗口。同账号 unknown 明确阻挡后续 D2 项并要求核对。最小账号间隔 1000ms，批次可更长。

批次汇总取实际逐项状态，排队不等于完成。claimed commit 是撤销截止；之后仅记录取消申请，不承诺撤回。接受后丢响应保留 unknown 并查独立 Mock 账本；空结果不证明未发送，重试/恢复沿用同一业务身份、内容和 provider key。

跟进复用 followups，保存负责人、UTC due_at、IANA time_zone、目标、商机/会话/报价、internal_draft、execution_mode、stop_conditions、business_version。完整版本追加到 audit。默认 manual 到期仅 ready，不创建出站；自动模拟跟进事先冻结最终内容并申请单项 human_approval，执行时重走网关。改期或改关键内容推进业务版本并建立新请求，旧 job 不执行新内容。

实际网关 claim、dispatch 和终态投影到 scheduled / ready / executing / completed / cancelled / failed 等计划状态，并追加执行历史。unknown 保留关联请求和核对原因。停止原因包括 NEW_REPLY_OR_CONTEXT_CHANGED、HUMAN_TAKEOVER、THREAD_PAUSED/CLOSED、OPPORTUNITY_CLOSED/PAUSED、REQUIREMENTS_CHANGED、QUOTE_OR_FACT_INVALID、MEMBER_SIMULATION_OPT_OUT、ACTOR_NO_LONGER_AUTHORIZED、RESPONSIBLE_MEMBER_PERMISSION_LOST、FACTORY_PERMISSION_LOST、PLAN_RESCHEDULED_OR_CHANGED、MEMBER_CANCELLED，以及具体网关审批/资格/入站原因。

human 阻挡自动跟进和接管前旧计划，仍允许有权成员新发起、满足最新版本和审批的人工动作。outbound_paused 另行阻止全部新外发；恢复推进上下文，不复活旧授权。取消依据数据库状态，测试故意保留未取消 job 并重放；没有声称注入了真实 pg-boss.cancel 异常。

时区不使用本机隐式解释；不存在的本地时间拒绝，重叠时间默认 reject，须明确 earlier/later。Shanghai、New York DST gap/overlap、Kathmandu 非整小时偏移均有验证。

## 实际验证与准确命令

| 验证                           | 命令                                                                                                                  | 结果与 evidence/d2 证据                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| D2 PG/队列/审批/版本/并发/强杀 | `./scripts/zu test:d2`                                                                                                | 最终21组，退出0；integration-final.txt、integration.json、保留库清单 |
| 真实渠道资格隔离               | `./scripts/zu exec node scripts/verify-d2-eligibility.mjs`                                                            | 3项断言，退出0；eligibility.txt/json                                 |
| Chrome 桌面/手机               | `./scripts/zu test:d2:browser`                                                                                        | 1440×1000、390×844，两项通过；browser/ 与浏览器日志；原失败保留      |
| 单元                           | `./scripts/zu test:unit`                                                                                              | 88项，退出0；unit.txt                                                |
| B                              | `EVIDENCE_DIR=docs/build/evidence/d2/regression/b ./scripts/zu test:b`                                                | 14组，退出0；regression/b.txt 与 b/                                  |
| C                              | `EVIDENCE_DIR=docs/build/evidence/d2/regression/c C_API_PORT=3801 C_WORKER_PORT=3802 ./scripts/zu test:c`             | 23组，退出0；regression/c.txt 与 c/                                  |
| A1                             | `EVIDENCE_PATH=docs/build/evidence/d2/regression/a1.json ./scripts/zu test:integration`                               | 23组，退出0；regression/a1.txt/json                                  |
| A2                             | `EVIDENCE_DIR=docs/build/evidence/d2/regression/a2 ./scripts/zu test:a2`                                              | 19组，退出0；regression/a2.txt 与 a2/                                |
| 原始入站                       | `./scripts/zu test:a2:inbound`                                                                                        | 11组，退出0；regression/inbound.txt                                  |
| D1 离线                        | `EVIDENCE_DIR=docs/build/evidence/d2/regression/d1 D1_TEST_POINTER=.local/d1-d2-regression.json ./scripts/zu test:d1` | 16组，退出0；regression/d1.txt 与 d1/；未覆盖原私有 UI 指针          |

构建、strict、lint/包边界、重复迁移、doctor、日常数据及敏感信息审计的准确最终退出码见 verification-summary.json 和对应日志。Vite 有超过500kB的单包体积提示，未将它作为性能验收。没有以覆盖率替代行为验证。

21组覆盖：真实 D1 离线导入链与资格隔离；指定有效 owner、sales/失效/非指定 owner/跨租户/工厂拒绝；审批/业务/outbox/enqueue四点回滚及重复批准；冻结负向；三个请求成功/失败/延迟；新版本不继承审批；并发及 claim 后停顿的实际节奏；DST；默认提醒及改期历史；新回复/接管/暂停/关闭/需求/退订；成员/工厂失权；真实 worker SIGKILL→到期→重启后提醒保留、自动跟进实际完成、变更计划阻挡；保留旧job重放；cutoff与接受后丢响应核对；live拒绝；实际入站及失败收据重处理屏障；报价/PDF、报价换版/事实撤回及内部字段排除；human新人工动作；两个专用进程竞争；批次领取后撤销。

强杀证据包含 PID、SIGKILL、到期/恢复时间和同一计划/请求；两个专用进程在同一持久 job 的 beforeClaim 竞争，仅一次 claim/provider invocation。真实 fetch 与领域重放分别记录，没有声称两进程同时持有同一 queue lease。C 回归另覆盖 claim/接受后强杀、幂等/非幂等、迟到事实和最后检查窗口。浏览器实际检查逐人预览、审批、结果、提醒、DST错误、刷新重登及无横向溢出；截图另行实查。

## 失败与恢复（均保留原记录）

- 研究测试最初未先 fetch 被 D1 正确拒绝；改为真实 fetch/complete。
- 新线程 INSERT 被原完整会话 RLS 拒绝；增量0016增加指定 owner 的精确初始化窗口，未改已应用0015，不放宽关联后读取。
- 附件负测最初将[]改为相同[]，并非实质变化；改为不同附件后冻结拒绝。一次修改测试字符串语法失败，保留后修正。
- 核对误用 called_at，按真实 invocations.invoked_at修正。工厂失权使RLS隐藏计划，初版任务静默返回；改精确job入口先记录撤权停止原因。
- Mac/数据库时钟差使刚发布价阶暂不可用；报价生成改默认数据库时钟，保留显式测试时钟。报价收件冻结改用normalized_value，避免展示名当地址，B/C回归通过。
- claim后停顿的节奏窗口以在途阻挡和0017结果token结算修复；0018补实际跟进执行状态/历史。
- 首轮浏览器正文标签定位超时，手机同一路径被显式终止，未记成功；改实际textbox可访问名称后两视口通过。截图发现预览在列表底部未自动定位，补滚动后复验。
- 首轮lint仅两个文件格式问题，修复后复验。catalog-map首次误用历史默认输出，覆盖A1 catalog摘要；已从保留D1库真实catalog恢复45表/640列/155FK/111复合FK/190CHECK，新D2摘要单独存储，恢复依据见catalog-summary-recovery.json。没有改旧库或schema。

精确失败库清单、前后日志和恢复结果保留。原始私有 Playwright trace 留在 ignored 测试目录，不把含登录操作的 trace 复制进报告。没有模糊删库、删卷、reset、schema push、日常 seed、自动提交或推送。

## 数据、服务、人工检查及未验证项

仅增量0015—0018，详见 MIGRATIONS.md；app仍45、simulation4，映射652列/158FK（114复合）/196CHECK；原SQL和0000—0014保持。Alex仍v17/500件/1230.00USD、原PDF和pending审批，未代用户批准。日常库没有D2 fixture、批次、跟进或新研究线索，审计见final-audit.json。

日常入口 [5173](http://127.0.0.1:5173/)，API/worker 3001/3002；D2独立样例 [5473](http://127.0.0.1:5473/)，3701/3702。`./scripts/zu db:accounts`只输出本机私有文件路径；D2账号在`.local/d2-test-last.json`的users，日常Alex仍用原B账号。日常停止后`./scripts/zu dev`；D2停止后`./scripts/zu ui:d2`，不seed/reset。原C/D1样例保留为历史用途，不作为D2入口。

人工5步见 ACCEPTANCE.md，服务保留运行。仅本机Chrome与手机视口，未验证实体手机、其他浏览器、服务器部署及服务器数据库/文件持久化。真实DNS、至少两次真实研究、三家来源抽查、真实确认/重复导入以及真实线索进入批次，均延期且未通过。没有真实公司触达、真实模型、订单或资金流程。当前保持verification_blocked；补验通过后仍只能ready_for_user_review，用户验收前不记accepted。
