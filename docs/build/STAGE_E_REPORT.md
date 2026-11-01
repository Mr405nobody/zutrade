# 阶段 E：可重复的模拟 AI

2026-10-29（Asia/Shanghai），状态 **ready_for_user_review**。仅实施 E，没有进入 V 或标记 accepted。用户本次明确调整阶段顺序：D1/D2 的真实 DNS、真实研究与真实来源到批次链留待服务器网络可用后补验；两阶段继续 verification_blocked，不以离线公司代替联网验收。不部署、不调整代理、不关闭 SSRF。

## 已交付

- contracts 定义 AIProvider 输入上下文与 strict Zod 输出契约；ai 包实现 ct01.v1 场景目录、固定业务时钟、NFC/空白归一与可重放 MockAIProvider。五类建议包含需求提取、内部资料请求、问答、报价输入和人工跟进。完整固定表达和边界见 [E_SCENARIOS.md](E_SCENARIOS.md)。未知输入、绕审批指令、无有效资料、冲突和接管明确转人工，不伪装通用理解或网页研究。
- 领域按 workspace、完整会话工厂集合、关联商机及产品权限构建上下文，仅提供当前已确认且 buyer_visible 的有效规格与证据，不提供成本、来源任意 JSON、内部事实或其他工厂资料。运行保存 provider/model、preset、场景/契约版本、固定时钟、入站引用、上下文游标/摘要、证据、输出、校验、真实耗时和原因；token保持null，费用不适用。输出校验失败保留最多32KiB实际响应于校验记录，provider抛异常时没有伪造输出。
- 新 e.ai 任务复用真实 PostgreSQL/pg-boss/outbox。创建和入队同事务；provider 在事务外运行，只能获得数据与可选取消信号，无数据库、批准、发送、工具或网络能力。持久 event/job 校验任务身份，前后重核当前权限；取消、失权和迟到完成不覆盖终态。
- 消息内部工作区显示“模拟 AI”、场景、版本、来源、建议、校验与网关结果。采用数量建议调用正常需求服务；修改保存独立内部草稿；资料请求和跟进采用调用 D2 人工跟进服务。跟进需明确未来时间和 IANA 时区；固定场景日期不自动排程。拒绝/修改阻挡尚未领取的旧 FAQ。
- 当前指定 owner 可审核/停用固定 FAQ 模板及允许值；材质仅12oz / 12oz cotton / 12oz cotton canvas，尺寸仅35×40cm。仅符合有效事实、披露、模板审核、未接管、未暂停、当前上下文及入站屏障等条件时，由领域创建 verified_faq_policy 请求和完整冻结快照，再经原统一网关模拟执行。同一消息/模板版本重放复用同一请求。网关在claim及调用前重查，不依赖取消队列作为唯一防线。
- 500/800建议仅填需求；1230/1950金额由原计算器实际生成。报价/PDF/最终正文继续经原 owner 审批；sales不能批准。折扣、六周到货保证和样品费明确转确认/审批，未知费用不变成零。已有冻结正文、报价、附件均未由建议编辑覆盖。

## 实际验证

精确命令、退出码和文件在 [verification-summary.json](evidence/e/verification-summary.json)。最终结果：

| 验证                                                  | 结果                                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `./scripts/zu test:e`                                 | 21组，退出0，真实隔离PostgreSQL/pg-boss；integration-verified.txt/json                           |
| `./scripts/zu test:unit`                              | 93项，退出0；unit-verified.txt                                                                   |
| `./scripts/zu test:e:browser`                         | Chrome1440×1000、390×844，两项通过，退出0；browser-verified.txt、browser/                        |
| `./scripts/zu exec node scripts/verify-e-offline.mjs` | macOS子进程禁止所有出站网络，实际连接1.1.1.1:443返回EPERM；两次preset输出与数据库预期一致；退出0 |
| B / C / D2 回归                                       | 14 / 23 / 21组，退出0；独立库，D2原UI私有指针恢复保留                                            |
| build / strict / lint与包边界 / 重复迁移 / doctor     | 最终退出码见verification-summary.json；Vite仍有大于500kB单包提示，未声明性能验收                 |

21组覆盖：缺资料转人工及真实任务采用；相同输入/时钟/场景与证据一致；跨工作区、工厂、完整混合会话和直接RLS；严格输入与命令去重；未审核FAQ阻挡及sales无审核权；材质/尺寸真实网关模拟完成；并行完成、重复任务与同消息FAQ身份；500/800正常计算/PDF/指定owner审批及旧版本重核；折扣/到货/样品/未知/外部指令转人工；真实失败输出校验、生成前与生成中取消；生成中实际新入站使结果失效；接管前及claim后最后校验停止；未处理原始收据屏障；拒绝/修改与冻结保护；停用模板；人工跟进明确未来时间；内部、实际过期、撤回与冲突事实；当前权限撤销与伪造job拒绝；终态/输入冻结；入队失败共同回滚；禁用fetch仍可运行；真实worker停止、持久排队、重启完成同一AI任务。

浏览器实际操作生成、重复问答、查看来源、修改内部草稿、拒绝、自动FAQ经网关完成、模拟新买家消息、六周到货转人工、旧建议失效、刷新和owner→sales重新登录；sales无模板审核按钮。所有非本机浏览器网络被阻断，两视口无横向溢出、无pageerror。截图已实查。只代表本机手机视口，不代表实体设备。

## 真实失败与恢复

保留first—sixth、final/verified等原日志及精确失败库，没有把失败覆盖成成功：

- 首次strict构建发现需求对象重复字段，改为明确白名单覆盖。采用500件时，A2 intake已有source/simulation元数据不属于B需求契约，原样spread被Zod拒绝；改为仅保留B已知字段，再调用正常保存服务。
- 初次隔离入站测试错误传了userId，strict任务契约拒绝；按真实入站任务数据修复。报价测试把prepareOutbound参数顺序写反，及来源撤回误传document ID，均正确失败；分别改为真实服务签名和source version ID。
- FAQ第一次通过自身校验后仍被C的人工外发通道字段检查拒绝；补FAQ独立完整白名单校验分支，保留人工协议校验，再实际通过统一网关。没有放宽收件人、审批、事实或SSRF门槛。
- OS断网首次在尚未生成私有输入文件时失败；生成真实数据库输入/输出文件后，沙箱连接EPERM且重放一致。
- 首轮浏览器文本同时匹配code和textarea；随后getByLabel定位超时，手机同路径显式中断并记130；改用实际textbox/combobox可访问名称。手机误以全局第一个正文定位到不可见聊天项，改为当前内部建议。重登后仍在设置页，补实际返回消息动作。新收据尚未标准化时过早断言导致场景不符，改等最新实际入站ID及正文出现；最终两视口完整通过。没有用延时fixture替代入站。
- 最后服务抽查发现日常5173原进程未运行，首次连接ECONNREFUSED如实保留services-first.txt；执行既有`./scripts/zu start`恢复原库API/web/worker，未seed/reset，最终日常与E服务健康均200/ready，Alex审计仍pending。
- 初次lint含未用测试import，后续文档格式检查失败；分别移除和格式化后重验。一次编辑脚本定位字符串失败，没有修改迁移或清库，恢复后补上并行/claim后测试。

## 迁移、数据与限制

只追加0019_mock_ai，给原ai_runs增加命令/成员/场景/时钟/耗时/自动FAQ/独立决策列、完整会话/工厂RLS、最小运行权限、精确任务入口和结果冻结；注册e.ai队列。没有新增app表，实际app45、simulation4、映射662列/159FK（115复合）/200CHECK。日常重复迁移成功；旧0000—0018迁移身份与原始SQL 75,172字节/SHA256保持。MIGRATIONS.md和catalog-mapping.json有记录。

日常只应用schema，没有E样例业务写入；daily-preservation.json及final-audit.json验证Alex仍v17/500/1230.00USD、原PDF字节/冻结快照/pending审批。日常AI运行、批次、跟进和真实研究lead均未新建。没有自动提交、推送、seed、schema push、reset、删库/删卷、部署、真实触达或真实模型。测试库按精确名称保留；私有trace和账号不进入构建报告。

支持有限固定英文表达和CT-01，固定业务时钟日期不能用于真实交期承诺。FAQ的claimed提交后不承诺撤回，在途/unknown仍走C核对协议。真实模型接口只保留未来接入边界，不加载密钥或SDK，不提供模型准确率。D1/D2真实DNS、两次研究、三家来源抽查、确认/重复导入及真实来源到批次链仍未验证；未部署服务器或调整网络。本次通过不代表这条完整真实链已通过。

服务：E [5573](http://127.0.0.1:5573/)，停止后`./scripts/zu ui:e`，账号`./scripts/zu db:accounts`仅输出本机私有文件路径。5步人工验收见ACCEPTANCE.md。E自测通过仅ready_for_user_review；用户尚未验收，停在E，不进入V。

## 2026-10-30 用户验收更新

用户明确声明“我已验收通过阶段 E”。V 开工核对 verification-summary、21 组 PG/93 单元/两视口与断网证据、0019 迁移及实际代码，未发现 E 自身未解决的关键门槛，现记 **accepted**。上述 ready_for_user_review 与“未进入 V”是原交付时状态；D1/D2 真实来源链仍 verification_blocked。开发验收不代替产品内 owner 业务审批。
