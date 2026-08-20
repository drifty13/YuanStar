import { BrowserOcrRuntime } from "../src/ocr/browser-ocr-runtime.js";
import type { BrowserOcrRuntimeJobV1 } from "../src/ocr/browser-analysis-contract.js";
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

console.log("browser OCR runtime checks passed");
