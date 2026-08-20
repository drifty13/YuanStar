# 浏览器 OCR 批次编排阶段 1B：事实映射

本文只记录当前仓库已验证的行为，并据此界定浏览器批次层；不把目标文本当成既有实现。

## 1. 当前单图内核与身份边界

| 主题 | 当前事实 | 阶段 1B 映射 |
|---|---|---|
| 单图入口 | `BrowserVisionEngine.analyzeImage(input, { confirmedPool, expectedPageType })` 输出完整 `BrowserImageAnalysisV1`。 | 每图直接保留该 contract，不转换为业务库存。 |
| 图片 ID | `BrowserImageInput.imageId` 是内核输入；occurrence ID 由 `imageId + pageType + 几何位置`（经验页为 ordinal）确定。 | `sourceImageId` 是调用方来源映射，必须与内容 `imageId` 分离；不生成 `starInstanceId`。 |
| 用户确认池 | `ConfirmedImagePool` 为 `{ imageId, pageType }`；仅当其 `imageId` 与输入相等时生效，冲突将进入 warning/review。 | 每张批次输入携带独立 confirmedPool，按原样传给该图。 |
| 引擎与 OCR session | `BrowserVisionEngineRuntime.initialize()` 调用模块级 `loadAndVerifyModels()`；`ocr.ts` 缓存唯一模型集并记录 session 创建数。 | 一个批次默认创建/初始化一次 engine，按 sourceOrder 串行复用；禁止每图初始化。 |
| bitmap | route bitmap 和 page pipeline bitmap 均由单图 `finally` 关闭；批次仅持有 `File`/`Blob` 引用。 | 批次层不缓存或关闭调用方输入，也不保存 bitmap。 |

## 2. 正式任务、账号与失败处理

| 主题 | 当前 Python/NiceGUI 事实 | 阶段 1B 映射 |
|---|---|---|
| 任务绑定 | `ImportTaskState` 有 task_id；启动时捕获 `ocr_state`、`ocr_account`、workspace 与深拷贝 overlap 对。 | 输入显式携带 taskId、accountId、baseRevision。 |
| 账号切换 | `workspace_mutation_locked()` 在任务运行中阻止切换；成功切换后清空页面任务临时状态。 | 纯批次层不能切换账号；应用前 guard 必须比较 accountId。 |
| 成功写回 | `run_import_transaction()` 先做分析，再通过 `state.apply_local_analysis()` 一次写入。 | 浏览器批次只返回结果；不写 UI、IndexedDB 或业务状态。 |
| 失败 | `ImportFailure` 保留 stage/type/message/traceback；UI 报错时保留旧数据、上传、分类和 overlap。 | 单图失败转为公开且审计安全的 batch error，其他图继续。 |
| 进度 | Python `ImportProgressEvent` 是纯数据，含阶段、完成数、当前图和 engine 初始化数。 | 浏览器事件同样纯数据，不执行写回。 |
| 取消 | 当前正式 OCR 只有启动前确认框的取消；未发现运行中取消或 AbortSignal。 | 新批次只能诚实实现“当前原子单图步骤结束后的最早安全边界停止”。 |

## 3. revision 与陈旧结果

`SessionState.postprocess_revision` 会随本地编辑变化；`WorkspaceStore` 的 revision 只用于阻止较旧的持久化快照覆盖较新快照。当前 OCR 任务并未把两者作为可跨层比较的账号 revision。故阶段 1B 不复用或猜测该字段，而把 `baseRevision` 作为调用方提供的透明契约字段；`canApplyBatchResult()` 只比较 result/base/current 的相等性。

当前正式 UI 已存在 taskId 相等检查：若活跃 task 已变，更晚完成的旧 worker 不会应用。批次层扩展同一保护为 taskId、accountId、baseRevision 三重纯函数判断。

## 4. 多图池、来源与 overlap

- `SessionState.uploaded_images` 保留上传顺序；业务行以 source_image/source_image_index 追溯来源。
- `image_pools` 有 main/support/experience/unknown 四种内部状态；`confirmed_image_pools` 保证人工确认不被自动建议覆盖。
- overlap 仅为用户确认的同一已确认 main 或 support 池中的有序图对；没有全图自动两两比较。`add_overlap_pair()` 不生成库存也不自动删除。
- 现有 overlap 是 Python 业务层类型，不能不经迁移直接塞进浏览器单图识别；阶段 1B 只记录此边界，不输出候选关系。

## 5. IndexedDB 与私有样本边界

`web/src/storage.ts` 是独立 PoC 存储入口；不被批次编排导入。Git 忽略的私有手机截取样本仅以匿名 case ID 表达其语义，不向代码、公开文档、日志或审查 ZIP 写入真实文件名或绝对路径。

## 6. 实施结论

Stage 1B 的批次编排核心实现已完成：新增浏览器纯模块负责顺序调度、进度、取消边界、逐图隔离、汇总、资源所有权和纯 apply guard。它依赖既有 `BrowserVisionEngine` 接口，不修改 Python、NiceGUI、阶段 1A 单图 contract、IndexedDB 或 overlap 算法。

已通过的最小验证包括：TypeScript typecheck、batch orchestration 专项、runtime-core 与主星/辅星/经验星曜回归、Python 定向测试、Vite build，以及 `git diff --check`。

当前没有正式批次 UI；真实批次页面操作和 Android 批次验收后移到“批次模块接入正式页面”阶段。这属于调用方尚未接入，不是批次编排核心实现失败。

## 7. 本轮实际改动范围

本轮范围仅包含以下五个文件：

- `web/package.json`
- `web/src/ocr.ts`
- `web/src/structured/batch-orchestration.ts`
- `web/tests/batch-orchestration.test.ts`
- `web/docs/browser_runtime_batch_orchestration_mapping.md`
