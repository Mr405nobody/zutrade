# PDF QA，2026-10-28

真实执行：`./scripts/zu --filter @zutrade/domain build`、`./scripts/zu exec node scripts/verify-b-pdf.mjs`、bundled Python `scripts/check-b-pdf.py`、Poppler `pdftoppm -scale-to 1200 -png`，退出码均为 0。PDF 专项 Vitest 2 项、领域 strict typecheck 通过。

首轮解析失败：500 件 4 页、长条款 12 页，其中一半为只有页脚的空页；原因是 PDFKit 页脚 text 超过 bottom margin 而自动建页。修复页脚绘制的底边距后重新渲染，当前 500 件 2 页、长条款 6 页。初次 PNG 保留在 `initial-footer-regression`，不作为当前通过证据。

当前文本/几何检查：1230.00 / 1200.00 / 30.00、CT-01、中文工厂名、六周请求和不承诺到达条款均存在；内部成本探针、事实/来源内部 ID 未泄漏；每页有 SIMULATION；无空白页；所有可见字符在页面几何边界以内。长条款第 35 项存在。

当前视觉检查：人工查看 `revised-500-1.png`、`revised-500-2.png` 与 `long-contact-sheet.png`，中文无方框，行金额清楚，文本无水平截断/叠印，长条款跨页正常，页码和模拟标识正常。QA fixture 使用固定时间；实际业务使用冻结日期和时区。

这些为 PDF 渲染专项证据，不能替代真实 API/数据库权限、manifest 失败重试与持久化集成检查。
