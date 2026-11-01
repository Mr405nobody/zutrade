# 阶段 V：本地完整验收与交付

2026-10-30（Asia/Shanghai）。**verification_blocked**：本次授权的独立本地工作已完成，真实联网研究和真实来源到批次/完整演示仍受阻。不写ready_for_user_review或accepted，不进入真实渠道试点。

## 授权与前序核对

读取AGENTS、MASTER_PROMPT、CONFIRMED_SCOPE、V、DATABASE_NOTES、ACCEPTANCE_MATRIX、PROGRESS/HANDOFF/ACCEPTANCE、D1/D2/E报告、迁移及相关ADR。实际检查代码、Git状态、服务、E最终证据和日常只读审计；工程现有全部文件为未跟踪状态，未重新初始化、自动提交或覆盖用户改动。

E原为ready_for_user_review，21组真实PG/队列、93单元、两视口及OS出站禁用和B/C/D2回归最终通过，未发现E自身未解决的关键门槛。依据用户本次“我已验收通过阶段E”记录accepted。D1/D2仍verification_blocked；用户明确授权提前做V本地独立工作，不构成接受真实联网门槛。范围与恢复策略见ADR0014。

## 本次实现与业务链

新增test:v、test:v:recovery、test:v:browser、ui:v及专用审计/恢复后任务验证。使用新zutrade_v_test_库、4101/4102/5673、独立private目录；不覆盖E或日常指针。原始SQL和0000—0019迁移不变，V没有新增schema。

六组真实PG集成通过：

1. 在隔离库以原迁移副本安装0000—0018及认证/官方队列，初始化账号/成员/工厂/产品/来源后运行正常迁移0019；核对原记录和表OID，重复迁移保留。
2. 显式fixture研究→来源审核→身份确认/导入→重复导入同一lead→指定owner建立独立模拟身份。data_origin=offline_fixture，三家均fictional test，未生成已核实个人或真实渠道许可。
3. 同一商机模拟询盘→模拟AI报价建议→sales采用并确认工厂/500件需求→正常确定性计算USD1230→PDF→冻结正文/收件人/附件→sales批准拒绝→指定owner批准→统一delivery网关模拟完成。冻结UPDATE拒绝，内部成本备注未进外发正文，出站消息对应冻结正文。
4. 保存人工跟进、正常改期推进版本、旧事件重放不能执行新版本；注入800件新回复，等实际数据库到期后旧计划cancelled并记录NEW_REPLY_OR_CONTEXT_CHANGED，原1230历史与模拟执行不改写。
5. 消息/产品/研究/待办服务器读取可追溯同一thread、opportunity、lead、来源、AI、报价、审批、请求及跟进。
6. 35会话、91消息跨页读取没有重复；保存查询次数、耗时与实际索引。

实际截图发现权限反馈缺陷：成员资格缺失时selected?.approver_member_id与selected?.id同为空，误显示“指定审批人”；已改为必须存在selected。后端批准并未放行。两视口新增失权无该标记断言，移除顶部遗留“E ·”标签，不扩展业务范围。

## 重启、空库和恢复

最新recovery.json三组通过。先用正常领域命令在V新增一条当前有效的未来人工提醒，停止V写入者，核对45张app表行数和规范化行摘要、3个未来pg-boss任务，再stop/start同一PostgreSQL容器，核对系统标识与volume挂载完全一致。重启web/API/worker后所有摘要仍一致，消息、各成员已读、来源、审批冻结快照、AI历史与计划保留，原登录会话仍200。没有重新seed。

在同一停止写入窗口pg_dump全库并复制私有对象；最新dump630,670字节，包含auth/simulation，材料私有。恢复至zutrade_v_restore_808bb34c73604bbeacc56a69029a5cfd及新private目录，全部app行摘要和未来任务与源一致，报价版本/金额/冻结正文保留，以受限API身份执行授权PDF读取。2个私有对象分别132字节工厂来源和73,726字节PDF，manifest逐文件路径/大小/SHA256一致，原数据未覆盖。具体哈希在recovery.json；私有路径只由.local/v-recovery-last.json本机指示。

恢复后独立负测使用同一持久event/job：到期前保持scheduled；撤销恢复库中的sales权限后变cancelled/ACTOR_NO_LONGER_AUTHORIZED，模拟调用次数仍1→1，原库计划逐字段不变。权限随后恢复，测试取消历史保留。此变更发生在恢复一致性核对之后。

另建zutrade_v_empty_5cf6f4a3c70b4fa780bd761632094125空库执行全部20条业务迁移、auth及官方队列初始化，实际启动API/worker ready，/api/me未登录401。没有以日常清库或volume删除做空库测试。恢复在同一本机PG集群和角色下完成，未声称跨机器/生产恢复；全库与文件复制要求暂停写入，未实现在线零停机备份。

## 浏览器、安全与性能观察

真实Chrome桌面1440×1000与手机视口390×844两项通过，所有非本机浏览器请求阻断。四入口可触达；查看模拟AI历史、旧1230报价、模拟完成、明确离线来源、产品事实/价阶与待办；已授权PDF实取200/%PDF，无权跨工作区/当前撤权403或404，退出后401。显式503失败及重试恢复、实际延迟加载、另工作区空列表、失权UI、SSE建立后撤权permission-lost和旧会话退出后拒绝均实测。两视口无横向溢出/pageerror。截图实际查看，未发现影响本地闭环的其他布局缺陷；不代表实体手机或其他浏览器。

本次只读catalog验证API/worker受限，45张app表全部RLS/FORCE RLS且owner为migrator，迁移hash与原件一致；忽略.env/.local/data，私有文件不在web public，模式仍仅simulation/preset，审计动作保留。日常密码与所有本机账号文件密码扫描不在Git候选/web构建/服务日志中出现。新鲜HTTP下载/SSE/会话验证见browser/；SSRF/DNS重绑定/跳转/私网拒绝及高风险并发复用前序有效证据，12项映射见V_MATRIX.md，未声称本次重新执行所有历史强杀。

样本35会话/91消息/1离线研究3候选/2跟进，恢复准备另加1提醒。scope内单次SQL计数：会话1、消息3、产品5、研究6、待办20、AI31；一次本机观察分别15.28/1.67/4.29/3.38/10.29/14.13ms，排除身份/auth及SQL函数内部语句，不是API延迟或SLA。实际索引及计数见query-observations.json。会话30/消息默认30且硬限100，实际跨页无重复；部分产品/研究/批次/跟进历史只有硬限而非完整分页，todo/AI逐对象重核、SSE可见会话扫描会随规模增长。现有本地团队规模可操作，尚无生产负载结论。前端包>500kB提示保留。

## 实际命令、失败与恢复

精确退出码汇总在evidence/v/verification-summary.json。最终build、strict typecheck、lint/包边界、93单元、test:v六组、test:v:recovery三组、restore-guard、安全审计和两视口浏览器通过。doctor与日常只读审计确认原Alex仍v17/500/USD1230、原PDF和pending审批；没有日常业务批准或新增研究lead/批次/AI/跟进。数据库原卷保留。

保留首次真实失败，不覆盖成成功：

- 初始eslint发现验收脚本未用import、重复import与未用轮询助手，修正后通过。该初始输出由工具记录，后续eslint-scripts.txt为通过结果。
- integration-first未先fetch研究job，被D1正确拒绝；second断言误取results_snapshot.origin，实际为data_origin。修正验收脚本，不放宽领域入口。
- third在未来任务到期前期望停止，实际scheduled正确；改为等待真实DB时钟到期。fourth误用stopped状态，实际cancelled并有停止原因；fifth六组通过。失败精确库及日志保留。
- browser-first桌面在会话列表尚未加载时检查“加载更多”并提前退出查找，最终超时；同轮手机通过。显式等待首条会话后browser-second两视口通过。截图又发现空成员审批人标记，修复实际UI后browser-third两项通过。含登录操作trace留ignored test-results，不复制入报告。
- restore-guard-first假设分页新回复之前创建的旧计划仍scheduled，实际在源库已正确cancelled；没有恢复旧取消计划。另用正常命令新增当前提醒，重新独立备份恢复后guard-second通过；先前成功备份保留在私有恢复目录，首次/二次恢复库名另有recovery-runs.json。
- Vite启动早于API时私有日志有短暂ECONNREFUSED，readiness等待后恢复；没有伪造健康成功或重置库。

没有运行真实研究、调代理、关闭SSRF、购买/部署、真实AI/消息、schema push、reset、删日常库/卷、自动提交或推送。只追加测试/文档，源码修复为两处界面显示。

## 分类与剩余门槛

| 类别     | 实际结论                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------- |
| 实际通过 | PG业务/权限/事务、确定性金额/冻结/审批、持久队列、本机重启/迁移/独立备份恢复、浏览器本地路径        |
| 模拟验证 | 消息收发/渠道接受账本、preset AI、虚构工厂和offline_fixture公司，不代表真实询盘/触达                |
| 未配置   | Brave Search凭据；真实模型与真实消息适配器未启用                                                    |
| 未验证   | 实体手机/其他浏览器、服务器部署、跨机器恢复、生产压力/在线备份、真实模型与渠道                      |
| 受阻     | D1两次真实研究、至少三家真实来源复核、确认及重复导入；D2真实来源lead到模拟批次；V真实来源同一完整链 |

真实门槛准确步骤见FUTURE_INTEGRATIONS.md，不执行接入或部署。V保持verification_blocked，用户本次可审阅本地交付，不能以离线结果完成整体接受。

产品手册、架构对照、README、MIGRATIONS、ADR0014、PROGRESS/ACCEPTANCE/HANDOFF及后续清单已交付。人工5步见ACCEPTANCE.md。本轮停止等待用户验收，不自动accepted。
