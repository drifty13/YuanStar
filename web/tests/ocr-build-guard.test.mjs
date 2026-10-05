import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultClientConditions } from "vite";
import config from "../vite.config.mjs";
import { MAX_OCR_WORKER_BYTES, verifyOcrBuild } from "../scripts/verify-ocr-build.mjs";

assert.equal(config.base, "/");
assert.deepEqual(config.resolve.conditions, ["onnxruntime-web-use-extern-wasm", ...defaultClientConditions]);
const testRoot = new URL("../.tmp/test/", import.meta.url);
await mkdir(testRoot, { recursive: true });
const root = await mkdtemp(join(fileURLToPath(testRoot), "ocr-build-"));
const assets = join(root, "assets"), ort = join(root, "ort");
const worker = join(assets, "browser-vision-worker-fixture.js");
try {
  await mkdir(assets); await mkdir(ort);
  for (const name of ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]) await writeFile(join(ort, name), "external fixture", "utf8");
  await assert.rejects(() => verifyOcrBuild(root), /exactly one.*found 0/);
  await writeFile(worker, "/* standalone worker fixture */", "utf8");
  assert.equal((await verifyOcrBuild(root)).worker, "browser-vision-worker-fixture.js");
  await writeFile(join(assets, "browser-vision-worker-extra.js"), "fixture", "utf8");
  await assert.rejects(() => verifyOcrBuild(root), /exactly one.*found 2/);
  await rm(join(assets, "browser-vision-worker-extra.js"));
  await writeFile(worker, Buffer.alloc(MAX_OCR_WORKER_BYTES));
  await assert.rejects(() => verifyOcrBuild(root), /exceeds.*external-WASM/);
  await writeFile(worker, 'const wasm = "data:application/wasm;base64,AGFzbQ==";', "utf8");
  await assert.rejects(() => verifyOcrBuild(root), /embedded WASM/);
  await writeFile(worker, "/* standalone worker fixture */", "utf8");
  for (const name of ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]) {
    const path = join(ort, name);
    await rm(path);
    await assert.rejects(() => verifyOcrBuild(root), new RegExp(`missing or unreadable: ${name.replaceAll(".", "\\.")}`));
    await writeFile(path, "", "utf8");
    await assert.rejects(() => verifyOcrBuild(root), /empty or not a file/);
    await rm(path); await mkdir(path);
    await assert.rejects(() => verifyOcrBuild(root), /empty or not a file/);
    await rmdir(path); await writeFile(path, "external fixture", "utf8");
  }
  await verifyOcrBuild(root);
  console.log("OCR build guard passed: default conditions, worker count/size/embedded WASM, missing/empty/non-file MJS and WASM");
} finally {
  const child = relative(fileURLToPath(testRoot), root);
  if (!child || child.startsWith("..") || isAbsolute(child)) throw new Error("fixture cleanup must stay within the test output directory");
  await rm(root, { recursive: true, force: true });
}
