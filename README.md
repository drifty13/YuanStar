# YuanStar

YuanStar helps players organize *Ru Yuan / Code: Kite* star-stone inventory screenshots. The current product is a static browser application: screenshots, OCR inference, review, exports, and local data handling stay in the browser on the user's device.

## What it does

- Imports star-stone inventory screenshots for browser-local OCR.
- Lets users review and correct recognized main stars, support stars, and experience stones.
- Keeps account-scoped inventory data in the browser and supports local data import/export.
- Provides filtering, inventory summaries, and experience-stone planning tools.

YuanStar does not upload screenshots to a YuanStar server or call a cloud OCR service. Browser extensions or the browser itself can still make their own requests outside the application.

## Run the browser product

This repository declares `pnpm@11.19.0` in `web/package.json`. Use a compatible Node.js version (`^20.19.0` or `>=22.12.0`), then run:

```powershell
Set-Location web
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build
pnpm run preview -- --host 127.0.0.1 --port 4173
```

Open `http://127.0.0.1:4173/`. The primary areas are import/recognition, manual review, and data management. The build prepares same-origin OCR model, ONNX Runtime WASM, and experience-rule assets; generated `dist/`, `node_modules/`, and staging directories are not source releases.

The Python code remains as a local reference implementation. Its optional OCR dependencies are declared in `pyproject.toml`; the browser product does not require a Python server.

## Third-party material and licensing

Tracked OCR assets have provenance and hashes in `resources/ocr/manifest.json`. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the verified third-party information and outstanding provenance checks.

The YuanStar project license has not yet been selected. Until one is added, the repository is viewable but no general permission to copy, modify, or redistribute YuanStar's own code is granted.

Author: Drifty Yan
