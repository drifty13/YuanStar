import { createStarCatalog } from "../src/business/catalog.js";
import { createEmptyWorkspace, WorkspaceDomainError } from "../src/business/model.js";
import { recalculateWorkspacePostprocess } from "../src/business/postprocess.js";
import { WorkspaceSession } from "../src/business/session.js";

function expect(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function expectError(action: () => unknown, message: string): void { try { action(); } catch (error) { expect(error instanceof WorkspaceDomainError, message); return; } throw new Error(message); }

const catalog = createStarCatalog([
  { name: "天府", kind: "主星", aliases: [], displayGroup: null, usageTags: [], rawEffectText: null },
  { name: "文曲", kind: "辅星", aliases: [], displayGroup: null, usageTags: [], rawEffectText: null },
], {});
const workspace = createEmptyWorkspace("ocr-kind-atomic");
workspace.importReview.occurrences = {
  occurrence: { occurrenceId: "occurrence", sourceImageId: "image", sourceOrder: 0, row: 0, column: 0, completeness: "complete", kind: "主星", name: "天府", level: 40, quality: "橙", nameConfidence: .9, levelConfidence: .9, qualityConfidence: .9, reviewRequired: false, inventoryAction: "keep", removedFromCurrentInventory: false, manualOverride: false, equippedState: "unknown" },
};
let ids = 0;
const initial = recalculateWorkspacePostprocess(workspace, catalog, () => `initial-${++ids}`);
const originalId = initial.inventory[0]!.starInstanceId;
const session = new WorkspaceSession(initial, catalog, () => `fresh-${++ids}`);
session.setPlanTarget(originalId, 60);
session.updateInstance(originalId, { kind: "辅星", name: "文曲" });

const occurrence = session.state.importReview.occurrences.occurrence!;
const rebuilt = session.state.inventory[0]!;
expect(occurrence.kind === "辅星" && occurrence.name === "文曲" && occurrence.manualOverride, "the canonical OCR occurrence must receive the atomic kind and name edit");
expect(rebuilt.starInstanceId === originalId && rebuilt.kind === "辅星" && rebuilt.name === "文曲" && rebuilt.provenance.occurrenceId === "occurrence" && rebuilt.manualStatus === "user_resolved" && session.state.planTargets[originalId] === 60, "postprocess must retain OCR provenance, stable identity, and plan target");

const beforeRejected = JSON.stringify(session.state);
expectError(() => session.updateInstance(originalId, { kind: "主星" }), "kind-only OCR edits must be rejected");
expectError(() => session.updateInstance(originalId, { kind: "主星", name: "文曲" }), "mismatched OCR kind and name must be rejected");
expect(JSON.stringify(session.state) === beforeRejected, "rejected OCR kind edits must not mutate canonical state");

console.log("OCR kind atomic business and postprocess checks passed");
