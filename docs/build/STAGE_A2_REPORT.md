> 后续验收记录：用户于 2026-10-28 明确声明“我已验收通过阶段 A2。现在只执行阶段 B”，A2 现为 accepted。下文保留原自测交付报告及当时状态。

# 阶段 A2：消息工作台报告

日期：2026-10-28（Asia/Shanghai）。状态：**ready_for_user_review**。A1 用户已明确验收 accepted；本次只执行 A2，不进入 B。

## 用户可操作功能

正式 React 微信式工作台：四入口默认消息，桌面窄导航、会话列表、宽聊天，手机列表进入单会话。资料和内部团队区按需展开；身份、工厂、成员与健康检查从工作区设置进入。其他入口展示准确后续阶段，没有虚构成功操作。

owner 可受控注入 Alex Morgan / Northstar Events 的虚构棉布袋询盘（500 件、单色 logo、报价与六周到货需求）。界面持续标注模拟；买家需求不是工厂确认的价格/交期。原始入站先保存，再由独立 worker 标准化。可重放同一事件；同键异内容明确冲突。同名不同渠道身份分开，不按姓名合并。

成员可阅读与分页历史、独立保存已读位置、认领/指定负责人、接管与明确释放、添加团队备注、保存内部自由文本草稿及发送固定澄清模板。备注/草稿与买家历史分表/分状态保存，不进入外发快照。报价、折扣、交期承诺即使 owner 也不能通过此路径外发。

SSE 通知变化后回查数据库，断线明确提示并自动重连。已连接订阅持续复查登录、成员和工厂授权；失效关闭详情并清业务缓存。模板草稿固定上下文，入站/接管变化后要求重新核对。row_version 冲突返回 409，context_revision 专门控制动作失效，备注/已读不推进上下文。

## 实际模块与数据边界

- `domain/inbox.ts`：统一完整工厂集合授权、列表/详情/消息游标、已读、备注、负责人、接管与分配。会话本身无 factory_id；最小 intake opportunities + opportunity_threads 表达归属。
- `domain/inbound.ts`：owner-only 专用模拟入口；收据 digest、provider identity 去重、真实事务 outbox/入队、限定系统任务与审计、异常 retry/dead 投影。未知身份保留未解决屏障。
- `domain/delivery.ts`：共享 Delivery 命令服务，只接受 quantity/use/destination 的服务端版本化正文，无自由正文参数。固定 intent=human_reply、authorization_mode=member_send。request + 冻结 payload + outbox + pg-boss 同一事务连接；worker 重读授权、账号、联系资格、上下文、全账号屏障及冻结快照，提交 claim 后在事务外执行唯一 MockAdapter，记录 attempt 和 simulated 结果。
- `channels` 仅 simulation MockAdapter。API/worker 均沿用非 owner、非 superuser、无 BYPASSRLS 的运行身份。入站系统上下文根据持久事件/任务/可信账号建立，不冒用 owner；限定结果入口可在 claim 后成员失权时记录模拟结果。
- 0003/0004 增量迁移，不增加业务表。添加接管成员与收据的工厂/发起成员/标准化对象字段、完整集合 RLS 判定和系统作用域/发送阻塞入口。关联变更锁线程并推进上下文。当前 app 42 表、579 列、144 FK（103 复合）；原有 162 CHECK、冻结与追加审计触发器、42 FORCE RLS 保留。

账号锁一致采用 channel_accounts FOR UPDATE，先账号再线程。收据提交后即屏障，只有标准化业务成功同事务提交才解决。屏障函数读取完整账号收据，不能因 sales 看不到 B 工厂收据而越过它。线程锁在 messages INSERT 前取得，分页与 read 推进使用同一协议；ingest_seq 分配与提交按线程串行，迟到 occurred_at 不被误判已读。

## 启动与注入

沿用现有环境，日常命令和恢复方法见 [HANDOFF.md](HANDOFF.md)：`colima start --profile zutrade` → `./scripts/zu infra:up` → `./scripts/zu dev`。现有服务若已运行直接打开 [127.0.0.1:5173](http://127.0.0.1:5173)。升级时只 build/db:migrate，不重建数据库。

运行 `./scripts/zu db:accounts` 取得本机私有账号文件路径；不在报告保存随机密码。owner 在消息列表顶部展开注入入口，选 DEMO-A 后提交 Alex 场景；收据显示等待/处理中/标准化完成及失败原因。未选择工厂时进入 owner 待分配队列，可在会话资料中明确分配。重放按钮复用原 event ID；REST 对同 ID 异内容返回 409。

## 验证与证据

本阶段使用独立真实 PostgreSQL 测试库及浏览器独立工作区，不清空日常演示数据。证据仅记录实际结果，最终结果见下方完成记录。

| 验证                                   | 实际命令                                                                                        | 结果 / 退出码                                                             | 证据                                                                           |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 核心真实 PG / HTTP / worker            | `./scripts/zu test:a2`                                                                          | 19 组通过 / 0；成功测试库已按精确名称删除                                 | integration-verified.txt、integration.json                                     |
| 入站与系统作用域专项                   | `./scripts/zu test:a2:inbound`                                                                  | 11 组通过 / 0；异常计数、dead 屏障与原 job 重试                           | inbound-final.txt、inbound-scope-check.txt                                     |
| 默认桌面/手机回归                      | `./scripts/zu test:e2e`                                                                         | 8/8 通过 / 0；A1 登录/工厂/队列/退出、A2、健康断路恢复                    | browser-regression.txt                                                         |
| 本次消息/本次请求精确复验              | `./scripts/zu test:e2e a2.spec.ts`                                                              | 2/2 通过 / 0；1440×1000 / 390×844；无 pageerror、无横向溢出               | browser-final-verified.txt、desktop/mobile-browser.json                        |
| 锁定工具链构建、strict 类型、lint/边界 | `build` / `typecheck` / `lint`                                                                  | 均通过 / 0                                                                | build-verified.txt、typecheck-final.txt、lint-final.txt                        |
| 私有存储相关单元回归                   | `./scripts/zu test:unit`                                                                        | 4/4 通过 / 0                                                              | unit.txt                                                                       |
| 迁移及环境/原件/秘密审计               | `db:migrate` / `doctor` / `AUDIT_EVIDENCE_PATH=... ./scripts/zu exec node scripts/a1-audit.mjs` | 均通过 / 0；app 42 表；原件75,172字节与hash未变；候选文件及日志无密码匹配 | migrate.txt、migrate-hardening.txt、doctor.txt、repository-database-audit.json |

上述命令的脚本入口都经项目锁定 Node/pnpm；表格省略前缀的构建检查也使用 `./scripts/zu`。真实数据库最终核查使用最终构建后的模块。对故意伪造的入站 job，日志 `inbound_failure_projection_unavailable` 表示可信任务入口拒绝建立上下文，是预期负向结果，不是正常入站恢复失败。

最终成功截图已实际查看：[桌面本次模拟回复](evidence/a2/desktop-simulated-reply.png)、[手机本次模拟回复](evidence/a2/mobile-simulated-reply.png)；另保留 owner/sales、空态、离线及409截图。首次空态来自独立测试工作区无业务记录时的真实页面；后续重跑复用历史，没有清空它来获取空态。

核心检查包括真实入站与队列、事件/provider 去重、同名身份、成员独立已读、迟到消息/游标与显式锁同步并发、内部信息边界、冻结和同事务 xmin、命令幂等、队列失败回滚、接管 CAS、最新人工回复、claim 时停用/撤权/渠道暂停/资格失效、合成已 claimed 的保守 unknown（并非强杀证明）、全账号屏障、混合/未分配工厂隔离、SSE 建连后的撤权/新增工厂关联/成员停用/登录过期、进程重启与断线后数据库补查。补充系统作用域与异常重试/dead/官方队列重试检查。

## 真实失败与恢复

1. 离线依赖安装缺缓存 metadata，退出 1；在线安装复用锁定版本成功，未换全局 Node。完整构建初版通过。
2. 首轮并发测试用非管理员观察其他角色的锁等待，观测不到同步点且清理等待；改为仅测试管理员读取 pg_stat_activity，同步点明确可见并在 finally 释放线程锁。第四轮业务断言均通过后发现测试清理对已被信号终止的 child 再等待 exit；加入 signalCode 检查后正常退出。没有以随机 sleep 代替并发证明。
3. PostgreSQL 拒绝 request UUID 同参数隐式写入 text provider key（42P08）；显式 uuid→text 后恢复。原始失败见 integration-second.txt。
4. 真实 worker 的冻结目标触发器 FOR SHARE 缺最小列锁权限（42501），导致发送队列失败；0004 补 UPDATE(id) 权限，未放宽冻结保护。见 integration-third.txt。claim 错误处理新增窄 SD 阻塞入口后类型推断暴露 build-second 错误，补显式 Claim 泛型恢复。
5. 模拟入站作用域审查发现全账号屏障不能受工厂收据 RLS 过滤，增加只返回 fail-closed boolean 的窄函数；异 provider 非 UUID scope 改为字符串比较。0003 应用后保持原已应用 hash，后续修复仅 0004。
6. pg-boss findJobs 的旧 A1 state 选项实际不存在，维护脚本误计其他状态；按安装版公开类型/源码改为有界分页后显式 job.state 判定，再官方 retry。真实失败/恢复见 inbound-scope-check.txt，job/outbox 身份不变。
7. 浏览器第一轮发现登录组件清空整个查询缓存，顶层身份 observer 不同步；保留 me query 并重新查询，清理其余业务缓存。见 browser-first.txt，后续浏览器证据记录恢复结果。

8. 第二轮浏览器定位注入选择器的精确可访问名称包含 option 文字，改显式 aria-label。第三轮真实离线检查发现 Chromium 不会因设置 offline 自动关闭已有 SSE，补 online/offline 监听后恢复。第四轮虽旧宽泛断言通过，视觉复核发现本次请求被屏障阻挡而历史 simulated 掩盖了断言；收紧为按本次 receipt 处理完成、本次 request ID 模拟成功后重跑，旧第四轮不作为本次发送成功证明。

失败隔离库暂保留的5个精确名称记录于 evidence/a2/retained-test-databases.json；没有按模糊名称删除任何用户数据库。可重跑测试源码均在 scripts/，无需私有临时代码；账号资料仍受忽略。

## 人工验收

见 [ACCEPTANCE.md](ACCEPTANCE.md) 的 A2 五步路径；覆盖注入、查看/备注、模板模拟执行、双账号未读与接管、断线/刷新后保留。

## 限制与停点

A2 不包含供给事实确认、报价/PDF、owner 商业审批、真实找客户、批次、跟进或 AI。未启用真实邮件/WhatsApp/模型/企业发现。assisted 不表示自动答复已启用。

仅本机 Chrome 桌面/手机视口验证，未用真实手机或第二台设备。A2 没有附件上传/读取入口；schema 中既有附件字段不是已实现功能。未知身份的收据保留待人工确认屏障，没有凭姓名自动合并，也没有本阶段的身份修复界面。

C 承担独立持久模拟接收账本、完整审批撤销、非幂等渠道强杀和 unknown 核对。A2 验证已提交 queued 任务的正常停止/恢复与重复消费，合成 claimed 用于验证不自动重发；不把这些写成强杀容错已通过。结果不明保守保留 unknown。pg-boss supervisor 使用受控维护入口，runtime 不做 DDL。

无 Git 提交/推送、作者猜测或用户修改覆盖。A2 自测完成只可 ready_for_user_review，用户验收前不写 accepted，不进入 B。
