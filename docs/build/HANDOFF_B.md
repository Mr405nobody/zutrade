# ZuTrade B 交接

更新时间：2026-10-28（Asia/Shanghai）。用户明确验收 A2 accepted；本次只执行 B，完成自测停 ready_for_user_review。C 与以后未启动。原 A2 交接保留在 [HANDOFF_A2.md](HANDOFF_A2.md)。

## 运行与账号

工程 `/Users/warren/Desktop/ZuTrade`；Colima profile `zutrade`；PostgreSQL 18.6、55432、原持久卷。保留 `.env`、账号、会话、消息、备注、权限、配置和私有对象。只使用 `./scripts/zu` 的 Node 24.22.1 / pnpm 11.25.0。

web/API/worker 保持运行于 5173/3001/3002。直接打开 [本地工作台](http://127.0.0.1:5173)。服务停止后：

```sh
colima start --profile zutrade
./scripts/zu infra:up
./scripts/zu dev
```

已有库升级：`./scripts/zu build` 后 `./scripts/zu db:migrate`。独立终端也可分别运行 dev:web、dev:api、dev:worker；不重复启动已占用端口。不 reset、删卷或启动时重新 seed。

`./scripts/zu db:accounts` 返回私有账号文件路径。B 采用 `.local/b-accounts.json`，它复用已有 A2 浏览器独立工作区、owner/sales 和 Alex；没有创建另一套账号/买家/会话。原日常工作区没有 Alex，故不凭 DEMO-A 名称臆造归属。原 `.local/a1-accounts.json` 及数据完全保留；密码仅本机私有文件，不写报告。

## B 真实路径

产品入口展开 CT-01，查看模拟来源 v1、owner 已确认事实、来源定位、有效期和 500—999 件价阶。sales 上传/待确认录入，owner 发布价格及关键条件；发布/撤回/适用范围校验在服务端并有审计。文件仅私有存储，来源换版建立不可变新版本，旧文件保留。

打开 Alex 内部区，整理 500 件 CT-01 需求，生成 1230.00 USD；800 件为1950.00 USD。内部报价与买家气泡分离。旧需求、金额、卖方/接收人、证据、条款、有效期和 PDF 均冻结保留。改变需求、换版/撤回依据或更新价阶时，当前查询直接返回具体重核原因。validated 不表示 owner 已批准外发。

PDF 显式生成，pending/failed/ready 与商业冻结分开。生成失败显示固定错误码并可显式重试；ready 仅在实际不可变字节完成、复核并提交 manifest 后出现。下载读取同一字节并复核 hash，不重新渲染。文件缺失/损坏返回冲突，应恢复原字节；不篡改历史或替换 manifest。

独立浏览器异常产品以 B-UI-* 标识，保留已撤回来源和报价历史，供查看重核。不要撤回主演示 CT-01。`scripts/b-demo-prepare.mjs` 是一次性交付准备，标记后不覆盖用户需求；不是日常启动或 seed 的一部分。当前交付对象见 evidence/b/demo-ready.json。

## 数据与代码边界

业务迁移0000—0005，auth 与 pg-boss 沿用。0005 是最小 source product 归属、quote command 幂等列和 quote_pdf_artifacts；43 app 表=42基线+1产物表，没有 D1 prospecting_runs。原件 hash、冻结保护、复合 FK、FORCE RLS 和受限 runtime 角色保留。Drizzle 映射实际598列/148FK。

- domain/supply：资料、事实、价阶、owner 发布与产品锁；来源更新不覆盖旧冻结版本。
- domain/quote-calculator：可靠十进制、USD、整件、半开价阶、独立设置费、受控正减项折扣。
- domain/quoting：需求 CAS、完整快照、事务冻结、命令幂等、当前依赖复核、完整关联会话权限。
- domain/quote-pdf + storage：字段白名单、CJK、持久 manifest、原子不可变对象发布、受鉴权下载与损坏拒绝。
- API supply/quoting controller；React 产品与会话内部报价区，浏览器只依赖 contracts/ui。

设计详见 ADR0005/0006/0007。PDF 同步生成，没有新建异步队列。A2 原入站/发送 pg-boss/outbox 同事务方案和受控维护命令保持使用。

## 验证与继续工作

```sh
./scripts/zu test:unit
./scripts/zu test:b
./scripts/zu test:b:supply
./scripts/zu test:b:pdf
./scripts/zu test:b:browser
./scripts/zu test:a2
./scripts/zu test:a2:inbound
./scripts/zu test:integration
./scripts/zu test:e2e
./scripts/zu typecheck
./scripts/zu lint
./scripts/zu build
```

测试 B 用独立PG数据库；成功只删精确本轮测试库，失败库名称留证。浏览器用独立测试工作区、新异常产品/来源，finally 通过CAS恢复进入前需求，不覆盖日常工作区。保留卷检查为 `./scripts/zu exec node scripts/verify-b-persistence.mjs`，会短暂停启本项目 PostgreSQL，先结束浏览器工作；它不 seed。

详细结果、真实失败恢复、PDF解析和截图见 STAGE_B_REPORT.md、evidence/b。A2关键会话隔离、SSE撤权、入站屏障、发送幂等、持久化既有证据已核对，并重跑19组核心+11组入站及桌面/手机回归。没有以测试数量代替具体行为。

## C 接入边界与限制

C 才建设 owner 商业审批、最终发送内容、账号/接收人/附件冻结和审批绑定，以及完整发送协议。必须重验当前依赖、最新会话、审批和字节摘要；不能以 B validated 直接发送。报价 PDF、供给确认和用户开发验收均不授予外发权。

不启用真实渠道、模型、企业发现、批次或跟进。不改变 A2 关于 claimed/unknown 与强杀容错尚未验证的限制。未验证真实手机硬件/第二设备、完整灾备恢复和自动垃圾回收。所有数据及演示明确模拟。Git 原先文件均未跟踪，未猜作者、提交、推送或部署。
