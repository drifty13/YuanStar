import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyOcrAssets, REQUIRED_OCR_ASSET_FILENAMES, verifyOcrAssets } from "../scripts/copy-runtime-assets.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fixtureRoot = await mkdtemp(join(tmpdir(), "yuanstar-ocr-assets-"));
const sourceDir = join(fixtureRoot, "source");
const destinationDir = join(fixtureRoot, "staging");

try {
  await verifyOcrAssets();
  await mkdir(sourceDir, { recursive: true });
  const assets = await Promise.all(REQUIRED_OCR_ASSET_FILENAMES.map(async (filename, index) => {
    const bytes = Buffer.from(`fixture:${filename}:${index}`, "utf8");
    await writeFile(join(sourceDir, filename), bytes);
    return { filename, size: bytes.length, sha256: hash(bytes), source: "fixture", sourceVersion: "test", license: "Apache-2.0" };
  }));
  const manifestPath = join(sourceDir, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify({ assets }, null, 2)}\n`, "utf8");

  await copyOcrAssets({ sourceDir, destinationDir, manifestPath });
  for (const asset of assets) assert.equal(hash(await readFile(join(destinationDir, asset.filename))), asset.sha256, `staging hash mismatch for ${asset.filename}`);

  await rm(join(sourceDir, REQUIRED_OCR_ASSET_FILENAMES[0]));
  await assert.rejects(() => verifyOcrAssets({ sourceDir, manifestPath }), /missing source asset/);
  await writeFile(join(sourceDir, REQUIRED_OCR_ASSET_FILENAMES[0]), "wrong bytes", "utf8");
  await assert.rejects(() => verifyOcrAssets({ sourceDir, manifestPath }), /size mismatch|SHA256 mismatch/);
  console.log("asset pipeline verification passed");
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
