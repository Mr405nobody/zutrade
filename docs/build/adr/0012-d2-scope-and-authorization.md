# ADR 0012：D2 提前实施与统一发送授权

2026-10-29（Asia/Shanghai）。用户在前置检查停止后明确指示“现在直接做d2的步骤 dns等部署服务器后再进行测试”。这条最新授权变更阶段顺序：D1 仍 verification_blocked，不记 accepted；本次实施 D2，但真实 DNS/研究来源到批次的正向验收延期到服务器网络条件满足后。没有授权上传、部署或修改 Clash。离线 fixture 只用于隔离验证，不能作为真实来源链。

D2 复用基线批次/版本/items、approvals、followups、C 的冻结内容、command_receipts、outbox 与统一 dispatch。批次版本审批绑定逐项完整 payload 摘要和实际名单/节奏/截止；每个 item 通过 batch_approval 追溯唯一批准。自动跟进使用明确 automatic_followup 来源和 human_approval，默认 manual 只产生提醒及内部草稿。人工接管阻挡自动跟进及接管前旧计划，仍允许有权成员新发起获批的人工动作。paused 另设会话 outbound_paused，阻止全部新外发。

模拟身份单独创建，source_evidence 标内部演示、关联原 lead；不创建真实采购人员或邮箱，不更改真实渠道权限。批次草稿可编辑，提交后生成新不可变版本、逐项请求和 pending 审批；所有实质修改均重新冻结和审批。

pg-boss startAfter 负责唤醒，数据库 due/version/权限与 account/batch next_claim_at 在 claim 事务中落实节奏。早到或竞争任务以同一业务 request/payload/provider key 延期，不能从队列领取获得发送权。取消是数据库业务状态，队列取消不是安全依据。claimed commit、unknown、独立 Mock 账本和恢复协议沿用 C。

跟进计划修改推进 business_version，完整计划版本写入追加 audit；旧 job 携带原版本不能执行新内容。UTC 与 IANA 时区分别保存；DST 重叠要求显式 earlier/later，不存在时间拒绝。D2 最终状态取实际验证；延期的真实链不能写成已验证。

实际增量为0015—0018，均保留首次应用后的字节。指定 owner 的模拟线程初始化仅限尚无商机关联的窗口，之后恢复完整关联授权。节奏既检查 claim 时间，也在精确 C result token 下按实际结果写回推进账号与批次 next_claim_at；同账号 unknown 要求核对。跟进真实网关状态投影与执行历史由受限触发器追加，不把 queued 当完成。

B兼容修复：新报价默认取数据库时钟，避免本机与Colima时钟差；收件快照取normalized_value，展示名独立保留。历史冻结报价与PDF不改写，金额计算与B规范化协议保持。D2内部模拟联系人明确标为非真实个人，并与原公司线索关联，不设置verified_at。
