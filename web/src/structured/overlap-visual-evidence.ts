import type { CardVisualEvidenceV1, Rect } from "./contracts.js";
import { createRuntimeCanvas } from "./image-canvas-runtime.js";

function cropRect(rect: Rect, xRatio: number, yRatio: number, widthRatio: number, heightRatio: number): Rect {
  return {
    x: rect.x + Math.floor(rect.width * xRatio),
    y: rect.y + Math.floor(rect.height * yRatio),
    width: Math.max(1, Math.floor(rect.width * widthRatio)),
    height: Math.max(1, Math.floor(rect.height * heightRatio)),
  };
}

function grayscale32(bitmap: ImageBitmap, rect: Rect): Uint8Array {
  const canvas = createRuntimeCanvas(32, 32);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("cannot create overlap evidence canvas");
  context.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, 32, 32);
  const pixels = context.getImageData(0, 0, 32, 32).data;
  const gray = new Uint8Array(32 * 32);
  for (let index = 0; index < gray.length; index += 1) {
    const offset = index * 4;
    gray[index] = Math.round(((pixels[offset] ?? 0) * 299 + (pixels[offset + 1] ?? 0) * 587 + (pixels[offset + 2] ?? 0) * 114) / 1000);
  }
  return gray;
}

function dctBits(gray: Uint8Array): string {
  const coefficients: number[] = [];
  for (let vertical = 0; vertical < 8; vertical += 1) {
    for (let horizontal = 0; horizontal < 8; horizontal += 1) {
      let total = 0;
      for (let y = 0; y < 32; y += 1) {
        for (let x = 0; x < 32; x += 1) total += (gray[y * 32 + x] ?? 0) * Math.cos((Math.PI * (2 * x + 1) * horizontal) / 64) * Math.cos((Math.PI * (2 * y + 1) * vertical) / 64);
      }
      const scale = .25 * (horizontal === 0 ? 1 / Math.sqrt(2) : 1) * (vertical === 0 ? 1 / Math.sqrt(2) : 1);
      coefficients.push(total * scale);
    }
  }
  const thresholdValues = coefficients.slice(1).sort((left, right) => left - right);
  const median = thresholdValues[Math.floor(thresholdValues.length / 2)] ?? 0;
  return coefficients.map((value) => value >= median ? "1" : "0").join("");
}

function hueHistogram(bitmap: ImageBitmap, rect: Rect): number[] {
  const canvas = createRuntimeCanvas(32, 32);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("cannot create overlap hue canvas");
  context.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, 32, 32);
  const pixels = context.getImageData(0, 0, 32, 32).data;
  const histogram = Array.from({ length: 12 }, () => 0);
  for (let index = 0; index < 32 * 32; index += 1) {
    const offset = index * 4;
    const red = (pixels[offset] ?? 0) / 255;
    const green = (pixels[offset + 1] ?? 0) / 255;
    const blue = (pixels[offset + 2] ?? 0) / 255;
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    const delta = maximum - minimum;
    if (maximum === 0 || delta / maximum < 42 / 255) continue;
    let hue = 0;
    if (maximum === red) hue = ((green - blue) / delta + (green < blue ? 6 : 0)) * 30;
    else if (maximum === green) hue = ((blue - red) / delta + 2) * 30;
    else hue = ((red - green) / delta + 4) * 30;
    histogram[Math.min(11, Math.floor(Math.max(0, hue) / 15))]! += 1;
  }
  const total = histogram.reduce((sum, value) => sum + value, 0);
  return histogram.map((value) => total ? value / total : 0);
}

export function createCardVisualEvidence(bitmap: ImageBitmap, sourceRect: { card: Rect; name: Rect; level: Rect }): CardVisualEvidenceV1 {
  const icon = cropRect(sourceRect.card, .12, .12, .76, .76);
  return {
    algorithm: "phash_hue_v1",
    iconBits: dctBits(grayscale32(bitmap, icon)),
    nameBits: dctBits(grayscale32(bitmap, sourceRect.name)),
    levelBits: dctBits(grayscale32(bitmap, sourceRect.level)),
    hueHistogram: hueHistogram(bitmap, icon),
  };
}
