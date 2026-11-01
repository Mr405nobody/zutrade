# ZuTrade Codex 建设交接包

本包用于让 Codex 从零建设 ZuTrade 本地完整首版。你每次只启动一个阶段，验收后再启动下一阶段。任务范围确认于 2026 年 10 月 28 日。

## 你已经确定的范围

- Mac 开发环境，可以使用 Docker；本轮不部署线上环境。
- 你与 1—4 名成员替工厂销售；工厂作为签约、收款和履约主体。
- 微信式桌面工作台，四个入口：消息、找客户、产品、待办。手机支持紧急查看、接管和审批。
- 买家收发使用 MockAdapter，AI 使用可重复的 MockAIProvider。
- 找客户必须真实读取公开网站或搜索 API，并保存来源。模拟 AI 不承担任意网页的通用语义理解。
- 业务闭环做到可信报价、owner 审批、模拟外发与明确跟进。本轮不接正式消息渠道、真实大模型、订单、收款、物流和佣金结算。

## 怎样开始

1. 在 Mac 上新建一个项目目录，例如 ZuTrade。
2. 将本压缩包解压后得到的 zutrade-build-kit 文件夹放进这个项目目录。
3. 在 Codex 中打开项目目录 ZuTrade。后续 apps、packages、infra 等工程目录建在 ZuTrade 根目录，交接资料保留在 zutrade-build-kit 中。
4. 将下面这段开工提示词发给 Codex。

```text
请以当前打开目录作为 ZuTrade 项目根目录。
先阅读 zutrade-build-kit/MASTER_PROMPT.md、zutrade-build-kit/specs/CONFIRMED_SCOPE.md、zutrade-build-kit/specs/DATABASE_NOTES.md，以及 zutrade-build-kit/stages/00-bootstrap.md。
按照其中的约束执行阶段 0。需要查阅的其他文件都在 zutrade-build-kit 中，请直接读取，不要假设你能打开我在 ChatGPT 中的私有页面。
本次只授权完成阶段 0。请真正建立并运行工程骨架，完成本阶段验证、交付启动方式和人工验收步骤，再停在 ready_for_user_review 等待我验收。
本轮不执行 A1 或后续阶段，不接真实 AI、不发送真实消息、不部署线上环境。
```

如果 Codex 打开的目录中已经有代码，先让它检查现有状态和根目录位置，再继续；不需要为了使用本包删除原目录。

## 每次启动下一阶段

前一阶段验收通过后，发送：

```text
我已验收通过阶段 0。现在只执行阶段 A1。
请重新读取 zutrade-build-kit/MASTER_PROMPT.md、zutrade-build-kit/stages/A1-identity-database.md，以及仓库 docs/build 下的 PROGRESS、HANDOFF 和上一阶段验收报告。
先核对现有代码、迁移记录和 Git 状态，再继续建设。完成 A1 后给出实际验证结果和人工验收步骤，停在 ready_for_user_review，不进入 A2。
```

之后将阶段 ID 和阶段文件名替换为对应项。换会话时使用 prompts/RESUME.md；验收发现问题时使用 prompts/FIX_CURRENT_STAGE.md。

## 阶段清单

| 阶段 | 文件 | 你应能看到的成果 |
| --- | --- | --- |
| 0 | stages/00-bootstrap.md | 可启动的 web、API、worker 和 PostgreSQL 健康探针 |
| A1 | stages/A1-identity-database.md | 真实登录、42 表业务数据库、成员与工厂权限 |
| A2 | stages/A2-inbox.md | 持久化消息工作台、模拟收发、内部备注和基础网关 |
| B | stages/B-supply-quoting.md | 可信供给、需求、金额计算、报价版本与 PDF |
| C | stages/C-approval-dispatch.md | 精确审批、完整发送网关、幂等和未知结果核对 |
| D1 | stages/D1-live-prospecting.md | 真实发现海外企业、来源证据、可复查线索 |
| D2 | stages/D2-outreach-followup.md | 逐人批次审核、模拟执行、跟进与停止条件 |
| E | stages/E-mock-ai.md | 可重放的模拟 AI、受控 FAQ、内部建议与转人工 |
| V | stages/V-local-acceptance.md | 本地完整闭环、并发恢复验证与交付手册 |

原架构中的 F 是正式渠道试点，本轮明确不执行。V 是本地最终验收，不能把 V 的完成记成 F 的完成。

## 文件用途

- MASTER_PROMPT.md：每个阶段都必须遵守的工程总控要求。
- stages：可以单独发给 Codex 的九份阶段提示词。
- specs：范围、真实获客、数据库实施、验收矩阵与界面说明。
- references：上一轮技术架构、产品设计、原始 SQL、已认可的 UI 效果图及旧交互原型。
- templates：Codex 在项目中建立进度和报告文件时使用的模板。
- prompts：开工、下一阶段、修复与换会话的短指令。
- PROMPTS_ALL_IN_ONE.md：便于全文阅读、检索或一次上传的合并版。每次仍只执行当前授权阶段。

## 真实网络能力如何验收

找客户有两条真实路径：公开企业目录发现，以及配置搜索 API 后的关键词发现。必须至少完成一条真实联网发现闭环。若没有搜索 API 凭据，公开目录模式仍需真实从目录链接发现企业，不能只读取事先手写的公司名单来冒充发现。

关键词搜索 API 若尚未配置，界面及验收报告标明不可用，不自动替换为演示结果。两条真实来源都被环境阻塞时，D1 停在 verification_blocked，等待所需网络或来源条件；不能用离线测试通过代替真实联网验收。

本包是建设提示词和输入资料，尚未创建实际应用。原始 SQL 的既有约束验证不等于新工程的集成、并发或浏览器验收已经完成。
