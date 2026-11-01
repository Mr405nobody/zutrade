# ADR 0007：报价快照、命令与当前可用性

日期：2026-10-28（Asia/Shanghai）。阶段 B，采用。

需求保存采用 opportunity.row_version CAS，结构化产品、数量、规格、印刷、目的地、用途、原始时间请求、语言和待确认项。除 internalNote 后的规范化需求发生变化才推进 requirements_revision；完全相同的保存不 UPDATE。内部备注变化只推进普通 row_version，不使报价失效。正式报价严格核对 workspace、factory、buyer、contact、contact point、opportunity、linked thread 和 product。

生成命令先按 workspace + command UUID advisory lock 去重，再锁全部关联会话及商机行；需求保存使用同一商机锁。报价与供给发布/撤回共用 `b-product:<product UUID>` advisory lock。命令相同内容返回原版本；同键不同内容、过期 row_version 或已推进的 current_version 返回 409。并发新版本只有一个推进。资料撤回先提交时，等待锁的生成命令重新读取依据并阻断；生成先提交时，历史保留，下一次直接检查显示重核。

确定性 QuoteCalculator 使用 decimal.js（独立 precision 50）；传输金额为十进制字符串，数据库 numeric。USD 精度 2，half_up_per_line，逐行舍入后求和。piece 数量为正整数，价阶采用 `[qty_min,qty_max)`。单次设置费独立成行。未知运费、税费、样品费只在排除项和待确认中保存。折扣以 product subtotal 为基数，先比较未舍入的请求和 owner 发布边界，再按行舍入；discount 行为正减项，汇总扣除，不允许负总额。超边界请求追加待核验提案审计并阻断，不改变原始价格。允许折扣的 kind/value/basis 保存在公开冻结快照中；销售填写的理由只进入版本关联的内部追加审计，不自动写入外部费用描述。

同一事务插入 quotes（首次）、quote_versions 草稿、全部 quote_lines 和 quote_evidence，冻结后才推进 quotes.current_version_id 并建立 pending PDF manifest。任一步失败，全部回滚。保留原 SQL 的所有冻结触发器、复合外键和 FORCE RLS；quote 父身份不变，但可推进当前版本。

摘要范围为 `terms_snapshot.snapshot` 的完整 `b-quote-v1` 对象：递归排序对象键，保留数组顺序，JSON 编码后 UTF-8 SHA256；版本号、生成时间、完整公开需求、卖方/买方/接收账号、规格和计算输入、费用行、折扣、范围/排除/待确认、生产条件、付款/样品、有效期/时区及具体事实/来源/价阶版本引用均纳入。内部备注不进入该对象。PDF 内容只使用它的对外字段白名单；摘要不包含 PDF hash，因此没有循环依赖。

默认有效期为生成时刻加七天，并与当前工厂代理授权、价阶、事实、各来源到期时刻取最早值。实际瞬时到期和 Asia/Shanghai 显示时区固定保存；有缩短时说明原因。生产周期保留 business/calendar 与起算条件，committed_arrival_date 保持空，不由买家六周请求推算。

失效不重写快照。查询会直接检查商机需求修订、工厂当前授权、quote 当前版本、事实当前版本/状态/有效期、来源当前版本/撤回/有效期及价阶有效期。完整版本读取按关联会话、商机与产品锁重新核对，避免依赖异步传播。旧金额、条款、证据和 PDF 保留；对旧版允许有权成员历史查看和下载。B 的 validated 仅表示业务校验和冻结，始终显示尚未获得外发审批。

阻断原因与超边界折扣提案追加到 audit_events。工作区查询读取与当前需求修订匹配、且晚于最近成功报价的阻断原因，刷新后仍可查看；新需求或成功生成不会一直显示旧阻断。未来 C 必须调用同一当前可用性检查，并绑定冻结 PDF 及审批，不以 validated 状态代替 owner 商业审批。
