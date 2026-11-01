# 阶段 0：工程启动报告

后续记录：用户于 2026-10-28 明确验收阶段 0，现为 accepted。下文保留当时自测交付记录；当前阶段见 PROGRESS.md。

日期：2026-10-28（Asia/Shanghai）。状态：**ready_for_user_review**。用户尚未验收。本次未进入 A1。

## 已完成的实际行为

- 在 `/Users/warren/Desktop/ZuTrade` 从零建立本地 Git 仓库和 pnpm workspace，保留全部 build-kit 原件。原目录没有正式代码或 Git 历史。
- web、NestJS API、独立 worker 已真实启动；页面四入口可切换，业务为空状态并说明开放阶段，没有假登录、消息、客户或报价。
- 页面实际轮询 API 存活/就绪信息，分别显示 Web、API、Docker PostgreSQL 和 worker。停止数据库、停止 worker、API 请求失败时会显示对应失败或未知；恢复后自动刷新。
- PostgreSQL 18.6 运行于原生 arm64 Docker 容器。使用持久命名卷、容器健康检查、本机 55432 端口及受限 runtime 账号，未使用原有本机 5432 数据库。
- worker 每 5 秒执行真实数据库查询，输出带 UTC 时间和实例 ID 的 JSON 心跳；API 通过其独立 3002 探针判断活性，15 秒过期，不写死在线。
- 私有文件接口实际支持 SHA256 不可变写入及读取校验；目录 `data/private` 权限 700，文件 600。没有业务上传/下载路由或 public 挂载。

## 主要模块与版本

`apps/web` / `api` / `worker`；共享 `packages/domain`、`db`、`contracts`、`channels`、`ai`、`ui`、`config`、`storage`；`infra`、真实检查脚本与测试。

Node 24.22.1、pnpm 11.25.0、TypeScript 6.0.2、NestJS 12.3.2、React 19.3.1、Vite 8.3.5、Tailwind 4.3.3、Drizzle 0.45.4、pg 8.23.1、pg-boss 12.38.0、Vitest 5.0.5、Playwright 1.64.1。锁文件已保存，未使用 require/动态导入补丁。pg-boss 原生 ESM 导入、编译和实际进程加载通过，**没有初始化队列或执行任务**。

直接依赖与复制的 shadcn Button 来源/许可证见根目录 THIRD_PARTY_NOTICES.md 和 licenses；架构决定见 ADR 0001/0002。

## 环境处理与真实故障

初始环境：macOS 26.2 arm64、全局 Node 25.6.1、环境 pnpm 11.25.0，没有 Docker。5432、5000、7000 等原有服务被保留。项目使用 5173/3001/3002/55432，均绑定 127.0.0.1。

项目工具链放 `.local/toolchain`，未替换全局 Node。通过 Homebrew 安装 Docker CLI 29.4.0、Compose 5.1.2、Colima 0.10.1 与 Lima 2.1.1。Docker daemon 为 29.2.1/linux arm64，context 为 colima-zutrade。

实际修复过：缺失 `@opentelemetry/api` 必需 peer（安装曾退出 1）、嵌套 pnpm 使用环境自带 Node 24.19.0（构建曾退出 1）、TS 6 需要显式 Node types（构建曾退出 2）。修复后安装、类型、lint、构建均通过，未关闭严格 peer 或类型检查。

Docker Hub 拉取连续三次 TLS 握手超时，未伪装为成功。新建的 zutrade profile 已配置 Google 官方镜像缓存、下载并发 1 和重试 10，随后 canonical `postgres` 拉取成功。缓存与官方 registry 的 OCI index 摘要完全一致：`sha256:5c4783a8cc3f0074912164f94dfa1be4e043438f0f707cf968d7af9a0d31a2c8`，Compose 固定此摘要；证据见 [镜像来源](evidence/postgres-image-source.json)。没有账号、费用或关闭 TLS 校验。

## 启动与访问

在项目根目录日常运行：

```sh
colima start --profile zutrade
./scripts/zu infra:up
./scripts/zu dev
```

本机工具链、依赖及 `.env` 已准备。新设备/新 checkout 首次运行 `./scripts/zu setup`；它会下载并校验 Node、安装固定 pnpm/锁文件依赖、生成随机本地密码，保留既有 `.env`。本机已重复运行验证幂等。若已有 Docker Desktop daemon，可省略 Colima 命令。

| 用途          | 地址/命令                                               |
| ------------- | ------------------------------------------------------- |
| 页面          | http://127.0.0.1:5173                                   |
| API 存活      | http://127.0.0.1:3001/health/live                       |
| API 就绪      | http://127.0.0.1:3001/health/ready                      |
| worker 就绪   | http://127.0.0.1:3002/health/ready                      |
| 数据库        | 127.0.0.1:55432，凭据仅见本地 `.env`                    |
| worker 日志   | `tail -f .local/logs/worker.log`                        |
| 容器状态/日志 | `./scripts/zu infra:status` / `./scripts/zu infra:logs` |

本阶段没有测试账号，不需要登录。应用仅提供本地工程页面和健康接口。独立启动方式见 README/HANDOFF；Ctrl+C 停止应用而保留数据库。

## 实际执行的验证

| 验证                     | 实际命令/操作                                                    | 结果与退出码                                                                                                  | 证据                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 固定依赖安装             | `./scripts/zu install --frozen-lockfile`                         | 通过，0                                                                                                       | [安装](evidence/install.txt)、[命令记录](evidence/checks.json)                                                                  |
| 重复准备                 | `./scripts/zu setup`                                             | 通过，0，已有环境未覆盖                                                                                       | [输出](evidence/setup-repeat.txt)、[配置](evidence/configuration.json)                                                          |
| 环境 doctor              | `./scripts/zu doctor --services`                                 | 全部通过，0                                                                                                   | [就绪检查](evidence/doctor-ready.txt)                                                                                           |
| 缺失环境识别             | 暂时移走 `.env` 执行 doctor，再原样恢复                          | 正确拒绝，预期 1                                                                                              | [缺失环境](evidence/doctor-missing-env.txt)                                                                                     |
| 缺失 Docker daemon 识别  | 首次执行项目 doctor                                              | 正确报错，预期 1                                                                                              | [初始检查](evidence/doctor-before-docker.txt)                                                                                   |
| lint/格式/依赖边界       | `./scripts/zu lint`                                              | 通过，0；11 个子包，无循环或浏览器依赖服务端                                                                  | [lint](evidence/lint.txt)                                                                                                       |
| 严格类型                 | `./scripts/zu typecheck`                                         | 通过，0；包含应用、包、测试和配置                                                                             | [类型检查](evidence/typecheck.txt)                                                                                              |
| 构建                     | `./scripts/zu build`；实际 `dev` 也先构建                        | 全部通过，0                                                                                                   | [构建](evidence/build.txt)                                                                                                      |
| 私有对象单元测试         | `./scripts/zu test:unit`                                         | 4/4 通过，0；持久字节、重复不可变写、篡改拒绝、越界/目录拒绝                                                  | [单元测试](evidence/test-unit.txt)                                                                                              |
| Docker 启动              | `./scripts/zu infra:up`                                          | 容器 healthy，0                                                                                               | [启动](evidence/infra-up.txt)                                                                                                   |
| 三进程真实运行与故障恢复 | `./scripts/zu verify:runtime`                                    | 8 项检查通过，0                                                                                               | [真实探针与恢复记录](evidence/runtime.json)                                                                                     |
| worker 停止/恢复         | 实际停止独立 worker，再启动新实例                                | API live 200、ready 503、DB 仍 ok；恢复 200                                                                   | 同上                                                                                                                            |
| PostgreSQL 停止/恢复     | `infra:stop` / `infra:start`                                     | API ready 和 worker ready 503；live 200；恢复后 200                                                           | 同上、浏览器截图                                                                                                                |
| volume 与应用重启        | 重启 DB、重复 infra:up、重启 API/worker，再按固定摘要重建容器    | 系统标识始终 `7701697112392880170`，未重建/清空卷                                                             | [运行记录](evidence/runtime.json)、[容器重建](evidence/infra-recreate-pinned.txt)、[最终数据库](evidence/postgres-runtime.json) |
| 浏览器实际验收           | `./scripts/zu test:e2e`，本机 Chrome，1440×1000 与 390×844       | 2/2 通过，0；无 pageerror、无横向溢出；四入口、刷新、API 请求中断/恢复、刷新页面；桌面实际停止/恢复 Docker DB | [结果](evidence/browser.txt)、[摘要](evidence/browser-summary.json)                                                             |
| 端口冲突                 | 运行中再次执行 `./scripts/zu start`                              | 明确拒绝，预期 1                                                                                              | [配置检查](evidence/configuration.json)                                                                                         |
| 原始 SQL 与密钥忽略      | SHA256/字节数、git check-ignore、扫描候选 Git 文件的本地密码匹配 | 全部通过，0，无密码匹配                                                                                       | [仓库检查](evidence/repository-hygiene.json)                                                                                    |

额外核对了真实存在的环境文件、运行日志、临时私有对象及 Git 元数据的 HTTP 访问，四项均返回 403；临时对象检查后已删除，见 [私有 HTTP 边界](evidence/private-http-boundary.json)。

截图已经实际查看：[桌面正常](evidence/desktop-healthy.png)、[手机正常](evidence/mobile-healthy.png)、[数据库停止](evidence/desktop-database-stopped.png)、[API 请求中断](evidence/desktop-api-unavailable.png)。截图不替代 runtime.json 中的真实探针结果。

## 数据与迁移

只创建基础设施 runtime 角色；查询确认 NOSUPERUSER、NOBYPASSRLS、NOCREATEDB、NOCREATEROLE。业务、认证、队列 schema 数量为 0。无迁移版本、无 seed、无账号或业务记录。原始 SQL 保持 75,172 字节及规定 SHA256，详见 MIGRATIONS.md。

数据库 volume 为 `zutrade_postgres_data`，挂载 `/var/lib/postgresql`；文件目录为 `data/private`。不得删除卷、暗中 reset 或覆盖本地环境配置。`.env` 为 600，data/private 为 700，相关目录正确忽略。

## 亲自验收

完整 5 步见 [ACCEPTANCE.md](ACCEPTANCE.md)：打开页面看四项真实状态，切换四入口并刷新，打开原始健康结果，停止/恢复数据库，只停止/重启 worker。每步均有预期画面与恢复命令。

## 未完成、未验证与阻塞

- **本阶段未完成：无关键剩余项。** 环境网络问题已经解决，当前无验证阻塞；服务保持运行供验收。
- **未验证环境：** 没有在第二台 Mac、x64 主机、真实手机硬件或 Docker Desktop 上重复安装。本机 arm64、Chrome 桌面及手机视口已经验证。新设备的空缓存首次安装仍依赖网络；本机重复 setup 已通过。
- **明确未实施的后续范围：** A1 的 42 表、Better Auth、RLS 与 pg-boss 官方初始化/事务行为；A2/C 的模拟收发与网关；E 的 MockAIProvider 场景输出；D1 的真实企业发现；业务附件鉴权下载。未用 stub 或空脚本宣称这些能力完成。
- 浏览器断网测试通过请求中断复现；数据库停止使用真实 Docker 操作。没有执行真实渠道、真实模型、真实企业发现或跨租户/金额/审批竞态测试，因为它们尚未实现，属于后续阶段。

## 续接与停点

当前分支 `stage-0-bootstrap`，本机未配置 Git user.name/email，所以尚无提交，文件未暂存；没有代填身份、远程推送或部署。所有工程、锁文件、进度、范围、ADR、验收与交接文件已保存在磁盘。下一会话先看真实 Git/容器/端口状态和 HANDOFF。

**停止在 ready_for_user_review。等待用户验收，不自动执行 A1 或后续阶段。**
