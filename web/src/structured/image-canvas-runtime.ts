/** Worker-safe raster canvas used by the production recognition import graph. */
export type RuntimeCanvas = OffscreenCanvas;

export function createRuntimeCanvas(width: number, height: number): RuntimeCanvas {
  if (typeof OffscreenCanvas === "undefined") {
    throw new Error("worker_runtime_unavailable: OffscreenCanvas is required");
  }
  return new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
}

export function imageDataForBitmap(bitmap: ImageBitmap): ImageData {
  const canvas = createRuntimeCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("无法创建 Worker Canvas 2D 上下文");
  context.drawImage(bitmap, 0, 0);
  return context.getImageData(0, 0, bitmap.width, bitmap.height);
}
