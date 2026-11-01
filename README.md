# ZuTrade

Mac 本地代理销售工作台。0—C、E 已由用户接受；D1/D2 的真实联网及来源到批次链仍待补验。阶段 V 已授权提前执行本地集成、恢复、界面与交付；整体状态保持 **verification_blocked**，不以离线公司替代真实验收。消息为 simulation，AI 为可重放 mock/preset；不发送真实消息、不调用真实模型。

## 日常启动

```sh
cd /Users/warren/Desktop/ZuTrade
colima start --profile zutrade
./scripts/zu infra:up
./scripts/zu dev
```

使用 Docker Desktop 时可省略 Colima。日常已有数据，不必重新 seed。页面 http://127.0.0.1:5173 ，API/worker 为3001/3002，PostgreSQL18.6为55432（保留本机5432）。所有服务只监听loopback。统一使用 `./scripts/zu` 的 Node24.22.1/pnpm11.25.0，不能换全局版本。

`./scripts/zu db:accounts` 只输出私有文件路径，在本机打开取得随机密码。日常 Alex 沿用 `.local/b-accounts.json` 指向的原账号；原 v17/500件/USD1230、PDF及pending审批保留。owner/sales工厂权限由服务端验证，公众注册关闭。开发阶段验收不等于业务owner批准。

## 新设备与确实为空的数据库

```sh
./scripts/zu setup
./scripts/zu infra:up
./scripts/zu build
./scripts/zu db:configure
./scripts/zu db:provision
./scripts/zu db:migrate
./scripts/zu db:seed
./scripts/zu dev
```

setup保留已有.env；configure仅补缺失的独立随机凭据；provision配置受限角色。迁移检查已执行文件hash，重复运行不重建表；seed是显式初始化，不能用来掩盖丢失或覆盖旧业务。原始SQL和0000—0019迁移不得改写，禁止schema push、启动reset或删卷。

已有环境升级：先停止应用，备份数据库与私有对象；运行 `./scripts/zu build`、`./scripts/zu db:migrate`，再 `./scripts/zu start`。不要重新seed。pg-boss初始化/升级只在受控迁移身份下执行，runtime不持有DDL权限。V分别验证了带数据0018→0019升级和真正空库全部迁移启动。

## 保留数据重启

应用总启动终端按Ctrl+C，再运行 `./scripts/zu start`；源码变化先build。数据库用以下命令停止和启动同一容器与volume：

```sh
./scripts/zu infra:stop
./scripts/zu infra:start
./scripts/zu doctor --services
```

等待健康恢复后再打开页面，不重新seed。`zutrade_postgres_data`和私有 `data/private` 应保留。单独调试可先build，再开三个终端分别执行 `./scripts/zu dev:web`、`dev:api`、`dev:worker`；后端读取编译产物，改源码后需build。

## V 独立样例与验证

V页面 http://127.0.0.1:5673 ，停止后 `./scripts/zu ui:v`；API/worker为4101/4102。账号只在 `.local/v-test-last.json` 的 users.owner/users.sales。全部公司明确为离线测试数据。历史C/D1/D2/E样例分别5273/5373/5473/5573，不能当作真实来源链。

```sh
./scripts/zu build
./scripts/zu typecheck
./scripts/zu lint
./scripts/zu test:unit
./scripts/zu test:v
./scripts/zu test:v:recovery
./scripts/zu test:v:browser
./scripts/zu exec node scripts/v-security-audit.mjs
```

先关闭ui:v再执行测试。test:v每次创建新隔离数据库/私有目录并更新V指针；不改E或日常指针。recovery读取当前V样例，会短暂停启本项目同一PostgreSQL容器（所有本地服务暂失连接），不删卷；测试自行停止/重启V应用，恢复到新库与目录。执行恢复验证后再运行浏览器测试，勿并行争用V端口。测试库按精确名称保留，不模糊清理。

备份/恢复私有位置由 `.local/v-recovery-last.json` 指示，包括全库custom dump、private对象及manifest；目录700、文件600。备份含auth账号和模拟账本，不能进Git或直接分享。当前脚本仅接受V隔离源，拒绝对日常库自动恢复。日常备份应先停止所有写入者，在同一停止写入窗口执行pg_dump及对象复制；恢复始终新库/新目录，先provision角色，再核对版本、冻结摘要、附件字节和权限。没有在线备份或跨机器恢复保证。

前序验证入口保留：`test:integration`、`test:a2`、`test:a2:inbound`、`test:b`、`test:c`、`test:d1`、`test:d2`、`test:e`。各有独立库/端口条件，详见阶段报告；不应在日常库复现商业审批。真实 `prospecting:live` 仅在后续授权且服务器网络可用时补验，本次未执行。

## 常见故障

| 现象              | 处理                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| Node/pnpm不匹配   | 运行 `./scripts/zu setup`，所有入口继续用zu；保留.env                                               |
| Docker不可用      | 启动已有Docker Desktop或Colima profile，再infra:up；不修改代理                                      |
| 端口占用          | 停止已知同一服务或使用其现有页面，勿重复启动、勿盲杀其他应用                                        |
| 503或worker未就绪 | doctor --services；检查.local/logs/api.log、worker.log及infra:logs；数据库恢复后等待连接池/心跳恢复 |
| SSE断开           | 页面应显示断连；恢复后自动重连并从数据库补查；401重新登录，403/404核对成员及全部关联工厂            |
| 409版本冲突       | 刷新并核对最新消息/需求/审批版本，再显式发起新动作                                                  |
| PDF缺失或摘要不符 | 保留失败与原记录，从对应备份恢复原对象；不替换冻结文件假装成功                                      |
| SSRF_DNS_REJECTED | 当前fake-IP返回被安全边界拒绝；不关闭SSRF或改代理；留待可用真实网络补验                             |
| unknown           | 到请求区核对独立模拟账本；未查到不代表未发送，不能盲目重发                                          |
| 迁移checksum不符  | 停止升级，核对已执行原文件和日志，恢复正确文件或追加修复迁移，不改日志绕过                          |

.env、.local、data及日志均被Git忽略；私有附件不挂web public。日志和报告不得记录连接密码。API/worker为非owner、非superuser、无BYPASSRLS身份；业务事实、审批、任务、SSRF和冻结检查不能为演示关闭。

产品路径见 [操作手册](docs/PRODUCT_MANUAL.md)，实现对照见 [架构与数据库](docs/ARCHITECTURE_ACTUAL.md)，本次结果见 [V报告](docs/build/STAGE_V_REPORT.md)，人工步骤见 [ACCEPTANCE](docs/build/ACCEPTANCE.md)，续接与未验事项见 [HANDOFF](docs/build/HANDOFF.md)。
