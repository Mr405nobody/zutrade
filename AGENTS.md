# ZuTrade 项目约定

- 当前工程根目录是本文件所在目录。开始工作先读 `zutrade-build-kit/MASTER_PROMPT.md`、确认范围、当前阶段文件和 `docs/build` 交接记录。
- 每次只执行用户授权的一个阶段。自测通过写 `ready_for_user_review`；用户验收前不得写 `accepted`。
- 使用 `./scripts/zu` 运行项目锁定的 Node/pnpm；不要用全局 Node 版本替代项目工具链。源码采用 ESM 和 strict TypeScript。
- 保持 build-kit 原始 SQL 和参考资料不变。迁移只在相应阶段添加；禁止 schema push、启动时 reset 或删除日常数据库 volume。
- 浏览器仅依赖 contracts/ui；领域包不依赖应用入口。共享包通过公开导出使用，边界由 lint 检查。
- `.env`、`.local` 和 `data` 不进入 Git；私有对象不挂载到 web public。日志与报告不记录连接密码。
- 消息模拟、AI 模拟与真实企业发现分别配置。当前阶段不启用真实消息发送、真实模型或业务发现功能。
- 变更与实际验证记录在 `docs/build`，保留真实失败和恢复结果。
