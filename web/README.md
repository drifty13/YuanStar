# YuanStar Web

这里是 YuanStar 当前实际使用的浏览器端产品。

早期这个目录只是用来验证“浏览器本地 OCR + IndexedDB”能不能跑通，现在已经不再是单独的 PoC：截图导入、页面分类、结构化识别、人工核对、背包整理、计划养成和经验星曜计算都已经接入这一套前端。

## 技术栈

- TypeScript 7 + Vite 8；
- ONNX Runtime Web 1.27，WASM execution provider；
- PP-OCRv6 检测 / 识别模型与 PP-OCRv4 方向分类模型；
- 原生 Canvas、File / Clipboard、IndexedDB 和 Blob API；
- 浏览器本地 OCR，不依赖 Python OCR 服务或云端 OCR API。

当前 OCR batch 保持单 Worker、单 session 串行处理。主星 / 辅星名称和等级使用 progressive fallback：优先识别原彩 ROI，只有结果不满足严格安全条件时才继续执行 contrast 与 Otsu 两种备用预处理。

## 当前使用流程

1. 导入多张背包截图；
2. 自动判断主星、辅星或经验星曜页面，并由用户确认分类；
3. 在浏览器本地执行 OCR；
4. 对低置信、重复、重叠或其他需要确认的内容进行人工核对；
5. 将确认后的结果写入当前账号背包；
6. 在“人工核对”页查看当前背包、计划背包和经验星曜需求；
7. 通过“数据”菜单进行本地导入 / 导出。

所有业务数据保存在当前站点的 IndexedDB 中。不同域名、浏览器和设备拥有各自独立的数据空间。

## 安装与启动

推荐使用仓库声明的 Node / pnpm 版本：

```powershell
Set-Location web
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build
pnpm run preview -- --host 127.0.0.1 --port 4173
```

打开：

`http://127.0.0.1:4173/`

正式 build 会先执行 `scripts/copy-runtime-assets.mjs`，把 OCR 模型、字符表、ONNX Runtime Web WASM 和其他运行时资源准备到静态站点目录。不要用裸 `vite build` 代替项目的 `pnpm run build`。

## 运行时与隐私

- OCR 模型和 WASM 资源由当前站点同源提供；
- 截图不会上传到 YuanStar 服务器；
- OCR 推理在浏览器本地完成；
- IndexedDB 保存账号、背包和计划数据；
- 清理浏览器站点数据会删除这些本地记录；
- 浏览器扩展或浏览器自身仍可能产生与 YuanStar 无关的外部网络请求。

## 开发诊断

本地 build / preview 下可以通过 query 参数查看 OCR 性能数据：

`http://127.0.0.1:4173/?ocrPerf=1`

需要强制恢复完整三 variant OCR 并输出 variant audit 时：

`http://127.0.0.1:4173/?ocrPerf=1&ocrVariantAudit=1`

这些参数只用于开发诊断，不会改变普通访问页面的 UI。

## 相关文档

更早期的浏览器迁移、Python 对照、隐私网络证据和 Android 验收记录仍保留在 `web/docs/`，用于追溯实现过程；其中部分文档描述的是历史阶段，不代表当前产品界面。
