import { classifyProductImportImageVisual } from "../src/product-import-visual-classifier.js";
import { classifyPageVisual } from "../src/structured/page-routing-visual-only.js";
import { createScreenshotProfile } from "../src/structured/profiles.js";
import { BrowserVisionWorkerClient } from "../src/structured/browser-vision-worker-client.js";
import type { BrowserVisionEngine, PageClassificationV1 } from "../src/structured/contracts.js";
import { ProductOcrImportCoordinator, applyProductImportClassification, applyProductImportClassificationFailure, createProductImportImages, moveProductImportImage, type ProductImportImage } from "../src/product-ocr-import.js";

function expect(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function rejects(action: () => Promise<unknown>, message: string): Promise<void> {
  try { await action(); } catch { return; }
  throw new Error(message);
}

// Selected-tab pixel structures use the existing routing detector, without text or OCR.
function pixels(pageType: PageClassificationV1["pageType"]): ImageData {
  const width = 300, height = 600;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let at = 0; at < data.length; at += 4) { data[at] = 40; data[at + 1] = 40; data[at + 2] = 40; data[at + 3] = 255; }
  if (pageType !== "unknown") {
    const left = { main: 12, support: 112, experience: 212 }[pageType];
    for (let y = 52; y < 72; y++) for (let x = left; x < left + 75; x++) {
      const at = (y * width + x) * 4;
      data[at] = 220; data[at + 1] = 180; data[at + 2] = 100;
    }
  }
  return { width, height, data } as ImageData;
}

const originals = new Map(["createImageBitmap", "OffscreenCanvas"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let currentPixels = pixels("main");
let canvasFailure: "constructor" | "context" | "draw" | "read" | null = null;
const closed: number[] = [];
let created = 0;
const setGlobal = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
const bitmapFactory = async () => {
  const ordinal = ++created;
  closed.push(0);
  return { width: currentPixels.width, height: currentPixels.height, close() { closed[ordinal - 1]++; } } as ImageBitmap;
};
class StubCanvas {
  constructor(_width: number, _height: number) { if (canvasFailure === "constructor") throw new Error("canvas construction failed"); }
  getContext() {
    if (canvasFailure === "context") return null;
    return {
      drawImage() { if (canvasFailure === "draw") throw new Error("draw failed"); },
      getImageData() { if (canvasFailure === "read") throw new Error("read failed"); return currentPixels; },
    };
  }
}
const image = createProductImportImages([new File(["fixture"], "visual.png", { type: "image/png" })], { createObjectUrl: () => "blob:visual" })[0]!;
const ocrCalls = { initialize: 0, classifyImage: 0, recognize: 0 };
const engine: BrowserVisionEngine = {
  async initialize() { ocrCalls.initialize++; return { schemaVersion: "1.0", models: [] }; },
  async classifyImage() { ocrCalls.classifyImage++; throw new Error("OCR classification forbidden"); },
  async analyzeImage() { ocrCalls.recognize++; throw new Error("recognition forbidden during suggestions"); },
  async dispose() {},
};

try {
  setGlobal("createImageBitmap", bitmapFactory);
  setGlobal("OffscreenCanvas", StubCanvas);
  const coordinator = new ProductOcrImportCoordinator({ engine });
  for (const [pageType, pool] of [["main", "主星"], ["support", "辅星"], ["experience", "经验星曜"], ["unknown", "主星"]] as const) {
    currentPixels = pixels(pageType);
    const routing = classifyPageVisual(currentPixels, createScreenshotProfile(currentPixels).viewport);
    expect(routing.pageType === pageType && routing.tabOcrMs === 0 && routing.tabOcrCandidates.length === 0, `${pageType} routes from pixels alone`);
    const result = await coordinator.classify(image);
    expect(result.pageType === pageType && result.tabOcrEvidence.length === 0, `${pageType} classifier uses no tab OCR evidence`);
    expect(result.visualEvidence.every(({ source }) => source === "visual"), "all classification evidence is visual");
    const updated = applyProductImportClassification([image], image.sourceImageId, result)[0]!;
    expect(updated.pool === pool && !updated.confirmed, `${pageType} maps to its pool without auto-confirmation`);
    if (pageType === "unknown") {
      expect(result.reviewRequired && updated.classificationStatus === "failed" && updated.classificationReviewRequired && updated.suggestedPool === null && updated.poolSource === "fallback", "unknown preserves failed/manual review and safe display fallback");
      const moved = moveProductImportImage([updated], [], image.sourceImageId, "辅星").images[0]!;
      expect(moved.pool === "辅星" && moved.poolSource === "manual" && !moved.confirmed, "unknown remains manually movable");
      const reapplied = applyProductImportClassification([moved], image.sourceImageId, result)[0]!;
      expect(reapplied.pool === "辅星" && reapplied.poolSource === "manual", "unknown cannot overwrite a manual pool");
    } else expect(updated.suggestedPool === pool && updated.classificationStatus === "suggested", `${pageType} retains suggestion metadata`);
    expect(closed[created - 1] === 1, `${pageType} closes its bitmap exactly once`);
  }
  expect(ocrCalls.initialize === 0 && ocrCalls.classifyImage === 0 && ocrCalls.recognize === 0, "default coordinator pre-classification makes zero OCR initialize/classifyImage/recognize calls");

  for (const failure of ["constructor", "context", "draw", "read"] as const) {
    canvasFailure = failure;
    await rejects(() => classifyProductImportImageVisual(image), `${failure} must reject to the page's failure handler`);
    expect(closed[created - 1] === 1, `${failure} closes the successfully created bitmap`);
  }
  canvasFailure = null;
  setGlobal("OffscreenCanvas", undefined);
  await rejects(() => coordinator.classify(image), "unsupported canvas must reject");
  expect(closed[created - 1] === 1 && !coordinator.classificationPending, "unsupported canvas closes bitmap and clears pending state");
  setGlobal("OffscreenCanvas", StubCanvas);
  const createdBeforeDecodeFailure = created;
  setGlobal("createImageBitmap", async () => { throw new Error("decode failed"); });
  let failedImages: ProductImportImage[] = [image];
  try { await coordinator.classify(image); } catch { failedImages = applyProductImportClassificationFailure(failedImages, image.sourceImageId); }
  expect(created === createdBeforeDecodeFailure, "failed decoding creates no bitmap to release");
  expect(failedImages[0]!.file === image.file && !failedImages[0]!.confirmed && failedImages[0]!.classificationReviewRequired && failedImages[0]!.classificationStatus === "failed", "decode failure retains imported File for manual review");
  setGlobal("createImageBitmap", undefined);
  await rejects(() => coordinator.classify(image), "unsupported bitmap API must reject into manual review");
  expect(!coordinator.classificationPending, "failed classification never leaves the pending counter stuck");
  setGlobal("createImageBitmap", bitmapFactory);
  currentPixels = pixels("support");
  expect((await coordinator.classify(image)).pageType === "support", "queue recovers after classification failures");
  expect(ocrCalls.initialize === 0 && ocrCalls.classifyImage === 0 && ocrCalls.recognize === 0, "unknown, failures and recovery never fall back to OCR");
  await coordinator.dispose();

  let workerCreations = 0;
  const workerClient = new BrowserVisionWorkerClient(() => { workerCreations++; throw new Error("Worker creation forbidden during suggestions"); });
  const workerCoordinator = new ProductOcrImportCoordinator({ engine: workerClient });
  expect((await workerCoordinator.classify(image)).pageType === "support", "visual classification works with the production Worker client idle");
  expect(workerCreations === 0 && workerClient.state === "idle" && workerClient.diagnostics.network.requestCount === 0, "pre-classification creates zero OCR Workers and leaves the client uninitialized");
  await workerCoordinator.dispose();

  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const order: string[] = [];
  const queued = new ProductOcrImportCoordinator({ engine, classifyImportImage: async (item) => {
    order.push(item.sourceImageId);
    if (order.length === 1) await blocked;
    return { pageType: "unknown", confidence: 0, visualEvidence: [], tabOcrEvidence: [], warning: null, reviewRequired: true };
  } });
  const first = queued.classify({ ...image, sourceImageId: "first" });
  const second = queued.classify({ ...image, sourceImageId: "second" });
  await Promise.resolve();
  expect(queued.classificationPending && order.join(",") === "first", "pre-classification remains serialized");
  await rejects(() => queued.run({ jobId: "pending", accountId: "A", gameVersion: "如鸢", baseRevision: 0, images: [], overlapPairs: [] }, () => {}), "pending classification must still block formal OCR");
  let disposed = false;
  const disposing = queued.dispose().then(() => { disposed = true; });
  await Promise.resolve();
  expect(!disposed, "dispose waits for queued visual classifications");
  release();
  await Promise.all([first, second, disposing]);
  expect(order.join(",") === "first,second" && !queued.classificationPending && disposed, "queue and pending lifecycle remain intact");
  expect(closed.every((count) => count === 1), "every successful bitmap creation closes exactly once");
  console.log("PASS visual import: main/support/experience/unknown, manual review, zero OCR calls, bitmap cleanup, unsupported APIs, failure recovery and serial queue");
} finally {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
}
