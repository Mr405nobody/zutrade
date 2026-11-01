# ADR 0006：冻结报价与私有 PDF 产物分离

日期：2026-10-28（Asia/Shanghai）。阶段 B，采用。

报价版本先在单个业务事务内完成需求、卖方、接收人、金额、条款和证据快照，计算规范化摘要后冻结。`terms_snapshot.snapshot` 的 `b-quote-v1` 规范化 JSON 是报价摘要范围，包含证据标识；不包含 PDF 字节摘要或产物生成状态。PDF 不反写冻结版本。

0005 添加单用途 `quote_pdf_artifacts`，绑定 workspace、factory、quote version、报价摘要与 `quote-pdf.v1` 模板。数据库检查报价已冻结且摘要完全匹配；复合外键隔离租户/工厂，唯一键约束一个版本和模板最多一个产物。状态为 pending、failed、ready；ready 的身份、对象引用与字节摘要永久不可更新/删除。此表不是通用文档管理系统。

用户显式调用生成/重试命令，使用独立于报价冻结的工作区事务。生成采用 PDFKit；内嵌 OFL 许可 Noto Sans CJK SC，保持中文工厂名称与英文条款可读。仅枚举外发字段，忽略内部备注、成本和原始证据附件。金额直接读取冻结快照，不运行另一套计算器。每页包含 SIMULATION；头部明确 INTERNAL PREVIEW / NOT APPROVED FOR SENDING。没有批准或发送状态。

生成依次锁住唯一产物行、设为 pending、渲染到有界内存 Buffer、向已有 LocalPrivateObjectStore 写不可变对象、readVerified 校验实际字节，最后写 ready manifest。内容地址 sha256 同时作为 local object_key / object_version 和 PDF 字节摘要；它与报价快照摘要是两个不同值。PDF 渲染在有界内存中完成；存储适配器复制输入字节后计算摘要，在真实私有根目录对应的摘要前缀内创建随机、独占、0600 权限的临时文件。完整写入、fsync 并关闭后，以同目录 hard link 原子发布摘要键；hard link 不覆盖已存在的目标。目标存在时先校验已有字节；发布后重新校验并 fsync 目录，最后仅 unlink 本次临时名称。PDF 规模受冻结字段、条款数量和长度上限约束。

渲染/对象写入失败会返回 failed，并持久化固定错误代码而不保存任意异常文本。API 必须提交此失败状态，不把失败当成功下载。显式重试复用同一 manifest，failed 先转 pending；并发生成由行锁串行，后来的请求复用已经 ready 的对象，不渲染第二个产物。

若进程在临时文件写入期间退出，只有未引用的 `.pending-*` 文件可能保留，最终摘要键不会成为半写文件；失败调用在 finally 中仅移除自己创建的临时文件。若进程在对象原子发布后、数据库提交前退出，数据库保持原 pending/failed；无 manifest 引用的完整对象可能留在私有目录。重试只写不可变内容地址对象，绝不覆盖已发布字节。本阶段不扫描或自动清理其他进程的临时文件和历史对象，避免删除仍在写入或被历史引用的文件。存储会检查根目录 realpath 仍在 private 且不在 public，拒绝摘要前缀和最终对象的 symlink。若进程在首次 manifest 插入前退出，没有 ready 记录；查询如实显示待生成。ready 只会在对象写入并验证后提交。

状态查询、生成、下载均调用 `requireQuoteVersion`，从数据库追溯 quote → opportunity → 全部 linked threads，复用 A2 完整线程授权；不接受可省略的 thread 参数。未登录和停用用户先由 API / workspace 事务拒绝。历史失效报价可以按当前权限下载旧 PDF，以保留历史；失效事实不会改变历史金额、条款或字节。

下载仅用已存储 manifest 读取并校验 sha256/长度，绝不自动重新渲染。如果已发布文件缺失或损坏，下载返回明确冲突；状态查询将展示 `PDF_OBJECT_UNAVAILABLE`，保留数据库 ready 记录和历史引用。恢复应找回原字节，不能换一份 PDF 冒充原产物。

实际渲染和文本证据在 `docs/build/evidence/b/pdf`。首轮真实 QA 捕获页脚落入 PDFKit 底边距外而产生页脚专用空页；修复绘制页脚时的底边距后，500 件为 2 页、长条款为 6 页；中文、1230.00、价款、排除项、最后一项长条款及全页几何边界通过解析，并人工检查 Poppler PNG。

实现依据：[PDFKit 文本与字体](https://pdfkit.org/docs/text.html)、[bufferPages 与页码](https://pdfkit.org/docs/getting_started.html)、[Noto CJK 字体](https://github.com/notofonts/noto-cjk)。锁定版本与许可证见 package manifest、lockfile 和 `packages/domain/assets/OFL.txt`。

原子存储补充验证：保留原有 4 项存储测试，增加 8 个并发相同内容发布、孤立的中断临时文件不会阻止有效写入、private 路径 symlink 到 public 被拒绝、注入写入 3 字节后失败并重试成功。失败注入确认最终摘要键未出现且本次临时文件已清除；不修改或删除历史对象。与 PDF 2 项合计 10 项通过。
