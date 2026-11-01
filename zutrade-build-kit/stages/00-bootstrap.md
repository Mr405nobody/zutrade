# 阶段 0 工程启动

本次只执行阶段 0。先读 MASTER_PROMPT 和 CONFIRMED_SCOPE，确认项目根目录。目标是建立可构建、可启动、有真实健康探针的工程骨架，为下一阶段提供可复现环境。

## 输入与前置检查

- 检查当前目录、Git 状态、仓库指令、Mac 架构、Node/pnpm、Docker daemon 和端口可用性。环境缺失时给出准确准备步骤，完成不受影响的工作。
- 检查 references 中的 SQL checksum、架构、产品说明与 approved-ui.png。原型只用于布局参考。
- 若已有工程，先评估可复用内容；不覆盖未知文件，不自动删除数据库 volume。

## 建设任务

1. 建立 pnpm workspace 和 apps/web、apps/api、apps/worker、共享 packages 的最小结构，配置 TypeScript strict、格式检查、lint、构建、开发命令和依赖边界。
2. 锁定兼容版本，解决 Node 24、NestJS 构建、ESM 和 pg-boss 的模块兼容，实际运行构建验证。保存版本决策，避免用 require/动态导入补丁掩盖构建错误。
3. Docker Compose 启动 PostgreSQL 18，绑定本机接口、使用持久 volume 和健康检查。开发服务默认只绑定 localhost；生成不进入 Git 的本地配置，提供 .env.example。
4. web 显示简洁的 ZuTrade 页面骨架与四入口。API 提供 /health/live 与 /health/ready：存活与数据库可用性分别报告。
5. worker 作为独立进程运行，执行真实数据库连接检查并输出可识别且有时间戳的心跳/结构化日志；网页只展示实际获取到的健康信息，不能写死 worker 在线。
6. 建立本地私有文件存储接口与受控 data 目录约定。此阶段不需要完成业务上传下载，但要确定服务端路径与未来对象接口边界。
7. 建立 docs/build 的进度、范围、ADR、验收与交接文件。工程根目录如需增加 AGENTS.md，仅写项目约定并保留已有指令，不能改变平台权限。

## 本阶段边界

此阶段可以只运行基础数据库健康查询，不安装完整业务模型、不创建假登录、不声称消息或审批已经完成。下一阶段 A1 才完成 42 表、认证和任务队列初始化。阶段 0 不能只输出计划文件。

## 必须验证

- doctor 能准确报告缺失依赖或就绪状态。
- 依赖安装、lint、typecheck、build 实际通过；仅验证当前实现范围。
- web、API、worker 都能分别启动；停掉数据库后 ready 失败，不能继续显示全绿；恢复后状态恢复。
- 重启 PostgreSQL 不自动重建或清空 volume；再次启动命令可复用。
- 环境文件、运行日志和本地数据被 Git 正确忽略，示例文件不含真实密钥。

## 交付与停点

提供准确的两到三条启动命令、页面地址、健康接口与 worker 日志检查方式。用户可以：启动依赖、启动工程、打开页面、停止/恢复数据库看真实状态。保存阶段报告，更新为 ready_for_user_review 后停止，不进入 A1。
