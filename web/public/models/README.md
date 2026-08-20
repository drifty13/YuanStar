# Browser Product OCR release assets

此目录是 Browser Product 构建期间生成的 OCR 资产 staging 目录。构建会从仓库根目录的 `resources/ocr/` 验证并复制以下四个 release assets：

- `PP-OCRv6_det_small.onnx`
- `ch_ppocr_mobile_v2.0_cls_mobile.onnx`
- `PP-OCRv6_rec_small.onnx`
- `ppocrv6_chars.txt`

不要手工替换这些文件。`resources/ocr/manifest.json` 是文件名、大小、SHA-256、来源和许可的机器可读记录；`resources/ocr/PROVENANCE.md` 说明其 provenance 与派生规则。构建会在复制前验证 manifest，且运行时只从本站同源静态资源加载这些文件。
