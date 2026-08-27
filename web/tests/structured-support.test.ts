import { candidateFromCircle, classifyCompleteness } from "../src/structured/card-completeness.js";
import { buildCardCandidates } from "../src/structured/main-grid.js";
import { resolveName as resolveMainName } from "../src/structured/main-postprocess.js";
import { classifyStarResultStatus, parseLevel } from "../src/structured/star-postprocess.js";
import { SUPPORT_ALIASES, SUPPORT_STAR_NAMES, resolveSupportName } from "../src/structured/support-postprocess.js";
import type { CircleProposal, ScreenshotProfile } from "../src/structured/types.js";

function expect(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function equal<T>(actual: T, expected: T, message: string): void { expect(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`); }

function profile(): ScreenshotProfile {
  return {
    profileId: "phone_portrait_v1", deviceKind: "phone", imageWidth: 200, imageHeight: 300,
    viewport: { x: 0, y: 0, width: 160, height: 300 }, contentBounds: { x: 0, y: 50, width: 160, height: 150 },
    columnCount: 4, confidence: 1, evidence: [],
  };
}

function circle(column: number, y: number, radius = 20): CircleProposal {
  return { centerX: [26, 61, 96, 130][column]!, centerY: y, radius, score: 90, source: "fixture" };
}

equal(SUPPORT_STAR_NAMES.length, 24, "support catalog must use all production entries");
for (const name of ["三台", "文昌", "文曲", "解神", "禄存", "地劫", "红鸾", "恩光"]) expect(SUPPORT_STAR_NAMES.includes(name), `support catalog should include ${name}`);
equal(SUPPORT_ALIASES, { "天鉞": "天钺", "天馬": "天马", "天貴": "天贵", "陰煞": "阴煞", "祿存": "禄存", "左輔": "左辅", "紅鸞": "红鸾", "鈴星": "铃星" }, "confirmed Traditional aliases stay in the shared OCR resource");
expect(resolveSupportName([{ text: "三台", confidence: 0.96, variant: "color" }]).normalized === "三台", "support canonical name should resolve");
for (const [traditional, canonical] of Object.entries(SUPPORT_ALIASES)) {
  expect(resolveSupportName([{ text: traditional, confidence: 0.96, variant: "color" }]).normalized === canonical, `${traditional} should normalize to Simplified canonical ${canonical}`);
}
expect(resolveSupportName([{ text: "未知", confidence: 0.99, variant: "color" }]).normalized === null, "unknown support name should require review");

// 生产真实 aliases 只能进入各自目录，不能污染辅星或主星。
expect(resolveMainName([{ text: "紫薇", confidence: 0.95, variant: "color" }]).normalized === "紫微", "main production alias should remain valid");
expect(resolveSupportName([{ text: "紫薇", confidence: 0.95, variant: "color" }]).normalized === null, "main alias must not enter support");
expect(resolveSupportName([{ text: "紫星耀", confidence: 0.95, variant: "color" }]).normalized === null, "experience alias must not enter support");
expect(resolveMainName([{ text: "三台", confidence: 0.95, variant: "color" }]).normalized === null, "support name must not enter main");

equal([parseLevel("1级"), parseLevel("60"), parseLevel("0"), parseLevel("61")], [1, 60, null, null], "support level range must stay 1-60");
expect(classifyCompleteness(circle(1, 167), profile()).completeness === "complete", "support exact bottom contact should stay complete");
expect(classifyCompleteness(circle(1, 168), profile()).completeness === "partial_bottom", "support 1px bottom overflow should be partial");
expect(classifyCompleteness(circle(1, 72), profile()).completeness === "complete", "support exact top contact should stay complete");
expect(classifyCompleteness(circle(1, 71), profile()).completeness === "partial_top", "support 1px top overflow should be partial");
expect(classifyStarResultStatus("complete", null, null) === "needs_review", "empty OCR must not alter support geometry");
expect(classifyStarResultStatus("partial_bottom", "三台", 60) === "excluded_partial", "support partial must remain excluded");

const tail = buildCardCandidates([
  ...[0, 1, 2, 3].map((column) => circle(column, 90, 15)),
  circle(0, 130, 15), circle(1, 130, 15),
], { ...profile(), contentBounds: { x: 0, y: 50, width: 160, height: 150 } });
equal(tail.filter((card) => card.rowIndex === 1).map((card) => card.columnIndex), [0, 1], "support tail row with two cards should be retained without filling");
expect(candidateFromCircle(circle(1, 168), profile(), 0, 1, 1).completeness === "partial_bottom", "support local text overflow should stay per-card");

console.log("structured support ROI checks passed");
