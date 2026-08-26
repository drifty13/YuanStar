import { candidateFromCircle, classifyCompleteness, isInside } from "../src/structured/card-completeness.js";
import { buildCardCandidates } from "../src/structured/main-grid.js";
import { classifyResultStatus, cleanName, parseLevel, resolveLevel, resolveName } from "../src/structured/main-postprocess.js";
import { createScreenshotProfile, layoutSpec } from "../src/structured/profiles.js";
import type { CircleProposal, OcrCandidate, ScreenshotProfile } from "../src/structured/types.js";

function expect(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function equal<T>(actual: T, expected: T, message: string): void { expect(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`); }

function profile(): ScreenshotProfile {
  return {
    profileId: "phone_portrait_v1", deviceKind: "phone", imageWidth: 200, imageHeight: 300,
    viewport: { x: 0, y: 0, width: 160, height: 300 }, contentBounds: { x: 0, y: 0, width: 160, height: 240 },
    columnCount: 4, confidence: 1, evidence: [],
  };
}

function circle(column: number, y: number, radius = 15): CircleProposal {
  const xs = [26, 61, 96, 130];
  return { centerX: xs[column]!, centerY: y, radius, score: 90, source: "fixture" };
}

// 内容区坐标缩放与黑边检测。
const pixels = new Uint8ClampedArray(140 * 200 * 4);
for (let y = 0; y < 200; y += 1) for (let x = 0; x < 140; x += 1) {
  const at = (y * 140 + x) * 4;
  const value = x < 15 || x >= 125 ? 0 : 40;
  pixels[at] = value; pixels[at + 1] = value; pixels[at + 2] = value; pixels[at + 3] = 255;
}
const scaled = createScreenshotProfile({ data: pixels, width: 140, height: 200, colorSpace: "srgb" } as ImageData);
equal(scaled.viewport, { x: 15, y: 0, width: 110, height: 200 }, "viewport should remove continuous black bars");
equal(scaled.contentBounds, { x: 15, y: 36, width: 110, height: 142 }, "content bounds should scale from the selected profile");

function screenshotForProfile(width: number, height: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(40);
  return { data, width, height, colorSpace: "srgb" } as ImageData;
}
const phone916UpperEdge = createScreenshotProfile(screenshotForProfile(569, 1000));
expect(phone916UpperEdge.profileId === "phone_9_16_v1", "ratio 0.569 should remain in the 9:16 phone geometry family");
const tabletLowerEdge = createScreenshotProfile(screenshotForProfile(570, 1000));
expect(tabletLowerEdge.profileId === "tablet_portrait_v1", "ratio 0.570 should enter the tablet geometry family");
// 900×1600 is the strict 9:16 MuMu-native phone viewport.
const phone916 = createScreenshotProfile(screenshotForProfile(900, 1600));
expect(phone916.profileId === "phone_9_16_v1" && phone916.deviceKind === "phone", "strict 9:16 phone viewport should use its own geometry family");
expect(layoutSpec(phone916.profileId).radiusRatio === .079 && layoutSpec(phone916.profileId).horizontalSearchRatio === 0, "9:16 phone geometry should use observed radius and fixed columns");
// Matches the accepted tablet viewport ratio 1747 / 2816 ≈ 0.6204.
const unchangedTablet = createScreenshotProfile(screenshotForProfile(620, 1000));
expect(unchangedTablet.profileId === "tablet_portrait_v1" && layoutSpec(unchangedTablet.profileId).radiusRatio === .068, "existing tablet geometry must remain unchanged");
const unchangedPhone = createScreenshotProfile(screenshotForProfile(440, 1000));
expect(unchangedPhone.profileId === "phone_portrait_v1" && layoutSpec(unchangedPhone.profileId).radiusRatio === .088, "existing phone geometry must remain unchanged");

// 四列与末行 1/2/3 张完整卡。
for (const tailCount of [1, 2, 3]) {
  const proposals = [0, 1, 2, 3].flatMap((column) => [circle(column, 60), circle(column, 100)]);
  for (let column = 0; column < tailCount; column += 1) proposals.push(circle(column, 140));
  const cards = buildCardCandidates(proposals, profile());
  equal(cards.filter((card) => card.rowIndex === 2).map((card) => card.columnIndex), Array.from({ length: tailCount }, (_, index) => index), `tail ${tailCount} should be retained`);
}

const bounded: ScreenshotProfile = { ...profile(), contentBounds: { x: 0, y: 50, width: 160, height: 150 } };
// 名称框越底部边界、等级框越顶部边界、等于边界保留、越界 1px 排除。
expect(classifyCompleteness(circle(1, 167, 20), bounded).completeness === "complete", "name ROI exactly on bottom boundary should stay complete");
expect(classifyCompleteness(circle(1, 168, 20), bounded).completeness === "partial_bottom", "name ROI 1px past bottom should be partial");
expect(classifyCompleteness(circle(1, 72, 20), bounded).completeness === "complete", "level ROI exactly on top boundary should stay complete");
expect(classifyCompleteness(circle(1, 71, 20), bounded).completeness === "partial_top", "level ROI 1px above top should be partial");
expect(isInside({ x: 0, y: 50, width: 20, height: 150 }, bounded.contentBounds), "rect equal to bounds should be inside");
expect(!isInside({ x: 0, y: 49, width: 20, height: 150 }, bounded.contentBounds), "rect 1px outside should be excluded");

const nameCut = candidateFromCircle(circle(1, 168, 20), bounded, 0, 1, 1);
expect(nameCut.circle.centerY + nameCut.circle.radius <= 200 && nameCut.completeness === "partial_bottom", "complete disc with cut name ROI must be a bottom fragment");

// 几何完整但 OCR 为空仍是待审查。
expect(classifyResultStatus("complete", null, null) === "needs_review", "empty OCR must not alter geometric completeness");
expect(classifyResultStatus("partial_bottom", "天府", 60) === "excluded_partial", "partial geometry must remain excluded");

// 主星别名、图案文本过滤与等级 1-60。
expect(cleanName(" 天 府 级 ") === "天府", "name cleaning should match Python");
const alias = resolveName([{ text: "紫薇", confidence: 0.95, variant: "color" }]);
expect(alias.normalized === "紫微", "confirmed alias should normalize");
expect(resolveName([{ text: "◆", confidence: 0.99, variant: "color" }]).normalized === null, "pattern text should be rejected");
equal([parseLevel("1级"), parseLevel("60"), parseLevel("0级"), parseLevel("61级"), parseLevel("-1级")], [1, 60, null, null, null], "level range parsing");
const levelCandidates: OcrCandidate[] = [{ text: "60级", confidence: 0.96, variant: "color" }, { text: "50", confidence: 0.2, variant: "contrast" }];
expect(resolveLevel(levelCandidates).level === 60, "high-confidence complete level should win weighted consensus");

console.log("structured main ROI checks passed");
