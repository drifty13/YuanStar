import type { GameVersion } from "./business/model.js";
import type { ReconcileDraftV1, ReconcileResolutionV1, ReconcileSourceImageInput } from "./business/reconcile.js";
import type { ConfirmedOverlapPairV1 } from "./structured/batch-orchestration.js";
import { BrowserOcrRuntime } from "./ocr/browser-ocr-runtime.js";
import { BrowserVisionWorkerClient } from "./structured/browser-vision-worker-client.js";
import type { BrowserVisionEngine, PageClassificationV1 } from "./structured/contracts.js";
import type {
  BrowserAnalysisResultV1,
  BrowserOcrRuntimeJobV1,
  BrowserOcrRuntimeProgressV1,
  BrowserOcrRuntimeRunV1,
} from "./ocr/browser-analysis-contract.js";

export type ProductImportPool = "主星" | "辅星" | "经验星曜";
export type ProductOverlapPool = Exclude<ProductImportPool, "经验星曜">;

export interface ProductImportImage {
  sourceImageId: string;
  filename: string;
  size: number;
  file: File;
  pool: ProductImportPool;
  confirmed: boolean;
  suggestedPool: ProductImportPool | null;
  classificationStatus: "classifying" | "suggested" | "failed";
  classificationReviewRequired: boolean;
  poolSource: "suggested" | "manual" | "fallback";
  objectUrl: string;
  width: number | null;
  height: number | null;
}

export interface ProductOverlapPair {
  pairId: string;
  pool: ProductOverlapPool;
  beforeId: string;
  afterId: string;
}

export interface ProductOcrRunContextV1 {
  jobId: string;
  accountId: string;
  gameVersion: GameVersion;
  baseRevision: number;
  images: ProductImportImage[];
  overlapPairs: ProductOverlapPair[];
}

export class ProductOcrImportError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "ProductOcrImportError"; }
}

const runtimePool: Record<ProductImportPool, "main" | "support" | "experience"> = {
  主星: "main",
  辅星: "support",
  经验星曜: "experience",
};

const productPool: Record<"main" | "support" | "experience", ProductImportPool> = {
  main: "主星",
  support: "辅星",
  experience: "经验星曜",
};

let sourceOrdinal = 0;

function defaultSourceImageId(file: File): string {
  sourceOrdinal += 1;
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `import-${file.size.toString(36)}-${file.lastModified.toString(36)}-${sourceOrdinal.toString(36)}-${random}`;
}

export function createProductImportImages(
  files: Iterable<File>,
  options: {
    createSourceImageId?: (file: File, index: number) => string;
    createObjectUrl?: (file: File) => string;
    defaultPool?: ProductImportPool;
  } = {},
): ProductImportImage[] {
  const createSourceImageId = options.createSourceImageId ?? ((file: File) => defaultSourceImageId(file));
  const createObjectUrl = options.createObjectUrl ?? ((file: File) => URL.createObjectURL(file));
  const seen = new Set<string>();
  return [...files].filter((file) => file.type.startsWith("image/")).map((file, index) => {
    const sourceImageId = createSourceImageId(file, index);
    if (!sourceImageId.trim() || seen.has(sourceImageId)) throw new ProductOcrImportError("source_image_id_invalid", "导入图片标识无效或重复。");
    seen.add(sourceImageId);
    return {
      sourceImageId,
      filename: file.name || `clipboard-image-${index + 1}.png`,
      size: file.size,
      file,
      pool: options.defaultPool ?? "主星",
      confirmed: false,
      suggestedPool: null,
      classificationStatus: "classifying",
      classificationReviewRequired: false,
      poolSource: "suggested",
      objectUrl: createObjectUrl(file),
      width: null,
      height: null,
    };
  });
}

export function applyProductImportClassification(
  images: ProductImportImage[],
  sourceImageId: string,
  classification: Pick<PageClassificationV1, "pageType" | "reviewRequired">,
): ProductImportImage[] {
  const suggestedPool = classification.pageType === "unknown" ? null : productPool[classification.pageType];
  return images.map((image) => {
    if (image.sourceImageId !== sourceImageId) return image;
    if (!suggestedPool) return { ...image, pool: image.poolSource === "manual" ? image.pool : "主星", confirmed: false, suggestedPool: null, classificationStatus: "failed", classificationReviewRequired: true, poolSource: image.poolSource === "manual" ? "manual" : "fallback" };
    return {
      ...image,
      pool: image.poolSource === "manual" ? image.pool : suggestedPool,
      confirmed: false,
      suggestedPool,
      classificationStatus: "suggested",
      classificationReviewRequired: classification.reviewRequired,
      poolSource: image.poolSource === "manual" ? "manual" : "suggested",
    };
  });
}

export function applyProductImportClassificationFailure(images: ProductImportImage[], sourceImageId: string): ProductImportImage[] {
  return images.map((image) => image.sourceImageId === sourceImageId
    ? { ...image, pool: image.poolSource === "manual" ? image.pool : "主星", confirmed: false, classificationStatus: "failed", classificationReviewRequired: true, poolSource: image.poolSource === "manual" ? "manual" : "fallback" }
    : image);
}

export function confirmProductImportPool(images: ProductImportImage[], pool: ProductImportPool): ProductImportImage[] {
  return images.map((image) => image.pool === pool && image.classificationStatus !== "classifying" ? { ...image, confirmed: true } : image);
}

export function confirmAllProductImportImages(images: ProductImportImage[]): ProductImportImage[] {
  return images.map((image) => image.classificationStatus === "classifying" ? image : { ...image, confirmed: true });
}

export function sortProductImportImagesForDisplay(images: ProductImportImage[]): ProductImportImage[] {
  const priority = (image: ProductImportImage): number => {
    if (image.classificationStatus === "failed") return 0;
    if (image.classificationReviewRequired) return 1;
    if (!image.confirmed) return 2;
    return 3;
  };
  const originalOrder = new Map(images.map((image, index) => [image.sourceImageId, index]));
  return [...images].sort((left, right) => priority(left) - priority(right) || (originalOrder.get(left.sourceImageId)! - originalOrder.get(right.sourceImageId)!));
}

export function moveProductImportImage(
  images: ProductImportImage[],
  pairs: ProductOverlapPair[],
  sourceImageId: string,
  targetPool: ProductImportPool,
): { images: ProductImportImage[]; pairs: ProductOverlapPair[] } {
  const current = images.find((image) => image.sourceImageId === sourceImageId);
  if (!current || current.classificationStatus === "classifying" || current.pool === targetPool) return { images, pairs };
  return {
    images: images.map((image) => image.sourceImageId === sourceImageId ? { ...image, pool: targetPool, confirmed: false, poolSource: "manual" } : image),
    pairs: pairs.filter((pair) => pair.beforeId !== sourceImageId && pair.afterId !== sourceImageId),
  };
}

export function removeProductImportImage(
  images: ProductImportImage[],
  pairs: ProductOverlapPair[],
  sourceImageId: string,
): { images: ProductImportImage[]; pairs: ProductOverlapPair[]; removed: ProductImportImage | null } {
  const removed = images.find((image) => image.sourceImageId === sourceImageId) ?? null;
  return {
    images: images.filter((image) => image.sourceImageId !== sourceImageId),
    pairs: pairs.filter((pair) => pair.beforeId !== sourceImageId && pair.afterId !== sourceImageId),
    removed,
  };
}

function overlapPairId(pool: ProductOverlapPool, beforeId: string, afterId: string): string {
  return `overlap:${runtimePool[pool]}:${beforeId}->${afterId}`;
}

export function addProductOverlapPair(
  images: ProductImportImage[],
  pairs: ProductOverlapPair[],
  pool: ProductOverlapPool,
  beforeId: string,
  afterId: string,
): ProductOverlapPair[] {
  const before = images.find((image) => image.sourceImageId === beforeId);
  const after = images.find((image) => image.sourceImageId === afterId);
  if (!before || !after) throw new ProductOcrImportError("overlap_image_missing", "请选择两张当前池中的图片。");
  if (beforeId === afterId) throw new ProductOcrImportError("overlap_same_image", "重叠关系必须选择两张不同图片。");
  if (before.pool !== pool || after.pool !== pool) throw new ProductOcrImportError("overlap_pool_mismatch", "重叠图片必须位于同一个主星或辅星池。");
  if (!before.confirmed || !after.confirmed) throw new ProductOcrImportError("overlap_unconfirmed", "请先确认两张图片的所属池，再添加重叠关系。");
  if (pairs.some((pair) => pair.pool === pool && ((pair.beforeId === beforeId && pair.afterId === afterId) || (pair.beforeId === afterId && pair.afterId === beforeId)))) throw new ProductOcrImportError("overlap_duplicate", "该重叠关系已存在。");
  return [...pairs, { pairId: overlapPairId(pool, beforeId, afterId), pool, beforeId, afterId }];
}

export function validateProductOcrImport(images: ProductImportImage[], pairs: ProductOverlapPair[]): string | null {
  if (!images.length) return "请先添加至少一张本地图片。";
  if (new Set(images.map((image) => image.sourceImageId)).size !== images.length || images.some((image) => !image.file || !image.sourceImageId.trim())) return "待识别图片状态无效，请移除后重新添加。";
  if (images.some((image) => image.classificationStatus === "classifying")) return "正在判断图片类型，请稍候。";
  if (images.some((image) => !image.confirmed)) return "请先确认所有待识别图片的所属池。";
  const ids = new Set(images.map((image) => image.sourceImageId));
  for (const pair of pairs) {
    const before = images.find((image) => image.sourceImageId === pair.beforeId);
    const after = images.find((image) => image.sourceImageId === pair.afterId);
    if (!ids.has(pair.beforeId) || !ids.has(pair.afterId) || pair.beforeId === pair.afterId || !before?.confirmed || !after?.confirmed || before.pool !== pair.pool || after.pool !== pair.pool) return "重叠关系已失效，请重新确认。";
  }
  return null;
}

export function buildProductOcrRuntimeJob(context: ProductOcrRunContextV1): BrowserOcrRuntimeJobV1 {
  const invalid = validateProductOcrImport(context.images, context.overlapPairs);
  if (invalid) throw new ProductOcrImportError("import_validation_failed", invalid);
  const confirmedOverlapPairs: ConfirmedOverlapPairV1[] = context.overlapPairs.map((pair) => ({
    pairId: pair.pairId,
    sourceImageIdA: pair.beforeId,
    sourceImageIdB: pair.afterId,
  }));
  return {
    schemaVersion: 1,
    jobId: context.jobId,
    images: context.images.map((image, index) => ({
      sourceImageId: image.sourceImageId,
      sourceOrder: index + 1,
      file: image.file,
      confirmedPool: { imageId: image.sourceImageId, pageType: runtimePool[image.pool] },
    })),
    confirmedOverlapPairs,
  };
}

export function reconcileSourceImagesFromImport(images: ProductImportImage[]): ReconcileSourceImageInput[] {
  return images.map((image) => ({
    sourceImageId: image.sourceImageId,
    blob: image.file,
    filename: image.filename,
    mimeType: image.file.type || "application/octet-stream",
    width: image.width,
    height: image.height,
  }));
}

export function completedRuntimeResultForReconcile(run: BrowserOcrRuntimeRunV1): BrowserAnalysisResultV1 | null {
  return run.status === "completed" && run.result?.job.status === "completed" ? run.result : null;
}

export function isReconcileResolutionComplete(draft: ReconcileDraftV1, resolution: ReconcileResolutionV1): boolean {
  const mergedOccurrenceIds = new Set(draft.overlapReviewItems
    .filter((item) => resolution.overlap?.[item.rowReviewId]?.action === "merge")
    .flatMap((item) => [...item.leftOccurrenceIds, ...item.rightOccurrenceIds]));
  if (draft.ordinaryReviewItems.some((item) => !resolution.ordinary?.[item.occurrenceId] && !mergedOccurrenceIds.has(item.occurrenceId))) return false;
  if (draft.overlapReviewItems.some((item) => !resolution.overlap?.[item.rowReviewId])) return false;
  if (draft.bag.reviewReasonCodes.length && (!resolution.bag || !("currentCount" in resolution.bag) || !("capacity" in resolution.bag))) return false;
  for (const color of ["orange", "purple", "white"] as const) {
    const required = draft.experience.reviewReasonCodes.some((code) => code === `experience_${color}_conflict` || code === `experience_${color}_requires_review`);
    if (required && (!resolution.experience || !(color in resolution.experience))) return false;
  }
  return true;
}

export class ProductOcrImportCoordinator {
  private activeContext: ProductOcrRunContextV1 | null = null;
  private readonly engine: BrowserVisionEngine;
  private readonly runtime: BrowserOcrRuntime;
  private classificationQueue: Promise<void> = Promise.resolve();
  private pendingClassificationCount = 0;

  constructor(options: { engine?: BrowserVisionEngine; runtime?: BrowserOcrRuntime } = {}) {
    this.engine = options.engine ?? new BrowserVisionWorkerClient();
    this.runtime = options.runtime ?? new BrowserOcrRuntime({ createEngine: () => this.engine });
  }

  get active(): ProductOcrRunContextV1 | null { return this.activeContext; }
  get classificationPending(): boolean { return this.pendingClassificationCount > 0; }

  async classify(image: ProductImportImage): Promise<PageClassificationV1> {
    if (this.activeContext) throw new ProductOcrImportError("ocr_already_running", "识别运行期间不能重新判断图片类型。");
    this.pendingClassificationCount += 1;
    const classify = async (): Promise<PageClassificationV1> => {
      await this.engine.initialize({});
      return this.engine.classifyImage({ imageId: image.sourceImageId, file: image.file });
    };
    const result = this.classificationQueue.then(classify, classify);
    this.classificationQueue = result.then(() => undefined, () => undefined);
    try { return await result; }
    finally { this.pendingClassificationCount -= 1; }
  }

  async run(context: ProductOcrRunContextV1, onProgress: (event: BrowserOcrRuntimeProgressV1) => void): Promise<BrowserOcrRuntimeRunV1> {
    if (this.activeContext) throw new ProductOcrImportError("ocr_already_running", "已有识别任务正在运行。");
    if (this.classificationPending) throw new ProductOcrImportError("classification_in_progress", "正在判断图片类型，请稍候。");
    this.activeContext = context;
    try { return await this.runtime.run(buildProductOcrRuntimeJob(context), { onProgress }); }
    finally { this.activeContext = null; }
  }

  cancel(): boolean { return this.runtime.cancel(); }
  async dispose(): Promise<void> { await this.classificationQueue; await this.runtime.dispose(); this.activeContext = null; }
}
