# ADR 0008：完整外发快照与审批身份

日期：2026-10-29（Asia/Shanghai）。阶段 C，采用。

## 三种摘要

沿用 B 的 `b-quote-v1` 和原 `canonicalSnapshotHash`，不重新编码或改写历史商业报价摘要。PDF manifest 的 `pdf_sha256` 始终表示实际已保存文件字节。新增 `c-outbound-v1` 的 `snapshot_sha256` 表示完整最终外发内容；approvals 的复合外键引用这一摘要与具体 payload，而不是另外两种摘要。

C 快照包含完整账号身份、唯一主收件人的 contact point / buyer / contact / namespace / 实际目标、主题、正文、HTML（本版明确 null）、语言、模板版本与真实参数、quote version 与 B 摘要、附件 manifest、会话/需求 revision、规则版本，以及 thread / factory / opportunity / intent / authorization mode 的关联。生命周期、token、重试次数和任务身份不进入商业摘要。

## c-outbound-v1 规范化

- 字符串统一 NFC，CRLF 或 CR 转 LF；规范化结果本身保存、预览和执行，不只在 hash 时临时变换。
- 对象键按 UTF-16 code unit 排序，禁止规范化后重复键。序列化为无额外空白 JSON，再用 UTF-8 SHA256。
- 所有协议可空字段明确保存 null；缺失字段与 null 不等价。undefined、非 JSON 对象、NaN、Infinity、BigInt 均拒绝。
- 数字仅允许安全整数元数据。金额、数量和修订号采用服务端确定的十进制字符串；保留 B 已冻结的金额表示，不把 `2.40` 私改成 `2.4`。
- 数组有序。MVP 仅一个主收件人；额外 to / Cc / Bcc / channel_payload 字段不被 HTTP 契约接纳。网关再次比较完整白名单，不能通过隐藏地址扩大发送目标。
- A2 已存在的 policy 1 中性模板继续按原摘要协议核验，不改写历史；其正文、模板参数、收件人与账号均有精确白名单校验。内部草稿保持 member_send 身份，提交自由文本时创建新的 human_approval 请求。

## 身份与版本

请求的 contact point、账号、thread、factory、opportunity、intent、authorization mode、命令摘要、provider key 与创建成员不可变。换身份必须新请求。尚未 claimed 且无 attempt 的同身份请求可追加不可变 payload 版本：结束旧 live 审批，保留旧正文、附件及事件，再创建新审批。旧 job 保存 payloadId；不得改送 current pointer 后来的版本。旧任务的文件错误也不能把新版本误标 blocked。

claimed、已有 attempt 或 unknown 后不能替换同一 provider key 的内容。同一会话有在途或 unknown 时，新的自由文本、报价和 A2 模板请求均被阻止，不能用新 request ID 绕过重复风险。

## PDF 与商业字段

报价正文由 B 冻结快照白名单和受控开场生成，网关会再次对照，金额与条款不接受客户端自由覆盖。自由文本不声称完成语义安全判断，由指定 owner 审阅。内部笔记、成本、来源原文和其他工厂资料不进入生成正文。

附件引用 B 的 ready manifest：artifact ID、quote version、B 摘要、object key/version、PDF sha256、文件名、MIME 和字节数。保存/批准时调用 B 的报价访问及当前可用性接口，读取已保存字节，不重新渲染。PDF 原有内部预览水印保持不变；正文和预览解释审批授权的是这一份确切产物。商业报价状态仍为 validated，不写 approved/sent。

worker 在短 claim 事务外按 manifest 读取和核验文件；claim 内重新比较同一 manifest、归属、摘要及当前权限。adapter 使用预检得到的同一份内存字节并再核对其 sha256，不从可变路径重新读取。文件缺失、损坏、替换或归属错误均阻止审批/发送。附件内容被预检后替换的实际测试证明执行仍使用原已核验字节。

## 命令与审批

新增 append-only `app.command_receipts`，按 workspace + UUID 保存成员、命令类型、规范化输入摘要和结果。创建、修改、决策与核对分别使用命令；同键同内容返回原结果，异内容 409。访问权限仍先重新校验。

审批仅当前 active owner 且等于 workspace.approver_member_id 才可决策。页面命令必须带已查看的 payload ID、完整摘要和 approval.row_version；不会把旧页面点击绑定到新版本。前端轮询保留已查看版本，出现冲突后明确重新查看。

审批有效期默认数据库当前时刻加 24 小时，并与 B 报价的固定有效期取最早值（B 已受所有依据及代理期限约束）。expires_at 原有不可变保护保留，不允许延长复活；过期/失效记录结束后才能建立新记录。历史事件按审批锁和递增序号追加，禁止改删。
