import { buildCurrentInstanceUpdate } from "../src/product-current-instance-update.js";

function expect(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

const current = { kind: "主星" as const, name: "太阳", level: 40, quality: "橙" as const };

const ocrLevelOnly = buildCurrentInstanceUpdate(current, { ...current, level: 41 }, true);
expect(JSON.stringify(ocrLevelOnly) === JSON.stringify({ level: 41 }), "OCR-backed level edits must submit only level");

const ocrNameQuality = buildCurrentInstanceUpdate(current, { ...current, name: "武曲", quality: "紫" }, true);
expect(JSON.stringify(ocrNameQuality) === JSON.stringify({ name: "武曲", quality: "紫" }), "OCR-backed name and quality edits must not submit kind");

const ocrCrossKind = buildCurrentInstanceUpdate(current, { ...current, kind: "辅星", name: "文曲" }, true);
expect(JSON.stringify(ocrCrossKind) === JSON.stringify({ name: "文曲", kind: "辅星" }), "OCR-backed cross-kind edits must submit kind and name together");

const ocrUnselectedName = buildCurrentInstanceUpdate(current, { ...current, kind: "辅星", name: "" }, true);
expect(ocrUnselectedName === null, "OCR-backed cross-kind edits without a selected name must not form an update");

const manualCrossKind = buildCurrentInstanceUpdate(current, { ...current, kind: "辅星", name: "文曲" }, false);
expect(JSON.stringify(manualCrossKind) === JSON.stringify({ name: "文曲", kind: "辅星" }), "manual instances must retain atomic kind and name updates");

const manualUnselectedName = buildCurrentInstanceUpdate(current, { ...current, kind: "辅星", name: "" }, false);
expect(manualUnselectedName === null, "manual cross-kind edits without a selected name must not form an update");

console.log("product current instance update checks passed");
