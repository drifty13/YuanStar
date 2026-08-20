# YuanStar OCR release assets

`resources/ocr/` is the sole tracked source for the Browser Product's same-origin OCR runtime assets. `web/public/models/` is generated staging output only.

The three ONNX files match RapidOCR 3.9.2 package assets and the version-pinned hashes in RapidOCR's official model configuration. Their hosted source is RapidAI/RapidOCR on ModelScope, which identifies the model repository as Apache-2.0. RapidOCR separately identifies its engineering code as Apache-2.0 and attributes the underlying OCR model copyright to Baidu; the models are derived from PaddleOCR. The complete release attribution and license text are retained in `THIRD_PARTY_NOTICES.md` and `THIRD_PARTY_LICENSES/Apache-2.0.txt`.

`ppocrv6_chars.txt` is not a substituted standalone dictionary. It is the exact derived release artifact for the confirmed `PP-OCRv6_rec_small.onnx`: read custom metadata key `character`, split with `splitlines()`, encode UTF-8 after joining with CRLF, then append one final CRLF. That rule reproduces the tracked file's SHA256 exactly.

`manifest.json` is the machine-readable source of filenames, byte sizes, hashes, provenance and derivation data. The build asset script verifies every source byte against it before copying to staging; it never downloads assets or uses Python at build time.

Upstream references:

- https://raw.githubusercontent.com/RapidAI/RapidOCR/v3.9.2/python/rapidocr/default_models.yaml
- https://www.modelscope.cn/RapidAI/RapidOCR
- https://github.com/RapidAI/RapidOCR/blob/main/README.md
- https://github.com/PaddlePaddle/PaddleOCR
