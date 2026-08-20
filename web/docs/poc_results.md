# PoC 桌面结果

## 结论

当前判断：**结构化 ROI 浏览器 PoC 当前阶段通过，可提交本轮辅星与经验星曜执行层**。

桌面和 Android 真实设备均完成当前阶段的浏览器结构化验收：主星 smoke、辅星结构化识别、经验星曜橙/紫/白三类型识别、入口状态隔离和窄屏响应式回落均可运行且未崩溃。当前调试页面不是正式产品 UI；经验星曜生产 `tab_ocr` 页面文字回退、经验值换算、升级需求和库存抵扣仍不在本轮范围。

## 基本信息

- 分支：`poc/browser-structured-support-experience-roi`
- 桌面环境：Windows 10 x64，Chrome 150.0.0.0
- 浏览器公开设备指标：18 logical processors，deviceMemory 32 GiB
- 最终启动烟测 JS heap：limit 4,395,630,592 B，total 3,922,971 B，used 2,680,139 B（只代表该时刻，不作为峰值）
- 模型总大小：31,749,509 bytes，约 30.28 MiB
- 真实样本：一个脱敏编号的本机星石名称 ROI；119 × 37，5,206 bytes；未复制到 PoC 或 Git
- 卡死/崩溃：未出现

## 模型兼容性

三个模型均以 `wasm` execution provider 创建 session，并完成一次空张量首跑；未发现浏览器运行时不支持的算子。

| 模型 | 大小 | 输入 | 输出 | 首次加载 | 首次首跑 | 缓存后加载 | 缓存后首跑 |
|---|---:|---|---|---:|---:|---:|---:|
| PP-OCRv6 det small | 9,929,594 B | `x`, float32, dynamic × 3 × dynamic × dynamic | `fetch_name_0`, float32, dynamic × 1 × dynamic × dynamic | 430.7 ms | 33.9 ms | 292.7 ms | 41.1 ms |
| PP-OCRv4 cls mobile | 585,532 B | `x`, float32, dynamic × 3 × dynamic × dynamic | `save_infer_model/scale_0.tmp_1`, float32, dynamic × 2 | 103.5 ms | 7.3 ms | 52.8 ms | 7.3 ms |
| PP-OCRv6 rec small | 21,234,383 B | `x`, float32, dynamic × 3 × 48 × dynamic | `fetch_name_0`, float32, dynamic × dynamic × 18,710 | 280.3 ms | 148.1 ms | 188.7 ms | 166.6 ms |

以上加载时间是页面内逐模型计时，不包含初始 HTML/JS 下载；缓存后仍需重新创建和编译浏览器 session。

## 真实 OCR

- 原始文本：`天府`
- 检测框：`x=32, y=10, width=60, height=27`
- 检测置信度：0.85
- 识别置信度：1.00（PoC 显示精度为两位小数）
- 首次完整 OCR：解码 5.3 ms，预处理 1.3 ms，检测推理 8.2 ms，检测后处理 0.6 ms，识别推理 74.5 ms，识别后处理 6.5 ms，总计 97.8 ms
- 从备份恢复后复跑：总计 90.8 ms

## IndexedDB 与备份

| 项目 | 结果 | 证据边界 |
|---|---|---|
| 保存 Blob + JSON | 通过 | 页面返回唯一记录 ID |
| 刷新后恢复 | 通过 | 恢复 119 × 37 图片和 `天府` 结果 |
| 删除记录 | 通过 | 删除后再次恢复显示无记录 |
| JSON 序列化/反序列化 | 通过 | 7,921-byte 备份结构经同一 `fromBackup` 路径恢复 Blob 和结果 |
| 浏览器下载按钮 | 部分验证 | Chrome 页面执行并显示下载状态，但控制扩展未捕获下载事件，默认下载目录也未确认文件 |
| 原生 JSON 文件选择器导入 | 未自动验证 | Chrome 扩展未获文件 URL 权限；已验证的 Ctrl+V JSON 导入与文件导入共用解析、校验和写入函数 |

## 结构化 ROI 人工验收（当前阶段）

- 电脑端辅星：手机完整页 24 完整、手机末行 22 完整、平板页通过；名称/等级与 Python 对齐。
- 电脑端经验星曜：手机页通过；平板橙 22、紫 295、白 88 通过。
- 三个入口状态隔离、失败清旧结果和主星 24 完整 smoke 通过。
- Android：辅星完整页与电脑一致；经验星曜三类型页成功；窄屏可操作；无崩溃。

## 网络与隐私

结构化 PoC 运行期间的请求均为当前本地服务同源静态资源；外部请求 0，含用户数据请求 0，控制台 warning/error 0。当前服务端口由启动时动态确认，不写入固定局域网 IP。详见 `privacy_network_evidence.md`。

## 安卓 QQ 浏览器人工实测（用户反馈）

以下结果来自用户在实体 Android 12 手机 QQ 浏览器的人工实测，不是 Codex 自动执行结果：

- 运行环境：普通局域网 HTTP，`isSecureContext = false`，`crypto.randomUUID` 不可用，`crypto.getRandomValues` 可用。
- 三模型加载及首次推理通过；模型总大小为 31,749,509 bytes，首次加载约 30 秒量级，未崩溃或被系统杀页。
- 约 235 × 292 小图正确识别 `30级`、`天巫`，额外误检图案文字 `保`；总 OCR 耗时约 734.7 ms。UUID 兼容修复后不再出现 `crypto.randomUUID is not a function`。
- IndexedDB 保存、清空页面内存、恢复、JSON 导出、删除后无法恢复、JSON 导入及再次恢复均通过。
- 本轮结构化辅星与经验星曜页面均完成功能运行验收，未崩溃；本调试页面不代表正式产品 UI。

## 2026-08-05：局域网 HTTP 本地 ID 兼容修复

- 根因：安卓 QQ 浏览器通过局域网 HTTP 访问时不是安全上下文，`crypto.randomUUID` 不可用；模型兼容性和 OCR 推理本身并未失败。
- 修复：新增 `src/utils/id.ts` 的 `createLocalId()`。安全上下文优先使用原生 `randomUUID`；否则用 `getRandomValues` 生成 UUID v4；两者都不可用时只为本地 PoC 记录提供时间戳、计数器和随机片段兜底。
- 边界：该 ID 不用于认证、密钥、会话安全或任何安全边界，且未改变 IndexedDB schema、OCR 结果、模型或网络守卫。
- 回归：最小三路径测试、`pnpm run typecheck`、`pnpm run build` 均通过；桌面 Chrome 完成模型加载、OCR、保存和刷新恢复。QQ 浏览器环境可能自行注入外部脚本；应用主动外发用户数据未发现。
