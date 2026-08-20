# 隐私与网络证据

## 运行时保护

- 所有应用资源、ONNX 模型、字符表和 WASM 只允许当前页面同源 URL。
- `fetch`、XHR、WebSocket、Beacon 和表单提交均设置同源检查；非同源目标会被阻止并记录。
- 图片通过浏览器 `File`/剪贴板对象解码，OCR 结果只进入页面内存、IndexedDB 或用户触发的本地备份 Blob。
- 页面没有外部脚本、CDN、遥测、分析、远程 OCR API、登录或云存储。

## 桌面 Chrome 实测摘要

实测发生在真实样本 OCR、IndexedDB/备份恢复后：

```text
request_count: 15
external_request_count: 0
contains_user_data_count: 0
console_warning_or_error_count: 0
```

| URL 类别 | method | resource_type | reason | contains_user_data |
|---|---|---|---|---|
| `http://127.0.0.1:4173/` | GET | document | PoC 页面 | false |
| 当前站点 `/src/*`、`/@vite/*`、本地依赖脚本 | GET | script | 本地开发静态资源 | false |
| 当前站点 `/models/*.onnx`（3 个） | GET | fetch | 浏览器本地模型 | false |
| 当前站点 `/models/ppocrv6_chars.txt` | GET | fetch | 本地字符表 | false |
| 当前站点 `/ort/ort-wasm-simd-threaded.mjs` | GET | script | 本地 ONNX Runtime loader | false |
| 当前站点 `/ort/ort-wasm-simd-threaded.wasm` | GET | fetch | 本地 WASM runtime | false |

没有出现图片 Blob、OCR JSON、WebSocket、Beacon、XHR 或表单请求。开发模式的 Vite HMR 连接不承载图片或 OCR 结果；生产构建不包含开发 HMR。

## 安卓 QQ 浏览器人工实测边界

以下是用户在实体手机上的人工反馈，不是 Codex 自动执行结果：

- 应用主动外部请求：未发现。
- 应用用户数据上传：未发现。
- QQ 浏览器环境注入脚本：2 条，均为 QQ 域名脚本，`containsUserDataCount = 0`。

因此，不能声称能控制或审计浏览器自身的全部网络行为，也不能表述为“整个浏览器环境绝对零外部请求”。可以表述为：YuanStar PoC 源码未发现上传用户图片、OCR 结果或本地存档的主动请求。

## 证据边界

页面摘要来自 Resource Timing 加应用级 API 包装器，能覆盖本 PoC 发起的网络路径；它不是操作系统级抓包。若后续准备公开部署，仍应在生产静态构建上使用 Chrome DevTools Network/导出 HAR 再做一次独立复核。

含真实样本的桌面截图只保存在仓库忽略的 `tmp/`，未放入 PoC、Git 或文档。
