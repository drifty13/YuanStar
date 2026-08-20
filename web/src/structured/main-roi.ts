import type { Rect } from "./types.js";
import { createRuntimeCanvas, type RuntimeCanvas } from "./image-canvas-runtime.js";

export function clampRect(rect: Rect, width: number, height: number): Rect {
  const left = Math.max(0, Math.min(width, rect.x));
  const top = Math.max(0, Math.min(height, rect.y));
  const right = Math.max(left, Math.min(width, rect.x + rect.width));
  const bottom = Math.max(top, Math.min(height, rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function cropRect(bitmap: ImageBitmap, rect: Rect): RuntimeCanvas {
  const safe = clampRect(rect, bitmap.width, bitmap.height);
  const canvas = createRuntimeCanvas(safe.width, safe.height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("无法创建 ROI Canvas");
  context.drawImage(bitmap, safe.x, safe.y, safe.width, safe.height, 0, 0, safe.width, safe.height);
  return canvas;
}
