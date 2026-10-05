import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Public production worker is ~142 KB. This ceiling catches binary payload bloat.
export const MAX_OCR_WORKER_BYTES = 1024 * 1024;

export async function verifyOcrBuild(buildDir) {
  const workers = (await readdir(join(buildDir, "assets"), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^browser-vision-worker-[\w-]+\.js$/u.test(entry.name));
  if (workers.length !== 1) throw new Error(`OCR build must contain exactly one browser vision worker; found ${workers.length}`);
  const worker = await readFile(join(buildDir, "assets", workers[0].name));
  if (worker.length >= MAX_OCR_WORKER_BYTES) throw new Error(`OCR worker exceeds the ${MAX_OCR_WORKER_BYTES}-byte limit: ${worker.length}; check ORT external-WASM resolution`);
  if (/data:application\/wasm;base64/iu.test(worker.toString("utf8"))) throw new Error("OCR worker contains embedded WASM; use the external ORT artifacts");
  for (const filename of ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]) {
    let asset;
    try { asset = await stat(join(buildDir, "ort", filename)); }
    catch (error) { throw new Error(`OCR external runtime asset is missing or unreadable: ${filename}`, { cause: error }); }
    if (!asset.isFile() || asset.size === 0) throw new Error(`OCR external runtime asset is empty or not a file: ${filename}`);
  }
  return { worker: workers[0].name, bytes: worker.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifyOcrBuild(process.argv[2] ?? "dist");
  console.log(`OCR build guard passed: ${result.worker} (${result.bytes} bytes), external MJS/WASM present.`);
}
