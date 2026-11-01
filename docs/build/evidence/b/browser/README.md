# B 浏览器验证

执行：2026-10-28（Asia/Shanghai）。

实际命令：`./scripts/zu exec playwright test b.spec.ts`，退出码 0，desktop / mobile 共 2 个项目通过。视口为 1440×1000 和 390×844（手机截图按设备像素比输出）。测试使用 `.local/a2-browser-accounts.json` 的既有独立测试工作区与 Alex 会话，不接触日常演示工作区。每次新建独立模拟产品与来源，保留历史。

已验证行为：

- 产品入口实际上传文本来源；追加 v2，v1 下载字节不变；owner 发布对应价格。
- 会话内部保存 500 件需求、生成 USD 1230.00、显式生成 PDF；重复下载字节一致。
- 改为 800 件生成 USD 1950.00；旧版本完整需求和金额保留；界面可切换历史并显示重核状态。
- 未知运费、税费与样品费保持排除说明；内部备注未进入英文预览。
- 独立产物 manifest 的处理状态由测试准备为持久的 failed / PDF_GENERATION_FAILED；浏览器显示失败并通过真实 POST 显式重试成功。本项是错误状态界面夹具，**不声称浏览器测试制造了真实磁盘写入故障**；实际失败存储恢复由服务/数据库测试另行证明。
- 499 件被真实接口阻止，显示具体待确认依据；注入旧 expectedVersion 获得真实 409 并显示冲突。
- 仅撤回本轮独立来源后，界面显示具体来源失效原因；刷新保留历史与已保存 PDF。
- 两种视口均检查 document 横向溢出为 false，无浏览器 pageerror。已人工查看两种宽度的产品与报价截图，文字、金额、状态、四入口与内部区均可读。

证据：`desktop-browser.json` / `mobile-browser.json` 保存本轮对象 ID、PDF 字节摘要和结果；同目录 PNG 为对应真实页面截图。

失败和恢复：首次 APIRequestContext POST 未携带 Origin，被既有 CSRF 边界拒绝 403；测试修正为使用页面 Origin。随后修正来源上传表单定位、select 的明确可访问名称及多 alert 精确定位。实际发现报价工作区 GET 500，原因是后端查询 audit_events.created_at（真实字段为 occurred_at），修复并重建后重跑通过。上述均未通过放宽权限或模拟成功绕过。

通过后，测试增加了 finally 使用最新 expectedVersion 恢复运行前需求的保护（保留修订和测试报价历史）；该保护已通过静态类型和 lint 检查，先前成功运行的 JSON 不声称执行过新增保护。交付前演示 CT-01 需求与可用当前报价由集成流程恢复并核对。
