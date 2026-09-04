import { createOccurrenceId } from "../src/utils/id.js";
import { classifyQualityPixels } from "../src/structured/quality-postprocess.js";
import { applyHierarchicalNameSandwich, applyHierarchicalOrder, inferEquippedSandwiches, type EquippedRecognition } from "../src/structured/hierarchical-postprocess.js";
import { transferBitmapOnSuccess } from "../src/structured/bitmap-lifecycle.js";
import { classifyPageVisual, croppedGridTopCircleCount } from "../src/structured/page-routing-visual.js";
import { applyPageOverrides, routePage, routeTabOcrCandidates, toPageClassificationV1 } from "../src/structured/page-routing-logic.js";
import type { CardCandidate, MainStarResult } from "../src/structured/types.js";
import type { PageClassificationV1 } from "../src/structured/contracts.js";

function expect(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function equal<T>(actual: T, expected: T, message: string): void { expect(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`); }

equal(createOccurrenceId("image-a", "main", { row: 1, column: 2 }), createOccurrenceId("image-a", "main", { row: 1, column: 2 }), "same card geometry must keep occurrence ID");
expect(createOccurrenceId("image-a", "main", { row: 1, column: 2 }) !== createOccurrenceId("image-b", "main", { row: 1, column: 2 }), "different images must not share occurrence ID");
expect(createOccurrenceId("image-a", "main", { row: 1, column: 2 }) !== createOccurrenceId("image-a", "main", { row: 1, column: 3 }), "different geometry must not share occurrence ID");
expect(createOccurrenceId("image-a", "experience", { ordinal: 0 }) === createOccurrenceId("image-a", "experience", { ordinal: 0 }), "experience ordinal must be deterministic");

equal(routeTabOcrCandidates([{ text: "主星", confidence: 0.9, variant: "color" }]).pageType, "main", "主星 tab OCR must route main");
equal(routeTabOcrCandidates([{ text: "辅星", confidence: 0.9, variant: "color" }]).pageType, "support", "辅星 tab OCR must route support");
equal(routeTabOcrCandidates([{ text: "輔星", confidence: 0.9, variant: "color" }]).pageType, "support", "輔星 tab OCR must route support");
equal(routeTabOcrCandidates([{ text: "经验星石", confidence: 0.9, variant: "color" }]).pageType, "experience", "经验 tab OCR must route experience");
equal(routeTabOcrCandidates([{ text: "經驗星石", confidence: 0.9, variant: "color" }]).pageType, "experience", "經驗星石 tab OCR must route experience");
equal(routeTabOcrCandidates([{ text: "天府", confidence: 0.99, variant: "color" }]).pageType, "unknown", "star-name OCR must not route an unknown page");
equal(routeTabOcrCandidates([]).pageType, "unknown", "insufficient tab evidence must stay unknown");
equal(routeTabOcrCandidates([{ text: "主星", confidence: 0.9, variant: "color" }, { text: "辅星", confidence: 0.9, variant: "contrast" }]).pageType, "unknown", "conflicting tab OCR must stay unknown");
equal(routeTabOcrCandidates([{ text: "主星", confidence: 0.99, variant: "color" }, { text: "辅星", confidence: 0.05, variant: "contrast" }]).pageType, "unknown", "Python tab OCR ignores candidate confidence and keeps a real tie unknown");
equal(routeTabOcrCandidates([{ text: "主星", confidence: 0.92, variant: "color" }, { text: "主星", confidence: 0.21, variant: "contrast" }]).pageType, "main", "same tab token across candidates counts once");
equal(routeTabOcrCandidates([{ text: "模糊文字", confidence: 0.99, variant: "color" }]).pageType, "unknown", "no reliable page token must stay unknown");
const basePage: PageClassificationV1 = { pageType: "support", visualEvidence: [{ source: "visual", value: "selected_tab_visual:support", confidence: 0.82 }], tabOcrEvidence: [], confidence: 0.82, warning: null, reviewRequired: false };
const confirmedConflict = applyPageOverrides(basePage, { imageId: "image-a", pageType: "main" });
equal(confirmedConflict.pageType, "main", "confirmed pool must remain authoritative");
equal(confirmedConflict.warning, "confirmed_pool_conflict", "confirmed pool conflict must be visible");
expect(confirmedConflict.reviewRequired, "confirmed pool conflict must require review");

let visualRoutingCalls = 0;
let tabOcrRoutingCalls = 0;
const confirmedRoutingRun = await routePage("support", async () => {
  visualRoutingCalls += 1;
  tabOcrRoutingCalls += 1;
  throw new Error("confirmed routing must not run automatic visual or tab OCR");
});
equal([visualRoutingCalls, tabOcrRoutingCalls], [0, 0], "confirmed formal OCR must skip visual routing and tab OCR");
equal(confirmedRoutingRun.routing.tabOcrMs, 0, "confirmed formal OCR must report zero tab OCR time");
equal(confirmedRoutingRun.routing.pageType, "support", "confirmed formal OCR must select the confirmed pool");
equal(confirmedRoutingRun.routing.evidence, ["confirmed_pool:support"], "confirmed formal OCR must expose confirmed-pool evidence");
equal([confirmedRoutingRun.routing.tabOcrCandidates, confirmedRoutingRun.routing.warning, confirmedRoutingRun.routing.reviewRequired], [[], null, false], "confirmed formal OCR must not invent tab evidence or classification review");
for (const pageType of ["main", "support", "experience"] as const) {
  const pipelineRoute = await routePage(pageType, async () => { throw new Error("confirmed pool must select its pipeline without automatic routing"); });
  equal(pipelineRoute.routing.pageType, pageType, `confirmed ${pageType} pool must select its matching formal OCR pipeline`);
}
const confirmedClassification = toPageClassificationV1(confirmedRoutingRun.routing);
equal(confirmedClassification.visualEvidence, [{ source: "confirmed_pool", value: "confirmed_pool:support", confidence: 1 }], "confirmed formal OCR classification must retain only confirmed-pool evidence");
equal([confirmedClassification.tabOcrEvidence, confirmedClassification.warning, confirmedClassification.reviewRequired], [[], null, false], "confirmed formal OCR classification must have no tab OCR conflict or classification review");

const automaticRoutingRun = await routePage(undefined, async () => {
  visualRoutingCalls += 1;
  tabOcrRoutingCalls += 1;
  return { routing: { pageType: "main", confidence: 0.75, evidence: ["tab_ocr:主星"], selected: true, tabOcrCandidates: [], warning: null, reviewRequired: false, tabOcrMs: 3 }, visualRoutingMs: 2 };
});
equal([visualRoutingCalls, tabOcrRoutingCalls], [1, 1], "unconfirmed formal OCR must retain visual routing and tab OCR fallback");
equal(automaticRoutingRun.routing.pageType, "main", "unconfirmed formal OCR must retain automatic routing result");

for (const [quality, hue] of [["橙", 12], ["紫", 142], ["蓝", 106], ["绿", 61]] as const) {
  const result = classifyQualityPixels(Array.from({ length: 800 }, () => ({ hue, saturation: 200, value: 220 })));
  equal(result.quality, quality, `${quality} quality must be canonical`);
  expect(result.confidence >= 0.7 && result.warnings.length === 0, `${quality} quality must be confident`);
}
const medianTarget = [
  ...Array.from({ length: 99 }, () => ({ hue: 12, saturation: 200, value: 220 })),
  ...Array.from({ length: 2 }, () => ({ hue: 142, saturation: 200, value: 220 })),
];
equal(classifyQualityPixels(medianTarget).quality, "橙", "quality hue must use the majority hue median, not an arithmetic mean");
expect(classifyQualityPixels(medianTarget).evidence.includes("hue=12.0"), "quality evidence must expose the median hue");
equal(classifyQualityPixels(Array.from({ length: 800 }, () => ({ hue: 0, saturation: 20, value: 220 }))).quality, "白", "bright neutral quality must be 白");
expect(classifyQualityPixels(Array.from({ length: 800 }, () => ({ hue: 0, saturation: 20, value: 100 }))).quality === null, "dark neutral quality must stay unknown");
expect(classifyQualityPixels(Array.from({ length: 800 }, () => ({ hue: 35, saturation: 200, value: 220 }))).warnings.includes("quality_visual_conflict"), "nearby hue must remain conservative");

type FixtureImage = { width: number; height: number; data: Uint8ClampedArray };
function fixtureImage(width: number, height: number): FixtureImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}
function setFixturePixel(image: FixtureImage, x: number, y: number, rgb: [number, number, number]): void {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const at = (y * image.width + x) * 4;
  image.data[at] = rgb[0]; image.data[at + 1] = rgb[1]; image.data[at + 2] = rgb[2]; image.data[at + 3] = 255;
}
function fixtureGoldTab(image: FixtureImage, left: number, top: number, width: number, height: number): void {
  for (let y = top; y < top + height; y += 1) for (let x = left; x < left + width; x += 1) setFixturePixel(image, x, y, [220, 170, 70]);
}
function fixtureCircle(image: FixtureImage, centerX: number, centerY: number, radius: number): void {
  for (let angle = 0; angle < Math.PI * 2; angle += 1 / radius) {
    const x = Math.round(centerX + Math.cos(angle) * radius);
    const y = Math.round(centerY + Math.sin(angle) * radius);
    setFixturePixel(image, x, y, [245, 245, 245]);
    setFixturePixel(image, x + 1, y, [245, 245, 245]);
  }
}
const fixtureViewport = { x: 0, y: 0, width: 300, height: 400 };
const normalMainVisual = fixtureImage(300, 400);
fixtureGoldTab(normalMainVisual, 12, 30, 75, 16);
equal(classifyPageVisual(normalMainVisual as unknown as ImageData, fixtureViewport).pageType, "main", "normal main selected-tab visual must route main");
const normalSupportVisual = fixtureImage(300, 400);
fixtureGoldTab(normalSupportVisual, 112, 30, 75, 16);
equal(classifyPageVisual(normalSupportVisual as unknown as ImageData, fixtureViewport).pageType, "support", "normal support selected-tab visual must route support");
const normalExperienceVisual = fixtureImage(300, 400);
fixtureGoldTab(normalExperienceVisual, 220, 30, 75, 16);
equal(classifyPageVisual(normalExperienceVisual as unknown as ImageData, fixtureViewport).pageType, "experience", "normal experience selected-tab visual must route experience");
const croppedGridVisual = fixtureImage(300, 400);
fixtureGoldTab(croppedGridVisual, 12, 30, 75, 16);
for (const centerX of [55, 150, 245]) fixtureCircle(croppedGridVisual, centerX, 48, 18);
expect(croppedGridTopCircleCount(croppedGridVisual as unknown as ImageData, fixtureViewport) >= 3, "three top card circles must trigger the cropped-grid gate");
const croppedRouting = classifyPageVisual(croppedGridVisual as unknown as ImageData, fixtureViewport);
equal(croppedRouting.pageType, "unknown", "cropped grid must not create selected-tab visual evidence");
equal(croppedRouting.evidence, [], "cropped grid must not expose selected-tab visual evidence");
equal(routeTabOcrCandidates([]).pageType, "unknown", "cropped grid without tab OCR must stay unknown");
equal(routeTabOcrCandidates([{ text: "主星", confidence: 0.96, variant: "color" }]).pageType, "main", "cropped grid with reliable tab OCR must use OCR routing");

function card(cardId: string, columnIndex: number): CardCandidate {
  const cardRect = { x: columnIndex * 40, y: 20, width: 30, height: 50 };
  return {
    cardId, rowIndex: 0, columnIndex, cardRect, discRect: cardRect,
    circle: { centerX: cardRect.x + 15, centerY: 35, radius: 15, score: 90, source: "fixture" },
    nameRect: { x: cardRect.x, y: 50, width: 30, height: 10 }, levelRect: { x: cardRect.x, y: 20, width: 15, height: 10 },
    completeness: "complete", evidence: ["fixture"],
  };
}

function star(cardId: string, columnIndex: number, level: number | null, options: { quality?: "橙" | "紫" | "蓝" | "绿" | "白" | null; equipped?: "equipped" | "unequipped" | "unknown" | "not_evaluated"; name?: string | null } = {}): MainStarResult {
  const name = options.name === undefined ? "天府" : options.name;
  return {
    instanceId: `occ-${cardId}`, cardId, rowIndex: 0, columnIndex,
    nameRaw: name ?? "", nameNormalized: name, levelRaw: level == null ? "" : String(level), level,
    nameConfidence: name ? 0.95 : 0, levelConfidence: level == null ? 0 : 0.95,
    status: name && level != null && options.quality != null ? "accepted" : "needs_review",
    reasons: [], ocrCandidates: { name: [], level: [] }, sourceRects: { card: card(cardId, columnIndex).cardRect, name: card(cardId, columnIndex).nameRect, level: card(cardId, columnIndex).levelRect },
    directName: name, effectiveName: name, nameSource: "direct_ocr", directLevel: level, effectiveLevel: level,
    levelSource: "direct_ocr", levelProvenance: [], quality: options.quality === undefined ? "橙" : options.quality,
    qualitySource: options.quality == null ? "unknown" : "visual_background", qualityConfidence: options.quality == null ? 0 : 0.9,
    qualityWarnings: options.quality == null ? ["quality_unknown"] : [], equippedState: options.equipped ?? "not_evaluated",
    equippedSource: options.equipped && options.equipped !== "not_evaluated" ? "relative_anchor_colour_entropy" : "unknown",
    equippedConfidence: options.equipped && options.equipped !== "not_evaluated" ? 0.9 : 0, equippedWarnings: [],
    inferenceProvenance: [], reviewRequired: !name || level == null || options.quality == null,
  };
}

function states(cards: CardCandidate[], state: "equipped" | "unequipped" | "unknown"): Map<string, EquippedRecognition> {
  return new Map(cards.map((item) => [item.cardId, { state, confidence: 0.9, source: "relative_anchor_colour_entropy", warnings: [] }]));
}

const fourCards = [0, 1, 2, 3].map((index) => card(`c${index}`, index));
const segmentStars = [
  star("c0", 0, 1, { equipped: "equipped" }), star("c1", 1, 1, { equipped: "equipped" }),
  star("c2", 2, 60, { equipped: "unequipped" }), star("c3", 3, 60, { equipped: "unequipped" }),
];
const segmentEvidence = new Map<string, EquippedRecognition>([
  ["c0", { state: "equipped", confidence: 0.9, source: "relative_anchor_colour_entropy", warnings: [] }],
  ["c1", { state: "equipped", confidence: 0.9, source: "relative_anchor_colour_entropy", warnings: [] }],
  ["c2", { state: "unequipped", confidence: 0.9, source: "relative_anchor_colour_entropy", warnings: [] }],
  ["c3", { state: "unequipped", confidence: 0.9, source: "relative_anchor_colour_entropy", warnings: [] }],
]);
const segmentChecked = applyHierarchicalOrder(fourCards, segmentStars, segmentEvidence);
// An explicit equipped-state boundary is not a cross-segment warning.
expect(!segmentChecked.some((item) => item.reasons.includes("hierarchical_level_order_conflict")), "equipped segment boundaries must not create cross-segment warning");

const qualityCards = [card("q0", 0), card("q1", 1)];
const qualityChecked = applyHierarchicalOrder(qualityCards, [
  star("q0", 0, 1, { quality: "橙", equipped: "equipped" }),
  star("q1", 1, 60, { quality: "紫", equipped: "equipped" }),
], states(qualityCards, "equipped"));
expect(!qualityChecked.some((item) => item.reasons.includes("hierarchical_level_order_conflict")), "quality boundaries must not create cross-quality warning");

const sandwichCards = [0, 1, 2].map((index) => card(`s${index}`, index));
const unique = applyHierarchicalOrder(sandwichCards, [star("s0", 0, 60), star("s1", 1, null, { name: null }), star("s2", 2, 60)], states(sandwichCards, "unequipped"));
expect(unique[1]!.level === 60 && unique[1]!.levelSource === "hierarchical_sort_inference", "[60, unknown, 60] must infer one level with provenance");

const pending = applyHierarchicalOrder(sandwichCards, [star("s0", 0, 60), star("s1", 1, null, { name: null }), star("s2", 2, 40)], states(sandwichCards, "unequipped"));
expect(pending[1]!.level === null && pending[1]!.levelSource === "direct_ocr", "[60, unknown, 40] must stay pending and direct unknown");

const nameStars = applyHierarchicalOrder(sandwichCards, [star("s0", 0, 40, { name: "天府" }), star("s1", 1, 40, { name: null }), star("s2", 2, 40, { name: "天府" })], states(sandwichCards, "unequipped"));
const nameInferred = applyHierarchicalNameSandwich(sandwichCards, nameStars);
expect(nameInferred[1]!.effectiveName === "天府" && nameInferred[1]!.nameSource === "hierarchical_sort_sandwich_inference", "same-segment name sandwich must infer with provenance");

const noChainCards = [0, 1, 2, 3].map((index) => card(`n${index}`, index));
const noChain = applyHierarchicalNameSandwich(noChainCards, [star("n0", 0, 40, { name: "天府" }), star("n1", 1, 40, { name: null }), star("n2", 2, 40, { name: null }), star("n3", 3, 40, { name: "天府" })]);
expect(noChain[1]!.effectiveName == null && noChain[2]!.effectiveName == null, "inferred names must not chain into later inference");

const unknownCards = [0, 1, 2].map((index) => card(`u${index}`, index));
const unknown = applyHierarchicalOrder(unknownCards, [star("u0", 0, 60, { quality: "橙", equipped: "unknown" }), star("u1", 1, null, { quality: null, equipped: "unknown", name: null }), star("u2", 2, 60, { quality: "橙", equipped: "unknown" })], states(unknownCards, "unknown"));
expect(unknown[1]!.level === null, "unknown equipped or quality must block hierarchy inference");

function atRow(cardId: string, rowIndex: number, columnIndex: number): CardCandidate {
  return { ...card(cardId, columnIndex), rowIndex };
}
function starAtRow(cardId: string, rowIndex: number, columnIndex: number, level: number | null, options: Parameters<typeof star>[3] = {}): MainStarResult {
  return { ...star(cardId, columnIndex, level, options), rowIndex };
}
const crossRowCards = [atRow("x0", 0, 3), atRow("x1", 1, 0), atRow("x2", 1, 1)];
const crossRowConflict = applyHierarchicalOrder(crossRowCards, [
  starAtRow("x0", 0, 3, 40, { equipped: "equipped" }),
  starAtRow("x1", 1, 0, 60, { equipped: "equipped" }),
  starAtRow("x2", 1, 1, 40, { equipped: "equipped" }),
], states(crossRowCards, "equipped"));
expect(crossRowConflict[1]!.reasons.includes("hierarchical_level_order_conflict"), "Python row-major sequence must treat r1c4 to r2c1 as consecutive for level order");

const crossRowSandwich = applyHierarchicalOrder(crossRowCards, [
  starAtRow("x0", 0, 3, 60, { equipped: "equipped" }),
  starAtRow("x1", 1, 0, null, { equipped: "equipped", name: null }),
  starAtRow("x2", 1, 1, 60, { equipped: "equipped" }),
], states(crossRowCards, "equipped"));
expect(crossRowSandwich[1]!.level === 60, "Python row-major level sandwich must cross r1c4 to r2c1");
const crossRowNames = applyHierarchicalNameSandwich(crossRowCards, [
  starAtRow("x0", 0, 3, 60, { equipped: "equipped", name: "天府" }),
  starAtRow("x1", 1, 0, 60, { equipped: "equipped", name: null }),
  starAtRow("x2", 1, 1, 60, { equipped: "equipped", name: "天府" }),
]);
expect(crossRowNames[1]!.effectiveName == null, "Python name sandwich keeps its explicit same-row adjacency gate");
const crossRowEquipped = inferEquippedSandwiches(crossRowCards, crossRowSandwich, new Map([
  ["x0", { state: "equipped", confidence: 0.9, source: "relative_anchor_colour_entropy", warnings: [] }],
  ["x1", { state: "unknown", confidence: 0.45, source: "relative_anchor_colour_entropy", warnings: [] }],
  ["x2", { state: "equipped", confidence: 0.9, source: "relative_anchor_colour_entropy", warnings: [] }],
]));
equal(crossRowEquipped.get("x1")?.state, "equipped", "Python equipped snapshot sandwich must slide across a row boundary without chaining");
const crossRowQualityBreak = applyHierarchicalOrder(crossRowCards, [
  starAtRow("x0", 0, 3, 60, { quality: "橙", equipped: "equipped" }),
  starAtRow("x1", 1, 0, null, { quality: "紫", equipped: "equipped", name: null }),
  starAtRow("x2", 1, 1, 60, { quality: "紫", equipped: "equipped" }),
], states(crossRowCards, "equipped"));
expect(crossRowQualityBreak[1]!.level == null, "quality change must still break cross-row level propagation");
const crossRowEquippedBreak = applyHierarchicalOrder(crossRowCards, [
  starAtRow("x0", 0, 3, 60, { equipped: "equipped" }),
  starAtRow("x1", 1, 0, null, { equipped: "unequipped", name: null }),
  starAtRow("x2", 1, 1, 60, { equipped: "unequipped" }),
], new Map([
  ["x0", { state: "equipped", confidence: 0.9, source: "relative_anchor_colour_entropy", warnings: [] }],
  ["x1", { state: "unequipped", confidence: 0.9, source: "relative_anchor_colour_entropy", warnings: [] }],
  ["x2", { state: "unequipped", confidence: 0.9, source: "relative_anchor_colour_entropy", warnings: [] }],
]));
expect(crossRowEquippedBreak[1]!.level == null, "equipped-state change must still break cross-row level propagation");

let successfulCloseCount = 0;
const successfulBitmap = { close: () => { successfulCloseCount += 1; } } as unknown as ImageBitmap;
const transferredBitmap = await transferBitmapOnSuccess(async () => successfulBitmap, async (bitmap) => bitmap);
equal(successfulCloseCount, 0, "successful bitmap work must transfer ownership without closing");
transferredBitmap.close();
equal(successfulCloseCount, 1, "transferred bitmap is closed exactly once by its success owner");
let failedCloseCount = 0;
const failedBitmap = { close: () => { failedCloseCount += 1; } } as unknown as ImageBitmap;
try {
  await transferBitmapOnSuccess(async () => failedBitmap, async () => { throw new Error("fixture failure"); });
  throw new Error("fixture failure must reject");
} catch (error) {
  equal((error as Error).message, "fixture failure", "failing bitmap work must preserve its error");
}
equal(failedCloseCount, 1, "failing bitmap work must close exactly once at its creation boundary");

console.log("structured runtime core checks passed");
