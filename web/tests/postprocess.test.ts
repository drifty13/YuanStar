import { createStarCatalog } from "../src/business/catalog.js";
import { createEmptyWorkspace, type EditableOccurrenceStateV1, WorkspaceDomainError } from "../src/business/model.js";
import { recalculateWorkspacePostprocess } from "../src/business/postprocess.js";
import { WorkspaceSession } from "../src/business/session.js";

function expect(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function expectError(action: () => unknown, code: string): void { try { action(); } catch (error) { expect(error instanceof WorkspaceDomainError && error.code === code, `expected ${code}`); return; } throw new Error(`expected ${code}`); }

const names = ["天府", "武曲", "紫微", "天相"];
const catalog = createStarCatalog([...names.map((name) => ({ name, kind: "主星" as const, aliases: [], displayGroup: null, usageTags: [], rawEffectText: null })), { name: "解神", kind: "辅星" as const, aliases: [], displayGroup: null, usageTags: [], rawEffectText: null }], { "天府别名": "天府" });

function occurrence(image: "a" | "b", column: number, overrides: Partial<EditableOccurrenceStateV1> = {}): EditableOccurrenceStateV1 {
  return { occurrenceId: `${image}-${column}`, sourceImageId: image, sourceOrder: image === "a" ? 1 : 2, row: 0, column, completeness: "complete", kind: "主星", name: names[column]!, level: 20 + column, quality: "橙", nameConfidence: .9, levelConfidence: .9, qualityConfidence: .9, reviewRequired: false, inventoryAction: "keep", removedFromCurrentInventory: false, manualOverride: false, equippedState: "unknown", ...overrides };
}
function base(pending = false) {
  const workspace = createEmptyWorkspace("phase2b-postprocess-smoke");
  workspace.importReview = {
    imagePools: { a: "main", b: "main" }, confirmedImagePools: ["a", "b"], overlapPairs: { main: [["a", "b"]], support: [] }, overlapAudit: [], imageAudit: { a: { suggestedPageType: "main", confirmedPool: "main" }, b: { suggestedPageType: "main", confirmedPool: "main" } },
    occurrences: Object.fromEntries([0, 1, 2, 3].flatMap((column) => [occurrence("a", column), occurrence("b", column, pending && column === 2 ? { name: null } : {})]).map((item) => [item.occurrenceId, item])),
  };
  let ids = 0;
  return recalculateWorkspacePostprocess(workspace, catalog, () => `initial-${++ids}`);
}
function session(workspace = base()) { let ids = 0; return new WorkspaceSession(workspace, catalog, () => `fresh-${++ids}`); }
function rowAudit(current: WorkspaceSession) { return current.state.importReview.overlapAudit.find((item: any) => item.type === "row_overlap") as any; }
function physical(current: WorkspaceSession) { return current.state.inventory.length; }
function multi(beforeLabels: number[], afterLabels: number[], pending = new Set<string>()) {
  const workspace = createEmptyWorkspace("phase2b-multi-row");
  const make = (image: "a" | "b", labels: number[], sourceOrder: number) => labels.flatMap((label, row) => [0, 1, 2, 3].map((column) => {
    const key = `${image}:${row}:${column}`;
    return { occurrenceId: `${image}-${row}-${column}`, sourceImageId: image, sourceOrder, row, column, completeness: "complete" as const, kind: "主星" as const, name: pending.has(key) ? null : names[column]!, level: 10 + label * 4 + column, quality: "橙" as const, nameConfidence: .9, levelConfidence: .9, qualityConfidence: .9, reviewRequired: false, inventoryAction: "keep" as const, removedFromCurrentInventory: false, manualOverride: false, equippedState: "unknown" as const };
  }));
  const all = [...make("a", beforeLabels, 1), ...make("b", afterLabels, 2)];
  workspace.importReview = { imagePools: { a: "main", b: "main" }, confirmedImagePools: ["a", "b"], overlapPairs: { main: [["a", "b"]], support: [] }, overlapAudit: [], imageAudit: {}, occurrences: Object.fromEntries(all.map((item) => [item.occurrenceId, item])) };
  let ids = 0; return recalculateWorkspacePostprocess(workspace, catalog, () => `multi-${++ids}`);
}
function rowAudits(current: WorkspaceSession) { return current.state.importReview.overlapAudit.filter((item: any) => item.type === "row_overlap") as any[]; }

const initial = base();
expect(initial.inventory.length === 4, "exact confirmed pair must build four physical stars");
expect(initial.importReview.overlapAudit.filter((item: any) => item.status === "duplicate").length === 1, "exact row is a single row-atomic duplicate audit");
const stableId = initial.inventory.find((item) => item.provenance.occurrenceId === "a-2")!.starInstanceId;

const edits = session(initial);
edits.setPlanTarget(stableId, 60);
edits.editOccurrence("b-2", { name: "天相" });
expect(physical(edits) === 8, "one name conflict must split the whole four-card row, never half a row");
expect(edits.state.inventory.some((item) => item.starInstanceId === stableId), "split side containing prior primary occurrence keeps its ID");
expect(edits.state.planTargets[stableId] === 60, "surviving ID preserves plan target through split");
const splitId = edits.state.inventory.find((item) => item.provenance.occurrenceId === "b-2")!.starInstanceId;
expect(!(splitId in edits.state.planTargets), "new split physical star has no copied explicit target");
edits.editOccurrence("b-2", { name: "紫微" });
expect(physical(edits) === 8 && edits.state.inventory.some((item) => item.starInstanceId === stableId), "restored exact values do not silently recreate an invalidated duplicate relation");
expect(rowAudit(edits)?.status === "invalidated", "ordinary edits must not restore an invalidated duplicate audit");
expect(edits.undo() && edits.undo(), "undo must restore the pre-split workspace through existing history");
expect(physical(edits) === 4 && edits.state.inventory.some((item) => item.starInstanceId === stableId) && edits.state.planTargets[stableId] === 60, "undo restores the original overlap, stable ID and plan target");

const pending = session(multi([1, 2], [1, 2], new Set(["b:1:2"])));
expect(rowAudits(pending).map((item) => item.status).join(",") === "duplicate,pending", "exact anchor plus unknown chooses one two-row alignment with a row-level pending review");
const pendingReview = rowAudits(pending).find((item) => item.status === "pending")!;
pending.editOccurrence("b-1-2", { name: "紫微" });
expect(rowAudits(pending).every((item) => item.status === "duplicate"), "pending to exact automatically becomes duplicate");
const keep = session(multi([1, 2], [1, 2], new Set(["b:1:2"])));
const keepReview = rowAudits(keep).find((item) => item.status === "pending")!;
keep.setRowOverlapResolution(keepReview.rowReviewId, "keep_separate");
keep.editOccurrence("b-1-2", { name: "紫微" });
expect(rowAudits(keep).some((item) => item.status === "keep_separate"), "keep_separate remains explicit after its row becomes exact");
const keepRetention = session(multi([1, 2], [1, 2], new Set(["b:1:2"])));
const retainedReview = rowAudits(keepRetention).find((item) => item.status === "pending")!;
keepRetention.setRowOverlapResolution(retainedReview.rowReviewId, "keep_separate");
keepRetention.editOccurrence("b-1-2", { name: "武曲" });
expect(keepRetention.state.importReview.overlapAudit.some((item: any) => item.rowReviewId === retainedReview.rowReviewId && item.resolution === "keep_separate"), "keep_separate decision survives a temporary name conflict even when the row is not active");
keepRetention.editOccurrence("b-1-2", { name: "紫微" });
expect(rowAudits(keepRetention).some((item) => item.rowReviewId === retainedReview.rowReviewId && item.status === "keep_separate") && physical(keepRetention) === 12, "restored exact row still honors retained keep_separate instead of automatically merging");
keepRetention.removeOverlapPair("main", "a", "b");
expect(!keepRetention.state.importReview.overlapAudit.some((item: any) => item.rowReviewId === retainedReview.rowReviewId), "removing the pair clears its scoped keep_separate tombstone");
const merge = session(multi([1, 2], [1, 2], new Set(["b:1:2"])));
merge.setRowOverlapResolution(rowAudits(merge).find((item) => item.status === "pending")!.rowReviewId, "merge");
merge.editOccurrence("b-1-2", { name: "天相" });
expect(rowAudits(merge).length === 0, "old manual merge cannot survive a later definite conflict that invalidates the alignment");

const excluded = session(initial);
excluded.setOccurrenceInventoryAction("b-1", "exclude_false_box");
expect(excluded.state.inventory.length === 7 && rowAudit(excluded) === undefined, "excluded occurrence leaves inventory and stops its row from automatic overlap");
excluded.setOccurrenceInventoryAction("b-1", "keep");
expect(physical(excluded) === 4, "restored occurrence re-enters automatic postprocess");
const excludedEdited = session(initial);
excludedEdited.setOccurrenceInventoryAction("b-1", "exclude_false_box");
const excludedEditedSnapshot = excludedEdited.state;
excludedEditedSnapshot.importReview.occurrences["b-1"]!.removedFromCurrentInventory = true;
const excludedEditedWithCurrentDelete = session(excludedEditedSnapshot);
excludedEditedWithCurrentDelete.editOccurrence("b-1", { quality: "紫" });
expect(excludedEditedWithCurrentDelete.state.importReview.occurrences["b-1"]!.inventoryAction === "keep" && excludedEditedWithCurrentDelete.state.importReview.occurrences["b-1"]!.removedFromCurrentInventory && physical(excludedEditedWithCurrentDelete) === 4, "legal edit restores false-box exclusion to keep without clearing current-inventory deletion state");
const crossKind = session(initial);
const crossKindId = crossKind.state.inventory.find((item) => item.provenance.occurrenceId === "a-0")!.starInstanceId;
crossKind.setPlanTarget(crossKindId, 60);
crossKind.updateInstance(crossKindId, { kind: "辅星", name: "解神" });
const crossKindOccurrence = crossKind.state.importReview.occurrences["a-0"]!;
const crossKindInstance = crossKind.state.inventory.find((item) => item.provenance.occurrenceId === "a-0")!;
expect(crossKindOccurrence.kind === "辅星" && crossKindOccurrence.name === "解神" && crossKindOccurrence.manualOverride, "OCR occurrence cross-kind edits must update canonical kind and name together");
expect(crossKindInstance.kind === "辅星" && crossKindInstance.name === "解神" && crossKindInstance.provenance.occurrenceId === "a-0" && crossKindInstance.manualStatus === "user_resolved", "cross-kind OCR edits must rebuild inventory through provenance-backed postprocess");
expect(crossKindInstance.starInstanceId === crossKindId && crossKind.state.planTargets[crossKindId] === 60, "cross-kind postprocess keeps the primary stable ID and its plan target when available");
const beforeIncompleteCrossKind = JSON.stringify(crossKind.state);
expectError(() => crossKind.updateInstance(crossKindId, { kind: "主星" }), "workspace_validation_error");
expectError(() => crossKind.updateInstance(crossKindId, { kind: "主星", name: "解神" }), "workspace_validation_error");
expect(JSON.stringify(crossKind.state) === beforeIncompleteCrossKind, "incomplete or mismatched OCR kind changes must leave canonical state untouched");
const unknownKindSnapshot = base();
unknownKindSnapshot.importReview.occurrences["a-0"] = { ...unknownKindSnapshot.importReview.occurrences["a-0"]!, kind: null, name: null, reviewRequired: true };
const unknownKind = session(unknownKindSnapshot);
unknownKind.editOccurrence("a-0", { name: "天府" });
const backfilledOccurrence = unknownKind.state.importReview.occurrences["a-0"]!;
expect(backfilledOccurrence.name === "天府" && backfilledOccurrence.kind === "主星" && backfilledOccurrence.manualOverride && backfilledOccurrence.inventoryAction === "keep" && physical(unknownKind) === 8 && rowAudit(unknownKind)?.status === "invalidated", "manual canonical rename backfills a missing kind without silently restoring an invalidated duplicate");

const pair = session(initial);
pair.removeOverlapPair("main", "a", "b");
expect(pair.state.inventory.length === 8, "removing a pair automatically separates the row");
pair.addOverlapPair("main", "a", "b");
expect(physical(pair) === 4, "adding a valid pair automatically restores the row");
pair.setImagePool("b", "support");
expect(pair.state.inventory.length === 8 && pair.state.importReview.overlapPairs.main.length === 0, "changing confirmed pool clears only involved pairs and separates components");
expectError(() => pair.addOverlapPair("main", "a", "b"), "workspace_validation_error");

const qualityConflict = session(initial);
const qualityOldId = qualityConflict.state.inventory.find((item) => item.provenance.occurrenceId === "a-0")!.starInstanceId;
qualityConflict.setPlanTarget(qualityOldId, 60);
qualityConflict.editOccurrence("a-0", { quality: "橙" });
qualityConflict.editOccurrence("b-0", { quality: "紫" });
expect(qualityConflict.state.importReview.overlapAudit.some((item: any) => item.type === "quality_conflict") && physical(qualityConflict) === 5, "conflicting manual component qualities split finalizable sources instead of making a physical star disappear");
expect(qualityConflict.state.inventory.find((item) => item.provenance.occurrenceId === "a-0")!.starInstanceId === qualityOldId && qualityConflict.state.planTargets[qualityOldId] === 60, "quality conflict keeps old primary ID and plan target while the secondary side receives a fresh ID");
qualityConflict.editOccurrence("b-0", { quality: "橙" });
expect(!qualityConflict.state.importReview.overlapAudit.some((item: any) => item.type === "quality_conflict") && qualityConflict.state.inventory.length === 4 && qualityConflict.state.inventory.find((item) => item.provenance.occurrenceId === "a-0")!.starInstanceId === qualityOldId && qualityConflict.state.planTargets[qualityOldId] === 60, "resolving manual quality conflict re-merges to the old primary ID and plan target");

edits.undo(); expect(edits.redo(), "ordinary postprocess edits participate in existing snapshot history");
edits.undo(); const beforeInvalid = JSON.stringify(edits.state); expect(edits.history.canRedo, "undo exposes redo before invalid mutation");
expectError(() => edits.editOccurrence("b-2", { level: 61 }), "workspace_validation_error");
expect(JSON.stringify(edits.state) === beforeInvalid && edits.history.canRedo, "invalid postprocess mutation changes neither workspace nor history");

const overlapTwoRows = multi([0, 1, 2], [1, 2]);
expect(overlapTwoRows.inventory.length === 12 && overlapTwoRows.importReview.overlapAudit.filter((item: any) => item.status === "duplicate").length === 2, "3-to-2 images select the longest two-row suffix-prefix alignment");
const oneRowSuffix = multi([0, 1, 2], [2, 3]);
expect(oneRowSuffix.inventory.length === 16 && oneRowSuffix.importReview.overlapAudit.filter((item: any) => item.status === "duplicate").length === 1, "failed longer alignment falls back to one exact suffix row without retaining partial duplicates");
const longestFailure = multi([0, 1, 2], [2, 3, 4]);
expect(longestFailure.inventory.length === 20 && longestFailure.importReview.overlapAudit.filter((item: any) => item.status === "duplicate").length === 1, "k=3 and k=2 conflicts cannot leak local duplicate rows before k=1 succeeds");
const allPending = session(multi([1], [1], new Set(["b:0:0"])));
const allPendingReview = rowAudit(allPending);
expect(allPendingReview?.status === "pending", "a complete no-conflict row with unknown fields remains available for explicit physical confirmation");
allPending.setRowOverlapResolution(allPendingReview.rowReviewId, "merge");
expect(physical(allPending) === 4 && allPending.state.inventory.some((item) => item.provenance.occurrenceId === "a-0-0" && item.name === "天府"), "one-side unknown manual merge unions all four cells and resolves from the known observation");

const complementaryWorkspace = base();
complementaryWorkspace.importReview.occurrences["a-2"] = { ...complementaryWorkspace.importReview.occurrences["a-2"]!, name: null };
complementaryWorkspace.importReview.occurrences["b-2"] = { ...complementaryWorkspace.importReview.occurrences["b-2"]!, level: null };
const complementary = session(recalculateWorkspacePostprocess(complementaryWorkspace, catalog, (() => { let id = 0; return () => `complementary-${++id}`; })()));
const complementaryReview = rowAudit(complementary);
expect(complementaryReview?.status === "pending", "complementary field unknowns produce one generic pending row");
complementary.setRowOverlapResolution(complementaryReview.rowReviewId, "merge");
const complementaryStar = complementary.state.inventory.find((item) => item.provenance.occurrenceId === "a-2");
expect(physical(complementary) === 4 && complementaryStar?.name === "紫微" && complementaryStar.level === 22 && complementaryStar.quality === "橙", "complementary name and level resolve from one physical component without per-image cases");

const bothUnknownWorkspace = base();
for (const id of ["a-2", "b-2"] as const) bothUnknownWorkspace.importReview.occurrences[id] = { ...bothUnknownWorkspace.importReview.occurrences[id]!, name: null };
const bothUnknown = session(recalculateWorkspacePostprocess(bothUnknownWorkspace, catalog, (() => { let id = 0; return () => `unknown-${++id}`; })()));
const bothUnknownReview = rowAudit(bothUnknown);
bothUnknown.setRowOverlapResolution(bothUnknownReview.rowReviewId, "merge");
expect(physical(bothUnknown) === 3 && bothUnknown.state.importReview.overlapAudit.some((item: any) => item.rowReviewId === bothUnknownReview.rowReviewId && item.occurrenceIds.length === 8), "both-unknown cell remains unresolved without a fabricated instance or half-row duplicate");
const conflictPrecedence = multi([1, 2], [1, 2], new Set(["b:1:0"]));
const conflicted = { ...conflictPrecedence, importReview: { ...conflictPrecedence.importReview, occurrences: { ...conflictPrecedence.importReview.occurrences, "b-1-0": { ...conflictPrecedence.importReview.occurrences["b-1-0"]!, name: "武曲", level: null } } } };
const conflictResult = recalculateWorkspacePostprocess(conflicted, catalog, (() => { let id = 0; return () => `precedence-${++id}`; })());
expect(conflictResult.importReview.overlapAudit.filter((item: any) => item.type === "row_overlap").length === 0, "name conflict with level unknown rejects instead of becoming pending");

const withManual = session(initial);
withManual.addInstance({ kind: "主星", name: "天府", level: 30, quality: "白", equippedState: "unknown", provenance: { sourceOrder: 99, occurrenceId: null, audit: {} }, manualStatus: "manual" });
const manualId = withManual.state.inventory.find((item) => item.provenance.occurrenceId == null)!.starInstanceId;
withManual.setPlanTarget(manualId, 60);
withManual.editOccurrence("b-1", { quality: "紫" });
expect(withManual.state.inventory.some((item) => item.starInstanceId === manualId) && withManual.state.planTargets[manualId] === 60, "manual-only instance and its target survive ordinary OCR postprocess");
withManual.deleteInstance(manualId);
withManual.editOccurrence("b-1", { quality: "橙" });
expect(!withManual.state.inventory.some((item) => item.starInstanceId === manualId) && !(manualId in withManual.state.planTargets), "manual-only delete is permanent and removes its target");

const deleteDuplicate = session(initial);
const deleteId = deleteDuplicate.state.inventory.find((item) => item.provenance.occurrenceId === "a-0")!.starInstanceId;
deleteDuplicate.setPlanTarget(deleteId, 60);
deleteDuplicate.deleteInstance(deleteId);
expect(physical(deleteDuplicate) === 3 && deleteDuplicate.state.importReview.occurrences["a-0"]!.removedFromCurrentInventory && deleteDuplicate.state.importReview.occurrences["b-0"]!.removedFromCurrentInventory, "current inventory delete marks every source observation of one physical component and changes 4 to 3");
expect(deleteDuplicate.state.importReview.occurrences["a-0"]!.inventoryAction === "keep" && rowAudit(deleteDuplicate)?.status === "duplicate", "current inventory delete preserves OCR evidence and the four-card overlap row");
expect(!(deleteId in deleteDuplicate.state.planTargets), "current inventory delete removes only the deleted component plan target");
deleteDuplicate.editOccurrence("b-1", { quality: "紫" });
expect(physical(deleteDuplicate) === 3, "ordinary postprocess edits do not revive a current-inventory deletion");
expect(deleteDuplicate.undo() && deleteDuplicate.undo() && physical(deleteDuplicate) === 4 && !deleteDuplicate.state.importReview.occurrences["a-0"]!.removedFromCurrentInventory && deleteDuplicate.state.planTargets[deleteId] === 60, "undo restores removed flags, inventory and plan target");
expect(deleteDuplicate.redo() && deleteDuplicate.redo() && physical(deleteDuplicate) === 3, "redo reapplies current inventory deletion");

const reversedWorkspace = createEmptyWorkspace("reversed-id-order");
reversedWorkspace.importReview = { imagePools: { a: "main", b: "main" }, confirmedImagePools: ["a", "b"], overlapPairs: { main: [["a", "b"]], support: [] }, overlapAudit: [], imageAudit: {}, occurrences: Object.fromEntries([0, 1, 2, 3].flatMap((column) => [occurrence("b", column), occurrence("a", column)]).map((item) => [item.occurrenceId, item])) };
let oldIds = 0; const reversedInitial = recalculateWorkspacePostprocess(reversedWorkspace, catalog, () => `old-${++oldIds}`); const oldPrimaryId = reversedInitial.inventory.find((item) => item.provenance.occurrenceId === "a-0")!.starInstanceId;
const reversedSession = session(reversedInitial); reversedSession.editOccurrence("b-0", { name: "武曲" });
expect(reversedSession.state.inventory.find((item) => item.provenance.occurrenceId === "a-0")!.starInstanceId === oldPrimaryId && reversedSession.state.inventory.find((item) => item.provenance.occurrenceId === "b-0")!.starInstanceId !== oldPrimaryId, "split assigns the old ID only to the old-primary subgroup regardless of occurrence insertion order");
reversedSession.editOccurrence("b-0", { name: "天府" });
expect(reversedSession.state.inventory.find((item) => item.provenance.occurrenceId === "a-0")!.starInstanceId === oldPrimaryId, "merge survivor follows deterministic primary ownership and exact-set reuse preserves IDs");
console.log("Phase B persisted-occurrence postprocess, overlap, ID, plan, quality, pools, pairs and history checks passed");
