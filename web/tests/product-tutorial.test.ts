import { bagReviewInfo, bagTutorialSteps, recognitionTutorialExamples, recognitionTutorialSteps, clampTutorialLift, clipTutorialRect, createBagTutorialGate, markTutorialSeen, shouldAutoStartTutorial, shouldRevealTutorialTarget, tutorialCardPosition, tutorialEntryLabel, tutorialModeForTab, tutorialSeen, tutorialSheetBounds, tutorialStepIndex, tutorialStorageKey, type TutorialRect } from "../src/product-tutorial-steps.js";
function equal(actual: unknown, expected: unknown, message = "equality"): void { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`); }
function ok(value: unknown, message: string): void { if (!value) throw new Error(message); }
equal(recognitionTutorialSteps.map(step => step.id), ["upload", "classify", "confirm", "overlap", "start", "progress"]);
equal(bagTutorialSteps.map(step => step.id), ["review", "bags", "find", "edit", "plan", "experience", "history"]);
equal(bagTutorialSteps[3]!.paragraphs!.length, 2);
ok(!bagTutorialSteps[5]!.body!.includes("左边") && !bagTutorialSteps[5]!.body!.includes("右边"), "responsive neutral experience wording");
ok(bagReviewInfo.sections[0]!.body.includes("「整页」") && bagReviewInfo.sections[4]!.body.includes("「取消」") && bagReviewInfo.sections[4]!.body.includes("「确认」"), "actual review action labels");
equal(tutorialModeForTab("import"), "recognition"); equal(tutorialModeForTab("review"), "bag");
equal(tutorialEntryLabel("import"), "查看导入识别教程"); equal(tutorialEntryLabel("review"), "查看背包整理教程");
for (const count of [6, 7]) {
  equal(tutorialStepIndex(0, -1, count), 0); equal(tutorialStepIndex(count - 1, 1, count), count - 1);
  let index = 0; for (let i = 1; i < count; i++) { index = tutorialStepIndex(index, 1, count); equal(index, i); }
  for (let i = count - 2; i >= 0; i--) { index = tutorialStepIndex(index, -1, count); equal(index, i); }
}
const map = new Map<string, string>(), storage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } };
const key = tutorialStorageKey("unit-account"), bagKey = tutorialStorageKey("unit-account", "bag");
equal(tutorialStorageKey(null), "yuanstar:tutorial:recognition:v1:guest"); equal(tutorialStorageKey(""), tutorialStorageKey(undefined));
ok(tutorialStorageKey("a:b") !== tutorialStorageKey("a%3Ab"), "account escaping is isolated");
equal(tutorialSeen(key, storage), false); markTutorialSeen(key, storage); equal(map.get(key), "seen"); equal(tutorialSeen(key, storage), true);
equal(tutorialSeen(bagKey, storage), false); equal(tutorialSeen(tutorialStorageKey("other"), storage), false);
const blocked = { getItem(): never { throw Error("blocked"); }, setItem(): never { throw Error("blocked"); } };
const blockedKey = tutorialStorageKey("blocked"); equal(tutorialSeen(blockedKey, blocked), false); markTutorialSeen(blockedKey, blocked); equal(tutorialSeen(blockedKey, blocked), true);
Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw Error("getter blocked"); } });
markTutorialSeen(tutorialStorageKey("getter")); equal(tutorialSeen(tutorialStorageKey("getter")), true);
const first = { ready: true, importing: true, seen: false, hasHistory: false };
equal(shouldAutoStartTutorial(first), true);
for (const override of [{ ready: false }, { importing: false }, { seen: true }, { hasHistory: true }, { hasHistory: undefined }]) equal(shouldAutoStartTutorial({ ...first, ...override }), false);
const gate = createBagTutorialGate(), ready = { reviewing: true, ready: true, seen: false, hasEvidence: true };
equal(gate.loaded("new", false), true); equal(gate.shouldStart("new", ready), false); gate.ocrCompleted("other"); equal(gate.shouldStart("new", ready), false);
gate.ocrCompleted("new"); equal(gate.loaded("new", true), true); equal(gate.shouldStart("new", ready), true);
for (const override of [{ reviewing: false }, { ready: false }, { seen: true }, { hasEvidence: false }]) equal(gate.shouldStart("new", { ...ready, ...override }), false);
equal(gate.loaded("old", true), false); gate.ocrCompleted("old"); equal(gate.shouldStart("old", ready), false); equal(gate.shouldStart("new", ready), false);
equal(gate.loaded("unknown", undefined), false); gate.reset(); gate.ocrCompleted("new"); equal(gate.shouldStart("new", ready), false);
const view = { left: 0, top: 0, width: 390, height: 844 };
const rect: TutorialRect = { left: -20, top: 40, right: 400, bottom: 900, width: 420, height: 860 };
equal(clipTutorialRect(rect, view), { left: 0, top: 32, right: 390, bottom: 844, width: 390, height: 812 });
equal(clipTutorialRect({ ...rect, top: 900, bottom: 1100 }, view), null);
equal(shouldRevealTutorialTarget(bagTutorialSteps[0]!, rect), true); equal(shouldRevealTutorialTarget(bagTutorialSteps[0]!, null), false); equal(shouldRevealTutorialTarget(bagTutorialSteps[6]!, rect), false);
equal(clampTutorialLift(1000, 844, 300), 140); equal(clampTutorialLift(-30, 844, 300), 0); equal(clampTutorialLift(1000, 420, 330, { top: 20, bottom: 34 }), 12);
for (const width of [320, 360, 390, 430, 768, 1024, 1440]) {
  const result = tutorialCardPosition(null, { width: 340, height: 250 }, { ...view, width });
  ok(result.left >= 12 && result.left + Math.min(340, width - 24) <= width - 12, `card within width ${width}`);
}
const target = { left: 600, right: 700, top: 90, bottom: 134, width: 100, height: 44 }, related = { ...target, left: 950, right: 1050 };
equal(tutorialCardPosition(target, { width: 340, height: 200 }, { ...view, width: 1440, height: 900 }, [target, related]).top, 150);
const bounds = tutorialSheetBounds({ ...view, top: 48, height: 420 }, 900, { top: 20, bottom: 34 }, { ...target, top: 414 });
equal(900 - bounds.bottom, 402); equal(900 - bounds.bottom - bounds.maxHeight, 80);
equal(recognitionTutorialExamples.screenshots.length, 3); equal(recognitionTutorialExamples.overlap.length, 1);
console.log("PASS tutorial configuration, navigation, conservative gate, persistence isolation/failures and geometry");
