import { createStarCatalog } from "../src/business/catalog.js";
import { createEmptyWorkspace } from "../src/business/model.js";
import { WorkspaceSession } from "../src/business/session.js";

function expect(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

const catalog = createStarCatalog([{ name: "太阳", kind: "主星", aliases: [], displayGroup: null, usageTags: [], rawEffectText: null, description: null }], {});
const workspace = createEmptyWorkspace("product-workspace-test", "代号鸢");
const session = new WorkspaceSession(workspace, catalog, () => "star-a");
const id = session.addInstance({ kind: "主星", name: "太阳", level: 40, quality: "橙", equippedState: "not_evaluated", provenance: { sourceOrder: 0, audit: { test: true } }, manualStatus: "manual" });
session.setPlanTarget(id, 60);
session.setBagValues(4, 10);
session.setExperienceQuantity("purple", 9);
let saved = session.state;
expect(saved.inventory[0]?.starInstanceId === "star-a", "review view identity must use starInstanceId");
expect(saved.planTargets[id] === 60 && saved.bag.currentCount === 4 && saved.experience.purple === 9, "visible product values must survive a session snapshot");

const reloaded = new WorkspaceSession(saved, catalog, () => "unused");
reloaded.updateInstance(id, { level: 41 });
saved = reloaded.state;
expect(saved.inventory[0]?.level === 41 && saved.planTargets[id] === 60, "edit must preserve the stable plan target");
reloaded.deleteInstance(id);
expect(reloaded.state.inventory.length === 0 && !reloaded.state.planTargets[id], "delete must remove the paired plan target");

const history = new WorkspaceSession(workspace, catalog, (() => { let count = 0; return () => `history-${++count}`; })());
const historyId = history.addInstance({ kind: "主星", name: "太阳", level: 20, quality: "橙", equippedState: "not_evaluated", provenance: { sourceOrder: 0 }, manualStatus: "manual" });
history.setPlanTarget(historyId, 40);
expect(history.undo() && history.state.planTargets[historyId] == null, "one operation must undo");
expect(history.undo() && history.state.inventory.length === 0 && history.redo() && history.state.inventory.length > 0 && history.redo(), "two undo/redo steps must round trip");
history.undo(); history.setBagValues(2, 5);
expect(!history.history.canRedo, "a new mutation must clear redo");
history.setPlanTarget(historyId, 40); history.resetAllPlanTargets();
expect(history.undo() && history.state.planTargets[historyId] === 40 && history.undo() && history.state.planTargets[historyId] == null, "reset plans must be one history step");
history.setExperienceQuantities({ orange: 1, purple: 2, white: 3 });
expect(history.undo() && history.state.experience.orange == null && history.state.experience.purple == null && history.state.experience.white == null, "one experience editor save must be one history step");

const reviewWorkspace = createEmptyWorkspace("product-review-workspace", "代号鸢");
reviewWorkspace.importReview.occurrences.missing = {
  occurrenceId: "missing", sourceImageId: "image-1", sourceOrder: 1, row: 0, column: 0, completeness: "complete", kind: null, name: null, level: null, quality: null,
  nameConfidence: 0, levelConfidence: 0, qualityConfidence: 0, reviewRequired: true, inventoryAction: "exclude_false_box", removedFromCurrentInventory: false, manualOverride: false, equippedState: "unknown",
};
const reviewSession = new WorkspaceSession(reviewWorkspace, catalog, (() => { let count = 0; return () => `review-${++count}`; })());
reviewSession.editOccurrence("missing", { name: "太阳", level: 1, quality: "紫" });
expect(reviewSession.state.inventory.length === 1 && reviewSession.state.inventory[0]!.name === "太阳", "post-save review edit immediately restores a complete occurrence into formal inventory");
const editUndone = reviewSession.undo(); const editUndoCount = Number(reviewSession.state.inventory.length); const editRedone = reviewSession.redo(); const editRedoCount = Number(reviewSession.state.inventory.length);
expect(editUndone && editUndoCount === 0 && editRedone && editRedoCount === 1, "post-save review edit participates in undo and redo");
reviewSession.setOccurrenceInventoryAction("missing", "exclude_false_box");
const ignoredCount = Number(reviewSession.state.inventory.length); const ignoreUndone = reviewSession.undo(); const restoredCount = Number(reviewSession.state.inventory.length);
expect(ignoredCount === 0 && ignoreUndone && restoredCount === 1, "post-save review ignore immediately mutates inventory and undo restores it");

const duplicateWorkspace = createEmptyWorkspace("product-duplicate-workspace", "代号鸢");
duplicateWorkspace.importReview.imagePools = { left: "main", right: "main" };
duplicateWorkspace.importReview.confirmedImagePools = ["left", "right"];
duplicateWorkspace.importReview.overlapPairs.main = [["left", "right"]];
for (const [sourceImageId, sourceOrder, row] of [["left", 1, 0], ["right", 2, 0]] as const) for (let column = 0; column < 4; column += 1) {
  const occurrenceId = `${sourceImageId}-${column}`;
  duplicateWorkspace.importReview.occurrences[occurrenceId] = {
    occurrenceId, sourceImageId, sourceOrder, row, column, completeness: "complete", kind: "主星", name: "太阳", level: 1, quality: "橙",
    nameConfidence: 1, levelConfidence: 1, qualityConfidence: 1, reviewRequired: false, inventoryAction: "keep", removedFromCurrentInventory: false, manualOverride: false, equippedState: "unknown",
  };
}
const duplicateSession = new WorkspaceSession(duplicateWorkspace, catalog, (() => { let count = 0; return () => `duplicate-${++count}`; })());
duplicateSession.setOccurrenceInventoryAction("left-0", "keep");
expect(duplicateSession.state.inventory.length === 4, "deterministic duplicate starts as a four-card merged inventory row");
duplicateSession.setRowOverlapResolution("main:left:0->right:0", "keep_separate");
const separateCount = Number(duplicateSession.state.inventory.length); const duplicateUndone = duplicateSession.undo(); const mergedCount = Number(duplicateSession.state.inventory.length); const duplicateRedone = duplicateSession.redo(); const redoneSeparateCount = Number(duplicateSession.state.inventory.length); const restoreMergedForInvalidation = duplicateSession.undo();
expect(separateCount === 8 && duplicateUndone && mergedCount === 4 && duplicateRedone && redoneSeparateCount === 8 && restoreMergedForInvalidation && Number(duplicateSession.state.inventory.length) === 4, "duplicate keep-separate restores the whole row atomically and preserves 4 to 8 undo and redo semantics");
const invalidatedDuplicate = duplicateSession.editOccurrence("right-0", { level: 2 });
const invalidatedState = duplicateSession.state;
expect(invalidatedDuplicate && invalidatedState.inventory.length === 8 && invalidatedState.importReview.overlapAudit.some((item: any) => item.type === "row_overlap" && item.status === "invalidated"), "editing a confirmed duplicate invalidates the entire relation instead of retaining a partial merge");
expect(duplicateSession.undo() && duplicateSession.state.inventory.length === 4 && duplicateSession.state.importReview.overlapAudit.some((item: any) => item.type === "row_overlap" && item.status === "duplicate"), "undo restores duplicate relation and inventory together");
const ignoredDuplicate = duplicateSession.resolveOccurrenceReview("right-1", "ignored");
expect(ignoredDuplicate && Number(duplicateSession.state.inventory.length) === 7 && duplicateSession.state.importReview.overlapAudit.some((item: any) => item.type === "row_overlap" && item.status === "invalidated"), "ignoring a confirmed duplicate invalidates the whole relation and updates inventory in one undoable mutation");
expect(duplicateSession.undo() && Number(duplicateSession.state.inventory.length) === 4 && duplicateSession.redo() && Number(duplicateSession.state.inventory.length) === 7, "duplicate ignore preserves relation invalidation through undo and redo");


console.log("product workspace checks passed");
