# Python 主星结构化识别执行层映射

本映射以当前 Python 生产代码与专项测试为准。浏览器实现只迁移主星完整截图所需的几何、ROI OCR 与最小后处理；品质、佩戴、层级推断、批次重叠、背包容量、经验星曜和正式 UI 均不在本轮范围。

## 几何与图像结构

| Python 来源 | 真实函数/类 | 输入 | 输出 | 依赖 | 浏览器迁移方案 | 本轮是否迁移 |
|---|---|---|---|---|---|---|
| `vision/viewport.py` | `detect_viewport`, `_edge_depth` | BGR 原图 | `ViewportResult`，含黑边裁剪后的 `viewport_box` | OpenCV 灰度统计 | Canvas `ImageData` 逐边连续暗条检测；保留 8px 门槛、18% 搜索上限、45% 安全回退 | 是 |
| `vision/layout_profiles.py` | `LayoutProfile`, `select_layout_profile` | viewport 宽高 | phone/tablet/fallback profile | 宽高比 | 等值迁移三套比例区间、四列中心、网格区、行距范围与底部安全线 | 是 |
| `vision/page_classifier.py` | `classify_page` | 原图、viewport、可选 OCR | `PageClassification` | 顶部选中标签视觉与 OCR | 本轮输入限定主星截图；只保留“主星调试入口”声明与 profile 证据，不迁移通用页面分类 | 否 |
| `vision/bottom_toolbar.py` | `locate_bottom_toolbar`, `_toolbar_label`, `_horizontal_groups`, `_dark_panel_top` | 原图、viewport、定位 OCR | `BottomToolbarEvidence` | 定位 OCR、暗面板边缘 | 不调用整图 OCR；使用 profile 的 `bottom_safe_y` 作为保守内容底线，并在结果证据中明确来源 | 部分 |
| `vision/card_detector.py` | `CircleProposal`, `_hough_proposals`, `_nms_2d`, `_main_radius_cluster` | 原图、viewport、搜索起点 | 去重后的主圆盘半径簇 | OpenCV HoughCircles、NMS | Canvas 灰度边缘环评分生成圆盘 proposal；2D NMS 与主半径簇保持相同职责，不引入 OpenCV.js | 是 |
| `vision/card_detector.py` | `_cluster_rows`, `_column_centers`, `_row_lattice` | 圆盘 proposal、viewport、profile | 四列行网格 | 中位数、列偏差、profile 行距 | 纯 TypeScript 行聚类、四列槽位、规则行与末行 1/2/3 张保留；不盲补缺卡 | 是 |
| `vision/card_detector.py` | `_boxes` | 圆心、半径 | card/name/level 三个框 | 半径比例 | 原样迁移：card `(-1.05r,-1r,2.1r,2.05r)`；name `(-.92r,+1.08r,1.84r,.62r)`；level `(+.02r,-1.06r,1.08r,.58r)` | 是 |
| `vision/card_detector.py` | `_circle_complete`, `_box_complete`, `_card_complete` | proposal、三个框、内容边界 | 完整卡布尔值 | 严格包含比较 | 纯 TypeScript；`>=`/`<=` 表示贴边保留，只有真正越界才排除 | 是 |
| `vision/card_detector.py` | `detect_cards` | 原图、viewport、profile、边界证据 | `CardCandidate[]` | 上述几何职责、局部视觉证据 | 浏览器输出行列、card/name/level ROI、圆盘、完整性和逐项证据；几何完整与 OCR 成败分离 | 是 |
| `vision/pipeline.py` | `_auto_excluded_edge_fragments` | cards、图高、content bounds | card id 到 top/bottom | 圆盘及两个 OCR 框 | 在浏览器候选阶段给出 `partial_top` / `partial_bottom`；文字框越界按单卡处理，不传播到整行 | 是 |
| `vision/pipeline.py` | `_row_crop_boxes` | 行内卡片、图尺寸 | 行复核裁剪框 | ROI 与半径 padding | 正式 UI/行复核裁剪不在本轮；调试叠图直接画每卡框 | 否 |

## OCR 模型调用

| Python 来源 | 真实函数/类 | 输入 | 输出 | 依赖 | 浏览器迁移方案 | 本轮是否迁移 |
|---|---|---|---|---|---|---|
| `vision/preprocess.py` | `crop`, `image_variants` | 原图与 ROI | 原图坐标裁剪；color/contrast/otsu 三变体 | OpenCV | Canvas 从原始 bitmap 裁剪，生成 3x color、对比度灰度、Otsu 变体 | 是 |
| `vision/ocr_engine.py` | `LocalRapidOcr._get_engine` | 延迟初始化请求 | 共享 OCR 引擎 | RapidOCR | 复用现有 `onnxruntime-web` Session 单例；结构化业务不拥有 Session 生命周期 | 是 |
| `vision/ocr_engine.py` | `recognize_many_single_line` | 多个直立小 ROI | 每 ROI 一条文本及置信度 | 方向分类、识别模型 | 原图坐标逐 ROI 直送识别模型；当前主星文字直立，不调用方向分类 | 是 |
| `vision/offline_pipeline.py` | `OfflineSingleImagePipeline.analyze_image` 中 `variant_images/variant_keys` 批处理 | 完整卡 name/level ROI | 每卡按字段归集的多变体候选 | `image_variants`、OCR engine | 浏览器主流水线按 card id 与字段保留候选来源，分别交给名称/等级后处理 | 是 |
| `vision/ocr_engine.py` | `recognize_positioned` | 大区域图像 | 带坐标 OCR 文本 | 检测+识别模型 | 仅 Python 工具栏定位使用；浏览器正式主链路不以整图通用 OCR 框为卡片来源 | 否 |

## 业务后处理

| Python 来源 | 真实函数/类 | 输入 | 输出 | 依赖 | 浏览器迁移方案 | 本轮是否迁移 |
|---|---|---|---|---|---|---|
| `catalog.py` | `StarCatalog.normalize`, `names_for_kind` | OCR 名称 | 标准名称/主星白名单 | `star_catalog.json`, `ocr_aliases.json` | 仅内嵌已确认的 14 个主星标准名与 `紫薇→紫微` 别名，不加入新名称或分组 | 是 |
| `vision/name_recognizer.py` | `clean_name`, `_allowed_names`, `resolve_name_candidates` | 多变体 OCR 候选 | raw、canonical、confidence、warnings | 主星目录、别名、保守模糊匹配 | 清除空白/符号/“级”；先精确与别名；仅保留保守候选逻辑；图案文本输出 `name_unknown` | 是 |
| `vision/level_recognizer.py` | `parse_level`, `resolve_level_candidates` | 多变体 OCR 候选 | raw、1–60 level、confidence、warnings | 正则、带“级”加权共识 | 等值迁移 O/o→0、负号拒绝、唯一整数、1–60、带“级”加权与冲突待审查 | 是 |
| `vision/offline_pipeline.py` | `RecognizedStar` 构造与 `review` 判定 | 完整卡与字段结果 | 每卡识别状态 | 页面、名称、等级、品质 | 本轮不要求品质；名称或等级为空则 `needs_review`，几何残片为 `excluded_partial`，否则 `accepted` | 部分 |
| `vision/offline_pipeline.py` | `finalize_stars` | stars、最终页面 | 复算 page/confidence/review | 页面分类 | 输入已明确为主星调试入口，不迁移页面回退 | 否 |
| `vision/offline_pipeline.py` | `apply_sort_order_level_inference`, `apply_sort_sandwich_inference` | 阅读序 cards/stars | 推断名称或等级 | 直接 OCR provenance | 附件限定“最小后处理”且禁止排序/同名聚合；不以邻卡推断填充 OCR | 否 |
| `vision/hierarchical_order.py` | `apply_hierarchical_order`, `apply_hierarchical_name_sandwich`, `recognize_equipped_on_demand` | cards/stars | 层级顺序与佩戴结果 | 品质、佩戴视觉 | 不迁移 | 否 |
| `vision/pipeline.py` | `LocalOfflineVisionPipeline.analyze` | 多图片批次 | 正式导入 `AnalysisResult` | 品质、背包、重叠、UI 合同 | 只参考结果字段与残片排除语义；批次、存储和正式导入不迁移 | 否 |

## 本轮不迁移的 UI / 存储职责

- 现有浏览器 `storage.ts`、UUID fallback、备份 JSON 与 IndexedDB 行为保持原样。
- 现有 `network.ts` 的同源网络保护保持原样。
- 不迁移 Python NiceGUI 导入、复核、排序、同名聚合、重叠、账号、计划、Excel。
- 调试页面只增加结构化主星入口、可切换叠层、JSON、表格和阶段耗时，不改变正式产品 UI。

## 由专项测试锁定的边界语义

- `tests/test_phase0_2b_vision.py`：profile 宽高比、黑边、四列圆盘网格、底部截断、名称别名、等级范围和共识。
- `tests/test_current_targeted_fix.py`：圆盘与 name/level 三者共同决定整卡；名称框恰好贴内容底边仍完整；末行 1/2/3 张完整卡必须保留；无工具栏时不得固定遮掉底部；OCR 为空不把完整卡变成残片。
- `tests/test_current_targeted_fix.py` 与 `tests/test_web_sort_fragment_hotfix.py`：上下边界相等保留，越界 1px 排除；文本框切边只按单卡排除，只有四列圆盘边界一致时 Python 批处理才有窄范围整行补偿。

## 收口验收记录

- 桌面浏览器已人工确认：三类主星样本的卡片框、名称 ROI、等级 ROI、行列顺序与结构化表格均正常；平板顶部残片会排除；手机末行不盲补不存在的列。
- 网络摘要复核为 `externalRequestCount = 0` 与 `containsUserDataCount = 0`。
- Android 已完成一次真实设备验收：完整主星截图得到 24 张完整卡，名称、等级与行列顺序未发现人工错误；页面未卡死、白屏、自动刷新或崩溃。窄屏页面较长但本轮不进行移动端视觉优化。
- 局域网地址仅作为本次人工验收的临时运行证据，不是源码配置或长期服务地址。
- 已知几何差异仍保留：手机内容区底边较 Python 保守 51px；三个代表样本的卡片数量、顺序与 OCR 结果未受影响。
