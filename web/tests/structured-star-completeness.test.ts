import { boxesForCircle, classifyCompleteness, isInside } from "../src/structured/card-completeness.js";
import { buildCardCandidates } from "../src/structured/main-grid.js";
import { createScreenshotProfile } from "../src/structured/profiles.js";
import { refineStarContentBounds } from "../src/structured/star-content-bounds.js";
import { classifyStarResultStatus } from "../src/structured/star-postprocess.js";
import { buildBrowserImageAnalysis } from "../src/structured/contract-builder.js";
import { buildBrowserAnalysisResult, type BrowserBatchAnalysisV1 } from "../src/structured/batch-orchestration.js";
import { createStarCatalog } from "../src/business/catalog.js";
import { automaticReconcileResolution, buildReconcileDraft, finalizeReconcileDraft } from "../src/business/reconcile.js";
import { buildProductReviewCandidates } from "../src/product-ocr-preview.js";
import { buildProductReviewEvidence } from "../src/product-ocr-review.js";
import type { CardCandidate, CircleProposal, MainStarResult, Rect, ScreenshotProfile } from "../src/structured/types.js";

let checks = 0;
function expect(value: unknown, message: string): asserts value { checks++; if (!value) throw new Error(message); }
function equal(actual: unknown, expected: unknown, message: string): void { expect(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)}`); }

// Synthetic viewport texture with optional black borders; all coordinates are image-relative.
function fixture(scale = 1, bars = 0) {
  const vw = Math.round(720 * scale), vh = Math.round(1280 * scale);
  const width = vw + 2 * bars, height = vh + 2 * bars;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = bars; y < bars + vh; y++) for (let x = bars; x < bars + vw; x++) {
    const at = (y * width + x) * 4;
    data[at] = data[at + 1] = data[at + 2] = x % 2 ? 25 : 85; data[at + 3] = 255;
  }
  const profile = createScreenshotProfile({ data, width, height, colorSpace: "srgb" } as ImageData);
  const tab: Rect = { x: bars + Math.round(62 * scale), y: bars + Math.round(215 * scale), width: Math.round(196 * scale), height: Math.round(42 * scale) };
  return { profile, tab };
}
function circle(column: number, y: number, radius = 56): CircleProposal {
  return { centerX: [119, 274, 430, 585][column]!, centerY: y, radius, score: 90, source: "fixture" };
}
const { profile, tab } = fixture();
const refined = refineStarContentBounds(profile, tab);
equal(refined.contentBounds.y, tab.y + tab.height, "credible tab bottom tightens top");
equal(refined.contentBounds.y + refined.contentBounds.height, profile.contentBounds.y + profile.contentBounds.height, "refinement keeps fallback bottom");
expect(refineStarContentBounds(profile, null) === profile, "missing anchor returns original profile");
for (const bad of [
  { ...tab, width: 10 }, { ...tab, height: 0 }, { ...tab, x: -1 }, { ...tab, x: 700 },
  { ...tab, y: 0 }, { ...tab, y: 400 }, { ...tab, y: NaN },
]) expect(refineStarContentBounds(profile, bad) === profile, "untrusted anchor keeps fallback");
expect(refineStarContentBounds({ ...profile, contentBounds: { ...profile.contentBounds, height: 1 } }, tab).contentBounds.height === 1, "anchor cannot invert bounds");
for (const [scale, bars] of [[.5, 0], [1.25, 0], [1, 30]] as const) {
  const f = fixture(scale, bars), p = refineStarContentBounds(f.profile, f.tab);
  equal(p.viewport, { x: bars, y: bars, width: Math.round(720 * scale), height: Math.round(1280 * scale) }, "viewport removes letterbox");
  equal(p.contentBounds.y, f.tab.y + f.tab.height, "anchor uses scaled/offset image coordinates");
  const c = { ...circle(0, 637), centerX: bars + 119 * scale, centerY: bars + 637 * scale, radius: 56 * scale };
  equal(classifyCompleteness(c, p).completeness, "complete", "scaled middle candidate stays complete");
  equal(classifyCompleteness({ ...c, centerY: p.contentBounds.y + c.radius - 1 }, p).completeness, "partial_top", "scaled/offset top cut is enforced");
}
const physical: ScreenshotProfile = { ...profile, contentBounds: { x: -100, y: -100, width: 1000, height: 1600 } };
equal(classifyCompleteness(circle(0, 637), physical).completeness, "complete", "physical middle is complete");
equal(classifyCompleteness(circle(0, 20), physical).completeness, "partial_top", "image top limits theoretical content");
equal(classifyCompleteness(circle(0, 1250), physical).completeness, "partial_bottom", "image bottom limits theoretical content");
const intersected = { ...physical, viewport: { x: 60, y: 300, width: 600, height: 500 }, contentBounds: { x: 100, y: 250, width: 500, height: 500 } };
equal(classifyCompleteness(circle(1, 357), intersected).completeness, "partial_top", "viewport top wins intersection");
equal(classifyCompleteness(circle(1, 657), intersected).completeness, "partial_bottom", "content bottom wins intersection");
equal(classifyCompleteness(circle(0, 450), intersected).completeness, "invalid", "content left wins intersection");
equal(classifyCompleteness(circle(3, 450), { ...intersected, contentBounds: physical.contentBounds }).completeness, "complete", "viewport right accepts an inside candidate");
equal(classifyCompleteness({ ...circle(3, 450), centerX: 620 }, { ...intersected, contentBounds: physical.contentBounds }).completeness, "invalid", "viewport right clips an outside candidate");

const levelCut = { ...refined, contentBounds: { ...refined.contentBounds, y: 300, height: 600 } };
const levelBoxes = boxesForCircle(circle(0, 357));
expect(isInside(levelBoxes.discRect, levelCut.contentBounds) && isInside(levelBoxes.nameRect, levelCut.contentBounds) && !isInside(levelBoxes.levelRect, levelCut.contentBounds), "only level ROI is cut");
equal(classifyCompleteness(circle(0, 357), levelCut).completeness, "partial_top", "level alone decides completeness");
const nameCut = { ...refined, contentBounds: { ...refined.contentBounds, height: 743 - refined.contentBounds.y } };
const nameBoxes = boxesForCircle(circle(0, 657));
expect(isInside(nameBoxes.discRect, nameCut.contentBounds) && isInside(nameBoxes.levelRect, nameCut.contentBounds) && !isInside(nameBoxes.nameRect, nameCut.contentBounds), "only name ROI is cut");
equal(classifyCompleteness(circle(0, 657), nameCut).completeness, "partial_bottom", "name alone decides completeness");
const discOnly = { ...circle(0, 637), centerX: 55 };
const discBoxes = boxesForCircle(discOnly);
expect(!isInside(discBoxes.discRect, refined.contentBounds) && isInside(discBoxes.nameRect, refined.contentBounds) && isInside(discBoxes.levelRect, refined.contentBounds), "only disc is cut horizontally");
equal(classifyCompleteness(discOnly, refined).completeness, "invalid", "disc alone decides completeness");
const roiBounds = { ...refined, contentBounds: { x: 63, y: refined.contentBounds.y, width: 600, height: refined.contentBounds.height } };
expect(!isInside(boxesForCircle(circle(0, 637)).cardRect, roiBounds.contentBounds), "decorative card rectangle extends beyond required ROIs");
equal(classifyCompleteness(circle(0, 637), roiBounds).completeness, "complete", "card rectangle does not substitute for required ROIs");
equal(classifyCompleteness(circle(0, 305, 53), refined).completeness, "partial_top", "internal top cut becomes fragment");
equal(classifyCompleteness(circle(0, 969), refined).completeness, "complete", "ambiguous manual bottom keeps fallback and remains reviewable");

const proposals = [305, 469, 637, 803, 1080].flatMap((y) => [0, 1, 2, 3].map((c) => circle(c, y)));
const before = buildCardCandidates(proposals, profile), after = buildCardCandidates(proposals, refined);
const identities = (cards: CardCandidate[]) => cards.map(({ cardId, rowIndex, columnIndex, circle, cardRect, discRect, nameRect, levelRect }) => ({ cardId, rowIndex, columnIndex, circle, cardRect, discRect, nameRect, levelRect }));
equal(identities(after), identities(before), "refinement preserves candidate count/identity, rows, columns and all ROIs");
const mixed = buildCardCandidates([0, 1, 2, 3].map((c) => circle(c, c === 0 ? 315 : 317)), refined);
equal(mixed.map((c) => c.completeness), ["partial_top", "complete", "complete", "complete"], "fragment does not propagate to neighbors");
equal(classifyStarResultStatus("complete", null, null), "needs_review", "failed OCR does not alter physical completeness");

const catalog = createStarCatalog([{ name: "天府", kind: "主星", aliases: [], displayGroup: null, usageTags: [], rawEffectText: null }], {});
function failedReview(cards: CardCandidate[]) {
  const results: MainStarResult[] = cards.map((card) => ({
    instanceId: `synthetic:${card.rowIndex}:${card.columnIndex}`, rowIndex: card.rowIndex, columnIndex: card.columnIndex,
    nameRaw: "", nameNormalized: null, levelRaw: "", level: null, nameConfidence: 0, levelConfidence: 0,
    status: classifyStarResultStatus(card.completeness, null, null), reasons: [], ocrCandidates: { name: [], level: [] },
    sourceRects: { card: card.cardRect, name: card.nameRect, level: card.levelRect }, quality: "橙", reviewRequired: true,
  }));
  const analysis = buildBrowserImageAnalysis("synthetic", { pageType: "main", confidence: 1, reviewRequired: false, warning: null, visualEvidence: [], tabOcrEvidence: [] },
    { profile: refined, candidates: cards, results, timings: { decodeMs: 0, profileContentBoundsMs: 0, gridCompletenessMs: 0, roiCropMs: 0, nameRecognitionMs: 0, levelRecognitionMs: 0, postprocessMs: 0, totalMs: 0, peakCandidateCount: cards.length } }, "main");
  const batch: BrowserBatchAnalysisV1 = { schemaVersion: "1.0", taskId: "synthetic-task", accountId: "synthetic-account", baseRevision: 0, status: "completed", startedAt: "", finishedAt: "", warnings: [],
    images: [{ sourceImageId: "synthetic", sourceOrder: 7, confirmedPool: { imageId: "synthetic", pageType: "main" }, status: "completed", analysis, error: null }],
    summary: { totalImages: 1, completedImages: 1, failedImages: 0, cancelledImages: 0, ordinaryOccurrenceCount: cards.length, experienceOccurrenceCount: 0, ocrSessionInitializationCount: 0, peakConcurrentAnalyses: 1, totalDurationMs: 0 } };
  const result = buildBrowserAnalysisResult(batch);
  const draft = buildReconcileDraft(result, { currentAccountId: "synthetic-account", currentRevision: 0, activeTaskId: "synthetic-task", catalog });
  const resolution = automaticReconcileResolution(draft);
  const evidence = buildProductReviewEvidence({ ...result, job: { jobId: batch.taskId, status: "completed", startedAt: "", finishedAt: "" }, sourceImages: [{ sourceImageId: "synthetic", sourceOrder: 7, confirmedPool: batch.images[0]!.confirmedPool ?? null }] });
  const preview = buildProductReviewCandidates(draft, resolution, evidence, new Set());
  return { draft, resolution, preview };
}
const failed = failedReview(mixed);
equal(failed.preview.filter((c) => c.tier === 1).length, 3, "all three complete failed OCR candidates stay Tier1");
expect(failed.preview.some((c) => c.tier === 2 && c.kind === "fragment" && c.occurrenceId.includes("synthetic:0:0")), "only the geometrically clipped candidate becomes Tier2");
const unresolvedId = failed.preview.find((c) => c.tier === 1)!.occurrenceId;
const rescued = finalizeReconcileDraft(failed.draft, { ...failed.resolution, ordinary: { ...failed.resolution.ordinary, [unresolvedId]: { action: "edit", name: "天府", level: 1, quality: "橙" } } }, { catalog, gameVersion: "如鸢", createStarInstanceId: () => "rescued" });
expect(rescued.workspace.inventory.some((item) => item.starInstanceId === "rescued"), "physically complete failed OCR is manually rescuable");
const manualBottom = failedReview(buildCardCandidates([0, 1, 2, 3].map((c) => circle(c, 969)), refined));
expect(manualBottom.preview.length === 4 && manualBottom.preview.every((c) => c.tier === 1 && c.kind === "required"), "uncertain manual bottom stays rescuable Tier1");
console.log(`structured star completeness: ${checks} checks passed`);
