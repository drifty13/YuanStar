# Python 经验星曜结构化识别执行层映射

本映射以当前 Python 生产 OCR、`ExperienceStoneResult`、参考规则工作簿与真实样本为准。经验星曜不是主星/辅星四列卡片网格；浏览器端只迁移图标定位、类型、数量 ROI、数量 OCR、未知值和诊断状态，不迁移经验换算、升级需求或库存抵扣。

## 页面入口、profile 与定位范围

| Python 来源 | 真实行为 | 浏览器迁移职责 |
|---|---|---|
| `vision/viewport.py::detect_viewport` | 与主/辅星相同，先剔除可信黑边并保留原图坐标 | 复用现有 viewport 检测 |
| `vision/page_classifier.py::classify_page` | 经验页 canonical page type 为 `experience`；视觉选中标签证据为 `selected_tab_visual:experience`，OCR tokens 为“经验星石/紫星曜/白星曜” | 独立“结构化经验星曜”入口；不把主星或辅星名称送进经验目录 |
| `vision/offline_pipeline.py::analyze_image` | 仍选择 phone/tablet/fallback profile，但经验分支不运行 `detect_cards`、工具栏或主/辅星内容边界；`SingleImageAnalysis.content_bounds` 通常为 `None` | 输出 viewport/profile；调试 JSON 中的 `contentBounds` 明确表示经验圆形搜索带，不冒充 Python 的主/辅星 card content bounds |
| `vision/experience_recognizer.py::locate_experience_rois` | 在 viewport 的垂直 18%–62% 搜索圆形图标；仅当“可靠选中经验标签 + tablet profile”时把顶部提高到 24%，以排除导航圆圈 | 新建经验专用几何模块，复用 viewport/profile，但不塞进 `main-grid.ts` |
| `locate_experience_rois::_dominant_icon_row` | 按圆心 y 聚类，容差为 `max(18px, medianRadius*.38)`；选择数量最多的水平簇并按 x 排序 | 等值迁移为单行条目顺序；Canvas 候选再按真实 phone/tablet 经验页的三个槽位校正同排圆心与半径，但不会补造未检测槽位；真实生产不是四列补槽模型 |

## 图标框、类型和数量 ROI

| Python 来源 | 真实行为 | 浏览器迁移职责 |
|---|---|---|
| `locate_experience_rois` | Hough 参数：`dp=1.2`、最小圆心距 `max(32,vw*.10)`、半径 `max(18,vw*.045)` 至 `max(30,vw*.11)` | 使用现有 Canvas 圆环候选能力实现等价局部候选，不引入 OpenCV.js |
| `_kind` | 取图标框内部 22%–78% 区域；HSV 饱和度>70 的像素中位 hue；目标 hue 为 orange=10、purple=130、white=100；置信度 `max(0,1-distance/35)` | 这是现有 Python 视觉证据，允许等值迁移；不得另造肉眼阈值 |
| `experience_count_box` | 数量框相对 icon box：x `+0.40w`、y `+0.78h`、宽 `0.60w`、高 `0.24h` | 输出并叠加原图坐标 quantity ROI |
| `_count` | 仅裁本地图标右下数量框并单行 OCR；严格接受 `\d{1,6}`，包括 0；多个合法候选取最高置信度；空值、非数字、逗号或超过 6 位均为 `None`，绝不改写成 0 | 复用现有 OCR Session；输出 raw candidates、标准化整数或 quantity unknown |

## canonical identity 与资源口径

- Python OCR 内部类型键固定为 `orange`、`purple`、`white`，阅读顺序固定为橙→紫→白；正式输出字段为 `orange_count`、`purple_count`、`white_count`，批处理/UI canonical labels 为“橙星曜、紫星曜、白星曜”。
- `data/star_catalog.json` 只把“紫星曜、白星曜”列为可投喂 `经验星石`，并带 500/100 经验；它没有把橙星曜列入普通星石 catalog。
- 生产参考工作簿 `YuanStar_Phase0_6A_经验星曜规则与逐级数据.xlsx` 明确确认橙星曜 canonical label 和 1000 经验，仅在“背包已有经验”折算中参与，不出现在需求展示。该分层解释了 catalog 的省略，并不改变 OCR 的三类 canonical output。
- `ocr_aliases.json` 的“紫星耀→紫星曜、白星耀→白星曜、星耀→星曜”属于文本归一化资源；当前经验 OCR 不识别名称文本，而以现有颜色规则识别类型，因此浏览器结果不得把辅星名称或主星 alias 当作经验类型。

## 完整性、未知值与复核状态

| Python 来源 | 真实行为 | 浏览器迁移职责 |
|---|---|---|
| `_tab_is_selected` | 只有 page=`experience`、置信度≥0.65 且证据含 `selected_tab_visual:` 或 `tab_ocr:` 才算已验证经验页 | 独立入口可声明预期类型，但结果必须保留页面证据和复核状态 |
| `recognize_experience_stones` | 没有候选时三项均 `None`，warning=`experience_icons_not_found` | 输出空结果为 `needs_review`，不得伪造成三个 0 |
| `recognize_experience_stones` | 类型冲突、未分类图标、已检测类型数量无法解析、标签未验证、viewport cropped 都会产生 warning；`complete` 仅在标签已验证、未裁切且无任何 warning 时为真 | 页面/条目诊断沿用相同 warning；几何完整与数量 OCR 失败分离 |
| `field` | 已检测类型返回其 count（可为 `None`）；只有整页 `complete=true` 时，未出现的类型才安全输出 0；否则未出现类型为 `None` | 保留“完整页缺席类型=0”和“证据不完整=未知”的关键区别 |
| `ExperienceStoneResult` | 生产模型是三类聚合结果，不提供主/辅星式 `CardCandidate` 或逐项 partial 字段 | 浏览器调试表可逐图标输出 `accepted/needs_review/excluded_partial`，但 `excluded_partial` 只用于图标/数量 ROI 真正越出 viewport 的诊断，不冒充 Python 的四列残片模型 |

## 本轮迁移、部分迁移与不迁移

- **迁移**：viewport/profile、经验页选中标签视觉证据、专用圆形条目行、既有三类颜色规则、quantity ROI、1–6 位数量解析、raw candidates、最高置信候选、阅读顺序和三类隔离。
- **部分迁移**：Python 只提供整页 `complete`；浏览器为验收增加逐条几何状态，但聚合 0/unknown 仍严格沿用 Python 语义。生产的 `tab_ocr:` 页面文字回退未迁移，当前真实样本均使用 `selected_tab_visual:experience`。
- **不迁移**：`experience_calculator.py`、`experience_rules.py` 的经验换算/升级需求/6-24 计算、IndexedDB 库存、NiceGUI 编辑与保存、排序或同名聚合。

## 专项测试对应语义

- `tests/test_phase0_2b_vision.py`：颜色图标绑定局部数量、tablet 可靠标签排除顶部导航圆圈、phone/未验证页面保留 18% 搜索范围、page 证据传递。
- `tests/test_current_targeted_fix.py`：经验分析 `content_bounds=None` 时不得重新派生主/辅星 profile 边界；三类分辨结果保持橙/紫/白顺序。
- 浏览器专项测试需新增：三类 canonical identity、0/1/多位/6 位边界、7 位/非数字/空值为未知、缺席类型仅在完整页为 0、主/辅/经验目录隔离、状态切换与失败清旧结果。
