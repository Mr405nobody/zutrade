# 架构与数据库实际实现对照

2026-10-30，V 本地交付。实现以现有源码、增量SQL和真实PG证据为准；真实研究成功链仍延期。

| 需求/边界          | 实际实现                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Mac本地/锁定运行时 | scripts/zu 固定 Node24.22.1/pnpm11.25.0；React/Vite web，Nest API，独立worker；Docker PG18.6                                         |
| 包边界             | web仅消费contracts/ui及前端工具；domain不依赖apps；db/channels/ai/storage/prospecting公开导出；eslint+boundaries检查                 |
| 身份               | Better Auth密码会话，auth_subject→app_users；先验证会话，再事务内发现本人有效成员，随后选择workspace；不信任客户端role               |
| 租户/工厂          | withWorkspace设置事务局部user/workspace/member；app FORCE RLS，完整thread关联工厂集合授权；未归属会话仅owner；提交/回滚不污染池      |
| 运行角色           | zutrade_api、zutrade_worker非superuser/owner/BYPASSRLS；独立auth/simulation角色；migrator仅迁移/初始化；pg-boss DDL不在runtime       |
| 消息/统一网关      | 原始入站先持久化并锁账号；worker标准化；普通模板、FAQ、报价、批次、自动跟进共用delivery网关；网络调用在claim提交后                   |
| 执行结果           | claimed为撤销截止；持久幂等身份；独立simulation账本可复现接受后丢响应；unknown需核对，不提升为真实已送达                             |
| 可信供给/金额      | 来源版本→owner确认fact/price_rule→确定性十进制计算；numeric保存/十进制字符串传输；未知费用不为零                                     |
| 冻结与PDF          | quote_versions及lines保留；quote_pdf_artifacts绑定私有内容寻址字节；payload版本冻结收件人、卖方、账号、正文、附件摘要；审批精确绑定  |
| 任务               | 唯一pg-boss；业务/outbox身份/enqueue同一连接同事务；无第二套outbox发布/租约器；worker重新核对发起成员当前权限                        |
| 研究               | D1 prospecting_runs持久deadline、累计预算/检查点/终态证据；review独立CAS；确认/复制来源/导入同事务；fixture仅显式测试注入            |
| AI                 | ct01.v1 MockAIProvider + strict Zod，无DB/网络/发送能力；ai_runs保存输入/证据/输出/校验/决定；FAQ仅审核模板与允许值                  |
| SSE                | 每2秒重查真实会话与当前成员授权，失权通知/断流，重连靠DB游标补查；不把SSE当消息主库                                                  |
| 私有存储           | LocalPrivateObjectStore，目录700/文件600，摘要寻址不可覆盖，拒绝路径穿越/symlink；API下载前做工作区/全部工厂授权，web public不挂文件 |

## 表和迁移

原始42张业务表的SQL为75,172字节，SHA256 b7f72b68adce6ad161eedf66b65389cd35461ec20446a9e97fa560550c21a1fe。0000副本仅去除已确认的外层BEGIN/COMMIT，由Drizzle统一事务和迁移日志管理。

B增加quote_pdf_artifacts、C增加command_receipts，形成44张app表；D1增加prospecting_runs至45张。D2/E复用原表并追加列/约束，无新app表。auth4表、simulation4表、pgboss13表及infra迁移日志另计。完整Drizzle映射截至0019为662列/159FK（115复合）/200CHECK；不是用schema push生成约束。当前实际catalog见 build/evidence/e/catalog-mapping.json、V的security-audit.json。

业务迁移0000—0019和认证迁移均保留原文件与已执行hash。0013—0014是研究，0015—0018是批次/跟进/初始化/节奏/历史，0019是模拟AI。完整逐条记录见 build/MIGRATIONS.md。V无新增迁移：独立带数据0018→0019升级、全量空库迁移、重复迁移均实测，日常库不降级、不reset。

## 查询与运行边界

V样本35会话、91消息、1次离线研究/3候选、2跟进，消息与会话均实际跨页读取且无重复。会话页30条（读取31判断下一页），消息默认30、硬限100；产品/来源/事实/价阶列表多为100硬限，研究列表30、批次40、跟进100；后者目前不是完整历史分页。长期增长前应补游标与归档入口，不能声称当前UI能浏览所有历史。

来源获取由持久180秒deadline、每请求10秒、累计请求数、重试/跳转、字节/快照/候选上限约束；具体锁定值见 packages/contracts/src/prospecting.ts。测试注入不会放宽运行时SSRF。所有任务按业务状态与版本停止，队列重试不延长业务期限。

实际SQL次数与耗时见 build/evidence/v/query-observations.json：计数仅包含已建立scope内的client.query，不包含身份解析/会话/auth查询及数据库触发器内部语句。一次本机暖数据观察，无压测、无吞吐量/SLA。todo与AI有逐对象检查，查询次数随有界列表增长；研究重复提示逐候选查询，最多50候选。SSE当前按可见workspace线程构建摘要，线程量增长时应再评估开销。必要索引清单已从实际pg_indexes保存，金额/冻结/权限边界没有为了减少查询而省略。

前端当前单JS包约524.59kB（gzip160kB），构建提示大于500kB；属于已知规模限制，未宣称生产性能或跨浏览器性能。

## 备份与恢复

V暂停自身写入者后全库pg_dump及私有对象复制；恢复到新库和新目录，通过全部app行摘要、任务身份、报价/审批/正文与附件字节检查，再以受限角色鉴权读取。原数据不覆盖。私有备份含auth与simulation，连同账号/trace仅留ignored .local；报告不放连接密码。过程不是在线一致性备份或跨机器恢复演练。
