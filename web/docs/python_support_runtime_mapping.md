# Python 辅星结构化识别执行层映射

本映射以当前 Python 生产代码、`data/star_catalog.json`、`data/ocr_aliases.json`、参考工作簿和专项测试为准。浏览器 PoC 只迁移辅星截图的几何、名称/等级 ROI、本地 OCR 与最小后处理；不改写 Python，不迁移品质、佩戴、排序推断、重叠、库存或正式导入。

## 页面入口、profile 与内容边界

| Python 来源 | 真实行为 | 浏览器迁移职责 |
|---|---|---|
| `vision/viewport.py::detect_viewport` | 从四边连续暗条推导 viewport；每边至少 8 px，最多搜索对应边长 18%；裁后宽或高不足原图 45% 时放弃裁切并给出警告 | 复用现有浏览器 viewport 检测；所有输出保持原图坐标 |
| `vision/layout_profiles.py::select_layout_profile` | 按 viewport 宽高比选择 `phone_portrait_v1`、`tablet_portrait_v1` 或 fallback；三者均定义四列中心、网格区、行距和底部安全线 | 直接复用 `profiles.ts`，不新增辅星专用坐标 |
| `vision/page_classifier.py::classify_page` | 优先用顶部选中标签视觉区分主星/辅星/经验星石；无视觉证据时才 OCR 标签；辅星 canonical page type 为 `support` | 调试页使用独立“结构化辅星”入口；入口声明与 OCR 目录仍保持隔离，不把名称命中当作强页面证据 |
| `vision/bottom_toolbar.py` + `vision/card_detector.py::detect_cards` | 主星、辅星、unknown 共用工具栏探测和卡片检测。顶部有标签锚点时，内容顶为 profile `grid_region[1]`；内容底优先取 OCR 确认的工具栏顶，否则取 `bottom_safe_y` | 复用既有内容边界和四列网格；浏览器不迁移整页定位 OCR，只保留已验收的 profile 安全底线并明确证据来源 |

## 四列卡片、完整卡与残片

| Python 来源 | 真实行为 | 浏览器迁移职责 |
|---|---|---|
| `vision/card_detector.py::_hough_proposals/_nms_2d/_main_radius_cluster` | 从网格区产生圆盘候选、二维 NMS、主半径簇 | 复用浏览器 Canvas 圆环候选与 NMS，不引入 OpenCV.js |
| `vision/card_detector.py::_cluster_rows/_column_centers/_row_lattice` | 主星与辅星共用四列阅读顺序；三卡行只在缺槽有局部图像证据时补一个候选，不盲补；末行 1/2/3 张保留 | 直接复用 `main-grid.ts` 的共享几何职责并做最小中性化命名（若必要），不复制整条 pipeline |
| `vision/card_detector.py::_boxes` | card `(-1.05r,-1r,2.1r,2.05r)`；name `(-.92r,+1.08r,1.84r,.62r)`；level `(+.02r,-1.06r,1.08r,.58r)` | 辅星名称和等级 ROI 与主星完全相同 |
| `vision/card_detector.py::_circle_complete/_box_complete/_card_complete` | 圆盘、名称框、等级框都必须在内容边界内；`>=`/`<=` 表示恰好贴边仍完整，只有越界才排除 | 复用 `card-completeness.ts`；顶部/底部越界分别输出原因，越界 1 px 排除 |
| `vision/pipeline.py::_auto_excluded_edge_fragments` | 批处理按单卡圆盘与两个文字框判定边缘残片；OCR 空值不参与几何完整性；局部文字框越界不传播到整行 | `excluded_partial` 只由几何决定；名称或等级未知只会进入 `needs_review` |

## OCR 调用、名称目录与等级后处理

| Python 来源 | 真实行为 | 浏览器迁移职责 |
|---|---|---|
| `vision/preprocess.py::image_variants` | 对每个名称/等级 ROI 生成 color、contrast、otsu 变体 | 复用浏览器 ROI 预处理与现有 OCR Session |
| `vision/offline_pipeline.py::analyze_image` | 仅完整卡进入 OCR；所有 ROI 变体一次批量 `recognize_many_single_line`，再按 card/field 归组 | 辅星 pipeline 复用同一 Session 和批量接口，保留每个原始候选及置信度 |
| `catalog.py::load_catalog` | UTF-8 加载 JSON，合并条目内 aliases 与 `ocr_aliases.json`，并验证 alias 目标存在；参考工作簿只补充描述 | 浏览器目录由生产 JSON 生成/同步，不手写样本清单 |
| `data/star_catalog.json` | 当前生产辅星共 24 个：从“解神”到“天贵”；三条 `usage_tags` 仅属于 catalog 元数据 | 浏览器只迁移这 24 个 canonical name，不新增名称或 display group |
| `data/ocr_aliases.json` | 当前没有辅星专用 alias；现有 `紫薇→紫微` 属主星，`紫星耀/白星耀/星耀` 属经验名称归一化 | 不虚构辅星 alias；专项测试锁定这些真实 alias 不会让主星/经验名称进入辅星目录 |
| `vision/name_recognizer.py::clean_name/_allowed_names/resolve_name_candidates` | 清除空白、非文字数字符号和“级”；`support` 只允许辅星目录；先精确/alias，再以 0.86 相似度、OCR≥0.72、至少两变体一致且无近似并列做保守模糊确认 | 新建独立辅星后处理入口，复用算法但注入辅星目录；未知名称输出 `name_unknown` 并复核 |
| `vision/level_recognizer.py::parse_level/resolve_level_candidates` | O/o→0；拒绝负号；只接受唯一数字串与 1–60；候选按置信度和“级”字加权，接近冲突时未知 | 直接复用主星等级后处理；等级为空不改变几何完整性 |

## 属性、子类型、状态与本轮边界

- Python `RecognizedStar` 生产输出没有辅星“属性”或“子类型”字段。参考工作簿的“星石类别/星石描述/属性加成”和 catalog 的 `usage_tags` 不由图片 OCR pipeline 输出，因此本轮不向结构化结果补写这些字段。
- Python 的正式 `review_required` 还会考虑品质和 unknown page；本 PoC 明确不迁移品质，所以状态收敛为：几何残片 `excluded_partial`；几何完整但名称或等级未知 `needs_review`；名称与等级均确认 `accepted`。
- 不迁移 `apply_hierarchical_order`、名称/等级排序推断、佩戴识别、品质、批次重叠、同名聚合、IndexedDB 正式库存和 NiceGUI UI。
- 主星与辅星目录必须分别注入；同一后处理算法可复用，但状态、表格、JSON 和失败清理必须独立。

## 专项测试对应语义

- `tests/test_phase0_2b_vision.py`：四列几何、底部残片、名称目录隔离、等级范围与候选共识。
- `tests/test_current_targeted_fix.py`：圆盘与两个 OCR 框共同决定完整性；贴边保留、越界 1 px 排除；末行 1/2/3 张保留；OCR 空值不改变几何完整性。
- 浏览器专项测试需新增：24 项目录加载、真实 alias 隔离、主星/辅星互不污染、未知名称、等级 1/60/越界、末行两张及上下边界。
