# 源码 Git 上传记录

2026-11-01（Asia/Shanghai）。用户明确授权将全部相关源码上传至 `Mr405nobody/zutrade`。本次只整理、验证和上传现有工程，不启动新的建设阶段，不改变阶段验收状态。

## 上传范围

- web、API、worker、共享包、原有 SQL 迁移、脚本、测试、锁文件和工程配置。
- README、许可证、操作及架构文档、build-kit 原始参考资料、已有建设报告和验证证据。
- 保留 `.env.example` 作为配置模板。`.env`、`.local`、`data`、依赖目录、构建产物和运行日志按现有 `.gitignore` 排除。
- 原始 SQL 与参考资料不修改；不运行迁移、seed、reset 或数据库卷操作，不启用真实消息或模型。

## 上传前实际验证

| 检查                                                       | 实际结果                                                                               |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| GitHub 连接器访问仓库                                      | 返回 404；本机 GitHub CLI 未登录，HTTPS 无可用凭据                                     |
| 现有 SSH 连接                                              | GitHub 确认身份为 Mr405nobody；SSH 读取目标仓库成功，尚无远端 refs                     |
| Git 候选文件                                               | 新增本记录前 979 个文件，46,532,018 字节；无超过 GitHub 单文件限制的大文件             |
| 私有材料排除                                               | `.env`、`.local`、`data/private`、node_modules、web/dist 均被忽略                      |
| 凭据核查                                                   | 对照本机配置中的 90 个敏感值，候选文本未发现匹配；未发现私钥及常见 GitHub/AWS 令牌格式 |
| `./scripts/zu exec node scripts/baseline-copy.mjs --check` | 退出 0，原始 SQL 校验和及精确两行转换一致                                              |
| `./scripts/zu lint`                                        | 退出 0，格式与 12 个包的依赖边界通过                                                   |
| `./scripts/zu typecheck`                                   | 退出 0                                                                                 |
| `./scripts/zu test:unit`                                   | 退出 0，9 个测试文件、100 个测试通过                                                   |
| `./scripts/zu build`                                       | 退出 0；保留已有前端单包超过 500 kB 的提示                                             |

本次没有重跑数据库集成、浏览器或真实获客验证；既有失败与恢复记录保留。D1、D2、V 仍为 `verification_blocked`，不能将源码上传视为功能验收通过。

首次暂存检查 `git diff --cached --check` 退出 2，原因仅为历史证据中的行尾空格/末尾空行，以及已冻结的 `0000_baseline.sql`、`0012_delivery_retry_identity.sql` 末尾空行。保留这些文件原始字节，不改写历史日志或迁移；排除上述既有材料后，源码与本次记录的暂存空白检查退出 0。

提交及推送使用 `codex/source-import` 分支，远端通过 SSH 连接到用户指定仓库。提交作者使用 SSH 已验证的 GitHub 用户名和对应的 GitHub noreply 邮箱，不修改全局 Git 身份配置。推送后核对远端分支 SHA 与本地提交相同，并确认工作区没有遗漏的非忽略文件；实际提交链接随本次交付提供。
