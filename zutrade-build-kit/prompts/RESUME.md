# 换会话或中断后继续

```text
继续当前目录中的 ZuTrade 项目。
先读 zutrade-build-kit/MASTER_PROMPT.md、specs/CONFIRMED_SCOPE.md，以及 docs/build/PROGRESS.md、HANDOFF.md、最近阶段报告和相关 ADR；specs 路径位于 zutrade-build-kit 内。
检查实际代码、Git 状态、数据库迁移与正在运行的服务，确认当前阶段和用户已经验收的节点。
本次只继续上一轮尚未完成的已授权阶段，不自动进入下一阶段。不要重新初始化工程，不删除现有数据，不用 reset 掩盖迁移或持久化问题。
先用一段话说明你核对到的当前状态，再完成该阶段剩余任务、验证和报告；完成后停在 ready_for_user_review。若当前已等待我验收，只指出验收入口，不自行展开后续阶段。
```
