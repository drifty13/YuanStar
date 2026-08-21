import { BrowserOcrRuntime } from "../src/ocr/browser-ocr-runtime.js";
import type { BrowserOcrRuntimeJobV1 } from "../src/ocr/browser-analysis-contract.js";
import {
  attachOcrPerfImageDiagnostics,
  createLevelVariantAuditRecord,
  createNameVariantAuditRecord,
  createOcrPerfReport,
  createOcrVariantAuditReport,
  emitOcrPerfReportIfEnabled,
  emitOcrVariantAuditReportIfEnabled,
  isOcrPerfDiagnosticsEnabled,
  isOcrVariantAuditEnabled,
  variantsFromCandidateLengths,
} from "../src/ocr/performance-diagnostics.js";
import { resolveName as resolveMainName } from "../src/structured/main-postprocess.js";
import type {
  BrowserImageAnalysisV1,
  BrowserImageInput,
  BrowserVisionEngine,
  ConfirmedImagePool,
  ModelManifest,
  PageClassificationV1,
  VisionAssetConfig,
} from "../src/structured/contracts.js";

function expect(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function equal<T>(actual: T, expected: T, message: string): void {
  expect(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}

function ordinary(imageId: string, column: number) {
  return {
    occurrenceId: `${imageId}-ordinary-${column}`,
    row: 0,
    column,
    completeness: "complete",
    sourceRect: { card: { x: 0, y: 0, width: 1, height: 1 }, name: { x: 0, y: 0, width: 1, height: 1 }, level: { x: 0, y: 0, width: 1, height: 1 }, quality: { x: 0, y: 0, width: 1, height: 1 }, equipped: { x: 0, y: 0, width: 1, height: 1 } },
    directName: "太阳", effectiveName: "太阳", nameSource: "direct_ocr", nameConfidence: 1, nameWarning: null,
    directLevel: 40, effectiveLevel: 40, levelSource: "direct_ocr", levelConfidence: 1, levelWarning: null,
    quality: "橙", qualitySource: "visual_background", qualityConfidence: 1, qualityWarning: null,
    equippedState: "not_evaluated", equippedSource: "unknown", equippedConfidence: 0, equippedWarning: null,
    rawOcrCandidates: { name: [], level: [] }, visualEvidence: null, inferenceProvenance: [], warnings: [], reviewRequired: false,
  } as BrowserImageAnalysisV1["occurrences"][number];
}

function analysis(imageId: string, includeExperience = false): BrowserImageAnalysisV1 {
  return {
    schemaVersion: "1.0",
    imageId,
    pageClassification: { pageType: "main", visualEvidence: [], tabOcrEvidence: [], confidence: 1, warning: null, reviewRequired: false },
    profileAndBounds: { profile: {} as BrowserImageAnalysisV1["profileAndBounds"]["profile"], contentBounds: null, contentBoundsSource: "fixture", warnings: [] },
    occurrences: [0, 1, 2, 3].map((column) => ordinary(imageId, column)),
    experienceOccurrences: includeExperience ? [{
      occurrenceId: `${imageId}-experience`, ordinal: 0, canonicalType: "purple", canonicalName: "紫星曜", quantity: 12, quantityUnknown: false,
      directEvidence: { kindHue: 280, kindConfidence: 1, countConfidence: 1, rawOcrCandidates: [{ text: "12", confidence: 1, variant: "fixture" }] },
      sourceRect: { icon: { x: 0, y: 0, width: 1, height: 1 }, count: { x: 1, y: 0, width: 1, height: 1 } }, completeness: "complete", warnings: [], reviewRequired: false,
    }] : [],
    experienceAggregate: includeExperience ? { orangeCount: null, purpleCount: 12, whiteCount: null, complete: true, warnings: [] } : null,
    inventoryHeader: {
      roi: { x: 0, y: 0, width: 1, height: 1 }, tokens: [],
      currentCount: { value: 12, status: "confirmed", confidence: 1, rawText: "12", normalizedText: "12", evidence: [], reviewReasonCodes: [] },
      capacity: { value: 250, status: "confirmed", confidence: 1, rawText: "250", normalizedText: "250", evidence: [], reviewReasonCodes: [] },
    },
    warnings: [],
    timings: { decodeMs: 0, profileContentBoundsMs: 0, geometryCompletenessMs: 0, roiCropMs: 0, nameRecognitionMs: 0, levelRecognitionMs: 0, qualityRecognitionMs: 0, equippedRecognitionMs: 0, tabOcrMs: 0, postprocessMs: 0, totalMs: 1, peakCandidateCount: 4, ocrSessionCreationCount: 1, ocrRecognitionCallCount: 1 },
  };
}

class FakeEngine implements BrowserVisionEngine {
  initialized = 0;
  disposed = 0;
  constructor(private readonly handler: (imageId: string) => Promise<BrowserImageAnalysisV1>, private readonly initFails = false) {}
  async initialize(_config: VisionAssetConfig): Promise<ModelManifest> {
    this.initialized += 1;
    if (this.initFails) throw new Error("worker startup failed");
    return { schemaVersion: "1.0", models: [] };
  }
  async classifyImage(_input: BrowserImageInput, _options?: { confirmedPool?: ConfirmedImagePool }): Promise<PageClassificationV1> { throw new Error("not used"); }
  async analyzeImage(input: BrowserImageInput): Promise<BrowserImageAnalysisV1> { return this.handler(input.imageId); }
  async dispose(): Promise<void> { this.disposed += 1; }
}

function job(id = "runtime-job"): BrowserOcrRuntimeJobV1 {
  return {
    schemaVersion: 1,
    jobId: id,
    images: [
      { sourceImageId: "source-a", sourceOrder: 1, file: {} as File, confirmedPool: { imageId: "source-a", pageType: "main" } },
      { sourceImageId: "source-b", sourceOrder: 2, file: {} as File, confirmedPool: { imageId: "source-b", pageType: "main" } },
    ],
    confirmedOverlapPairs: [{ pairId: "pair-a-b", sourceImageIdA: "source-a", sourceImageIdB: "source-b" }],
  };
}

const normalEngine = new FakeEngine(async (imageId) => analysis(imageId, imageId === "source-a"));
const normalProgress: string[] = [];
const normalRuntime = new BrowserOcrRuntime({ createEngine: () => normalEngine, now: () => new Date("2026-08-13T00:00:00.000Z") });
const normal = await normalRuntime.run(job(), { onProgress: (event) => normalProgress.push(event.phase) });
equal(normal.status, "completed", "a complete local batch must complete");
expect(normal.result != null, "a successful batch must return a public contract");
expect(normalProgress.includes("initializing") && normalProgress.includes("image_completed") && normalProgress.includes("completed"), "progress must originate from initialization and image execution");
expect(normal.result.occurrences.some((item) => item.kind === "experience" && (item.occurrence as BrowserImageAnalysisV1["experienceOccurrences"][number]).quantity === 12), "experience quantities must survive the runtime contract");
equal(normal.result.overlap.relations.length, 4, "confirmed row overlap relations must survive the adapter");
const serialized = JSON.stringify(normal.result);
expect(!serialized.includes("accountId") && !serialized.includes("baseRevision") && !serialized.includes("starInstanceId"), "the public OCR contract must contain no business identity or revision");
expect(typeof structuredClone === "function" ? structuredClone(normal.result).schemaVersion === 1 : JSON.parse(serialized).schemaVersion === 1, "the public contract must be cloneable plain data");
await normalRuntime.dispose();
equal(normalRuntime.state, "disposed", "explicit disposal must reach the disposed state");
equal(normalEngine.disposed, 1, "explicit disposal must release the initialized engine once");

const beforeInitialize = new AbortController();
beforeInitialize.abort();
const beforeInitializeProgress: string[] = [];
const beforeInitializeEngine = new FakeEngine(async (imageId) => analysis(imageId));
const beforeInitializeRun = await new BrowserOcrRuntime({ createEngine: () => beforeInitializeEngine }).run(job("cancel-before-initialize"), {
  signal: beforeInitialize.signal,
  onProgress: (event) => beforeInitializeProgress.push(event.phase),
});
equal(beforeInitializeRun.status, "cancelled", "pre-initialize cancellation must be explicit");
equal(beforeInitializeRun.result, null, "pre-initialize cancellation must not create a result contract");
expect(beforeInitializeProgress.includes("cancelling") && beforeInitializeProgress.includes("cancelled"), "pre-initialize cancellation must terminate progress");
equal(beforeInitializeEngine.initialized, 0, "pre-initialize cancellation must not start image processing");

let cancelRuntime: BrowserOcrRuntime;
let cancelFirstRun = true;
const cancellingEngine = new FakeEngine(async (imageId) => {
  if (imageId === "source-a" && cancelFirstRun) cancelRuntime.cancel();
  return analysis(imageId);
});
cancelRuntime = new BrowserOcrRuntime({ createEngine: () => cancellingEngine });
const cancelledProgress: string[] = [];
const cancelled = await cancelRuntime.run(job("cancel-job"), { onProgress: (event) => cancelledProgress.push(event.phase) });
equal(cancelled.status, "cancelled", "cancellation must never produce a partial success contract");
equal(cancelled.result, null, "cancelled runtime output must not be reviewable as a completed result");
expect(cancelledProgress.includes("cancelling") && cancelledProgress.includes("cancelled"), "cancellation must report explicit lifecycle progress");
expect(cancellingEngine.disposed === 1, "cancellation must release the old Worker-backed engine before a new job");
cancelFirstRun = false;
const next = await cancelRuntime.run(job("new-job"));
equal(next.status, "completed", "a new job must run after cancelled work is released");

const failedRuntime = new BrowserOcrRuntime({ createEngine: () => new FakeEngine(async (imageId) => analysis(imageId), true) });
const failed = await failedRuntime.run(job("init-failure"));
equal(failed.error?.code, "engine_initialization_failed", "initialization failure must use a public runtime error code");

equal(isOcrPerfDiagnosticsEnabled(""), false, "performance diagnostics must be disabled without the URL flag");
equal(isOcrPerfDiagnosticsEnabled("?ocrPerf=1"), true, "performance diagnostics must be enabled by the URL flag");
const perfAnalysis = analysis("perf-image");
perfAnalysis.pageClassification.pageType = "experience";
attachOcrPerfImageDiagnostics(perfAnalysis, {
  fileName: "fixed-nine.png",
  inventoryRecognitionMs: 9,
  name: variantsFromCandidateLengths([]),
  level: variantsFromCandidateLengths([]),
  experienceCount: variantsFromCandidateLengths([3, 2]),
  typeRecognitionMs: 4,
  quantityRecognitionMs: 12,
});
const perfReport = createOcrPerfReport({
  schemaVersion: "1.0", taskId: "perf", accountId: "internal", baseRevision: 0, status: "completed",
  startedAt: "2026-08-13T00:00:00.000Z", finishedAt: "2026-08-13T00:00:01.000Z",
  images: [{ sourceImageId: "perf-image", sourceOrder: 1, confirmedPool: { imageId: "perf-image", pageType: "experience" }, status: "completed", analysis: perfAnalysis, error: null }],
  summary: { totalImages: 1, completedImages: 1, failedImages: 0, cancelledImages: 0, ordinaryOccurrenceCount: 0, experienceOccurrenceCount: 0, ocrSessionInitializationCount: 1, peakConcurrentAnalyses: 1, totalDurationMs: 1 },
  warnings: [],
}, 100);
equal(perfReport.imageCount, 1, "performance reports must aggregate a completed image");
equal(perfReport.timingTotals.inventoryRecognitionMs, 9, "inventory recognition timing must remain distinct");
equal(perfReport.ocrCalls.experienceCountRecognitionCalls, 5, "experience variant calls must reflect the executed candidates");
equal(perfReport.perImage[0]?.fileName, "fixed-nine.png", "performance reports must retain the local filename");
equal(perfReport.timingsMayOverlap, true, "performance reports must disclose overlapping timing scopes");
const emptyPerfReport = createOcrPerfReport({
  schemaVersion: "1.0", taskId: "empty", accountId: "internal", baseRevision: 0, status: "completed",
  startedAt: "2026-08-13T00:00:00.000Z", finishedAt: "2026-08-13T00:00:00.000Z", images: [],
  summary: { totalImages: 0, completedImages: 0, failedImages: 0, cancelledImages: 0, ordinaryOccurrenceCount: 0, experienceOccurrenceCount: 0, ocrSessionInitializationCount: 0, peakConcurrentAnalyses: 0, totalDurationMs: 0 },
  warnings: [],
}, 0);
equal(emptyPerfReport.imageCount, 0, "an empty batch must produce a safe performance report");
equal(emptyPerfReport.timingPercentages.nameRecognitionMs, 0, "an empty batch must not divide by zero");
const missingExperienceTimingReport = createOcrPerfReport({
  schemaVersion: "1.0", taskId: "ordinary", accountId: "internal", baseRevision: 0, status: "completed",
  startedAt: "2026-08-13T00:00:00.000Z", finishedAt: "2026-08-13T00:00:00.000Z",
  images: [{ sourceImageId: "ordinary", sourceOrder: 1, confirmedPool: { imageId: "ordinary", pageType: "main" }, status: "completed", analysis: analysis("ordinary"), error: null }],
  summary: { totalImages: 1, completedImages: 1, failedImages: 0, cancelledImages: 0, ordinaryOccurrenceCount: 4, experienceOccurrenceCount: 0, ocrSessionInitializationCount: 1, peakConcurrentAnalyses: 1, totalDurationMs: 1 },
  warnings: [],
}, 1);
equal(missingExperienceTimingReport.timingTotals.quantityRecognitionMs, 0, "missing experience timing must remain safe for ordinary images");
let perfLogGroups = 0;
const perfOutput = { group: () => { perfLogGroups += 1; }, groupEnd: () => undefined, log: () => undefined, table: () => undefined };
equal(emitOcrPerfReportIfEnabled(perfReport, "", perfOutput), false, "normal pages must not emit performance logs");
equal(perfLogGroups, 0, "normal pages must leave the console untouched");
equal(emitOcrPerfReportIfEnabled(perfReport, "?ocrPerf=1", perfOutput), true, "the URL flag must emit a performance report");
equal(perfLogGroups, 1, "enabled diagnostics must emit one grouped report");

equal(isOcrVariantAuditEnabled("?ocrPerf=1"), false, "variant audit must remain disabled without its dedicated flag");
equal(isOcrVariantAuditEnabled("?ocrPerf=1&ocrVariantAudit=1"), true, "variant audit must require both URL flags");
const nameAudit = createNameVariantAuditRecord({
  imageId: "audit-image", fileName: "audit.png", pageType: "main", row: 0, column: 0, cardId: "card-1",
  candidates: [{ variant: "color", text: "紫薇", confidence: 0.93 }, { variant: "contrast", text: "紫微", confidence: 0.91 }, { variant: "otsu", text: "天府", confidence: 0.99 }],
  resolveName: resolveMainName,
  pipelineDirectName: "天府",
  pipelineEffectiveName: "天府",
});
equal(nameAudit.v1.normalized, "紫微", "one-variant name shadow resolver must use the first candidate only");
equal(nameAudit.v12.normalized, "紫微", "two-variant name shadow resolver must preserve the first-two resolver result");
equal(nameAudit.official.normalized, "天府", "all-three name shadow resolver must retain the official resolver result");
equal(nameAudit.v3ChangesFinalDecision, true, "name mismatch must record a third-variant final-decision change");
const levelAudit = createLevelVariantAuditRecord({
  imageId: "audit-image", fileName: "audit.png", pageType: "main", row: 0, column: 0, cardId: "card-1",
  candidates: [{ variant: "color", text: "4O", confidence: 0.32 }, { variant: "contrast", text: "40", confidence: 0.31 }, { variant: "otsu", text: "50", confidence: 0.99 }],
  pipelineDirectLevel: 50,
  pipelineEffectiveLevel: 50,
});
equal(levelAudit.v1.level, 40, "one-variant level shadow resolver must apply the existing parser only to v1");
equal(levelAudit.v12.level, 40, "two-variant level shadow resolver must preserve existing weighted consensus");
equal(levelAudit.official.level, 50, "all-three level shadow resolver must retain the official resolver result");
equal(levelAudit.features.repair, true, "level audit must expose O-to-zero repair evidence");
const auditAnalysis = analysis("audit-image");
attachOcrPerfImageDiagnostics(auditAnalysis, {
  fileName: "audit.png", inventoryRecognitionMs: 0,
  name: variantsFromCandidateLengths([3]), level: variantsFromCandidateLengths([3]), experienceCount: variantsFromCandidateLengths([]),
  variantAudit: { name: [nameAudit], level: [levelAudit] },
});
const auditReport = createOcrVariantAuditReport({
  schemaVersion: "1.0", taskId: "audit", accountId: "internal", baseRevision: 0, status: "completed",
  startedAt: "2026-08-13T00:00:00.000Z", finishedAt: "2026-08-13T00:00:01.000Z",
  images: [{ sourceImageId: "audit-image", sourceOrder: 1, confirmedPool: { imageId: "audit-image", pageType: "main" }, status: "completed", analysis: auditAnalysis, error: null }],
  summary: { totalImages: 1, completedImages: 1, failedImages: 0, cancelledImages: 0, ordinaryOccurrenceCount: 4, experienceOccurrenceCount: 0, ocrSessionInitializationCount: 1, peakConcurrentAnalyses: 1, totalDurationMs: 1 },
  warnings: [],
});
equal(auditReport.name.v1Mismatches.length, 1, "name audit report must aggregate mismatches");
equal(auditReport.level.v12Mismatches.length, 1, "level audit report must aggregate two-variant mismatches");
equal(auditReport.estimatedStrategies.combined.allV1.fullRecognitionCalls, 6, "shadow audit estimates must account only for already-returned candidates");
let variantAuditGroups = 0;
const variantAuditOutput = { group: () => { variantAuditGroups += 1; }, groupEnd: () => undefined, log: () => undefined, table: () => undefined };
equal(emitOcrVariantAuditReportIfEnabled(auditReport, "?ocrPerf=1", variantAuditOutput), false, "variant audit flag off must not touch the console");
equal(variantAuditGroups, 0, "variant audit flag off must leave the console untouched");
equal(emitOcrVariantAuditReportIfEnabled(auditReport, "?ocrPerf=1&ocrVariantAudit=1", variantAuditOutput), true, "variant audit flag must emit JSON audit output");
equal(variantAuditGroups, 1, "variant audit flag on must emit one grouped report");

console.log("browser OCR runtime checks passed");
