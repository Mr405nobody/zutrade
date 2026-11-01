# 阶段 C：审批与完整发送协议

日期：2026-10-29（Asia/Shanghai）。状态：**ready_for_user_review**。用户已在本次指令中明确验收 B；仅执行 C，不进入 D1。开发阶段验收不等于产品内商业审批。

## 用户能做什么

sales 在会话内部准备当前有效报价或最终自由文本，提交确切正文、主收件人和已保存 PDF 的审批。指定且有效的 owner 可在会话或待办查看完整预览、打开同一对象版本的 PDF，再明确点击“批准并模拟执行”；owner 自己准备的内容也先 pending，不自动批准。

审批支持拒绝、撤销、过期、失效、新版本和可展开历史。页面固定 owner 实际查看的 payload、完整摘要与 approval.row_version，轮询不会把旧页面的按钮绑定到新版本；冲突后必须重新查看。哈希、job/attempt/token 放在审计详情，不作为日常操作要求。

领取前撤销显示已停止；领取后显示取消申请/核对，不承诺本次撤回。unknown 可读取独立模拟渠道账本，或停止后续尝试并保留 unknown。空查询不解释成未发送；仅在提供方原幂等保证有效、内容不变且当前授权仍成立时允许受控恢复，没有无保护的“再发一遍”。

A2 中性模板仍为 human_reply/member_send；内部草稿身份不改写。自由文本另建 human_reply/human_approval 请求，由 owner 人工审阅语义。报价为 quote/human_approval，金额与条款由 B 冻结字段生成。所有实际发送只有 domain/dispatch 这一处 adapter.send。FAQ、批次和跟进保留类型契约并在领域校验中 fail closed，没有相应生产按钮或 AI 功能。

## Alex 实际交付对象

实际读取当前库后，Alex 的有效需求是 **500 件，1230.00 USD，B 报价 v17**，不是旧 v1，也没有假设一定为 800 件。沿用这个当前版本及已存 PDF，没有回退历史、延长依据或重新初始化账号。具体 ID、有效期及三种摘要见 `evidence/c/demo-ready.json`。

原工作区未指定审批 owner；通过既有受鉴权成员管理命令指定唯一有效 owner，留下原审计，没有用开发验收替代商业审批。`demo:c` 按 sales 身份一次性提交待审批内容；交付时不替用户批准这份 Alex 报价。重复命令不覆盖历史；`--refresh` 只用于显式按正常版本流程重新申请尚未 claimed 的当前内容。

C 正向自动验证另在独立数据库使用 800 件/1950.00 USD 的当前报价，实际完成 sales 提交、owner 审阅和批准、真实入队、worker、独立 Mock 接收及消息投影。异常 C 场景均在隔离数据库与专用进程中运行，未撤回 Alex 的供给或损坏其文件。

A2 浏览器回归沿用原验收工作区，追加了中性模板模拟消息、内部备注和接管历史；没有删除这些真实测试记录。相应上下文变化通过正常 payload 新版本重新申请 Alex 审批，不重写旧快照或报价。这些模拟历史不代表真实买家触达。

## 数据库、权限与不可变边界

增量迁移为 0006—0012：

| 迁移 | 内容                                                                                                                              |
| ---- | --------------------------------------------------------------------------------------------------------------------------------- |
| 0006 | append-only command_receipts；审批/证据权限与 restrictive RLS；dispatch 内容保护；simulation schema；精确 job/provider actor 入口 |
| 0007 | 首 claim 固定 provider 能力/保证期，执行 fencing，调用与接受 token 关联                                                           |
| 0008 | worker 在 opportunities 上取得行锁所需的单列权限，不授予报价/事实写权限                                                           |
| 0009 | 创建成员不可变；精确版本的阻断与审批失效生命周期                                                                                  |
| 0010 | 修复 PL/pgSQL reason 参数/列名歧义，保留先前已执行迁移                                                                            |
| 0011 | 调用开始即独立提交 invocation，区分在途调用、完成结论与接收副作用                                                                 |
| 0012 | 从持久 pg-boss retry_count 区分重复处理和真实任务重试                                                                             |

当前 app **44 表** = 原 42 + B PDF manifest + C command receipts；608 列、150 FK（107 复合）、172 CHECK。simulation 四张基础设施表单独统计；没有 prospecting_runs。认证和队列仍由既有官方迁移管理。原始 SQL 与原始基线的字节校验保持不变，SHA256 为 `b7f72b68adce6ad161eedf66b65389cd35461ec20446a9e97fa560550c21a1fe`。

API/worker 仍是非 owner、非 superuser、无 BYPASSRLS 的运行角色；没有放宽既有 RLS 或删除冻结保护。新增独立 zutrade_simulation 角色仅可 SELECT/INSERT simulation 表，API/worker 的业务连接不能访问该 schema。迁移身份只用于 schema、明确 fixture/维护和只读审计，不运行实际审批/发送业务。

收件 contact point、账号、thread、factory、opportunity、intent、授权模式、创建成员与幂等身份不可原地修改。同身份未 claimed 请求可新增 payload 并结束旧审批；有 claim/attempt/unknown 后不能复用原 key 更换内容。同一会话，或同账号/收件 contact point 存在在途/unknown，新的请求也不能绕过风险。

## 冻结、PDF 与事务

`c-outbound-v1` 对象键排序、NFC、LF、null/缺失、十进制字符串及数组语义见 ADR 0008。保存、预览和执行的是规范化结果本身。B 的 quote_snapshot_sha256、实际 PDF attachment.sha256、完整 payload.snapshot_sha256 严格区分；approvals 绑定第三种。

完整 payload、证据引用、目标关联、冻结和申请在一个事务中建立；不在批准后补翻译、正文或附件。报价正文在网关再次对照 B 冻结字段和受控参数，额外渠道/收件字段被拒绝。PDF 使用 B manifest 的 key/version、字节摘要、名称、类型、大小和 quote 绑定。原内部预览水印保留，不在批准后重新生成或替换。

较重的文件读取在 claim 事务之外；claim 内核对相同 manifest 和当前权限，adapter 使用同一份已核验字节并再次核对 hash。实际文件在预检后被替换的测试证明执行仍用原字节；缺失、损坏或错误绑定则阻止。

批准、事件、业务状态、outbox 和真实 pg-boss send 使用同一事务连接。四个注入点共同回滚，未提交任务不能被消费。命令 UUID 同内容返回原结果，异内容冲突；双击和并发批准不重复业务任务或事件。

## 状态、锁与恢复

审批 SQL 状态仅 pending/approved/rejected/revoked/expired/invalidated，事件只追加；expires_at 不可延长复活。默认 24 小时，与 B 报价及其更早依赖期限取最早值。到期/失效记录结束后再申请新记录，保留历史。quote_versions.validated 始终只表示报价校验。

工作区 advisory lock 在成员建立上下文前取得；现有成员/工厂权限、指定 owner、需求、资料、接管、原始入站与 claim 都加入此协议，再取得账号与业务行锁。短 claim 复核当前身份、权限、simulation 账号、真实目标、资格/抑制、上下文、B 依据/报价、摘要、附件、审批及入站屏障。到期检查用锁后的数据库时钟，不依赖主机时钟或等待前的事务 now()。

pg-boss fetch、业务 claimed commit、渠道接受是三个不同事实。claimed commit 为撤销截止。首次 claim 固定执行版本、token、能力与保证期；调用前再核对 token 和当前约束，网络在事务外。最后检查与调用之间仍有窗口，未声称 token 能撤回在途调用。

正常同 attempt 的重复任务不抢 90 秒内的 claim；真正 pg-boss retry 从持久 retry_count 识别，立即 fence/核对，不能把 lease 当新业务授权。非幂等模式没有自动第二次发送；幂等恢复必须原内容、原 key、原保证期并重新校验。旧 worker 失效后停止新调用；已接受的迟到事实另行追加证据并核对，不能覆盖状态或被撤权/撤销丢弃。

## 独立 Mock 的事实

Mock 不读取 app 审批或 dispatch 状态帮网关兜底。独立角色和连接分别持久化 invocation、acceptance、完成调用结论与 callback。调用数从 invocations，副作用数从 acceptances 统计。normal、reject、delay、重复/乱序 callback、接受后丢响应、有/无幂等均有实际路径。非幂等同 key 调两次会产生两次接收；幂等同内容复用、异内容冲突。回调/核对仍只投影同一 request，消息唯一且不倒退；模拟不进入真实 delivered/read。

## 实际验证与证据

| 范围                                 | 命令与证据                                                                                             | 结果                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| C PG/审批/文件/队列/并发/强杀        | `./scripts/zu test:c`；integration-final-verified.txt、integration.json                                | 23 组通过，退出 0                                 |
| 规范化、B 计算/PDF/存储              | `./scripts/zu test:unit`；unit-final-verified.txt                                                      | 25 项通过，退出 0                                 |
| B 当前供给/报价/文件/权限            | `EVIDENCE_DIR=docs/build/evidence/c/b ./scripts/zu test:b`；b-regression-final.txt、b/integration.json | 14 组通过，退出 0                                 |
| A1 身份/RLS/事务/官方队列            | `./scripts/zu test:integration`；a1-regression.txt、a1-regression.json                                 | 23 组通过，退出 0                                 |
| A2 核心/SSE/网关                     | `./scripts/zu test:a2`；a2-regression-recovery.txt、a2-regression.json                                 | 19 组通过，退出 0                                 |
| 原始入站/system 作用域               | `./scripts/zu test:a2:inbound`；inbound-regression.txt                                                 | 11 组通过，退出 0                                 |
| C Chrome 桌面/手机                   | `./scripts/zu test:c:browser`；browser/ 与 browser-final-verified.txt                                  | 2 项通过，退出 0                                  |
| A1/A2/健康 Chrome 回归               | `./scripts/zu test:e2e a1.spec.ts a2.spec.ts bootstrap.spec.ts`                                        | 8 项通过，退出 0；browser-regression-verified.txt |
| 构建、strict 类型、lint/边界、doctor | evidence/c 中对应日志                                                                                  | 全部通过，退出 0                                  |

每个必需强杀均在专用子进程 IPC 同步点实际 SIGKILL，保存 PID、同步点时间、signal、原 job、恢复 PID、fetch retry_count=1、payload/key/attempt 与独立账本计数。使用官方 fail 保留原 job 进入真实 retry，再由恢复进程实际 fetch；不是 mock boss，不是抛异常冒充退出，也没有缩短业务时钟。

| 能力 / 终止点                       | 终止前调用/接受 | 恢复后调用/接受 | 同一业务请求结果            |
| ----------------------------------- | --------------- | --------------- | --------------------------- |
| 非幂等 / claim 已提交、调用前       | 0 / 0           | 0 / 0           | unknown，未盲目重发         |
| 非幂等 / 接受已独立提交、app 写回前 | 1 / 1           | 1 / 1           | 查账核对为 simulated        |
| 幂等 / claim 已提交、调用前         | 0 / 0           | 1 / 1           | 原 key/内容恢复为 simulated |
| 幂等 / 接受已独立提交、app 写回前   | 1 / 1           | 1 / 1           | 查账核对为 simulated        |

其他实际门槛：一个专用 worker 从真实 pg-boss fetch，另一个专用 worker 重放同一持久 job 身份以构造重复领域处理；两进程同时进入 claim 同步点，只有一个业务 claim 和一次调用。没有声称二者同时持有同一 pg-boss lease；撤销/接管使用 beforeClaim、afterClaim、afterFinalCheck 同步点；旧 worker 在 token 失效后不再调用；越过最后检查后的接收保留事实；保证期过后无调用；四点回滚；原始 pending/retry/dead 屏障；撤权锁竞争；联系人改址；旧版本任务；PDF 缺失/替换/hash/归属与预检后改盘；篡改不可变身份；嵌套额外地址；复制线程不能绕 unknown；owner 自备报价仍 pending；human 模式下新获批人工报价完成；混合工厂与下载拒绝；重复/乱序回执无重复消息或真实状态升级。

process-persistence.json 在新独立进程重新读取审批、payload、attempt、Mock 账本的完整摘要与 PDF，一致；四次强杀另证明跨 worker 重启保留。保留卷/PostgreSQL stop/start 沿用 B 已通过证据，本次未为复验中断用户 PostgreSQL。C 不宣称验证断电或灾备恢复。

## 真实失败与恢复

- 首次当前时间 fixture 早于 Colima 的数据库时钟，价阶被正确阻止；测试改用真实 DB 时刻，业务到期复核也统一到锁后 DB clock。
- 新 request SQL 的 UUID/text 参数推断、worker quote 行锁权限、PL/pgSQL reason 同名歧义分别实际失败。通过明确 cast、单列行锁权限和后续增量迁移修复；不修改已执行迁移、RLS 或冻结保护。
- 调整恢复后，旧 A2 合成 claim 测试还把正常活跃 claim 当过期。改为独立线程、明确过期的合成 fixture，仍标注不是 crash 证据；C 的真正 crash 单独验证。
- strict 检查发现工具测试缺少 root workspace 类型依赖，补充 contracts/channels 的公开导出依赖；未从 shared 包内部 dist 导入。
- 首轮浏览器分页等待与 PDF response body 的自动化读取不准确。改为等待列表真实增长，并从实际打开的 blob 读取确切字节核对；没有用另一份临时 PDF 冒充预览。
- 浏览器实测发现上一项异步结果可能覆盖新选择，及两个待办子组件用了相同 React key。分别修复选择归属检查与唯一 key；临时诊断代码已移除。过期样例显式建立独立历史 target，行状态只取当前 payload 审批。
- 两套 Playwright 初次并行共用产物目录，发生 ENOENT。现 C 产物/报告独立置于 .local，重新验证；应用状态没有因此伪造成功。
- 既有阶段脚本首次回归仍写默认同名证据，覆盖了部分 integration/PDF 输出。新回归结果已复制到 C；增加 EVIDENCE_DIR/EVIDENCE_PATH 供后续分开保存，原阶段其他日志/截图和业务历史仍保留。报告不把这次回归输出冒充原 B 验收产物。
- 最终交接探针曾发现日常端口未运行；按已有 start 正常恢复并重新验证，保留原库和全部历史，没有据此重建账号。
- 恢复协议去掉测试 claim 期限覆盖后，一处保证期测试尚用旧参数，真实失败已保留；改为官方 retry/fetch，与其他强杀相同。不再以测试参数授予新发送权。

各次失败日志和保留测试库清单在 evidence/c；没有模糊删除库、清卷、reset、schema push 或伪造通过。

## 启动、复验与限制

日常已有服务：5173 / 3001 / 3002，Colima zutrade、PostgreSQL 18.6:55432 与原卷。升级入口：`./scripts/zu db:configure`、`./scripts/zu db:provision`、`./scripts/zu db:migrate`、`./scripts/zu build`；不重建账号或 seed。停止后的常规启动为 `colima start --profile zutrade`、`./scripts/zu infra:up`、`./scripts/zu dev`。

`test:c` 生成隔离库与专用 worker，并保留库、私有对象及私有 session；`test:c:browser` 在其独立 API 3401 / worker 3402 / web 5273 上建立追加的 C-UI 样例，结束时停止测试服务。`./scripts/zu ui:c` 只重开现有样例，不重新初始化；手工账号通过 `./scripts/zu db:accounts` 所示本机私有文件取得。不得把随机密码复制到报告。

pg-boss 沿用显式官方维护：`./scripts/zu db:queue-maintain`。用户可在待办主动核对在途/unknown，无需等待 lease；没有新建租约或 outbox 发布器。历史对象不自动回收。列表目前为每会话/待办最近 60 个请求，单请求的完整版本、审批和执行历史可展开；未建设大规模归档检索。

仅本机 Chrome 桌面 1440×1000 与手机视口 390×844；不是实体手机、其他浏览器或第二设备验证。过期 UI 样例通过新建历史有效期 fixture 初始化，不声称等待了完整 24 小时；服务/SQL 的不可延长和真实到期判断另有数据库行为证据。无真实消息、模型、业务发现、D1/D2/E 生产者、订单或资金流程。关键门槛若最终复验未过，不进入 ready_for_user_review。

人工 5 步见 ACCEPTANCE.md。完成后停止在 C，D1 仍 not_started；不提交或推送 Git。

D1 启动续记（2026-10-29）：用户明确启动下一阶段 D1，按阶段规则将 C 记 accepted。依据仅为该明确授权；上文 ready_for_user_review 是 C 交付时状态，不声称新增了人工验收操作。开发接受没有批准 Alex 或任何产品内商业动作。
