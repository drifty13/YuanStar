# YuanStar 浏览器本地 OCR + IndexedDB 最小 PoC

本目录只验证静态网页、浏览器本地 ONNX 推理、IndexedDB 和隐私边界。它不迁移现有 NiceGUI UI，不调用 Python OCR 服务，也不修改 Python MVP。

## 技术栈

- TypeScript 7 + Vite 8 静态页面；
- ONNX Runtime Web 1.27 的 WASM execution provider，单线程运行；
- RapidOCR 3.9.2 当前使用的 PP-OCRv6 检测/识别模型和 PP-OCRv4 方向分类模型；
- 原生 Canvas、File/Clipboard、IndexedDB 和 Blob API；
- 本地记录 ID 优先使用安全上下文的 `crypto.randomUUID()`；局域网 HTTP 下会降级到 `crypto.getRandomValues()` 生成 UUID v4，极少数无 Web Crypto 的环境再使用仅供本地 PoC 的唯一性兜底；
- 所有 JavaScript、WASM、模型和字符表均由当前本地静态站点提供，运行时不依赖 CDN。

ONNX Runtime Web 的部署方式遵循官方的[浏览器构建说明](https://onnxruntime.ai/docs/tutorials/web/build-web-app.html)和[本地 WASM 资产说明](https://onnxruntime.ai/docs/tutorials/web/deploy.html)。

## 安装与启动

常规 Node/pnpm 环境：

```powershell
Set-Location 'web'
pnpm install
pnpm exec vite --host 0.0.0.0 --port 4173 --strictPort
```

手机与电脑连接同一 Wi-Fi 后，在电脑运行 `ipconfig` 查找 WLAN IPv4，并在手机打开：

`http://<WLAN_IPV4>:4173/`

前台服务使用 `Ctrl+C` 停止。Wi-Fi 重连后 IP 可能变化，应重新查询后再访问。

## 使用顺序

1. 选择截图或文字 ROI；桌面可使用 Ctrl+V 粘贴本地图片。
2. 点击“加载并验证模型”，等待三个模型均完成首跑。
3. 通用文字框可点击“开始本地 OCR”；完整星曜页面按页面类型分别运行“结构化主星”“结构化辅星”或“结构化经验星曜”。三个入口拥有独立结果区，运行失败会清除本入口的旧结果。
4. 经验星曜只输出橙/紫/白类型与数量；空值或非 1–6 位纯数字保持“数量未知”，不做经验换算或库存合并。
5. 保存到 IndexedDB，刷新页面，再点击“从 IndexedDB 恢复”。
6. 验证删除、备份导出和备份导入。
7. 点击“刷新摘要”，确认 `containsUserDataCount = 0`；若出现外部请求，记录 URL 并区分 YuanStar 应用请求与浏览器环境注入脚本。

## PoC 边界

- 检测后处理是无 OpenCV 的轴对齐 DB 概率图近似，不等同于 Python RapidOCR 的旋转框、轮廓和 unclip 全实现。
- 方向分类模型已完成浏览器加载和首跑兼容性验证；最小 OCR 链路假设文字正向，不应用旋转分类结果。
- 模型兼容错误会原样显示，不会静默替换模型。
- IndexedDB 是站点本地数据；清理浏览器站点数据会删除记录。
- “浏览器与设备”区会显示协议、安全上下文和两项 Web Crypto API 能力，便于诊断安卓局域网 HTTP 环境；本地 ID 不用于认证、密钥、会话安全或任何安全边界。
- 当前阶段 Android 真实设备人工验收已通过：主星 smoke、辅星结构化识别、经验星曜三类型识别、入口状态隔离和窄屏响应式回落均可运行且未崩溃；这只代表当前调试 PoC 的功能可用，不代表正式产品 UI 已接入。
- 应用主动外发用户数据为 0。QQ 浏览器可能自行注入外部脚本，这些请求不属于 YuanStar 应用请求，详见 `docs/privacy_network_evidence.md`。
- 主星与辅星复用生产一致的四列整卡/名称/等级 ROI；经验星曜使用独立的单排图标、HSV 类型证据和图标右下数量 ROI，不强行复用四列网格。
- 已知缺口：经验星曜生产 `tab_ocr` 页面文字回退尚未迁移；本轮不迁移经验值换算、升级需求或库存抵扣，也未接入正式产品 UI。

## 文档

- `docs/poc_results.md`
- `docs/python_browser_comparison.md`
- `docs/privacy_network_evidence.md`
- `docs/android_manual_test.md`
- `docs/python_main_runtime_mapping.md`
- `docs/python_support_runtime_mapping.md`
- `docs/python_experience_runtime_mapping.md`
