# 当前建设范围

用户已明确验收 0、A1、A2、B，本次只授权 C：审批与完整发送协议。C 已完成自测并交付 ready_for_user_review，尚未得到用户验收。D1/D2/E/V 均未启动。

当前在已有本地工程、账号、业务历史和持久卷上增加：完整最终外发快照、指定 owner 审批、事务入队、短事务 claim、token/撤销截止、独立持久 Mock、unknown 核对和真实并发/强杀验证。报价和文件沿用 B；A2 中性模板仍走统一网关，自由文本进入单独人工审批。

仅 simulation 消息，没有真实发送、真实模型或企业发现执行。FAQ、批次、跟进只保留类型与拒绝未启用生产者的领域边界，不显示已完成。原始 SQL 不改写，不 schema push、reset 或删卷。

具体实现、验证、限制和人工验收分别见 STAGE_C_REPORT.md、evidence/c、HANDOFF.md 和 ACCEPTANCE.md。用户的开发验收不等于任何报价的产品内 owner 批准。
