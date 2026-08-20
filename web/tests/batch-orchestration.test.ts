import {
  analyzeBrowserBatch,
  canApplyBatchResult,
  type BrowserBatchProgressEventV1,
  type BrowserBatchTaskV1,
} from "../src/structured/batch-orchestration.js";
import type {
  BrowserImageAnalysisV1,
  BrowserImageInput,
  BrowserVisionEngine,
  ConfirmedImagePool,
  ModelManifest,
  PageClassificationV1,
  VisionAssetConfig,
} from "../src/structured/contracts.js";

function expect(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function equal<T>(actual: T, expected: T, message: string): void { expect(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`); }

function analysis(imageId: string, ordinary = 1, experience = 0): BrowserImageAnalysisV1 {
  return {
    schemaVersion: "1.0", imageId,
    pageClassification: { pageType: "main", visualEvidence: [], tabOcrEvidence: [], confidence: 1, warning: null, reviewRequired: false },
    profileAndBounds: { profile: {} as BrowserImageAnalysisV1["profileAndBounds"]["profile"], contentBounds: null, contentBoundsSource: "fixture", warnings: [] },
    occurrences: Array.from({ length: ordinary }, (_, index) => ({ occurrenceId: `${imageId}-o${index}` })) as unknown as BrowserImageAnalysisV1["occurrences"],
    experienceOccurrences: Array.from({ length: experience }, (_, index) => ({ occurrenceId: `${imageId}-e${index}` })) as unknown as BrowserImageAnalysisV1["experienceOccurrences"],
    experienceAggregate: null,
    inventoryHeader: {
      roi: { x: 0, y: 0, width: 0, height: 0 },
      tokens: [],
      currentCount: { value: null, status: "not_present", confidence: null, rawText: null, normalizedText: null, evidence: [], reviewReasonCodes: [] },
      capacity: { value: null, status: "not_present", confidence: null, rawText: null, normalizedText: null, evidence: [], reviewReasonCodes: [] },
    },
    warnings: [],
    timings: { decodeMs: 0, profileContentBoundsMs: 0, geometryCompletenessMs: 0, roiCropMs: 0, nameRecognitionMs: 0, levelRecognitionMs: 0, qualityRecognitionMs: 0, equippedRecognitionMs: 0, tabOcrMs: 0, postprocessMs: 0, totalMs: 1, peakCandidateCount: 1, ocrSessionCreationCount: 0, ocrRecognitionCallCount: 1 },
  };
}

class FakeEngine implements BrowserVisionEngine {
  initialized = 0;
  disposed = 0;
  calls: Array<{ imageId: string; confirmedPool?: ConfirmedImagePool }> = [];
  constructor(private readonly handler: (imageId: string) => Promise<BrowserImageAnalysisV1>) {}
  async initialize(_config: VisionAssetConfig): Promise<ModelManifest> { this.initialized += 1; return { schemaVersion: "1.0", models: [] }; }
  async classifyImage(_input: BrowserImageInput, _options?: { confirmedPool?: ConfirmedImagePool }): Promise<PageClassificationV1> { throw new Error("not used"); }
  async analyzeImage(input: BrowserImageInput, options?: { confirmedPool?: ConfirmedImagePool }) { this.calls.push({ imageId: input.imageId, confirmedPool: options?.confirmedPool }); return this.handler(input.imageId); }
  async dispose() { this.disposed += 1; }
}

function task(ids = ["a", "b", "c"]): BrowserBatchTaskV1 {
  return {
    schemaVersion: "1.0", taskId: "task-1", accountId: "account-1", baseRevision: 7,
    images: ids.map((id, index) => ({ sourceImageId: `source-${id}`, sourceOrder: ids.length - index, input: { imageId: id, file: {} as File }, confirmedPool: { imageId: id, pageType: index % 2 ? "support" : "main" } })),
  };
}

const successEngine = new FakeEngine(async (id) => analysis(id, 1, id === "b" ? 2 : 0));
const events: BrowserBatchProgressEventV1[] = [];
const success = await analyzeBrowserBatch(task(), { engine: successEngine, onProgress: (event) => events.push(event) });
equal(success.status, "completed", "all successful images must complete");
equal(success.images.map((item) => item.sourceOrder), [1, 2, 3], "source order must drive the output order");
equal(success.summary, { totalImages: 3, completedImages: 3, failedImages: 0, cancelledImages: 0, ordinaryOccurrenceCount: 3, experienceOccurrenceCount: 2, ocrSessionInitializationCount: 0, peakConcurrentAnalyses: 1, totalDurationMs: success.summary.totalDurationMs }, "success summary must retain all counts");
equal(successEngine.initialized, 1, "one batch must initialize an injected engine once");
equal(successEngine.disposed, 0, "an injected engine must remain caller-owned");
equal(successEngine.calls.map((call) => call.confirmedPool?.imageId), ["c", "b", "a"], "confirmed pools must stay isolated per input");
equal(events.map((event) => event.kind), ["task_started", "image_started", "image_classified", "image_completed", "image_started", "image_classified", "image_completed", "image_started", "image_classified", "image_completed", "task_completed"], "progress events must be ordered and complete");
expect(events.every((event) => event.taskId === "task-1" && event.total === 3 && event.stage === event.kind), "all progress events must be pure task-scoped data");
equal(success.images[0]?.analysis?.imageId, "c", "single-image contract must remain unmodified");

const mixedEngine = new FakeEngine(async (id) => { if (id === "b") throw new Error("decoder diagnostic detail"); return analysis(id); });
const mixed = await analyzeBrowserBatch(task(), { engine: mixedEngine });
equal(mixed.status, "partial", "one failed image must not discard other images");
equal(mixed.images.map((item) => item.status), ["completed", "failed", "completed"], "failed image must be explicit and isolated");
equal(mixed.images[1]?.error?.message, "image analysis failed", "public batch errors must not expose source paths");

const failed = await analyzeBrowserBatch(task(["bad"]), { engine: new FakeEngine(async () => { throw new Error("decode"); }) });
equal(failed.status, "failed", "all failed images must produce failed status");

const preCancelled = new AbortController(); preCancelled.abort();
const before = await analyzeBrowserBatch(task(["never"]), { engine: new FakeEngine(async () => analysis("never")), signal: preCancelled.signal });
equal(before.status, "cancelled", "cancellation before the first image must be explicit");
equal(before.images[0]?.status, "cancelled", "cancellation before start must not analyze the first image");

const controller = new AbortController();
const cancellingEngine = new FakeEngine(async (id) => { if (id === "c") controller.abort(); return analysis(id); });
const cancelled = await analyzeBrowserBatch(task(), { engine: cancellingEngine, signal: controller.signal });
equal(cancelled.status, "cancelled", "cancellation after an atomic image must cancel the task");
equal(cancellingEngine.calls.map((call) => call.imageId), ["c"], "cancellation must not launch later images");
equal(cancelled.images.map((item) => item.status), ["completed", "cancelled", "cancelled"], "completed work stays visible while later work is cancelled");

const progressCancelled = new AbortController();
const progressCancellationEngine = new FakeEngine(async (id) => analysis(id));
const progressCancelledBatch = await analyzeBrowserBatch(task(), {
  engine: progressCancellationEngine,
  signal: progressCancelled.signal,
  onProgress: (event) => { if (event.kind === "image_completed") setTimeout(() => progressCancelled.abort(), 0); },
});
equal(progressCancelledBatch.images.map((item) => item.status), ["completed", "cancelled", "cancelled"], "a cancel click delivered after image completion must stop later images");
equal(progressCancellationEngine.calls.map((call) => call.imageId), ["c"], "event-loop yielding must make post-completion cancellation observable before the next image");

const afterLast = new AbortController();
const lastEngine = new FakeEngine(async (id) => { afterLast.abort(); return analysis(id); });
const last = await analyzeBrowserBatch(task(["last"]), { engine: lastEngine, signal: afterLast.signal });
equal(last.status, "cancelled", "last-image cancellation must not masquerade as completion");
equal(last.images[0]?.status, "completed", "the finished last atomic image remains preserved");

const owned = new FakeEngine(async (id) => analysis(id));
await analyzeBrowserBatch(task(["owned"]), { createEngine: () => owned });
equal(owned.initialized, 1, "internally created engine must initialize once");
equal(owned.disposed, 1, "internally created engine must be disposed in finally");

equal(canApplyBatchResult({ result: success, currentAccountId: "account-1", currentRevision: 7, activeTaskId: "task-1" }), { action: "apply", reason: "ready" }, "current completed result may apply");
equal(canApplyBatchResult({ result: success, currentAccountId: "account-1", currentRevision: 7, activeTaskId: "old-task" }).reason, "active_task_mismatch", "old task result must not apply");
equal(canApplyBatchResult({ result: success, currentAccountId: "other", currentRevision: 7, activeTaskId: "task-1" }).reason, "account_mismatch", "switched account result must not apply");
equal(canApplyBatchResult({ result: success, currentAccountId: "account-1", currentRevision: 8, activeTaskId: "task-1" }).reason, "revision_mismatch", "changed revision result must not apply");
equal(canApplyBatchResult({ result: mixed, currentAccountId: "account-1", currentRevision: 7, activeTaskId: "task-1" }), { action: "review", reason: "partial_requires_ingest_review" }, "partial result must be left to a later ingest review policy");
equal(canApplyBatchResult({ result: cancelled, currentAccountId: "account-1", currentRevision: 7, activeTaskId: "task-1" }).reason, "cancelled_result", "cancelled result must not apply");

console.log("batch orchestration checks passed");
