D1 启动记录（2026-10-29）：用户明确授权启动下一阶段，故 C accepted。未编造人工验收操作，未批准 Alex 或任何产品内商业动作。以下 C 交付内容为历史记录；D1 正在实施。

# ZuTrade C 交接

更新时间：2026-10-29（Asia/Shanghai）。B 已由用户明确验收；本次仅 C，状态 **ready_for_user_review**，等待用户验收，不进入 D1。原 B 交接保留于 HANDOFF_B.md。

## 直接使用

- 日常工作台：[http://127.0.0.1:5173](http://127.0.0.1:5173)，API/worker 为 3001/3002。
- 独立 C 样例：[http://127.0.0.1:5273](http://127.0.0.1:5273)，API/worker 为 3401/3402。用无痕窗口和独立账号查看，避免混用两套登录会话。
- 账号：运行 `./scripts/zu db:accounts`，只在本机打开所示私有文件。Alex 沿用 `.local/b-accounts.json`，独立样例为 `.local/c-ui-accounts.json`。不重新初始化账号，不把随机密码写入报告。

日常服务停止后：

```sh
colima start --profile zutrade
./scripts/zu infra:up
./scripts/zu dev
```

独立样例停止后：

```sh
./scripts/zu ui:c
```

`ui:c` 只重开已有隔离数据库和样例，不 seed、不覆盖历史。当前服务均保留运行；Ctrl+C 只停止对应应用进程，不删卷。PostgreSQL 18.6 沿用 Colima profile zutrade、55432 和原持久卷。

## Alex 与产品内审批

当前实际有效报价是 **v17 / 500 件 / 1230.00 USD**。不要恢复旧 v1 或依据旧文档假设仍是某个 800 件版本。若之后需求或资料变化，请按 B 正常版本/确认流程生成新有效报价。

`demo:c` 已以 sales 身份提交当前有效报价、最终正文、主收件人和原 PDF 字节；交付保持等待 owner 审批，没有自动批准。账号未指定审批人时，已通过既有 owner 管理命令指定唯一有效 owner，并留下审计。这与商业批准是两件事。

在 Alex → 内部工作区 → 审批与模拟执行打开待审批内容，owner 核对收件人、金额、条款和“查看已保存 PDF”，再点“批准并模拟执行”。owner 自己准备的内容也需要这一步。

未 claimed 内容可用“以当前内容建立新版本并重新审批”；原审批结束但历史保留。已经执行/claimed/unknown 的内容不能在同 key 下换正文；新内容属于新业务请求，未知结果先核对。普通自由文本在对应输入框填写后提交人工审批，不能从 A2 member_send 草稿直接改授权模式。

A2 回归追加的中性模拟消息、备注及接管历史保留；上下文变化后按正常流程追加 payload、重新申请，不改写旧记录。重复 `demo:c` 不覆盖；`demo:c --refresh` 是显式重申未 claimed 当前内容的开发交付命令，不是日常启动项，不会自动批准或复活失效资料。

## 协议边界

- 只有 simulation，没有真实邮件/WhatsApp/模型/业务发现。未来 FAQ/批次/跟进仅类型与 fail-closed 领域边界，没有假生产按钮。
- 请求身份不可变；审批绑定完整 payload ID/hash/row_version。旧页面和旧 job 不能转送新内容。
- B 商业摘要、实际 PDF 字节摘要、C 全外发摘要分别保存。PDF 原水印不在审批后改动，缺失/损坏要恢复原字节，不能换文件冒充。
- 工作区短事务锁串行化撤权、需求/资料、入站与 claim；业务过期用锁后数据库时钟。PDF 读取在 claim 外，adapter 用同一份已核验字节。
- claimed commit 为撤销截止。之后只有取消申请和核对，实际接受事实仍然保留。调用前后都有 token 检查，但承认最后检查/外部调用窗口。
- unknown 空查账不是未发送证明。非幂等不自动再发；幂等恢复必须在原保证内、原内容/原 key、当前授权仍成立。停止尝试可以继续保留 unknown。
- Mock 独立角色/连接与四表账本，调用开始即单独 commit。API/worker 业务角色不能修改账本。

## 数据升级与复验

本机已升级，日常无需再 seed。新检出/已有库升级可运行：

```sh
./scripts/zu db:configure
./scripts/zu db:provision
./scripts/zu db:migrate
./scripts/zu build
```

C 迁移 0006—0012，app 44 表、simulation 4 表、auth 4、pgboss 13；没有 D1 表。原件校验、SQL 冻结触发器、RLS 与受限业务角色保留。

```sh
./scripts/zu test:c
./scripts/zu test:c:browser
./scripts/zu test:unit
EVIDENCE_DIR=docs/build/evidence/c/b ./scripts/zu test:b
EVIDENCE_DIR=docs/build/evidence/c/a2 ./scripts/zu test:a2
./scripts/zu test:a2:inbound
EVIDENCE_PATH=docs/build/evidence/c/a1-regression.json ./scripts/zu test:integration
./scripts/zu typecheck
./scripts/zu lint
./scripts/zu doctor --services
```

`test:c` 创建精确命名的隔离库，实际 SIGKILL 专用 worker；不会强杀日常进程或删除演示历史。成功/失败测试库均保留，清单见 evidence/c/retained-test-databases.json。`test:c:browser` 使用最新 C 隔离库，追加独立 C-UI 样例；重新运行不覆盖旧样例。浏览器测试会停止其自己的临时服务；复验后用 `ui:c` 重开样例。

真实 pg-boss retry 使用原 job 和递增 retry_count，恢复前独立查账/fence。原 `./scripts/zu db:queue-maintain` 继续负责显式官方维护，没有第二套发布器/调度器。生产者尚未启用或无法确认的结果不伪造成功。

## 证据与继续工作

完整报告 STAGE_C_REPORT.md；规范化/PDF/审批见 ADR 0008，锁/撤销/恢复见 ADR 0009，Mock 见 ADR 0010。`integration.json` 含正向关联、PID/IPC/SIGKILL/retry_count、调用/副作用计数及状态；browser/ 有桌面/手机截图。`final-audit.json` 确认 Alex 仍 pending、attempt/渠道调用为零、角色权限和原件摘要。

已验证本机 Chrome 的 1440×1000 与 390×844 视口，未验证实体手机/其他浏览器/灾备。每个列表最近 60 个请求；历史明细按请求展开。既有阶段脚本首轮覆盖部分同名证据的情况、恢复修复和准确范围如实写在报告中。

下一步仅等待用户验收 C。不得自行 accepted、进入 D1、推送 Git、接真实渠道或联系买家。
