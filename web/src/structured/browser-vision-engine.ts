import { disposeLocalOcr, getOcrRuntimeMetrics, isModelLoaded, loadAndVerifyModels, runLocalOcr } from "../ocr.js";
import type { BrowserImageAnalysisV1, BrowserImageInput, BrowserVisionEngine, ConfirmedImagePool, InventoryOcrTokenV1, ModelManifest, PageClassificationV1, PageType, Rect, VisionAssetConfig } from "./contracts.js";
import { buildBrowserImageAnalysis } from "./contract-builder.js";
import { transferBitmapOnSuccess } from "./bitmap-lifecycle.js";
import { createScreenshotProfile } from "./profiles.js";
import { classifyPageVisual, classifyPageWithTabOcr, toPageClassificationV1, type PageRoutingEvidence } from "./page-routing.js";
import { routePage } from "./page-routing-logic.js";
import { runStructuredExperience } from "./experience-pipeline.js";
import { runStructuredMain } from "./main-pipeline.js";
import { runStructuredSupport } from "./support-pipeline.js";
import type { ScreenshotProfile } from "./types.js";
import { inventoryHeaderRoi, observeInventoryHeader } from "./inventory-header.js";
import { createCardVisualEvidence } from "./overlap-visual-evidence.js";
import { createRuntimeCanvas, imageDataForBitmap, type RuntimeCanvas } from "./image-canvas-runtime.js";
import { attachOcrPerfImageDiagnostics, createLevelVariantAuditRecord, createNameVariantAuditRecord, variantsFromCandidateLengths } from "../ocr/performance-diagnostics.js";
import { resolveName as resolveMainName } from "./main-postprocess.js";
import { resolveSupportName } from "./support-postprocess.js";

interface RoutedImage {
  bitmap: ImageBitmap;
  profile: ScreenshotProfile;
  imageData: ImageData;
  routing: PageRoutingEvidence;
  routeTimings: {
    decodeMs: number;
    profileContentBoundsMs: number;
    visualRoutingMs: number;
    tabOcrMs: number;
    totalMs: number;
  };
}

async function canvasBlob(canvas: RuntimeCanvas): Promise<Blob> {
  return canvas.convertToBlob({ type: "image/png" });
}

async function recognizeInventoryTokens(bitmap: ImageBitmap, roi: Rect): Promise<InventoryOcrTokenV1[]> {
  const canvas = createRuntimeCanvas(roi.width, roi.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建 inventory ROI Canvas");
  context.drawImage(bitmap, roi.x, roi.y, roi.width, roi.height, 0, 0, roi.width, roi.height);
  const file = new File([await canvasBlob(canvas)], "inventory-roi.png", { type: "image/png" });
  const output = await runLocalOcr(file);
  try {
    return output.result.lines.map((line) => ({
      rawText: line.text,
      normalizedText: line.text.replace(/[Oo]/g, "0").replace(/\s+/g, ""),
      confidence: line.confidence,
      rect: { x: roi.x + line.box.x, y: roi.y + line.box.y, width: line.box.width, height: line.box.height },
      variant: "inventory_roi_detection",
    }));
  } finally {
    output.bitmap.close();
  }
}

function emptyAnalysis(
  imageId: string,
  profile: ScreenshotProfile,
  pageClassification: PageClassificationV1,
  routing: PageRoutingEvidence,
  routeTimings: RoutedImage["routeTimings"],
): BrowserImageAnalysisV1 {
  return {
    schemaVersion: "1.0",
    imageId,
    pageClassification,
    profileAndBounds: {
      profile,
      contentBounds: profile.contentBounds,
      contentBoundsSource: "profile_content_bounds",
      warnings: [...profile.evidence.filter((item) => item.includes("rejected")), "page_type_unknown"],
    },
    occurrences: [],
    experienceOccurrences: [],
    experienceAggregate: null,
    inventoryHeader: observeInventoryHeader(profile, []),
    warnings: [...(pageClassification.warning ? [pageClassification.warning] : []), "page_type_unknown"],
    timings: {
      decodeMs: routeTimings.decodeMs,
      profileContentBoundsMs: routeTimings.profileContentBoundsMs,
      geometryCompletenessMs: routeTimings.visualRoutingMs,
      roiCropMs: 0,
      nameRecognitionMs: 0,
      levelRecognitionMs: 0,
      qualityRecognitionMs: 0,
      equippedRecognitionMs: 0,
      tabOcrMs: routeTimings.tabOcrMs,
      postprocessMs: 0,
      totalMs: routeTimings.totalMs,
      peakCandidateCount: 0,
      ocrSessionCreationCount: 0,
      ocrRecognitionCallCount: routing.tabOcrCandidates.length,
    },
  };
}

function attachOverlapVisualEvidence(analysis: BrowserImageAnalysisV1, bitmap: ImageBitmap): void {
  for (const occurrence of analysis.occurrences) {
    if (occurrence.completeness !== "complete") continue;
    occurrence.visualEvidence = createCardVisualEvidence(bitmap, occurrence.sourceRect);
  }
}

export class BrowserVisionEngineRuntime implements BrowserVisionEngine {
  private initialized = false;

  async initialize(_config: VisionAssetConfig): Promise<ModelManifest> {
    const models = await loadAndVerifyModels(_config);
    this.initialized = true;
    return { schemaVersion: "1.0", models };
  }

  private assertInitialized(): void {
    if (!this.initialized && !isModelLoaded()) throw new Error("请先 initialize 浏览器识别内核");
    this.initialized = true;
  }

  private async route(input: BrowserImageInput, confirmedPageType?: Exclude<PageType, "unknown">): Promise<RoutedImage> {
    this.assertInitialized();
    const routeStarted = performance.now();
    const decodeStarted = performance.now();
    return transferBitmapOnSuccess(
      () => createImageBitmap(input.file),
      async (bitmap) => {
        const decodedAt = performance.now();
        const image = imageDataForBitmap(bitmap);
        const baseProfile = createScreenshotProfile(image);
        const profiledAt = performance.now();
        const pageRoute = await routePage(confirmedPageType, async () => {
          const visualStarted = performance.now();
          const visual = classifyPageVisual(image, baseProfile.viewport);
          const visualFinished = performance.now();
          const routing = await classifyPageWithTabOcr(bitmap, baseProfile, visual);
          return { routing, visualRoutingMs: visualFinished - visualStarted };
        });
        const finished = performance.now();
        return {
          bitmap,
          imageData: image,
          profile: baseProfile,
          routing: pageRoute.routing,
          routeTimings: {
            decodeMs: decodedAt - decodeStarted,
            profileContentBoundsMs: profiledAt - decodedAt,
            visualRoutingMs: pageRoute.visualRoutingMs,
            tabOcrMs: pageRoute.routing.tabOcrMs,
            totalMs: finished - routeStarted,
          },
        };
      },
    );
  }

  async classifyImage(input: BrowserImageInput, options?: { confirmedPool?: ConfirmedImagePool }): Promise<PageClassificationV1> {
    const routed = await this.route(input);
    try {
      const confirmedPool = options?.confirmedPool?.imageId === input.imageId ? options.confirmedPool : undefined;
      return toPageClassificationV1(routed.routing, confirmedPool);
    } finally {
      routed.bitmap.close();
    }
  }

  async analyzeImage(
    input: BrowserImageInput,
    options?: { confirmedPool?: ConfirmedImagePool; expectedPageType?: PageType; variantAudit?: boolean },
  ): Promise<BrowserImageAnalysisV1> {
    const started = performance.now();
    const metricsBefore = getOcrRuntimeMetrics();
    const confirmedPool = options?.confirmedPool?.imageId === input.imageId ? options.confirmedPool : undefined;
    const routed = await this.route(input, confirmedPool?.pageType);
    try {
      const pageClassification = toPageClassificationV1(routed.routing, undefined, options?.expectedPageType);
      const inventoryRoi = inventoryHeaderRoi(routed.profile);
      const inventoryStarted = performance.now();
      const inventoryTokens = await recognizeInventoryTokens(routed.bitmap, inventoryRoi);
      const inventoryRecognitionMs = Math.round((performance.now() - inventoryStarted) * 100) / 100;
      const inventoryHeader = observeInventoryHeader(routed.profile, inventoryTokens.map((token) => ({
        text: token.rawText, confidence: token.confidence, rect: token.rect, variant: token.variant,
      })));
      if (pageClassification.pageType === "unknown") {
        const analysis = emptyAnalysis(input.imageId, routed.profile, pageClassification, routed.routing, routed.routeTimings);
        analysis.inventoryHeader = inventoryHeader;
        return attachOcrPerfImageDiagnostics(analysis, {
          fileName: input.file.name || input.imageId, inventoryRecognitionMs,
          name: variantsFromCandidateLengths([]), level: variantsFromCandidateLengths([]), experienceCount: variantsFromCandidateLengths([]),
        }, true);
      }
      const imagePageType = pageClassification.pageType;
      if (imagePageType === "experience") {
        const experience = await runStructuredExperience(input.file, {
          imageId: input.imageId,
          prepared: { bitmap: routed.bitmap, imageData: routed.imageData, profile: routed.profile },
          pageEvidence: {
            selected: true,
            confidence: pageClassification.confidence,
            evidence: pageClassification.visualEvidence.map((item) => item.value),
          },
          tabOcrMs: routed.routing.tabOcrMs,
        });
        try {
          const analysis = buildBrowserImageAnalysis(input.imageId, pageClassification, experience.output, "experience");
          analysis.inventoryHeader = inventoryHeader;
          analysis.timings.decodeMs = Math.round(routed.routeTimings.decodeMs * 100) / 100;
          analysis.timings.profileContentBoundsMs = Math.round(routed.routeTimings.profileContentBoundsMs * 100) / 100;
          const metricsAfter = getOcrRuntimeMetrics();
          analysis.timings.ocrSessionCreationCount = metricsAfter.sessionCreationCount - metricsBefore.sessionCreationCount;
          analysis.timings.ocrRecognitionCallCount = metricsAfter.recognitionCallCount - metricsBefore.recognitionCallCount;
          analysis.timings.totalMs = Math.round((performance.now() - started) * 100) / 100;
          return attachOcrPerfImageDiagnostics(analysis, {
            fileName: input.file.name || input.imageId,
            inventoryRecognitionMs,
            name: variantsFromCandidateLengths([]),
            level: variantsFromCandidateLengths([]),
            experienceCount: variantsFromCandidateLengths(experience.output.results
              .filter((result) => result.status !== "excluded_partial")
              .map((result) => result.ocrCandidates.length)),
            typeRecognitionMs: experience.output.timings.typeRecognitionMs,
            quantityRecognitionMs: experience.output.timings.quantityRecognitionMs,
          }, true);
        } finally {
          // The routed owner closes the shared bitmap below.
        }
      }
      const ordinary = imagePageType === "support"
        ? await runStructuredSupport(input.file, { imageId: input.imageId, prepared: { bitmap: routed.bitmap, imageData: routed.imageData, profile: routed.profile }, forceFullVariants: options?.variantAudit === true })
        : await runStructuredMain(input.file, { imageId: input.imageId, prepared: { bitmap: routed.bitmap, imageData: routed.imageData, profile: routed.profile }, forceFullVariants: options?.variantAudit === true });
      try {
        const analysis = buildBrowserImageAnalysis(input.imageId, pageClassification, ordinary.output, imagePageType);
        analysis.inventoryHeader = inventoryHeader;
        attachOverlapVisualEvidence(analysis, routed.bitmap);
        const metricsAfter = getOcrRuntimeMetrics();
        analysis.timings.decodeMs = Math.round(routed.routeTimings.decodeMs * 100) / 100;
        analysis.timings.profileContentBoundsMs = Math.round(routed.routeTimings.profileContentBoundsMs * 100) / 100;
        analysis.timings.ocrSessionCreationCount = metricsAfter.sessionCreationCount - metricsBefore.sessionCreationCount;
        analysis.timings.ocrRecognitionCallCount = metricsAfter.recognitionCallCount - metricsBefore.recognitionCallCount;
        analysis.timings.tabOcrMs = routed.routeTimings.tabOcrMs;
        analysis.timings.totalMs = Math.round((performance.now() - started) * 100) / 100;
        const resolveName = imagePageType === "support" ? resolveSupportName : resolveMainName;
        const variantAudit = options?.variantAudit ? {
          name: ordinary.output.results.filter((result) => result.status !== "excluded_partial").map((result) => createNameVariantAuditRecord({
            imageId: input.imageId,
            fileName: input.file.name || input.imageId,
            pageType: imagePageType,
            row: result.rowIndex,
            column: result.columnIndex,
            cardId: result.cardId ?? result.instanceId,
            candidates: result.ocrCandidates.name,
            resolveName,
            pipelineDirectName: result.directName ?? null,
            pipelineEffectiveName: result.effectiveName ?? result.nameNormalized,
          })),
          level: ordinary.output.results.filter((result) => result.status !== "excluded_partial").map((result) => createLevelVariantAuditRecord({
            imageId: input.imageId,
            fileName: input.file.name || input.imageId,
            pageType: imagePageType,
            row: result.rowIndex,
            column: result.columnIndex,
            cardId: result.cardId ?? result.instanceId,
            candidates: result.ocrCandidates.level,
            pipelineDirectLevel: result.directLevel ?? null,
            pipelineEffectiveLevel: result.effectiveLevel ?? result.level,
          })),
        } : undefined;
        return attachOcrPerfImageDiagnostics(analysis, {
          fileName: input.file.name || input.imageId,
          inventoryRecognitionMs,
          name: variantsFromCandidateLengths(ordinary.output.results
            .filter((result) => result.status !== "excluded_partial")
            .map((result) => result.ocrCandidates.name.length)),
          level: variantsFromCandidateLengths(ordinary.output.results
            .filter((result) => result.status !== "excluded_partial")
            .map((result) => result.ocrCandidates.level.length)),
          experienceCount: variantsFromCandidateLengths([]),
          variantAudit,
        }, true);
      } finally {
        // The routed owner closes the shared bitmap below.
      }
    } finally {
      routed.bitmap.close();
    }
  }

  async dispose(): Promise<void> {
    this.initialized = false;
    await disposeLocalOcr();
  }
}

export const browserVisionEngine = new BrowserVisionEngineRuntime();
