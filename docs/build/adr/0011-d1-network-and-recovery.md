# ADR 0011：D1 真实研究、网络边界与恢复

日期：2026-10-29（Asia/Shanghai）。状态：实现；联网验收受阻。

D1 仅新增 app.prospecting_runs（44→45）；0013/0014 与原 B/C 表并存。既有 0000—0012 不改。研究、outbox 和 pg-boss send 使用同一 PoolClient 事务。API/worker 角色不拥有表、无 BYPASSRLS；研究与线索另受工厂 restrictive RLS，任务/成员/工厂使用复合 FK。

终态 results_snapshot、checkpoint、请求计数、初始时间、deadline、执行身份均冻结。review_decisions 独立保存保留/排除原因、操作者、实际数据库时间和 CAS 审核版本，并追加 audit。导入锁工作区/研究，从服务器快照取值，核对结果和审核版本及 keep 决定，原子创建或显式关联 buyer、复制来源并建 lead；同 run/candidate 唯一。D1 没有真实个人联系人时只建公司线索，公开邮箱只留证据，不写 contact point、verified_at 或 allowed。

首次领取固定 DB first_started_at+180 秒；逐次外部 HTTP 前提交 request_count+1。重定向、HEAD/GET 和重试都占预算；80 硬上限。队列 retry_count 必须来自已 active 的持久 pg-boss job。正常重复执行不抢权，真正同 job retry 才推进 execution_version/token；每个请求前后与每个检查点重新核对 actor、工厂、token、期限和状态。重启继续原 checkpoint、deadline 和计数。取消/终态/新 token 后旧执行者不能存结果。进程强杀与实际 retry/fetch 的证据独立于合成过期 fixture。

HTTP 请求在业务事务外。仅 GET/HEAD、80/443 标准端口、无 URL 凭据；IPv4/IPv6/映射/保留地址均验证，完整解析 A/AAAA，任一不安全则拒绝。Node https.request 用验证后的 lookup 地址，保留 URL Host/SNI 与默认 TLS 证书验证、agent=false；不会再任意解析目标。每个跳转重新验证，最多 3 跳，拒绝 HTTPS 降级；正式搜索 endpoint 不跟随跳转。没有代理或私网开关。数据库 session advisory 锁将跨 worker 的并发限制为全局 2、每主机 1；只覆盖 HTTP，不占业务事务，退出/断连释放。

单请求包含 DNS/连接/正文处理共 10 秒，并受原 run 剩余期限约束。压缩前后均限制 2 MiB；仅支持 HTML/JSON/plain text 与 gzip/deflate/br，不执行网页脚本或表单。429 尊重 Retry-After；大于 10 秒直接保留速率错误，不提前重试。最多 2 次重试。外部页面没有 cookie、内部认证或 API key；Brave key 仅可发往固定正式 endpoint。页面先检查 robots，拒绝访问/不支持时保留失败证据。

目录配置是 Wikipedia 的 SG/GB/AU 活动公司分类，使用官方 categorymembers generator、pageprops 和 Wikidata EntityData，发现本次响应里的企业/实体链接，不预置企业。目录覆盖有限，关键词只作规则匹配。公司最多实体、robots、官网三种页面资源；目录最多 5 页。发现与部分结果持久检查点保存。必要字段、字段定位、发现链、实际 UTC、读取状态、完整解压响应字节 SHA256/hash_scope、提取器版本与署名随证据保存。官网未成功读取不能显示已读；搜索摘要和目录证据不成为人工确认或营销许可。快照 JSON 预留 jsonb 空白开销，总体不超过 512 KiB。

Brave 正式 GET API 适配使用 q/country/count≤20/offset/result_filter；启用须本地 key、confirmed 存储权与本地 entitlement reference。FixtureResearchProvider 只允许 NODE_ENV=test 的显式依赖注入；HTTP schema 没有 fixture 选项，运行时无 fallback。搜索摘要和实体事实仍须人工核对。

本机 DNS 将公网域名映射到 198.18.0.x，且直接 HTTPS 超时。SSRF 保护正确拒绝。用户明确选择保持网络现状。浏览工具能读到公开目录和官方资料，仅证明资料核对，不充当 worker 真实发现成功。D1 必须保持 verification_blocked，待真实公网解析及可达网络后补齐两次研究、三个来源抽查、真实候选导入与重复导入门槛。

官方核对：[Node HTTPS](https://nodejs.org/api/https.html)、[MediaWiki Categorymembers](https://www.mediawiki.org/wiki/API:Categorymembers)、[Pageprops](https://www.mediawiki.org/wiki/API:Pageprops)、[Wikidata 数据访问](https://www.wikidata.org/wiki/Wikidata:Data_access)、[CC0](https://www.wikidata.org/wiki/Wikidata:Licensing)、[Wikimedia User-Agent](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy)、[Brave GET](https://api-dashboard.search.brave.com/api-reference/web/search/get)、[Brave 条款](https://api-dashboard.search.brave.com/documentation/resources/terms-of-service)、[OWASP SSRF](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)。pg-boss 12.38.0 与 Node 24.22.1 的已安装类型/实现亦实际核对，未无故升级。
