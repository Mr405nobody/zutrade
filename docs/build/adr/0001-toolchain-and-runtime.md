# ADR 0001：锁定工具链、原生 ESM 与本地容器

日期：2026-10-28（Asia/Shanghai）。状态：已采用于阶段 0。

环境原为 macOS 26.2 arm64、全局 Node 25.6.1、环境提供的 pnpm 11.25.0；没有 Docker。项目目录只有 build-kit，没有 Git 或可复用正式代码。5432 已有本机 PostgreSQL，保留原进程。

采用项目私有 Node 24.22.1（官方 2026-10-21 LTS 安全补丁）和 pnpm 11.25.0。Node tarball 使用官方 SHA256 校验；二进制放 `.local/toolchain`，不修改全局 Node。`scripts/zu` 与嵌套 pnpm shim 保证使用同一 Node，避免环境提供的 pnpm wrapper 使用自身 Node 24.19.0。pnpm 内置 doctor 与项目脚本同名，`scripts/zu` 显式分派到 `pnpm run doctor`。

| 组件                       | 锁定版本          | 决定                                                                            |
| -------------------------- | ----------------- | ------------------------------------------------------------------------------- |
| Node / pnpm                | 24.22.1 / 11.25.0 | engineStrict；提交锁文件                                                        |
| TypeScript                 | 6.0.2             | typescript-eslint 8.72.1 的 peer 上限为 <6.1；因此未选 registry 的 TS 7         |
| NestJS                     | 12.3.2            | API 编译为 NodeNext ESM，直接使用静态 import                                    |
| pg-boss                    | 12.38.0           | 保持研究基线；要求 Node >=22.12；静态命名导入 PgBoss，无 require 或动态导入补丁 |
| Drizzle / pg               | 0.45.4 / 8.23.1   | 建立连接/ORM 工厂，阶段 0 无业务迁移                                            |
| React / Vite               | 19.3.1 / 8.3.5    | @vitejs/plugin-react 6.1.2，Tailwind 4.3.3                                      |
| Query / Lucide             | 5.105.0 / 1.63.0  | 仅健康查询与图标；不引入第二套状态主库                                          |
| ESLint / typescript-eslint | 10.13.0 / 8.72.1  | 官方 peer 范围匹配，严格检查工作区依赖边界                                      |
| Vitest / Playwright        | 5.0.5 / 1.64.1    | Node 24 可运行；浏览器使用本机 Chrome                                           |
| PostgreSQL                 | 18.6-bookworm     | 官方多架构镜像，实际运行 arm64，不指定 amd64                                    |

依赖版本/engines/peer 要求从 npm 官方 registry 查询，随后以实际安装、构建和运行结果校验。`@opentelemetry/api` 1.9.0 是 Drizzle/pg-boss 的必需 peer；仅满足模块契约，没有启用外部遥测。

Docker 环境使用 Homebrew 安装 Docker CLI 29.4.0、Compose 5.1.2、Colima 0.10.1（Lima 2.1.1），独立 profile `zutrade`，Apple Virtualization arm64，2 CPU / 2 GiB RAM / 20 GiB disk。Compose 脚本优先使用 Docker plugin，没有 plugin 时调用已安装的独立 `docker-compose`，不修改用户全局 Docker 配置。

PostgreSQL 映射 `127.0.0.1:55432`，web/API/worker 分别绑定 127.0.0.1:5173/3001/3002。持久卷挂载 `/var/lib/postgresql`，符合 PostgreSQL 18 官方镜像的新 PGDATA 布局；初始化脚本只在空卷执行。

容器管理员与健康查询 runtime 账号分离。runtime 为 NOSUPERUSER、NOCREATEDB、NOCREATEROLE、NOBYPASSRLS，无 schema CREATE。A1 仍需实现迁移角色、业务授权、认证身份发现、RLS 和真实队列事务，阶段 0 不提前声称这些门槛通过。

官方依据：[Node 发布说明](https://nodejs.org/en/blog/release/v24.22.1)、[Nest 入门](https://docs.nestjs.com/first-steps)、[TypeScript 6](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html)、[pg-boss](https://pgboss.io/introduction)、[PostgreSQL 镜像](https://github.com/docker-library/docs/blob/master/postgres/README.md)、[PostgreSQL 18.6](https://www.postgresql.org/docs/18/release-18-6.html)。完整直接依赖和许可见根目录 THIRD_PARTY_NOTICES.md。

## 实际下载与镜像身份

Docker Hub 连续三次出现 TLS 握手超时。为本项目新建的 Colima profile 配置 Google 官方 Docker Hub 缓存 `https://mirror.gcr.io`、下载并发 1、重试 10；不更改用户其他 profile 或全局代理。参考配置保存在 infra/colima.example.yaml，日常启动继续使用原命令。

镜像缓存与 Docker Hub 官方 tag 的 OCI index 摘要均为 `sha256:5c4783a8cc3f0074912164f94dfa1be4e043438f0f707cf968d7af9a0d31a2c8`，通过 Docker Hub 官方 registry 的真实清单查询核对，证据见 evidence/postgres-image-source.json。Compose 固定这个摘要，实际 image inspect 为 arm64。没有使用第三方重新打包镜像，也未关闭 TLS 校验。

[Google 官方缓存文档](https://docs.cloud.google.com/artifact-registry/docs/pull-cached-dockerhub-images)说明可通过 daemon 的 registry-mirrors 使用缓存；没有账号或付费服务。未来缓存不可用时会回源 Docker Hub，首次下载仍依赖可用网络。
