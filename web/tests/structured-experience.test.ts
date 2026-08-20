import { buildExperienceCandidates, classifyExperienceCompleteness, experienceCountRect } from "../src/structured/experience-geometry.js";
import { aggregateExperience, EXPERIENCE_CANONICAL, parseExperienceCount, resolveExperienceCount } from "../src/structured/experience-postprocess.js";
import { MAIN_STAR_NAMES } from "../src/structured/main-postprocess.js";
import { SUPPORT_STAR_NAMES } from "../src/structured/support-postprocess.js";
import type { CircleProposal, ExperienceKind, ExperienceResult, Rect } from "../src/structured/types.js";

function expect(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function equal<T>(actual: T, expected: T, message = "values should match"): void { expect(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`); }

equal(EXPERIENCE_CANONICAL, { orange: "橙星曜", purple: "紫星曜", white: "白星曜" });
for (const [text, expected] of [["0", 0], ["1", 1], ["295", 295], ["999999", 999999]] as const) {
  equal(parseExperienceCount(text), expected);
}
for (const text of ["", "  ", "12颗", "1,000", "1000000", "?", "１２"]) equal(parseExperienceCount(text), null);
equal(resolveExperienceCount([{ text: "?", confidence: 0.91, variant: "color" }]), {
  raw: "?", count: null, confidence: 0, reasons: ["experience_count_unparsed"],
});
equal(resolveExperienceCount([
  { text: "13", confidence: 0.82, variant: "color" },
  { text: "18", confidence: 0.71, variant: "contrast" },
]).count, 13);

const bounds: Rect = { x: 10, y: 20, width: 200, height: 120 };
equal(classifyExperienceCompleteness({ x: 10, y: 20, width: 200, height: 120 }, bounds), "complete");
equal(classifyExperienceCompleteness({ x: 9, y: 20, width: 200, height: 120 }, bounds), "invalid");
equal(classifyExperienceCompleteness({ x: 10, y: 19, width: 200, height: 120 }, bounds), "partial_top");
equal(classifyExperienceCompleteness({ x: 10, y: 20, width: 200, height: 121 }, bounds), "partial_bottom");
equal(experienceCountRect({ x: 100, y: 200, width: 100, height: 100 }), { x: 140, y: 278, width: 60, height: 24 });

const fixtureCircle = (centerX: number): CircleProposal => ({ centerX, centerY: 80, radius: 20, score: 42, source: "fixture" });
equal(buildExperienceCandidates([fixtureCircle(40)], { x: 0, y: 0, width: 200, height: 120 }).length, 1);
equal(buildExperienceCandidates([fixtureCircle(40), fixtureCircle(90)], { x: 0, y: 0, width: 200, height: 120 }).length, 2);
equal(buildExperienceCandidates([fixtureCircle(40), fixtureCircle(90), fixtureCircle(140)], { x: 0, y: 0, width: 200, height: 120 }).length, 3);

function result(kind: ExperienceKind, count: number | null, index: number): ExperienceResult {
  return {
    instanceId: `fixture-${index}`,
    index,
    canonicalName: EXPERIENCE_CANONICAL[kind],
    kind,
    kindConfidence: 0.9,
    countRaw: count == null ? "?" : String(count),
    count,
    countConfidence: count == null ? 0 : 0.9,
    status: count == null ? "needs_review" : "accepted",
    reasons: count == null ? ["experience_count_unparsed"] : [],
    ocrCandidates: [],
    sourceRects: { icon: { x: index * 50, y: 0, width: 40, height: 40 }, count: { x: index * 50 + 16, y: 31, width: 24, height: 10 } },
  };
}

const safeMissing = aggregateExperience([result("purple", 2, 0), result("white", 13, 1)], { selectedTab: true, viewportCropped: false });
equal(safeMissing, { orangeCount: 0, purpleCount: 2, whiteCount: 13, complete: true, warnings: [] });
const unknownQuantity = aggregateExperience([result("purple", null, 0)], { selectedTab: true, viewportCropped: false });
equal(unknownQuantity.purpleCount, null);
equal(unknownQuantity.orangeCount, null);
equal(unknownQuantity.complete, false);
expect(unknownQuantity.warnings.includes("experience_count_unparsed:purple"), "unparsed count should warn");
const unverified = aggregateExperience([result("orange", 0, 0)], { selectedTab: false, viewportCropped: false });
equal(unverified.whiteCount, null);
expect(unverified.warnings.includes("experience_tab_selection_unverified"), "unverified tab should warn");

for (const canonical of Object.values(EXPERIENCE_CANONICAL)) {
  expect(!MAIN_STAR_NAMES.includes(canonical as never), "experience canonical must not enter main catalog");
  expect(!SUPPORT_STAR_NAMES.includes(canonical), "experience canonical must not enter support catalog");
}
equal(MAIN_STAR_NAMES.some((name) => SUPPORT_STAR_NAMES.includes(name)), false);

console.log("structured experience ROI checks passed");
