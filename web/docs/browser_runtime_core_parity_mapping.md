# 浏览器识别内核生产对齐阶段 1A：事实映射

本文记录当前 Python 生产实现、catalog、浏览器 runtime core 与测试的事实，不把目标文本当作既有行为。实现基线为本分支创建前的 commit `1a8b295`（`poc: add structured support and experience runtimes`）。

## 1. 正式输出与空值语义

### Python 生产类型

| 职责 | 当前事实来源 | 关键字段与语义 |
|---|---|---|
| 单图分析 | `src/yuanstar/vision/models.py::SingleImageAnalysis` | `image_id`、`viewport`、`page`、`cards`、`stars`、`warnings`、`experience`、`bag`、`equipped_classifier_calls`、`content_bounds`；`as_dict()` 使用 dataclass 字段名输出 |
| 页面 | `PageClassification` | `page_type` 为 `main`、`support`、`experience`、`unknown`；`confidence` 为 0–1；`evidence` 是字符串列表 |
| profile/内容边界 | `ViewportResult` | 原图尺寸、原图坐标 `viewport_box`、profile id、confidence、warnings；主/辅星 `content_bounds` 是 `(top, bottom)`，经验页通常为 `None` |
| 卡片几何 | `CardCandidate` | `row_index`、`column_index`、`box_original`、`box_normalized`、`is_complete`、`completeness_confidence`、name/level ROI、圆盘；完整性与 OCR 成功独立 |
| 普通星曜 | `RecognizedStar` | `raw_name_text`/`canonical_name`、`raw_level_text`/`level`、`quality`、`equipped_state`、各字段 confidence/source/warnings、`review_required` |
| 导入边界 | `DetectedStarItem` | `recognized_name`/`final_name`、`recognized_level`/`final_level`、`recognized_quality`/`final_quality`、`equipped_state`、`field_warnings`、`manual_override`；该类型属于业务导入层，不能直接塞入浏览器纯识别 contract |
| 经验星曜 | `ExperienceStoneResult` | `orange_count`、`purple_count`、`white_count`，各自 confidence，`complete`、warnings、按类型的 evidence；数量空值是 `None`，不是 0 |

Python 的普通星曜缺失字段使用 `None`；品质未知不使用默认品质。经验页只有整页 `complete=True` 时，未出现的类型才安全回落为 0，否则保持 `None`。`not_evaluated` 是 Python 普通星曜佩戴状态的合法初始值，另有 `equipped`、`unequipped`、`unknown`。

### 浏览器当前输出

浏览器保留 `MainStarResult`/`ExperienceResult` 作为旧 diagnostic 输出，同时由 `BrowserVisionEngineRuntime` 统一生成 `BrowserImageAnalysisV1`。普通 occurrence 和经验 occurrence 使用确定性 ID，contract 包含品质、佩戴、direct/effective、source rect、provenance、review 与页面路由证据；业务账号、revision、库存和 IndexedDB 不进入该纯识别 contract。

当前旧 diagnostic 已有：profile、候选与完整性、行列、原始/标准化名称、等级、status/reasons、raw OCR candidates、source rects、阶段耗时与 JSON。失败入口会清空本入口旧 bitmap、结果、表格和 JSON；这些能力必须保留。

## 2. 品质识别

### Python 事实

来源为 `src/yuanstar/vision/quality_recognizer.py`：

- ROI 是每张卡 `box_original` 内部的相对环带 `_annulus`，半径范围 `0.62 <= r <= 0.96`，不使用页面绝对坐标。
- 输入为 BGR，转 HSV；彩色像素为 `S >= 52`，中性亮像素为 `S <= 45 and V >= 150`。
- 五个 canonical 值由 `src/yuanstar/domain.py::Quality` 和 recognizer 共同确认：`橙`、`紫`、`蓝`、`绿`、`白`。灰/白命名不是推测：白色特殊规则的 canonical 值确实是 `白`。
- 白色：`white_ratio >= 0.56` 且 `colour_ratio <= 0.24`，confidence 为 `min(0.92, 0.55 + white_ratio * 0.42)`。
- 彩色不足：`colour_ratio < 0.16`，返回 `None`、0 confidence、`quality_low_saturation` 与 `quality_unknown`。
- 彩色候选的目标 hue 为橙 12、紫 142、蓝 106、绿 61；使用彩色像素 hue 中位数，环形距离大于 19 或 `colour_ratio < 0.34` 时返回 `None`，warnings 为 `quality_visual_conflict` 与 `quality_unknown`。
- 确认彩色的 confidence 为 `min(0.93, 0.40 + colour_ratio * 0.38 + (19 - distance) / 19 * 0.25)`，warning 为空；evidence 保留 hue、distance、saturated 或 neutral 统计。
- `OfflineSingleImagePipeline` 以 `quality_source="visual_background"` 表示识别成功，以 `unknown` 表示没有品质；`review_required` 在 quality 为 `None` 时为真。品质未知不能删除卡片或改成默认橙色。

### 浏览器实现

浏览器 `quality-postprocess.ts` 已按上述相对环带、阈值、canonical 值、confidence 和 warning 迁移；彩色 hue 使用 `colourful` 像素的中位数，不使用算术平均。质量未知保留卡片 occurrence，并进入 review。

真实匿名主星和辅星样本逐卡品质对比均一致；对比表和样本范围记录在 review package 的 `06_quality_parity.md`。

## 3. 佩戴与层级后处理

### 佩戴视觉证据

来源为 `src/yuanstar/vision/hierarchical_order.py`：

- 佩戴 ROI 相对卡框：`x=-0.065w`、`y=0`、`width=0.37w`、`height=0.36h`。
- `classify_equipped_roi` 只判断头像式高颜色熵与简单锁/锚点式低颜色熵，不识别人；ROI 缺失或过小返回 `unknown` 与 `equipped_roi_missing`。
- 颜色熵 `>= 4.05` 为 `equipped`；`<= 3.95` 时按 confidence 判断 `unequipped` 或 `unknown`；中间区间为 `unknown` 与 `equipped_colour_entropy_conflict`。
- `recognize_equipped` 的 source 是 `relative_anchor_colour_entropy`；`recognize_equipped_on_demand` 只在无法由品质/等级边界解释的局部边界按需调用，并返回实际 classifier call 数。
- `infer_equipped_sandwiches` 使用同一张图的快照，仅允许 `equipped / unknown / equipped` 推断中间项；推断结果不会回写为下一轮传播输入。

### 层级分段与 provenance

`apply_hierarchical_order` 是当前 Python 的正式连续段规则：

- 先按 `(equipped_state, quality)` 连续分段；quality 缺失或 equipped 为 `unknown` 的卡单独成为不确定段，因此不会跨品质或跨佩戴状态传播。
- 每个分段使用同一个 base snapshot；direct level 仅来自 `level_source == "direct_ocr"` 的 `direct_level`，人工值可由 `manual_review` 使用。旧的 inference source 不会成为新的 direct evidence。
- 后续等级顺序按降序检查；同一段 `[60, unknown, 60]` 可作唯一夹心推断，`[60, unknown, 40]` 保持 pending；冲突只标记导致上升的后项 `hierarchical_level_order_conflict`。
- 连续段、等级冲突、等级夹心、`equipped_boundary_indexes` 与 equipped snapshot 夹心都只按 `(row_index, column_index)` 的 row-major 排序滑动；Python 不在 `r1c4 -> r2c1` 处自动切段。品质或 equipped state 改变仍会切段，snapshot 夹心不链式传播。`apply_hierarchical_name_sandwich` 是例外：它有显式同一行连续列条件，因此跨行不推断名称。
- stale level warnings 会在本轮层级重算前清除；人工值不被层级排序覆盖。
- 名称夹心要求同图、连续相邻、同 equipped、同 quality、同 level、左右名称相同且左右 name source 为 `direct_ocr` 或 `manual_review`；`hierarchical_sort_sandwich_inference` 不能再作为后续传播证据。
- `RecognizedStar` 的 `direct_level`、`level_source`、`level_provenance`、`name_source`、`quality_source`、`equipped_source` 是当前可迁移的 provenance 事实。当前 Python 没有独立 `direct_name` 字段，缺失 direct 名称需由 raw OCR/name source 表达，不能伪造 direct canonical name。

### 浏览器实现与真实边界样本

浏览器已迁移相对 equipped ROI、颜色熵分类、按需边界调用、快照夹心推断和连续 `(equipped_state, quality)` 分段；row-major 的段、等级规则和 equipped snapshot 夹心可跨 `r1c4 -> r2c1`，名称夹心保留 Python 的同一行门槛。旧 diagnostic JSON 仍保留。Phase 0.2C 已使用的匿名主星边界样本存在，Python 与浏览器逐卡 state/source/warning 均一致：边界两卡分别为 `equipped` 与 `unequipped`，其余卡为 `not_evaluated`。两端 confidence 数值不宣称逐像素完全相等。

## 4. 页面路由

### Python 路由证据

来源为 `src/yuanstar/vision/page_classifier.py::classify_page`：

- 视觉优先：在 viewport 顶部约 7%–24% 查找浅金色选中 tab；中心 `<35%` 为 `main`，`<65%` 为 `support`，否则为 `experience`，confidence 0.82，证据为 `selected_tab_visual:<page>`。
- 顶部检测到至少三个图标圆时视为 cropped grid，禁止从该区域臆造 tab 视觉证据。
- 无可靠视觉结果时，只对相对 tab ROI 做 OCR；tokens 为主星 `主星`、辅星 `辅星`、经验 `经验星石`/`紫星曜`/`白星曜`，证据为 `tab_ocr:<token>`。
- 无 token 返回 `unknown`/0；最高分并列返回 `unknown`/0.2 与 `page_evidence_conflict`；非经验 OCR 路由 confidence 为 0.75，经验为 0.70。
- `classify_page` 的 tab OCR 实际代码先构造 `joined = " ".join(texts)`，再对每个 token 使用 `if token in joined` 加 1 分；候选 confidence 不参与分数，同类重复 token 也只贡献一次，真实并列保持 unknown。
- 经验识别只在可靠 `experience` page 且 confidence >= 0.65 且证据前缀为 `selected_tab_visual:` 或 `tab_ocr:` 时认为 tab 已选中；缺失类型只有整页 complete 才为 0。

### 已决策的 Python/浏览器差异

`src/yuanstar/vision/offline_pipeline.py::OfflineSingleImagePipeline.analyze_image` 在上述 classifier 返回 `unknown` 后，还会统计普通卡的主星/辅星 catalog 命中；若只命中一侧，就返回 page `main` 或 `support`、confidence 0.45、evidence `name_dictionary_fallback`，随后 finalize stars。

本轮 goal 的阶段 D 又明确规定：

- 不根据星石名称结果反推页面类型；
- 视觉与 `tab_ocr` 都不足时返回 `unknown`，交给人工分流；
- 不新增第四个图片池。

本轮已明确决定：Python 正式代码保持不变，浏览器端不迁移 `name_dictionary_fallback`。这是经过决策的实现差异，不是遗漏，也不构成暂停项。浏览器页面路由只接受可靠选中页签视觉证据或 `tab_ocr` 文字证据；两者不足时返回 `unknown`，交给现有人工图片池分流。

浏览器 `page-routing-visual.ts` 在相同顶部 16% header 区域执行 cropped-grid 圆盘门槛；检测到至少三个顶部圆盘时不产生 `selected_tab_visual`，继续尝试 `tab_ocr`。浏览器 `page-routing-logic.ts` 保留 Python 的命中次数、固定 confidence 和并列规则，不使用候选 confidence 加权。

### 用户确认池

Python `SessionState` 持有 `image_pools` 与 `confirmed_image_pools`；已确认图片的池不会被自动分析结果静默覆盖，未知图片可人工路由并标记 confirmed。浏览器纯识别层现在只接受显式 `confirmedPool` 输入，不把 IndexedDB 或业务 image pool 状态塞入内核；冲突输出 warning/review，并以确认池为准。

## 5. 当前三类 PoC 与目标 contract 差距

| 目标 | 当前状态 | 映射结论 |
|---|---|---|
| 版本化 `BrowserImageAnalysisV1` | 已由 unified runtime 生成；旧 diagnostic 保留 | 纯识别 contract 不包含账号、revision、业务实例、UI selection 或 IndexedDB 指令 |
| direct/effective 字段 | 浏览器 contract 已补齐 | 保留 raw OCR candidates 与 direct/effective/provenance，不将 inferred 值伪装成 direct |
| occurrence ID | 浏览器 contract 已使用稳定 occurrence ID | 基于 `imageId + pageType + row/column`；经验使用稳定 ordinal；与业务 `starInstanceId` 分离 |
| 品质 | Python 五类、阈值、median hue；浏览器已迁移 | 保留 unknown/review；真实主辅样本逐卡一致 |
| 佩戴/层级 | Python 按需视觉与连续段规则；浏览器已迁移纯函数 | 不跨段、不链式传播；真实边界样本 state/source/warning 对照完成 |
| 页面统一路由 | Python visual/cropped-grid/tab OCR 规则；浏览器已统一 | `classifyImage` 已补齐 cropped-grid 与 `tab_ocr`；明确不迁移 Python `name_dictionary_fallback` |
| diagnostic | 旧表格/JSON/叠图/耗时保留 | 阶段 A 只能在其旁边增加 contract JSON 检查，不删除旧入口 |

## 6. ImageBitmap 所有权与关闭路径

- `BrowserVisionEngineRuntime.route()` 每次分析创建一个路由 bitmap；`classifyImage()` 和 `analyzeImage()` 的外层 `finally` 是它的唯一成功关闭者。若 profile、视觉路由或 tab OCR 抛错，创建边界立即关闭它。
- 已知页面的 unified 分析还由原有 main/support/experience pipeline 创建一个独立 bitmap，因此一次已路由的统一分析共创建两个；`unknown` 只创建路由 bitmap。pipeline 成功 bitmap 仅为生成旧 diagnostic overlay 而返回，在 unified contract 构建后由内部 `finally` 关闭；contract 构建抛错同样关闭。
- 每个 pipeline 在自身异常路径关闭其已创建 bitmap；成功路径将所有权移交给调用者。旧 diagnostic 页面保留该 bitmap 以绘制叠层，并在下一次运行、清空或失败清理时关闭，不能由 unified 入口提前关闭。
- `transferBitmapOnSuccess` 专项测试覆盖成功时移交所有权、异常时创建边界关闭且错误原样传播；没有重复关闭路径。

## 7. 已决策边界

1. 页面 `unknown` 时禁止根据星石名称反推页面类型；浏览器只使用可靠选中页签视觉证据和 `tab_ocr`。
2. `confirmedPool` 是用户明确确认的图片池。自动分类不得静默覆盖；证据冲突只输出 warning/review，并以用户确认池为准。
3. Python `name_dictionary_fallback` 保留在 Python 当前实现中，浏览器不迁移；后续测试和审查材料按此明确差异记录，不将其列为未决或暂停项。
