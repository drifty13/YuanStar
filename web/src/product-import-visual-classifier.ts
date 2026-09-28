import type { PageClassificationV1 } from "./structured/contracts.js";
import { imageDataForBitmap } from "./structured/image-canvas-runtime.js";
import { toPageClassificationV1 } from "./structured/page-routing-logic.js";
import { classifyPageVisual } from "./structured/page-routing-visual-only.js";
import { createScreenshotProfile } from "./structured/profiles.js";
import type { ProductImportImage } from "./product-ocr-import.js";

/** Manual-import suggestion only. Failures use the existing manual-review path. */
export async function classifyProductImportImageVisual(image: ProductImportImage): Promise<PageClassificationV1> {
  const bitmap = await createImageBitmap(image.file);
  try {
    const imageData = imageDataForBitmap(bitmap);
    const profile = createScreenshotProfile(imageData);
    return toPageClassificationV1(classifyPageVisual(imageData, profile.viewport));
  } finally {
    bitmap.close();
  }
}
