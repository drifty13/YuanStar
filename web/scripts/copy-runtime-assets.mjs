import { cp, mkdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = dirname(webRoot);

export const REQUIRED_OCR_ASSET_FILENAMES = Object.freeze([
  "PP-OCRv6_det_small.onnx",
  "ch_ppocr_mobile_v2.0_cls_mobile.onnx",
  "PP-OCRv6_rec_small.onnx",
  "ppocrv6_chars.txt",
]);

const ocrSource = join(repositoryRoot, "resources", "ocr");
const ocrStaging = join(webRoot, "public", "models");

function assetError(message) {
  return new Error(`OCR release asset validation failed: ${message}`);
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function validatedManifestAssets(manifest) {
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.assets)) throw assetError("manifest must contain an assets array");
  if (manifest.assets.length !== REQUIRED_OCR_ASSET_FILENAMES.length) throw assetError("manifest must contain exactly four OCR assets");
  const byFilename = new Map();
  for (const asset of manifest.assets) {
    if (!asset || typeof asset !== "object" || typeof asset.filename !== "string" || typeof asset.size !== "number" || typeof asset.sha256 !== "string") {
      throw assetError("each manifest asset must declare filename, size, and sha256");
    }
    if (!REQUIRED_OCR_ASSET_FILENAMES.includes(asset.filename) || byFilename.has(asset.filename)) throw assetError(`unexpected or duplicate asset: ${asset.filename}`);
    if (!Number.isSafeInteger(asset.size) || asset.size < 1) throw assetError(`invalid size for ${asset.filename}`);
    if (!/^[a-f0-9]{64}$/u.test(asset.sha256)) throw assetError(`invalid SHA256 for ${asset.filename}`);
    byFilename.set(asset.filename, asset);
  }
  for (const filename of REQUIRED_OCR_ASSET_FILENAMES) if (!byFilename.has(filename)) throw assetError(`manifest missing ${filename}`);
  return REQUIRED_OCR_ASSET_FILENAMES.map((filename) => byFilename.get(filename));
}

export async function verifyOcrAssets({ sourceDir = ocrSource, manifestPath = join(sourceDir, "manifest.json") } = {}) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw assetError(`cannot read manifest at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const assets = validatedManifestAssets(manifest);
  for (const asset of assets) {
    const path = join(sourceDir, asset.filename);
    let size;
    try {
      size = (await stat(path)).size;
    } catch {
      throw assetError(`missing source asset ${asset.filename}`);
    }
    if (size !== asset.size) throw assetError(`size mismatch for ${asset.filename}: expected ${asset.size}, got ${size}`);
    const actualHash = await sha256(path);
    if (actualHash !== asset.sha256) throw assetError(`SHA256 mismatch for ${asset.filename}: expected ${asset.sha256}, got ${actualHash}`);
  }
  return assets;
}

export async function copyOcrAssets({ sourceDir = ocrSource, destinationDir = ocrStaging, manifestPath = join(sourceDir, "manifest.json") } = {}) {
  const assets = await verifyOcrAssets({ sourceDir, manifestPath });
  await mkdir(destinationDir, { recursive: true });
  for (const asset of assets) {
    const sourcePath = join(sourceDir, asset.filename);
    const destinationPath = join(destinationDir, asset.filename);
    await cp(sourcePath, destinationPath);
    const copiedSize = (await stat(destinationPath)).size;
    const copiedHash = await sha256(destinationPath);
    if (copiedSize !== asset.size || copiedHash !== asset.sha256) throw assetError(`staging copy verification failed for ${asset.filename}`);
  }
  return assets;
}

export async function copyRuntimeAssets() {
  const ocrAssets = await copyOcrAssets();

  const ortSource = join(webRoot, "node_modules", "onnxruntime-web", "dist");
  const ortDestination = join(webRoot, "public", "ort");
  const ortNames = ["ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"];
  await mkdir(ortDestination, { recursive: true });
  for (const name of ortNames) await cp(join(ortSource, name), join(ortDestination, name));

  const experienceRulesSource = join(repositoryRoot, "resources", "reference", "YuanStar_Phase0_6A_经验星曜规则与逐级数据.xlsx");
  const experienceRulesDestination = join(webRoot, "public", "reference");
  await mkdir(experienceRulesDestination, { recursive: true });
  await cp(experienceRulesSource, join(experienceRulesDestination, "YuanStar_Phase0_6A_经验星曜规则与逐级数据.xlsx"));

  console.log(`Verified and copied ${ocrAssets.length} OCR assets, ${ortNames.length} ONNX Runtime Web assets, and the Phase 0.6 experience rules workbook.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await copyRuntimeAssets();
