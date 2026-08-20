# Third-party notices

This file records verified third-party provenance and does not grant a license to YuanStar itself. YuanStar has no project-wide license yet.

## OCR model assets and character table

The following tracked files are exact assets from the public `RapidAI/RapidOCR` ModelScope model repository at revision `v3.9.2`, published there under Apache License 2.0:

| YuanStar file | RapidOCR configuration key | SHA-256 |
| --- | --- | --- |
| `resources/ocr/PP-OCRv6_det_small.onnx` | `multi_PP-OCRv6_det_small` | `090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f` |
| `resources/ocr/ch_ppocr_mobile_v2.0_cls_mobile.onnx` | `ch_ppocr_mobile_v2.0_cls_mobile` | `e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c` |
| `resources/ocr/PP-OCRv6_rec_small.onnx` | `multi_PP-OCRv6_rec_small` | `6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884` |
| `resources/ocr/ppocrv6_chars.txt` | derived from the recognition model's `character` metadata | `769e7fa79bb297b5f18d8dbd149e364a45bc61f2b3f574e5ea836f0b261c23a6` |

RapidOCR's official v3.9.2 configuration records the same ModelScope paths and hashes. YuanStar does not replace or alter the ONNX files. The character table is derived from the confirmed recognition model metadata by splitting lines, joining them with CRLF, and adding one final CRLF; the result is byte-for-byte verified against the tracked file.

RapidOCR identifies its own engineering code as Apache-2.0 and separately attributes OCR model copyright to Baidu. The model distribution used here is therefore attributed to both the public RapidAI/RapidOCR ModelScope repository (Apache-2.0) and the PP-OCR/PaddleOCR model origin (Baidu copyright attribution). This repository includes the Apache-2.0 text at `THIRD_PARTY_LICENSES/Apache-2.0.txt` and this notice. No separate upstream model NOTICE file was available in the verified source material; if an upstream publisher adds one for these assets, it must be preserved in future distributions.

Sources:

- RapidOCR v3.9.2 model configuration: <https://raw.githubusercontent.com/RapidAI/RapidOCR/v3.9.2/python/rapidocr/default_models.yaml>
- RapidAI/RapidOCR model card and license: <https://www.modelscope.cn/RapidAI/RapidOCR>
- RapidOCR license and model-copyright attribution: <https://github.com/RapidAI/RapidOCR/blob/v3.9.2/LICENSE> and <https://github.com/RapidAI/RapidOCR/blob/main/README.md>
- PP-OCR upstream project: <https://github.com/PaddlePaddle/PaddleOCR>

## Browser packages

`web/package.json` pins `onnxruntime-web` 1.27.0 (MIT) and `xlsx` 0.18.5 (Apache-2.0). The source repository does not vendor either package. Build output copies ONNX Runtime WASM from `node_modules`; the generated output is ignored. Future distribution of that output must retain the ONNX Runtime MIT license and applicable notices. The MIT text is retained at `THIRD_PARTY_LICENSES/MIT-onnxruntime.txt`; the standard Apache-2.0 text for Apache-2.0 materials described in this notice is retained at `THIRD_PARTY_LICENSES/Apache-2.0.txt`.

## Python dependency declarations

`pyproject.toml` declares, but does not vendor, NiceGUI (MIT), Pydantic (MIT), OpenPyXL (MIT), and optional RapidOCR 3.9.2 (Apache-2.0). Optional Python OCR also declares ONNX Runtime and OpenCV. A separately packaged Python distribution requires its own resolved dependency-license review.

## Project-owned data confirmed for this release

The author has confirmed that `data/star_catalog.json`, `data/ocr_aliases.json`, and `resources/reference/YuanStar_Phase0_6A_经验星曜规则与逐级数据.xlsx` are self-created YuanStar project data and may be publicly redistributed. They are not third-party material covered by this notice.
