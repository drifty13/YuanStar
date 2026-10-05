import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

// Exercise the actual standalone failed-run branch, using the existing source-boundary test style.
const source = readFileSync(new URL("../src/product.ts", import.meta.url), "utf8");
const start = source.indexOf('    if (run.status === "failed" || !run.result) {');
const end = source.indexOf('    if (run.status === "partial"', start);
assert.ok(start >= 0 && end > start);
const failureBranch = source.slice(start, end);
for (const code of ["engine_initialization_timeout", "engine_initialization_failed", "image_analysis_failed"]) {
  let notice, rendered = 0;
  const context = { run: { status: "failed", result: null, error: { code, message: "fixture failure" } }, ocrUi: { status: "initializing", sourceImageId: "synthetic" },
    importNotice: (message, error) => { notice = { message, error }; }, renderPage: () => { rendered++; } };
  vm.runInNewContext(`(function () { ${failureBranch} })()`, context);
  assert.equal(context.ocrUi.status, "failed");
  assert.equal(context.ocrUi.sourceImageId, null);
  assert.equal(rendered, 1);
  assert.equal(notice.error, true);
  if (code === "engine_initialization_timeout") assert.equal(notice.message, "OCR 初始化超时，可以重试。");
  else assert.match(notice.message, /识别失败.*可直接重试.*fixture failure/u);
}
const pageShow = source.match(/window\.addEventListener\("pageshow", \(event\) => \{ if \(event\.persisted\) window\.location\.reload\(\); \}\);/);
assert.ok(pageShow, "standalone BFCache restore handler remains registered");
let onPageShow, reloads = 0;
vm.runInNewContext(pageShow[0], { window: { addEventListener: (_type, handler) => { onPageShow = handler; }, location: { reload: () => { reloads++; } } } });
onPageShow({ persisted: false }); assert.equal(reloads, 0);
onPageShow({ persisted: true }); assert.equal(reloads, 1);
console.log("PASS standalone timeout presentation: typed initialization error and existing retry UI");
