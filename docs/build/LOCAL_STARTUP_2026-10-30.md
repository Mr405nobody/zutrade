# 本地启动与使用说明核对

2026-10-30 13:54（Asia/Shanghai）。用户要求本地启动 ZuTrade 并提供使用手册。本次仅核对现有运行环境与入口，没有开展新建设阶段。

检查时日常服务已运行，因此沿用现有进程，没有重复启动、重新 seed、执行迁移或重启数据库。

实际验证：

- `./scripts/zu doctor --services`：退出码 0，项目工具链、Docker、四个服务端口、原始 SQL 摘要及 API readiness 全部通过。
- 使用 `./scripts/zu exec node --input-type=module` 发起本机 HTTP 检查：网页 5173 返回 200，标题为“ZuTrade · 本地工作台”；API 3001 和 worker 3002 的 `/health/ready` 均返回 200/ready，数据库与 worker 心跳正常，检查命令退出码 0。
- 核对日常账号文件 `.local/b-accounts.json` 存在 owner/sales 两个账号入口；没有输出账号密码。完整使用手册为 `docs/PRODUCT_MANUAL.md`。
- 请求在 Codex 浏览器打开 `http://127.0.0.1:5173`，应用返回 queued；页面 HTTP 可访问已经独立确认，不将 queued 记为浏览器交互验收。

消息仍为 simulation，AI 为 mock；没有发起企业研究、业务审批或消息发送。日常数据及私有对象保持，本次没有修改应用代码、阶段状态或验收结论。D1/D2/V 真实联网门槛仍按原交接记录保持 verification_blocked。

本次启动核对：ready_for_user_review。该状态仅指本次启动请求，不构成任何建设阶段 accepted。
