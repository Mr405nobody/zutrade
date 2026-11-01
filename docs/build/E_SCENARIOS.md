# E 场景目录与支持边界

版本 `ct01.v1`，输出 `e-output.v1`，固定业务时钟 `2026-10-29T00:00:00.000Z`。使用最新已标准化的买家消息；忽略大小写、首尾及连续空白，其他表达不做推测。所有公司、工厂、渠道和 AI 均按界面所示为模拟；这些场景不替代 D1/D2 真实来源验收。

| 消息                                           | 建议类型            | 结果与后续                                                     |
| ---------------------------------------------- | ------------------- | -------------------------------------------------------------- |
| What material is CT-01 made of?                | 普通问答            | 引用材质事实；满足当前审核政策才可自动模拟 FAQ                 |
| What are the dimensions of CT-01?              | 普通问答            | 引用尺寸事实；同上                                             |
| Please quote 500 CT-01 bags.                   | 需求提取 / 报价输入 | 建议数量 500；采用保存需求，再走正常报价计算/PDF/审批          |
| Change the quantity to 800 CT-01 bags.         | 需求提取 / 报价输入 | 建议数量 800；保存新需求，旧报价显示重核                       |
| Can you give a discount?                       | 任意                | needs_human；须正常报价及指定 owner 审批                       |
| Can you guarantee arrival within six weeks?    | 任意                | needs_human；工厂/owner 确认，不生成到货保证                   |
| How much does a sample cost?                   | 任意                | needs_human；未知样品费不变成零                                |
| Please find confirmed CT-01 product documents. | 资料检索请求        | 内部待确认请求；采用建人工任务，不调用网络、不发布事实         |
| Please suggest a follow-up for CT-01.          | 跟进建议            | 固定时钟 +1 天仅作建议；采用必须选择实际未来时间，建立人工提醒 |
| 其他消息或其他 SKU                             | 任意                | unsupported / needs_human，无编造答案                          |
| 要求忽略权限或绕审批的消息                     | 任意                | injection / needs_human，无工具调用                            |

有效资料缺失、过期、撤回、内部披露、来源换版时不作为回答依据；冲突资料保留具体证据并转人工。材质/尺寸须在已审核允许值内。适用场景选错类型也会转人工。人工接管/暂停时停止自动路径。

“采用”是业务建议处理，不是报价批准。FAQ 建议采用后仅存内部草稿；自动 FAQ 需在生成前明确勾选，且通过所有网关门槛。拒绝/修改会阻挡尚未领取的旧 FAQ，不能承诺撤回已领取或在途执行。新消息、需求、事实、模板或权限变化后旧结果保留但失效；不可用结果不能继续采用。

评估仅检查预设规则的确定性、契约、真实领域行为与失败恢复；没有真实模型准确率、token、模型费用或泛化能力结论。实现入口：packages/contracts/src/ai.ts、packages/ai/src/index.ts、packages/domain/src/ai.ts；未来适配说明见 ADR 0013。
