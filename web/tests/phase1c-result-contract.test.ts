import {
  analyzeConfirmedOverlap,
  analyzeBrowserBatchWithResult,
  buildBrowserAnalysisResult,
  summarizeInventory,
  type BrowserBatchAnalysisV1,
  type BrowserBatchImageResultV1,
} from "../src/structured/batch-orchestration.js";
import { normalizeInventoryText, observeInventoryHeader } from "../src/structured/inventory-header.js";
import type { BrowserImageAnalysisV1, BrowserImageInput, BrowserVisionEngine, ModelManifest, OrdinaryStarOccurrenceV1, PageClassificationV1, VisionAssetConfig } from "../src/structured/contracts.js";

function expect(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function equal<T>(actual: T, expected: T, message: string): void { expect(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`); }

const profile = { viewport: { x: 0, y: 0, width: 1000, height: 2000 } } as BrowserImageAnalysisV1["profileAndBounds"]["profile"];

function field(value: number | null) {
  return { value, status: value == null ? "not_present" as const : "confirmed" as const, confidence: value == null ? null : .9, rawText: value == null ? null : `${value}/400`, normalizedText: value == null ? null : `${value}/400`, evidence: [], reviewReasonCodes: [] };
}

function occurrence(imageId: string, row: number, column: number, name = `星${column}`, level = 20): OrdinaryStarOccurrenceV1 {
  return {
    occurrenceId: `${imageId}-r${row}c${column}`, row, column, completeness: "complete",
    sourceRect: { card: { x: 0, y: 0, width: 1, height: 1 }, name: { x: 0, y: 0, width: 1, height: 1 }, level: { x: 0, y: 0, width: 1, height: 1 }, quality: { x: 0, y: 0, width: 1, height: 1 }, equipped: { x: 0, y: 0, width: 1, height: 1 } },
    directName: name, effectiveName: name, nameSource: "direct_ocr", nameConfidence: 1, nameWarning: null,
    directLevel: level, effectiveLevel: level, levelSource: "direct_ocr", levelConfidence: 1, levelWarning: null,
    quality: "橙", qualitySource: "visual_background", qualityConfidence: 1, qualityWarning: null,
    equippedState: "unequipped", equippedSource: "visual_background", equippedConfidence: 1, equippedWarning: null,
    rawOcrCandidates: { name: [], level: [] },
    visualEvidence: { algorithm: "phash_hue_v1", iconBits: "1".repeat(64), nameBits: "0".repeat(64), levelBits: "10".repeat(32), hueHistogram: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    inferenceProvenance: [], warnings: [], reviewRequired: false,
  };
}

function analysis(imageId: string, current: number | null = 100, capacity: number | null = 400, rows = 1): BrowserImageAnalysisV1 {
  return {
    schemaVersion: "1.0", imageId,
    pageClassification: { pageType: "main", visualEvidence: [], tabOcrEvidence: [], confidence: 1, warning: null, reviewRequired: false },
    profileAndBounds: { profile, contentBounds: null, contentBoundsSource: "fixture", warnings: [] },
    occurrences: Array.from({ length: rows }, (_, row) => Array.from({ length: 4 }, (_, column) => occurrence(imageId, row, column))).flat(),
    experienceOccurrences: [], experienceAggregate: null,
    inventoryHeader: { roi: { x: 750, y: 1740, width: 190, height: 180 }, tokens: [], currentCount: field(current), capacity: field(capacity) },
    warnings: [],
    timings: { decodeMs: 0, profileContentBoundsMs: 0, geometryCompletenessMs: 0, roiCropMs: 0, nameRecognitionMs: 0, levelRecognitionMs: 0, qualityRecognitionMs: 0, equippedRecognitionMs: 0, tabOcrMs: 0, postprocessMs: 0, totalMs: 0, peakCandidateCount: 0, ocrSessionCreationCount: 0, ocrRecognitionCallCount: 0 },
  };
}

function image(sourceImageId: string, sourceOrder: number, result: BrowserImageAnalysisV1 | null, status: BrowserBatchImageResultV1["status"] = "completed", confirmedPool: BrowserBatchImageResultV1["confirmedPool"] = { imageId: sourceImageId, pageType: "main" }): BrowserBatchImageResultV1 {
  return { sourceImageId, sourceOrder, confirmedPool, status, analysis: result, error: status === "failed" ? { code: "analysis_failed", errorType: "Error", message: "image analysis failed", retryable: true } : null };
}

function batch(status: BrowserBatchAnalysisV1["status"], images: BrowserBatchImageResultV1[]): BrowserBatchAnalysisV1 {
  return { schemaVersion: "1.0", taskId: "task", accountId: "account", baseRevision: 4, status, startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", images, summary: { totalImages: images.length, completedImages: images.filter((item) => item.status === "completed").length, failedImages: images.filter((item) => item.status === "failed").length, cancelledImages: images.filter((item) => item.status === "cancelled").length, ordinaryOccurrenceCount: 0, experienceOccurrenceCount: 0, ocrSessionInitializationCount: 0, peakConcurrentAnalyses: images.length ? 1 : 0, totalDurationMs: 1 }, warnings: [] };
}

class ResultEngine implements BrowserVisionEngine {
  async initialize(_config: VisionAssetConfig): Promise<ModelManifest> { return { schemaVersion: "1.0", models: [] }; }
  async classifyImage(_input: BrowserImageInput): Promise<PageClassificationV1> { throw new Error("not used"); }
  async analyzeImage(input: BrowserImageInput): Promise<BrowserImageAnalysisV1> { return analysis(input.imageId); }
  async dispose(): Promise<void> {}
}

equal(normalizeInventoryText(" O12 / o400 "), "012/0400", "inventory normalization must retain Python O/o cleanup");
const observed = observeInventoryHeader(profile, [{ text: "O12 / 0400", confidence: .9, variant: "color" }]);
equal([observed.currentCount.value, observed.capacity.value, observed.roi], [12, 400, { x: 750, y: 1740, width: 190, height: 180 }], "inventory observation must use the focused lower-right count ROI and direct OCR values");
const splitTokens = observeInventoryHeader(profile, [
  { text: "246", confidence: .93, variant: "detected", rect: { x: 750, y: 1800, width: 40, height: 24 } },
  { text: "/", confidence: .9, variant: "detected", rect: { x: 794, y: 1800, width: 8, height: 24 } },
  { text: "250", confidence: .92, variant: "detected", rect: { x: 806, y: 1800, width: 40, height: 24 } },
]);
equal([splitTokens.currentCount.value, splitTokens.capacity.value], [246, 250], "adjacent inventory OCR tokens must merge before parsing");
equal(splitTokens.tokens.map((token) => token.rawText), ["246", "/", "250"], "inventory observation must retain raw OCR tokens in left-to-right order");
const lowConfidenceInventory = observeInventoryHeader(profile, [{ text: "246/250", confidence: .64, variant: "detected" }]);
equal([lowConfidenceInventory.currentCount.value, lowConfidenceInventory.capacity.value, lowConfidenceInventory.currentCount.status, lowConfidenceInventory.capacity.status], [null, null, "unreadable", "unreadable"], "sub-threshold inventory pattern matches must remain unreadable");
equal(observeInventoryHeader(profile, [{ text: "246/250", confidence: .65, variant: "detected" }]).currentCount.status, "confirmed", "threshold-confidence inventory pattern matches may confirm");
equal(observeInventoryHeader(profile, [{ text: "246/250", confidence: .9, variant: "detected" }, { text: "247/250", confidence: .64, variant: "contrast" }]).currentCount.value, 246, "sub-threshold conflicting candidates must not override a reliable inventory value");
equal(observeInventoryHeader(profile, [{ text: "500/400", confidence: .9, variant: "color" }]).currentCount.status, "invalid", "current count above capacity must not become a valid value");
equal(observeInventoryHeader(profile, [{ text: "not a count", confidence: .9, variant: "color" }]).capacity.status, "unreadable", "non-numeric OCR must stay explicit");
const unreadable = observeInventoryHeader(profile, [{ text: "not a count", confidence: .9, variant: "color" }]);
equal([unreadable.currentCount.rawText, unreadable.currentCount.normalizedText], ["not a count", "n0tac0unt"], "unreadable OCR must retain its direct raw evidence");
equal(observeInventoryHeader(profile, [{ text: "12/400", confidence: .9, variant: "color" }, { text: "13/400", confidence: .8, variant: "contrast" }]).currentCount.status, "ambiguous", "in-image OCR variants with competing values must not select one silently");
equal(observeInventoryHeader(profile, [{ text: "12/400", confidence: .9, variant: "color" }]), observeInventoryHeader(profile, [{ text: "12/400", confidence: .9, variant: "color" }]), "same inventory OCR input must be deterministic");

const consistentImages = [image("a", 1, analysis("a")), image("b", 2, analysis("b"))];
equal(summarizeInventory(consistentImages).status, "confirmed", "identical multi-image observations must confirm independently per field");
equal(summarizeInventory([image("a", 1, analysis("a", 100, 400)), image("b", 2, analysis("b", 101, 400))]).currentCount.status, "conflict", "conflicting current counts must not be silently selected");
equal(summarizeInventory([image("a", 1, analysis("a", 500, 400)), image("b", 2, analysis("b", 500, 400))]).status, "invalid", "invalid aggregate relationships must be reviewable");
equal(summarizeInventory([image("a", 1, analysis("a", 100, null))]).status, "partial", "one field may remain usable when the other is absent");
equal(summarizeInventory([image("a", 1, analysis("a", null, 400))]).status, "partial", "capacity may remain usable when current count is absent");
equal(summarizeInventory([image("a", 1, analysis("a", null, null))]).status, "unknown", "no observed fields must remain unknown instead of becoming zero");
const lowConfidence = analysis("low-confidence");
lowConfidence.inventoryHeader.currentCount.confidence = .64;
lowConfidence.inventoryHeader.capacity.confidence = .64;
equal(summarizeInventory([image("low-confidence", 1, lowConfidence)]).status, "unknown", "the established 0.65 confidence threshold must gate aggregation");

const pair = { pairId: "pair-a-b", sourceImageIdA: "a", sourceImageIdB: "b" };
equal(analyzeConfirmedOverlap(consistentImages, []).relations, [], "unconfirmed image pairs must never be analyzed");
equal(analyzeConfirmedOverlap([image("a", 1, analysis("a"), "completed", null), image("b", 2, analysis("b"), "completed", null)], [pair]).relations[0]?.status, "unavailable", "a pair without explicit confirmed pools is blocked");
equal(analyzeConfirmedOverlap([image("a", 1, analysis("a")), image("b", 2, analysis("b"), "completed", { imageId: "b", pageType: "support" })], [pair]).relations[0]?.status, "unavailable", "different confirmed pools cannot form an overlap pair");
equal(analyzeConfirmedOverlap([image("a", 1, analysis("a"), "completed", { imageId: "a", pageType: "experience" }), image("b", 2, analysis("b"), "completed", { imageId: "b", pageType: "experience" })], [pair]).relations[0]?.status, "unavailable", "experience images cannot form ordinary overlap pairs");
const overlap = analyzeConfirmedOverlap(consistentImages, [pair]);
equal(overlap.relations.map((item) => item.status), ["duplicate", "duplicate", "duplicate", "duplicate"], "exact suffix-prefix rows must produce independent duplicate relations");
function oneFieldConflict(fieldName: "effectiveName" | "effectiveLevel") {
  const conflicting = analysis("conflict");
  (conflicting.occurrences[0] as any)[fieldName] = fieldName === "effectiveName" ? "冲突星" : fieldName === "effectiveLevel" ? 41 : "紫";
  return analyzeConfirmedOverlap([image("a", 1, analysis("a")), image("conflict", 2, conflicting)], [{ pairId: `conflict-${fieldName}`, sourceImageIdA: "a", sourceImageIdB: "conflict" }]).relations;
}
for (const fieldName of ["effectiveName", "effectiveLevel"] as const) equal(oneFieldConflict(fieldName).map((item) => item.status), ["not_duplicate", "not_duplicate", "not_duplicate", "not_duplicate"], `${fieldName} conflict makes the whole row non-duplicate`);
const qualityDifferent = analysis("quality-different"); qualityDifferent.occurrences[0]!.quality = "紫"; qualityDifferent.occurrences[1]!.quality = null;
equal(analyzeConfirmedOverlap([image("a", 1, analysis("a")), image("quality-different", 2, qualityDifferent)], [{ pairId: "quality-diagnostic", sourceImageIdA: "a", sourceImageIdB: "quality-different" }]).relations.map((item) => item.status), ["duplicate", "duplicate", "duplicate", "duplicate"], "quality difference or absence is diagnostic only");
const equippedDifferent = analysis("equipped-different"); for (const item of equippedDifferent.occurrences) item.equippedState = "equipped";
const equippedRelations = analyzeConfirmedOverlap([image("a", 1, analysis("a")), image("equipped-different", 2, equippedDifferent)], [{ pairId: "equipped-ignored", sourceImageIdA: "a", sourceImageIdB: "equipped-different" }]).relations;
equal(equippedRelations.map((item) => item.status), ["duplicate", "duplicate", "duplicate", "duplicate"], "equipped state cannot affect overlap identity");
expect(equippedRelations.every((item) => item.evidence.comparedFields.join(",") === "name,level"), "overlap evidence contains only name and level");
const twoRowsA = analysis("two-a", 100, 400, 2); const twoRowsB = analysis("two-b", 100, 400, 2); twoRowsB.occurrences.filter((item) => item.row === 0 && item.column === 0).forEach((item) => { item.effectiveName = null; });
const anchoredPending = analyzeConfirmedOverlap([image("two-a", 1, twoRowsA), image("two-b", 2, twoRowsB)], [{ pairId: "anchored-pending", sourceImageIdA: "two-a", sourceImageIdB: "two-b" }]).relations;
equal(anchoredPending.map((item) => item.status), ["possible_duplicate", "possible_duplicate", "possible_duplicate", "possible_duplicate", "duplicate", "duplicate", "duplicate", "duplicate"], "an exact anchor retains an adjacent pending row instead of shrinking it away");
expect(anchoredPending.filter((item) => item.status === "possible_duplicate").every((item) => item.reviewReasonCodes.includes("overlap_row_requires_review")), "pending row has a stable row-review reason");
const twoExact = analyzeConfirmedOverlap([image("two-a", 1, analysis("two-a", 100, 400, 2)), image("two-b", 2, analysis("two-b", 100, 400, 2))], [{ pairId: "two-exact", sourceImageIdA: "two-a", sourceImageIdB: "two-b" }]).relations;
equal(twoExact.map((item) => item.status), Array(8).fill("duplicate"), "two exact rows are independently retained");
const shorterLeft = analysis("shorter-left", 100, 400, 2); const shorterRight = analysis("shorter-right", 100, 400, 2);
shorterLeft.occurrences.filter((item) => item.row === 0).forEach((item) => { item.effectiveName = `older-${item.column}`; item.directName = item.effectiveName; });
shorterRight.occurrences.filter((item) => item.row === 1).forEach((item) => { item.effectiveName = `conflict-${item.column}`; item.directName = item.effectiveName; });
equal(analyzeConfirmedOverlap([image("shorter-left", 1, shorterLeft), image("shorter-right", 2, shorterRight)], [{ pairId: "shorter-exact", sourceImageIdA: "shorter-left", sourceImageIdB: "shorter-right" }]).relations.map((item) => item.status), ["duplicate", "duplicate", "duplicate", "duplicate"], "a longer conflicting candidate falls back to a shorter exact suffix-prefix row");
const visuallyDifferent = analysis("different");
for (const item of visuallyDifferent.occurrences) item.visualEvidence = { algorithm: "phash_hue_v1", iconBits: "0".repeat(64), nameBits: "1".repeat(64), levelBits: "01".repeat(32), hueHistogram: [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] };
equal(analyzeConfirmedOverlap([image("a", 1, analysis("a")), image("different", 2, visuallyDifferent)], [{ pairId: "visual-conflict", sourceImageIdA: "a", sourceImageIdB: "different" }]).relations.map((item) => item.status), ["duplicate", "duplicate", "duplicate", "duplicate"], "low visual similarity is diagnostic only");
const missingVisual = analysis("missing-visual");
for (const item of missingVisual.occurrences) item.visualEvidence = null;
equal(analyzeConfirmedOverlap([image("a", 1, analysis("a")), image("missing-visual", 2, missingVisual)], [{ pairId: "visual-unavailable", sourceImageIdA: "a", sourceImageIdB: "missing-visual" }]).relations.map((item) => item.status), ["duplicate", "duplicate", "duplicate", "duplicate"], "missing visual evidence is diagnostic only");
equal(analyzeConfirmedOverlap(consistentImages, [{ ...pair, sourceImageIdA: "b", sourceImageIdB: "a" }]).relations.map((item) => item.status), overlap.relations.map((item) => item.status), "directed pairs retain their own endpoints while identical rows keep the same status");
equal(analyzeConfirmedOverlap(consistentImages, [{ pairId: "missing", sourceImageIdA: "a", sourceImageIdB: "missing" }]).relations[0]?.status, "unavailable", "missing pair sources must remain diagnostic");
equal(buildBrowserAnalysisResult(batch("completed", consistentImages), [{ pairId: "missing", sourceImageIdA: "a", sourceImageIdB: "missing" }]).review.status, "blocked", "missing pair sources must be structural input errors, not silently reviewable data");
equal(analyzeConfirmedOverlap([image("a", 1, analysis("a")), image("b", 2, null, "failed")], [pair]).relations[0]?.status, "unavailable", "a failed pair image must not fail the batch");
const transitive = analyzeConfirmedOverlap([...consistentImages, image("c", 3, analysis("c"))], [pair, { pairId: "pair-a-c", sourceImageIdA: "a", sourceImageIdB: "c" }]);
expect(transitive.relations.every((item) => item.status === "duplicate"), "transitive confirmed overlap may retain duplicate relations without global ambiguity conversion");

const completed = buildBrowserAnalysisResult(batch("completed", consistentImages), [pair]);
equal(completed.review.status, "ready_for_review", "complete, structurally valid results must be reviewable");
equal(completed.schemaVersion, 1, "final contract schema version is fixed");
equal(JSON.parse(JSON.stringify(completed)).task.taskId, "task", "final result must be JSON serializable");
equal(buildBrowserAnalysisResult(batch("partial", [image("a", 1, analysis("a")), image("b", 2, null, "failed")])).review.status, "needs_review", "partial batches retain reviewable successes");
equal(buildBrowserAnalysisResult(batch("cancelled", [image("a", 1, analysis("a")), image("b", 2, null, "cancelled")])).review.status, "needs_review", "cancelled batches retain completed analysis for review");
equal(buildBrowserAnalysisResult(batch("cancelled", [image("a", 1, null, "cancelled")])).review.status, "blocked", "cancelled batches without successes are blocked");
equal(buildBrowserAnalysisResult(batch("failed", [image("a", 1, null, "failed")])).review.status, "blocked", "failed batches are blocked");
equal(buildBrowserAnalysisResult(batch("completed", consistentImages), [], { accountId: "other", baseRevision: 4 }).review.status, "blocked", "stale account or revision must block later application");
equal(buildBrowserAnalysisResult(batch("completed", consistentImages), [pair]).overlap.relations.map((item) => item.relationId), buildBrowserAnalysisResult(batch("completed", consistentImages), [pair]).overlap.relations.map((item) => item.relationId), "same input must be deterministic");

const integrated = await analyzeBrowserBatchWithResult({
  schemaVersion: "1.0", taskId: "integrated", accountId: "account", baseRevision: 4,
  images: [
    { sourceImageId: "source-a", sourceOrder: 1, input: { imageId: "a", file: {} as File }, confirmedPool: { imageId: "a", pageType: "main" } },
    { sourceImageId: "source-b", sourceOrder: 2, input: { imageId: "b", file: {} as File }, confirmedPool: { imageId: "b", pageType: "main" } },
  ],
  confirmedOverlapPairs: [{ pairId: "integrated-pair", sourceImageIdA: "source-a", sourceImageIdB: "source-b" }],
}, { engine: new ResultEngine() }, { accountId: "account", baseRevision: 4 });
equal([integrated.batch.status, integrated.result.review.status], ["completed", "ready_for_review"], "the high-level batch entry must preserve Phase 1B output and add a reviewable final contract");
equal(integrated.result.overlap.relations.length, 4, "the high-level batch entry must forward only confirmed pairs into final relations");
equal(integrated.batch.images.map((item) => item.confirmedPool?.pageType), ["main", "main"], "batch results retain explicit confirmed pools");

console.log("phase 1c result-contract checks passed");
