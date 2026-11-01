# ADR 0005：供给来源、事实发布与价阶并发

状态：implemented；2026-10-28（Asia/Shanghai）；仅 B 阶段。

## 实际方案

沿用基线 source_documents/source_versions/facts/fact_versions/fact_evidence/price_rules。0005_supply_quoting 增加 source_documents.product_id 的可空复合工厂/产品外键，旧资料保留；B 新录入资料始终有明确产品。来源版本与价阶依原触发器默认冻结，创建时填写完整内容，不先创建再补 hash 或金额。新来源版本在同一 source_document 下递增，使用 document row_version 做 CAS，并推进 current_version_id；撤回/归档来源不能藉上传新版本重新激活。

sales 可以录入私有来源与事实草稿。owner 才能发布、撤回事实与来源或发布价阶；这是供给确认，与 C 阶段报价批准无关。所有操作经过当前成员与工厂权限，追加 audit_events。B 表另有针对 runtime 的工厂 RLS 限制。来源下载还检查使用它的报价关联商机的完整会话权限，不能用裸来源 ID 绕过混合工厂会话隔离。

事实采用结构化白名单：模拟标识、卖方名称、fabric/dimensions/color/printing、生产周期/工作日类型/起算条件、折扣基数与最高比例、样品条款和排除项。每个事实版本在冻结之前写入全部来源片段。发布重新核查产品、来源当前版本、撤回与有效期、定位片段和披露范围；记录确认人、时间、版本摘要，再冻结并推进事实 current_version_id。替代旧事实只修改旧版本允许的生命周期列，旧值、片段、确认人与摘要不变。

## 并发与适用性

所有涉及同一产品的来源版本、事实创建/发布/撤回、价阶发布与来源撤回，统一取得事务 advisory lock：

```sql
SELECT pg_advisory_xact_lock(hashtextextended('b-product:' || $1, 0));
```

事实发布在锁后重读当前指针；较早的草稿不能覆盖更晚的已发布版本。价阶使用 [qty_min, qty_max)，piece 限正整数区间，USD 金额为十进制字符串。价阶事实身份为 price_rule + scope/currency/unit/qty_min，更新相同身份建立新事实版本和新不可变价阶。其余当前有效价阶按同产品、币种、单位和可能兼容的条件检查重叠：两个 applicability 没有矛盾的共同字段，即保守视为可能同时适用；空对象不能绕过已有具体规格。重叠拒绝并返回409。相邻半开区间可共存。

该锁也由报价生成取得（报价领域实现与证据见阶段报告）。锁不替代查询时的依赖校验：来源换版、撤回、过期、事实替代与撤回后，旧记录仍保留，productDetail 的 price.usable 根据当前依赖直接计算，不能仅看 frozen_at 或 published。没有异步失效任务作为唯一依据。

## Seed 与证据

B 的已有 Alex 只存在于前序 A2 浏览器独立工作区。日常 A1 工作区没有 contact_point；首次针对它执行 seed 安全失败，没有推测工厂或创建另一套会话。默认 `.local/b-accounts.json` 只是原 `.local/a2-browser-accounts.json` 的私有账号引用副本；没有创建新账号、工作区、买家或会话。根据模拟账号、Alex 的规范化渠道身份与真实 opportunity_threads/opportunities 外键选择唯一已关联工厂，不以显示名称或 DEMO-A 猜测。

首次建立 CT-01 模拟资料的期限为当次 seed 时刻起30天。若已存在 CT-01，立即返回原对象，不覆盖资料、事实、价阶、到期时间或撤回状态。私有来源内容明确为模拟，不表示真实供应商确认。重复 seed 全量对比产品/来源/事实/价阶 JSON 完全一致，见 evidence/b/seed-repeat.json。

针对性真实 PostgreSQL 检查见 evidence/b/supply-integration.json：sales/owner 分离、冻结负向、兼容条件重叠与并发、价阶更新历史、来源换版 CAS、撤回不可复活、工厂 RLS。测试只使用精确命名独立数据库。真实前序失败与修复保存在 evidence/b/supply-recovery.json，未修改日常数据。
