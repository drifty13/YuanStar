import { createStarCatalog } from "../src/business/catalog.js";
import { buildReconcileDraftFromBrowserRuntime, finalizeReconcileDraft } from "../src/business/reconcile.js";
import type { BrowserAnalysisResultV1, BrowserOcrRuntimeRunV1 } from "../src/ocr/browser-analysis-contract.js";
import { BrowserOcrRuntime } from "../src/ocr/browser-ocr-runtime.js";
import type { BrowserImageInput, BrowserVisionEngine, ModelManifest, PageClassificationV1 } from "../src/structured/contracts.js";
import {
  ProductOcrImportCoordinator,
  ProductOcrImportError,
  addProductOverlapPair,
  applyProductImportClassification,
  applyProductImportClassificationFailure,
  buildProductOcrRuntimeJob,
  completedRuntimeResultForReconcile,
  confirmAllProductImportImages,
  confirmProductImportPool,
  createProductImportImages,
  isReconcileResolutionComplete,
  moveProductImportImage,
  reconcileSourceImagesFromImport,
  removeProductImportImage,
  sortProductImportImagesForDisplay,
  validateProductOcrImport,
  type ProductOcrRunContextV1,
} from "../src/product-ocr-import.js";
import { buildProductReviewEvidence, buildProductReviewImageSummaries, productReviewReasonText, productReviewRowCropRect } from "../src/product-ocr-review.js";

function expect(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function expectImportError(action: () => unknown, code: string): void { try { action(); } catch (error) { expect(error instanceof ProductOcrImportError && error.code === code, `expected ${code}`); return; } throw new Error(`expected ${code}`); }

const catalog = createStarCatalog([
  { name: "天府", kind: "主星", aliases: [], displayGroup: null, usageTags: [], rawEffectText: null },
  { name: "解神", kind: "辅星", aliases: [], displayGroup: null, usageTags: [], rawEffectText: null },
], {});
const original = new File([new Uint8Array([1, 2, 3])], "same.png", { type: "image/png", lastModified: 7 });
const second = new File([new Uint8Array([4, 5])], "second.png", { type: "image/png", lastModified: 8 });
const third = new File([new Uint8Array([6])], "third.png", { type: "image/png", lastModified: 9 });
const fourth = new File([new Uint8Array([7])], "fourth.png", { type: "image/png", lastModified: 10 });
let urlIndex = 0;
const images = createProductImportImages([original, original, second, third, fourth], { createSourceImageId: (_file, index) => `image-${index + 1}`, createObjectUrl: () => `blob:test-${++urlIndex}` });
expect(images.length === 5 && images[0]!.file === original, "File becomes the real import image payload");
expect(new Set(images.map((image) => image.sourceImageId)).size === 5, "repeated imports of the same File receive unique sourceImageIds");
expect(images.every((image) => image.pool === "主星" && !image.confirmed && image.classificationStatus === "classifying"), "new images stay unconfirmed while local classification is pending");

function classification(pageType: PageClassificationV1["pageType"], reviewRequired = false): PageClassificationV1 {
  return { pageType, reviewRequired, confidence: .9, warning: null, visualEvidence: [], tabOcrEvidence: [] };
}

class FakeClassificationEngine implements BrowserVisionEngine {
  initializeCalls = 0;
  recognizeCalls = 0;
  classificationCalls: string[] = [];
  async initialize(): Promise<ModelManifest> { this.initializeCalls++; return { schemaVersion: "1.0", models: [] }; }
  async classifyImage(input: BrowserImageInput): Promise<PageClassificationV1> {
    this.classificationCalls.push(input.imageId);
    return classification(input.imageId === "image-1" ? "main" : input.imageId === "image-2" ? "support" : "experience", input.imageId === "image-3");
  }
  async analyzeImage(): Promise<never> { this.recognizeCalls++; throw new Error("not used"); }
  async dispose(): Promise<void> {}
}

const fakeEngine = new FakeClassificationEngine();
const visualClassificationCalls: string[] = [];
const classificationCoordinator = new ProductOcrImportCoordinator({ engine: fakeEngine, classifyImportImage: async (image) => {
  visualClassificationCalls.push(image.sourceImageId);
  return classification(image.sourceImageId === "image-1" ? "main" : image.sourceImageId === "image-2" ? "support" : "experience", image.sourceImageId === "image-3");
} });
let autoClassified = images;
for (const image of images.slice(0, 3)) autoClassified = applyProductImportClassification(autoClassified, image.sourceImageId, await classificationCoordinator.classify(image));
expect(autoClassified[0]!.pool === "主星" && autoClassified[1]!.pool === "辅星" && autoClassified[2]!.pool === "经验星曜", "visual suggestions map main, support and experience into the three visible pools");
expect(autoClassified.slice(0, 3).every((image) => !image.confirmed && image.classificationStatus === "suggested"), "classification recommendations never auto-confirm an image");
expect(autoClassified[2]!.classificationReviewRequired && !autoClassified[2]!.confirmed, "reviewRequired keeps the recommendation explicitly unconfirmed");
expect(fakeEngine.initializeCalls === 0 && fakeEngine.classificationCalls.length === 0 && fakeEngine.recognizeCalls === 0, "pre-classification must make zero OCR initialize, classifyImage and recognize calls");
expect(visualClassificationCalls.join(",") === "image-1,image-2,image-3", "coordinator invokes the visual classifier with stable source identities");

const failedClassification = applyProductImportClassificationFailure(images, "image-4");
expect(failedClassification[3]!.file === third && failedClassification[3]!.classificationStatus === "failed" && !failedClassification[3]!.confirmed, "classifier failure preserves the exact File and requires manual correction");
expect(validateProductOcrImport(images, []) === "正在判断图片类型，请稍候。", "classification pending blocks OCR start with a specific message");
const displayPriorityInput = [
  { ...images[0]!, classificationStatus: "suggested" as const, classificationReviewRequired: false, confirmed: true },
  { ...images[1]!, classificationStatus: "suggested" as const, classificationReviewRequired: true, confirmed: false },
  { ...images[2]!, classificationStatus: "suggested" as const, classificationReviewRequired: false, confirmed: false },
  { ...images[3]!, classificationStatus: "failed" as const, classificationReviewRequired: true, confirmed: false },
];
expect(sortProductImportImagesForDisplay(displayPriorityInput).map((image) => image.sourceImageId).join(",") === "image-4,image-2,image-3,image-1", "display sort prioritizes failed, review-required, ordinary unconfirmed and confirmed images");
expect(displayPriorityInput.map((image) => image.sourceImageId).join(",") === "image-1,image-2,image-3,image-4", "display sorting does not mutate original import order");
expect(buildProductOcrRuntimeJob({ jobId: "stable-display-order", accountId: "account-1", gameVersion: "如鸢", baseRevision: 4, images: displayPriorityInput.map((image) => ({ ...image, confirmed: true })), overlapPairs: [] }).images.map((image) => image.sourceImageId).join(",") === "image-1,image-2,image-3,image-4", "runtime sourceOrder remains the stable import order after display-only sorting");
expect(confirmProductImportPool(failedClassification, "主星")[3]!.confirmed, "failed main fallback can be confirmed directly without forced dragging");

let allMainSuggested = images;
for (const image of images) allMainSuggested = applyProductImportClassification(allMainSuggested, image.sourceImageId, classification("main"));
const stableId = images[0]!.sourceImageId;
const confirmedMain = confirmProductImportPool(allMainSuggested, "主星");
expect(confirmedMain[0]!.sourceImageId === stableId && confirmedMain.every((image) => image.confirmed), "confirmation preserves stable identity across rerender state");
const withExperience = moveProductImportImage(confirmedMain, [], "image-5", "经验星曜").images;
expect(withExperience[4]!.suggestedPool === "主星" && withExperience[4]!.poolSource === "manual" && !withExperience[4]!.confirmed, "manual pool changes retain the OCR suggestion and clear only the moved image confirmation");
const onlyExperienceConfirmed = confirmProductImportPool(withExperience.map((image) => image.sourceImageId === "image-1" ? { ...image, confirmed: false } : image), "经验星曜");
expect(!onlyExperienceConfirmed[0]!.confirmed && onlyExperienceConfirmed[4]!.confirmed, "confirm pool touches only the selected pool");
expect(confirmAllProductImportImages(onlyExperienceConfirmed).every((image) => image.confirmed), "confirm all confirms every current legal pool without moving images");
const manualPoolJob = buildProductOcrRuntimeJob({ jobId: "manual-pool", accountId: "account-1", gameVersion: "如鸢", baseRevision: 4, images: confirmProductImportPool(withExperience, "经验星曜"), overlapPairs: [] });
expect(manualPoolJob.images[4]!.confirmedPool?.pageType === "experience" && withExperience[4]!.suggestedPool === "主星", "runtime confirmedPool uses the user's final pool rather than the retained OCR suggestion");

let pairedImages = confirmAllProductImportImages(allMainSuggested);
let pairs = addProductOverlapPair(pairedImages, [], "主星", "image-1", "image-2");
pairs = addProductOverlapPair(pairedImages, pairs, "主星", "image-3", "image-4");
const moved = moveProductImportImage(pairedImages, pairs, "image-1", "辅星");
expect(!moved.images[0]!.confirmed && moved.images[0]!.pool === "辅星", "moving an image clears only its confirmation");
expect(moved.images.slice(1).every((image) => image.confirmed), "moving one image preserves all other confirmations");
expect(moved.pairs.length === 1 && moved.pairs[0]!.beforeId === "image-3", "moving one image removes only overlap pairs involving that image");
const removed = removeProductImportImage(pairedImages, pairs, "image-3");
expect(removed.removed?.sourceImageId === "image-3" && removed.images.length === 4, "delete removes the transient image by identity");
expect(removed.pairs.length === 1 && removed.pairs[0]!.beforeId === "image-1", "delete removes only pairs involving the deleted image");
expectImportError(() => addProductOverlapPair(confirmAllProductImportImages(withExperience), [], "主星", "image-1", "image-5"), "overlap_pool_mismatch");
expectImportError(() => addProductOverlapPair(allMainSuggested, [], "主星", "image-1", "image-2"), "overlap_unconfirmed");
expectImportError(() => addProductOverlapPair(pairedImages, pairs, "主星", "image-1", "image-2"), "overlap_duplicate");
expectImportError(() => addProductOverlapPair(pairedImages, pairs, "主星", "image-2", "image-1"), "overlap_duplicate");
expect(validateProductOcrImport([], [])?.includes("至少一张") && validateProductOcrImport(allMainSuggested, [])?.includes("确认"), "empty and unconfirmed imports fail before runtime");

const runContext: ProductOcrRunContextV1 = { jobId: "job-1", accountId: "account-1", gameVersion: "如鸢", baseRevision: 4, images: pairedImages, overlapPairs: pairs };
const job = buildProductOcrRuntimeJob(runContext);
expect(job.images.map((image) => image.sourceOrder).join(",") === "1,2,3,4,5", "runtime sourceOrder follows the current UI order");
expect(job.images[0]!.confirmedPool?.pageType === "main", "main pool maps to runtime main");
const poolMapped = buildProductOcrRuntimeJob({ ...runContext, images: [
  { ...pairedImages[0]!, pool: "主星" },
  { ...pairedImages[1]!, pool: "辅星" },
  { ...pairedImages[2]!, pool: "经验星曜" },
] , overlapPairs: [] });
expect(poolMapped.images.map((image) => image.confirmedPool?.pageType).join(",") === "main,support,experience", "all three product pools map to runtime contract values");
expect(job.images[0]!.file === original && job.images.every((image) => image.file instanceof File), "runtime receives File objects rather than object URLs");
expect(job.confirmedOverlapPairs?.[0]?.pairId === pairs[0]!.pairId && job.confirmedOverlapPairs?.[0]?.sourceImageIdA === "image-1", "overlap pairs map with deterministic IDs and source identities");
const commitSources = reconcileSourceImagesFromImport(pairedImages);
expect(commitSources[0]!.blob === original && commitSources[0]!.sourceImageId === job.images[0]!.sourceImageId, "commit reuses the exact OCR File and sourceImageId");

// The stub deliberately fails recognition; only an explicit run may reach it.
const formalRun = await classificationCoordinator.run({ ...runContext, images: [pairedImages[0]!], overlapPairs: [] }, () => {});
expect(Number(fakeEngine.initializeCalls) === 1 && Number(fakeEngine.recognizeCalls) === 1 && fakeEngine.classificationCalls.length === 0, "formal run initializes once at runtime ownership and invokes recognition with the confirmed pool");
expect(formalRun.status === "failed" && formalRun.result === null && formalRun.error?.code === "image_analysis_failed" && classificationCoordinator.active === null, "formal OCR failure retains the existing runtime result and context cleanup");
expect(visualClassificationCalls.length === 3, "formal run does not substitute the visual suggestion classifier for OCR");

function occurrence(overrides: Record<string, unknown> = {}): any {
  return { occurrenceId: "occ-1", row: 0, column: 0, completeness: "complete", sourceRect: { card: { x: 10, y: 20, width: 80, height: 100 }, name: { x: 20, y: 80, width: 60, height: 15 }, level: { x: 20, y: 95, width: 30, height: 12 }, quality: { x: 10, y: 20, width: 20, height: 20 }, equipped: { x: 70, y: 20, width: 20, height: 20 } }, effectiveName: "天府", effectiveLevel: 40, quality: "橙", qualityConfidence: .9, nameConfidence: .9, levelConfidence: .9, equippedState: "unknown", reviewRequired: false, ...overrides };
}
function runtimeResult(overrides: Partial<BrowserAnalysisResultV1> = {}): BrowserAnalysisResultV1 {
  const item = occurrence();
  return {
    schemaVersion: 1,
    job: { jobId: "job-1", status: "completed", startedAt: "2026-08-13T00:00:00.000Z", finishedAt: "2026-08-13T00:00:01.000Z" },
    sourceImages: [{ sourceImageId: "image-1", sourceOrder: 1, confirmedPool: { imageId: "image-1", pageType: "main" } }],
    images: [{ sourceImageId: "image-1", sourceOrder: 1, confirmedPool: { imageId: "image-1", pageType: "main" }, status: "completed", error: null, analysis: { pageClassification: { pageType: "main", reviewRequired: false }, occurrences: [item], experienceOccurrences: [], experienceAggregate: null, inventoryHeader: {}, warnings: [] } as any }],
    failures: [], inventory: { status: "confirmed", currentCount: { value: 1, status: "confirmed", sources: [], reviewReasonCodes: [] }, capacity: { value: 100, status: "confirmed", sources: [], reviewReasonCodes: [] } }, overlap: { confirmedPairs: [], relations: [] }, occurrences: [{ occurrenceId: "occ-1", sourceImageId: "image-1", sourceOrder: 1, kind: "ordinary", occurrence: item }], review: { status: "ready_for_review", reasons: [] },
    ...overrides,
  };
}
function runtimeDraft(result = runtimeResult(), changes: Partial<{ runAccountId: string; runBaseRevision: number; currentAccountId: string; currentRevision: number; activeJobId: string }> = {}) {
  return buildReconcileDraftFromBrowserRuntime(result, { runAccountId: "account-1", runBaseRevision: 4, currentAccountId: "account-1", currentRevision: 4, activeJobId: "job-1", catalog, ...changes });
}
const clean = runtimeDraft();
expect(clean.status === "ready_to_finalize" && clean.task.accountId === "account-1" && clean.task.baseRevision === 4, "public runtime result enters the existing reconcile core with external business context");
expect(!("accountId" in runtimeResult().job) && !JSON.stringify(runtimeResult()).includes("baseRevision"), "public OCR contract remains free of account and revision fields");
expect(runtimeDraft(runtimeResult({ job: { ...runtimeResult().job, jobId: "stale-job" } })).blockReasonCodes.includes("active_task_mismatch"), "stale runtime job is blocked");
expect(runtimeDraft(runtimeResult(), { currentAccountId: "account-2" }).blockReasonCodes.includes("account_mismatch"), "stale account is blocked");
expect(runtimeDraft(runtimeResult(), { currentRevision: 5 }).blockReasonCodes.includes("revision_mismatch"), "stale revision is blocked");
expect(runtimeDraft(runtimeResult({ job: { ...runtimeResult().job, status: "partial" } })).blockReasonCodes.includes("partial_requires_retry"), "partial runtime result is blocked");
expect(runtimeDraft(runtimeResult({ review: { status: "blocked", reasons: [] } })).blockReasonCodes.includes("analysis_blocked"), "blocked analysis review is not ingested");
const completedRun = { jobId: "job-1", status: "completed", result: runtimeResult(), error: null } satisfies BrowserOcrRuntimeRunV1;
expect(completedRuntimeResultForReconcile(completedRun) === completedRun.result, "only a completed runtime run exposes a reconcile result");
for (const status of ["cancelled", "failed", "partial"] as const) {
  const run = { jobId: "job-1", status, result: status === "partial" ? runtimeResult({ job: { ...runtimeResult().job, status: "partial" } }) : null, error: null } as BrowserOcrRuntimeRunV1;
  expect(completedRuntimeResultForReconcile(run) === null, `${status} run cannot enter the reconcile adapter`);
}

let fresh = 0;
const finalized = finalizeReconcileDraft(clean, {}, { catalog, gameVersion: "如鸢", createStarInstanceId: () => `fresh-${++fresh}` });
expect(finalized.workspace.inventory.length === 1 && finalized.workspace.inventory[0]!.starInstanceId === "fresh-1", "clean runtime result explicitly finalizes to fresh physical IDs");
expect(finalized.workspace.planTargets && Object.keys(finalized.workspace.planTargets).length === 0, "fresh OCR rebuild clears old plan targets");
expect(finalized.workspace.accountId === "account-1" && finalized.workspace.revision === 4, "finalized workspace keeps the externally captured account and base revision for atomic commit");

const unresolved = occurrence({ effectiveName: null, reviewRequired: true });
const reviewResult = runtimeResult({
  images: [{ ...runtimeResult().images[0]!, analysis: { ...(runtimeResult().images[0]!.analysis as any), occurrences: [unresolved] } }],
  occurrences: [{ occurrenceId: "occ-1", sourceImageId: "image-1", sourceOrder: 1, kind: "ordinary", occurrence: unresolved }],
  review: { status: "needs_review", reasons: [] },
});
const reviewDraft = runtimeDraft(reviewResult);
expect(reviewDraft.status === "requires_review" && !isReconcileResolutionComplete(reviewDraft, {}), "unresolved ordinary result cannot commit without an explicit decision");
const reviewEvidence = buildProductReviewEvidence(reviewResult);
const cropRect = productReviewRowCropRect(reviewEvidence, "image-1", 0, { width: 200, height: 200 });
expect(cropRect != null && cropRect.x <= 10 && cropRect.y < 20 && cropRect.width >= 80 && cropRect.height > 100, "row review crop uses the unioned sourceRect card context with padding");
expect(productReviewReasonText(["ordinary_name_unresolved", "unknown_internal_code"]) === "名称未知、需要人工复核", "review reasons are mapped centrally to readable Chinese without exposing internal codes");
const unresolvedSummary = buildProductReviewImageSummaries(reviewDraft, {}, reviewEvidence)[0]!;
expect(unresolvedSummary.candidateCount === 1 && unresolvedSummary.pendingCount === 1 && unresolvedSummary.attentionRequired, "image review summary exposes candidate and pending counts and sorts attention-worthy images");
expect(isReconcileResolutionComplete(reviewDraft, { ordinary: { "occ-1": { action: "exclude" } } }), "explicit exclusion completes an ordinary review decision");
const excludedSummary = buildProductReviewImageSummaries(reviewDraft, { ordinary: { "occ-1": { action: "exclude" } } }, reviewEvidence)[0]!;
expect(excludedSummary.pendingCount === 0 && excludedSummary.excludedCount === 1, "image review summary updates after an explicit exclusion");
expect(finalizeReconcileDraft(reviewDraft, { ordinary: { "occ-1": { action: "edit", name: "天府", level: 40, quality: "橙" } } }, { catalog, gameVersion: "如鸢", createStarInstanceId: () => "reviewed" }).workspace.inventory[0]!.name === "天府", "complete manual resolution can finalize and does not guess unknown OCR fields");
const oldWorkspace = JSON.stringify(finalized.workspace);
const abandonedPending = { draft: reviewDraft, resolution: {}, oldWorkspace };
expect(abandonedPending.oldWorkspace === oldWorkspace && JSON.stringify(finalized.workspace) === oldWorkspace, "discarding an in-memory pending review leaves the committed workspace unchanged");

let releasePrepare!: () => void;
const prepareGate = new Promise<void>((resolve) => { releasePrepare = resolve; });
const backgroundEngine = new FakeClassificationEngine();
backgroundEngine.initialize = async () => { backgroundEngine.initializeCalls++; await prepareGate; return { schemaVersion: "1.0", models: [] }; };
const backgroundCoordinator = new ProductOcrImportCoordinator({ engine: backgroundEngine, classifyImportImage: async () => classification("support") });
const background = backgroundCoordinator.prepare();
expect(backgroundCoordinator.prepare() === background, "coordinator prepare is a thin forwarder preserving runtime's shared Promise");
const independentSuggestion = await backgroundCoordinator.classify(images[0]!);
expect(independentSuggestion.pageType === "support" && !backgroundCoordinator.classificationPending, "visual suggestion must resolve while OCR preparation is still pending");
expect(backgroundEngine.initializeCalls === 1 && backgroundEngine.classificationCalls.length === 0 && backgroundEngine.recognizeCalls === 0, "background initialization is independent of visual classify's zero OCR calls");
releasePrepare(); await background; await backgroundCoordinator.dispose();

const failedBackgroundEngine = new FakeClassificationEngine();
failedBackgroundEngine.initialize = async () => { failedBackgroundEngine.initializeCalls++; throw new Error("model unavailable"); };
const failedBackgroundCoordinator = new ProductOcrImportCoordinator({ engine: failedBackgroundEngine, classifyImportImage: async () => classification("experience") });
await failedBackgroundCoordinator.prepare().catch(() => undefined);
expect((await failedBackgroundCoordinator.classify(images[0]!)).pageType === "experience", "background prepare failure must not break visual recommendations");
expect(failedBackgroundEngine.initializeCalls === 1 && failedBackgroundEngine.classificationCalls.length === 0 && failedBackgroundEngine.recognizeCalls === 0, "visual classify after failed prepare must not retry or perform OCR");
await failedBackgroundCoordinator.dispose();

let runtimeCreations = 0, initializes = 0, analyzes = 0, disposes = 0;
const accountEngine: BrowserVisionEngine = {
  initialize: async () => { initializes++; return { schemaVersion: "1.0", models: [] }; },
  classifyImage: async () => { throw new Error("visual classify must bypass this engine"); },
  analyzeImage: async (input) => {
    analyzes++;
    const absent = { value: null, status: "not_present", confidence: null, rawText: null, normalizedText: null, evidence: [], reviewReasonCodes: [] };
    return { ...runtimeResult().images[0]!.analysis!, imageId: input.imageId,
      inventoryHeader: { roi: { x: 0, y: 0, width: 0, height: 0 }, tokens: [], currentCount: absent, capacity: absent },
      timings: { ocrSessionCreationCount: 0, totalMs: 0 } } as any;
  },
  dispose: async () => { disposes++; },
};
const accountRuntime = new BrowserOcrRuntime({ createEngine: () => { runtimeCreations++; return accountEngine; } });
const accountCoordinator = new ProductOcrImportCoordinator({ runtime: accountRuntime, classifyImportImage: async () => classification("main") });
await accountCoordinator.prepare();
for (const accountId of ["account-A", "account-B"]) {
  const accountRun = await accountCoordinator.run({ ...runContext, jobId: accountId, accountId, images: [pairedImages[0]!], overlapPairs: [] }, () => undefined);
  expect(accountRun.status === "completed" && accountCoordinator.active === null, "formal coordinator success must survive account context changes");
}
expect(runtimeCreations === 1 && initializes === 1 && analyzes === 2 && disposes === 0, "account A to B must reuse the page runtime without dispose/reprepare");
await accountCoordinator.dispose(); await accountCoordinator.dispose();
expect(Number(disposes) === 1, "coordinator disposal must release its runtime engine once");
console.log("P4 coordinator checks passed: thin prepare, visual independence, account reuse, formal success");
console.log("Step 2B product import state, runtime job, public-result adapter, review and safety checks passed");
