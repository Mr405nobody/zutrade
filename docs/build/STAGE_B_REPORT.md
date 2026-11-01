# 阶段 B：可信供给与报价

日期：2026-10-28（Asia/Shanghai）。状态：**ready_for_user_review**。A2 已由用户本次明确验收 accepted；本次范围仅 B，未进入 C。

## 用户可操作的功能

“产品”入口可查看工厂授权范围内的产品、上传 PDF/PNG/JPEG/UTF-8 文本、追加不可变来源版本、录入结构化待确认事实，核对定位片段、版本、有效期和披露范围。sales 可以录入和上传，owner 才能确认事实、发布价阶和撤回。上传不会自动成为已确认依据。供给持续标注模拟，不表示真实供应商确认。

Alex 会话内部区可整理采购需求、生成确定性报价、查看依据和版本历史，打开同一冻结数据的英文预览并显式生成/下载 PDF。500 × 2.40 + 30 = **1230.00 USD**，800 件为 **1950.00 USD**。设置费一次一行；未知运费、税费和样品费明确排除，没有填零。20 个工作日绑定图稿/样品和订金确认条件，六周到货要求保持待确认。

需求实质变化推进 requirements_revision；内部备注或完全相同的保存不会任意使报价失效。每个版本保存完整公开需求、卖方、买方、收件账号、规格、费用、舍入、价阶/事实/来源引用、条款及固定有效期，历史不读取当前名称或当前需求来重建。默认七天，与代理授权和依据更早到期取最早时刻，保存 Asia/Shanghai 显示时区及缩短原因。

报价状态“已校验”只表示业务校验与冻结；界面与 PDF 始终提示“尚未获得外发审批”。报价不进入买家 messages；没有报价审批或发送动作。原 A2 受控模板回复仍走统一模拟网关。

## 演示关系与账号

检查真实数据后发现，日常 A1 工作区没有 Alex 联系人；唯一既有 Alex 会话位于 A2 独立浏览器验收工作区。因此 B 沿用该工作区、原账号、Alex、商机与其实际关联工厂，不凭 DEMO-A 显示名猜归属，也没有新建另一套买家、工作区或会话。CT-01 的模拟来源、价阶和事实建立在这条实际关系下。

执行 `./scripts/zu db:accounts`，在本机打开输出的 `.local/b-accounts.json` 获取 B 演示原账号。该文件仅引用既有 A2 测试账号，权限 600；随机密码不在报告中。原 `.local/a1-accounts.json` 保留。浏览器测试只创建独立异常产品/来源，保留测试历史；交付时恢复 CT-01 的 500 件需求及有效当前报价/PDF，见 evidence/b/demo-ready.json。

首次 seed 使用实际运行时间，有效期三十天；重复 `./scripts/zu db:seed:b` 在产品已存在时直接返回，不覆盖用户修改、不延长旧有效期、不重新激活撤回内容。重复 seed 的完整前后摘要证据见 seed-repeat.json。

## 实际数据库增量与领域规则

唯一新增业务迁移 `0005_supply_quoting`：source_documents 增加 product_id 复合归属；quote_versions 增加命令 UUID/内容摘要及唯一约束；新增单用途 quote_pdf_artifacts，并增加供给/报价按工厂授权的 restrictive RLS 与必要 runtime grants。当前 app **43 表**是原 42 表加 PDF manifest，没有 prospecting_runs。Drizzle 实际映射为 598 列、148 FK（106 复合）、171 CHECK。认证和队列表沿用既有安装。

原 SQL 75,172 字节与 SHA256 `b7f72b68adce6ad161eedf66b65389cd35461ec20446a9e97fa560550c21a1fe` 保持不变；未使用 schema push、reset 或删卷。原冻结触发器、复合外键、FORCE RLS 均保留，API/worker 仍非 owner、非 superuser、无 BYPASSRLS。

来源和价阶在完整 INSERT 时即冻结；事实全部 evidence 在 freeze 前建立。owner 发布时复核来源、有效期和披露范围，再确认、冻结并推进当前版本。价格变更建立新规则及事实版本，旧行不改写。价阶使用 `[qty_min,qty_max)`，同产品、币种、单位及可能兼容条件在同一个产品锁下拒绝重叠；包含同事务和并发验证，没有 LIMIT 1 随选价格。

QuoteCalculator 使用 pinned decimal.js、50 位独立精度和 USD 两位 half_up_per_line；API 金额为十进制字符串，数据库 numeric。只信服务端选取的价阶。折扣基数为产品小计，先验证精确请求在 owner 发布边界内，再舍入正的 discount 减项；超边界保留待核验提案并阻断，不改原价阶。默认无折扣，演示发布边界为产品小计最多 5%。

生成使用同一明确事务建立 quote、版本、明细、证据和冻结摘要，冻结后推进逻辑父对象 current_version 并建立 pending PDF 索引。需求行锁、关联会话锁、产品 advisory lock、命令幂等及 expectedCurrentVersionId 处理并发；同键同内容返回原结果，异内容或过期版本 409。中途失败全量回滚。资料撤回、换版、价格替代、需求和授权变化均在查询时直接复核，不只依赖异步失效任务。

详见 ADR [0005](adr/0005-supply-publication-and-locks.md)、[0007](adr/0007-quote-snapshot-and-current-eligibility.md)。

## PDF、私有文件与恢复

PDFKit 读取冻结快照的字段白名单，不二次计算金额，不打包内部成本、备注、证据原文或内部附件。嵌入 Noto CJK 字体及 OFL license，覆盖中文工厂名。上传上限 5 MiB，校验字节类型，服务端生成对象身份，目录不公开挂载。来源文件和报价 PDF 下载均重验会话、成员、workspace、factory；报价和被其引用的来源还从数据库追溯完整关联会话，省略 thread 参数或使用裸文件 ID 不能绕过。

报价摘要是 `b-quote-v1` 规范化完整快照的 SHA256，PDF 字节摘要为另一独立值。冻结后不修改 terms_snapshot 补 PDF hash。quote_pdf_artifacts 永久绑定版本、快照摘要、模板版本、object_key/object_version、PDF sha256、MIME 与大小；ready 记录不可改写或删除。

PDF 显式生成/重试在冻结事务提交后另开业务事务，锁唯一 manifest。私有存储将完整字节写独占临时文件并 fsync，通过不覆盖目标的原子 hard link 发布不可变对象，再核验字节和 fsync 目录，最后提交 ready。渲染/写入失败持久化 failed；重试复用身份。进程中断最多留下无引用的临时/完整对象，没有成功索引指向半写文件；不自动扫描删除历史对象。重复下载复用已存字节，缺失或损坏明确报错，不重新渲染替换。

详见 ADR [0006](adr/0006-quote-pdf-artifact.md)。B 采用同步显式生成，因此没有新增队列或第二套 outbox；现有 pg-boss/A2 worker 保持使用。

## 验证证据

测试均使用独立真实 PostgreSQL 数据库，或既有独立浏览器测试工作区；未撤回或破坏 CT-01 演示来源。报价计算和有效期用固定 `2030-01-01T08:00:00Z` 测试时钟；数据库真实审计时间和浏览器运行时间如实保留。

| 验证                       | 命令                                                      | 实际结果与证据                                                                                          |
| -------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| B 真实数据库/API/PDF/竞态  | `./scripts/zu test:b`                                     | 14 组通过 / 0；integration-verified.txt、integration.json                                               |
| 供给发布专项               | `./scripts/zu test:b:supply`                              | 8 组通过 / 0；supply-verified.txt、supply-integration.json                                              |
| 计算/存储/PDF 单元         | `./scripts/zu test:unit`                                  | 22 项通过 / 0；unit-verified.txt                                                                        |
| A1 数据库/auth/队列回归    | `./scripts/zu test:integration`                           | 23 组通过 / 0；a1-regression.json                                                                       |
| A2 核心与入站回归          | `./scripts/zu test:a2` / `test:a2:inbound`                | 19 / 11 组通过 / 0；a2-regression.txt、a2-inbound-regression.txt                                        |
| B 桌面/手机真实浏览器      | `./scripts/zu test:b:browser`                             | 1440×1000、390×844 两项目通过 / 0；browser/ JSON 与 PNG                                                 |
| 完整浏览器回归             | `./scripts/zu test:e2e`                                   | A1/A2/B/健康页面共10项目通过 / 0；browser-regression-recovery.txt                                       |
| 构建/类型/lint/边界/doctor | `build` / `typecheck` / `lint` / `doctor`                 | 全部通过 / 0；build-complete.txt、typecheck-final.txt、lint-final.txt、doctor.txt                       |
| PDF 文字/字体/分页/边界    | `./scripts/zu test:b:pdf` + bundled Python 检查           | 500 件两页、长条款六页；pdf/QA.md、text-check.json、全页 PNG                                            |
| 保留卷重启                 | `./scripts/zu exec node scripts/verify-b-persistence.mjs` | 实际 PG stop/start 后来源/需求/报价/文件及 A2 关系全量摘要一致；persistence-final.txt、persistence.json |

冻结负向检查覆盖版本更新/删除、明细与证据增删改；事务故障在第一行后注入，证明不留半套版本或错误 current pointer。并发验证包括同命令复用、异内容冲突、双成员新版本冲突，以及等待数据库锁后需求编辑/来源撤回先提交时生成被阻止。边界包括 499/500/999/1000、非整数、币种/单位/规格、缺依据、过期与代理授权截短。真实存储失败、重试、字节一致、损坏拒绝和内部字段排除分别有服务与 PDF 解析证据。实际 API 报价 PDF 也单独解析金额、中文卖方、排除条款与几何边界并查看渲染页，见 api-pdf-check.json、api-v1-preview.png。

## 真实失败与恢复

- 供给独立测试初次 fixture SQL 的 UUID/text 参数推断失败；显式 cast 后通过，失败库精确名称及恢复记录保留在 supply-recovery.json。日常 workspace 无 Alex 的首次 seed 明确失败且不写数据；确认实际既有关系后成功。
- 供给审阅发现同事务 SQL now() 等值导致重叠检查漏查，修正 `<= now()`，新增同事务及并发重叠证据通过。折扣精确边界在舍入前检查，避免小金额舍入掩盖超边界。
- PDF 首轮实际渲染发现页脚造成额外空页；修复页脚边距后重新解析并查看全部页面，保留首轮失败说明。
- 报价工作区的持久阻断查询误用了 audit_events.created_at，真实浏览器触发 500；按真实 occurred_at 修复，并新增 API 工作区查询回归。类型/ESLint/格式检查的初次错误及恢复日志保留。
- 浏览器测试最初 Origin 缺失被 403 拒绝，修正测试请求后恢复；新报价失效警告使旧 A2 的宽泛 alert 定位产生歧义，收紧到对应消息警告区，并为独立测试线程恢复上轮失败留下的接管状态，再复跑。没有放宽应用权限。
- 末次审计命令的输出参数首次误传目录，EISDIR 后改为明确 JSON 文件路径并通过；没有数据库变更。失败数据库精确名称保留在 retained-test-databases.json，未模糊删除。
- PDF 失败界面采用独立 manifest 的持久 failed 状态夹具；不把它称为真实浏览器磁盘失败。真实 I/O 故障及恢复在数据库/存储专项验证。

## 限制、启动和停点

仅 USD/整件/结构化供给，不扩展汇率或通用文档解析。资料仍需人工核对录入；没有 OCR/AI。只在本机 Chrome 和手机视口测试，未使用真实手机硬件或第二台设备。原 A2 关于非幂等渠道强杀/unknown 核对的限制仍由 C 处理，B 不声称完成该协议。历史对象自动回收与完整灾备恢复不在 B 验证范围。

保留可运行服务于 5173/3001/3002，PostgreSQL 18.6 在 Colima `zutrade`、55432，持久卷未变。服务已在运行时直接打开页面；停止后用：

```sh
colima start --profile zutrade
./scripts/zu infra:up
./scripts/zu dev
```

已有库升级使用 `./scripts/zu build`、`./scripts/zu db:migrate`；新来源演示只需首次显式 `./scripts/zu db:seed:b`，日常启动不重新 seed。C 后续需将 owner 审批绑定具体冻结报价、最终外发内容、账号与已发布 PDF 字节，并在发送前调用当前依赖复核；不得以 validated 或本次开发验收代替商业审批。

未提交、推送 Git，未猜测作者身份。B 已完成自测并设为 ready_for_user_review；用户验收前不设 accepted，C 保持 not_started。

## 后续验收记录

用户在本次启动 C 的指令中明确声明“我已验收通过阶段 B”，因此 PROGRESS 将 B 记录为 accepted。上文 ready_for_user_review 是原自测交付时的历史状态。C 的开发验收和产品内 owner 商业审批仍独立。
