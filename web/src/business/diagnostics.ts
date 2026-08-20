import { browserCatalog } from "./browser-catalog";
import { createEmptyWorkspace, type WorkspaceStateV1 } from "./model";
import { createWorkspaceSnapshot } from "./snapshot";
import { buildReconcileDraft, commitReconciledAnalysis } from "./reconcile";
import { recalculateWorkspacePostprocess } from "./postprocess";
import { commitWorkspacePostprocessMutation } from "./postprocess-commit";
import { WorkspaceSession } from "./session";
import type { BrowserAnalysisResultV1 } from "../structured/batch-orchestration";
import { closeDatabase, commitWorkspaceTransaction, deleteDatabaseForTest, getImage, getRestorePoint, getRestorePointImage, getWorkspace, listImagesForAccount, listRestorePoints, openDatabase, PRODUCTION_DB_NAME, PRODUCTION_DB_VERSION, PRODUCTION_STORES, putAccount, type ImageRecord, WorkspaceRevisionConflictError } from "./persistence/repository";

const ACCOUNT_ID = "phase2a-synthetic-account";
const originalImage = new Blob(["phase2a-original-image"], { type: "text/plain" });
const changedImage = new Blob(["phase2a-current-image"], { type: "text/plain" });

function syntheticWorkspace(revision = 0): WorkspaceStateV1 {
  const workspace = createEmptyWorkspace(ACCOUNT_ID);
  workspace.revision = revision;
  workspace.bag = { currentCount: 2, capacity: 40, resolution: { status: "synthetic" }, manualFields: ["currentCount", "capacity"] };
  workspace.inventory = [
    { starInstanceId: "phase2a-star-main", kind: "主星", name: "天府", level: 40, quality: "橙", equippedState: "unequipped", provenance: { sourceOrder: 1, sourceImageId: "phase2a-image", row: 0, column: 0 }, manualStatus: "synthetic" },
    { starInstanceId: "phase2a-star-support", kind: "辅星", name: "解神", level: 20, quality: "紫", equippedState: "unknown", provenance: { sourceOrder: 1, sourceImageId: "phase2a-image", row: 0, column: 1 }, manualStatus: "synthetic" },
  ];
  workspace.planTargets = { "phase2a-star-main": 60 };
  workspace.experience = { orange: 3, purple: 4, white: 5, evidence: { source: "synthetic" }, manualFields: [] };
  workspace.importReview = { imagePools: { "phase2a-image": "main" }, confirmedImagePools: ["phase2a-image"], overlapPairs: { main: [], support: [] }, overlapAudit: [], imageAudit: { "phase2a-image": { source: "synthetic" } }, occurrences: {} };
  return createWorkspaceSnapshot(workspace, browserCatalog);
}

function image(blob: Blob): Omit<ImageRecord, "accountId"> {
  return { imageId: "phase2a-image", blob, filename: "synthetic-phase2a.txt", mimeType: blob.type, width: null, height: null, createdAt: "2026-08-09T00:00:00.000Z" };
}

export async function describePhase2ADatabase(): Promise<Record<string, unknown>> {
  const db = await openDatabase();
  try {
    const workspace = await getWorkspace(db, ACCOUNT_ID);
    return { databaseName: PRODUCTION_DB_NAME, databaseVersion: PRODUCTION_DB_VERSION, objectStores: [...db.objectStoreNames], syntheticAccountId: ACCOUNT_ID, workspaceRevision: workspace?.revision ?? null, starInstanceCount: workspace?.snapshot.inventory.length ?? 0 };
  } finally { closeDatabase(db); }
}

export async function runPhase2APersistenceSmoke(): Promise<Record<string, unknown>> {
  await deleteDatabaseForTest();
  const db = await openDatabase();
  try {
    await putAccount(db, { accountId: ACCOUNT_ID, displayName: "Phase 2A Synthetic", gameVersion: "如鸢", createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z" });
    const first = await commitWorkspaceTransaction(db, { accountId: ACCOUNT_ID, expectedRevision: 0, nextSnapshot: syntheticWorkspace(), imageUpserts: [image(originalImage)] });
    const restoredAtOne = await getWorkspace(db, ACCOUNT_ID);
    if (restoredAtOne?.snapshot.inventory.map((item) => item.starInstanceId).join(",") !== "phase2a-star-main,phase2a-star-support") throw new Error("starInstanceId 未在 reload 后保持稳定");
    const secondSnapshot = { ...restoredAtOne.snapshot, bag: { ...restoredAtOne.snapshot.bag, currentCount: 3 } };
    const second = await commitWorkspaceTransaction(db, { accountId: ACCOUNT_ID, expectedRevision: 1, nextSnapshot: secondSnapshot });
    let conflict = false;
    try { await commitWorkspaceTransaction(db, { accountId: ACCOUNT_ID, expectedRevision: 1, nextSnapshot: secondSnapshot }); } catch (error) { conflict = error instanceof WorkspaceRevisionConflictError; }
    if (!conflict) throw new Error("stale revision 未被拒绝");
    const atTwo = await getWorkspace(db, ACCOUNT_ID);
    if (atTwo?.revision !== 2 || atTwo.snapshot.bag.currentCount !== 3) throw new Error("revision conflict 覆盖了当前 workspace");
    const thirdSnapshot = { ...atTwo.snapshot, bag: { ...atTwo.snapshot.bag, currentCount: 4 } };
    const third = await commitWorkspaceTransaction(db, { accountId: ACCOUNT_ID, expectedRevision: 2, nextSnapshot: thirdSnapshot, imageUpserts: [image(changedImage)], optionalRestorePoint: { restorePointId: "phase2a-restore-point", reason: "synthetic smoke", createdAt: "2026-08-09T00:00:01.000Z", imageIds: ["phase2a-image"], images: [{ imageId: "phase2a-image", blob: originalImage, metadata: { filename: "synthetic-phase2a.txt" } }] } });
    let aborted = false;
    try { await commitWorkspaceTransaction(db, { accountId: ACCOUNT_ID, expectedRevision: 3, nextSnapshot: third.snapshot, imageUpserts: [{ ...image(changedImage), imageId: "aborted-image" }], abortAfterWritesForTest: true }); } catch { aborted = true; }
    const currentImage = await getImage(db, ACCOUNT_ID, "phase2a-image");
    const restorePoint = await getRestorePoint(db, ACCOUNT_ID, "phase2a-restore-point");
    const restoreImage = await getRestorePointImage(db, ACCOUNT_ID, "phase2a-restore-point", "phase2a-image");
    const afterAbort = await getWorkspace(db, ACCOUNT_ID);
    if (!aborted || afterAbort?.revision !== 3 || await getImage(db, ACCOUNT_ID, "aborted-image")) throw new Error("abort 后出现部分写入");
    if (restorePoint?.workspaceRevision !== 2 || restorePoint.snapshot.revision !== 2 || restorePoint.snapshot.bag.currentCount !== 3 || afterAbort.snapshot.bag.currentCount !== 4) throw new Error("restore point 未保留 transaction 前 workspace");
    if (await currentImage?.blob.text() !== "phase2a-current-image" || await restoreImage?.blob.text() !== "phase2a-original-image") throw new Error("restore point 图片未独立保存");
    return { status: "passed", databaseName: PRODUCTION_DB_NAME, databaseVersion: PRODUCTION_DB_VERSION, objectStores: PRODUCTION_STORES, accountId: ACCOUNT_ID, initialRevision: first.revision, conflictRevision: second.revision, finalRevision: third.revision, currentBagCount: afterAbort.snapshot.bag.currentCount, restorePointRevision: restorePoint.workspaceRevision, restorePointBagCount: restorePoint.snapshot.bag.currentCount, starInstanceIds: afterAbort.snapshot.inventory.map((item) => item.starInstanceId), currentImage: "phase2a-current-image", restorePointImage: "phase2a-original-image", abortNoPartialWrite: true, pocDatabaseUntouched: true };
  } finally { closeDatabase(db); }
}

function protectionResult(accountId: string, taskId: string, baseRevision: number, status: "completed" | "partial" = "completed"): BrowserAnalysisResultV1 {
  const occurrence = { occurrenceId: `${taskId}-occurrence`, row: 0, column: 0, completeness: "complete", effectiveName: "天府", effectiveLevel: 40, quality: "橙", equippedState: "unknown", reviewRequired: false };
  return {
    schemaVersion: 1,
    task: { taskId, accountId, baseRevision, status },
    images: [{ sourceImageId: `${taskId}-image`, sourceOrder: 1, confirmedPool: null, status: "completed", error: null, analysis: { pageClassification: { pageType: "main", reviewRequired: false }, occurrences: [occurrence], experienceOccurrences: [], experienceAggregate: null, inventoryHeader: {}, warnings: [] } as never }],
    failures: [], inventory: { status: "confirmed", currentCount: { value: 1, status: "confirmed", sources: [], reviewReasonCodes: [] }, capacity: { value: 100, status: "confirmed", sources: [], reviewReasonCodes: [] } }, overlap: { confirmedPairs: [], relations: [] }, occurrences: [{ occurrenceId: occurrence.occurrenceId, sourceImageId: `${taskId}-image`, sourceOrder: 1, kind: "ordinary", occurrence: occurrence as never }], review: { status: "ready_for_review", reasons: [] },
  } as BrowserAnalysisResultV1;
}

export async function runPhase2BProtectionSmoke(): Promise<Record<string, unknown>> {
  const accountId = `phase2b-protection-${Date.now()}`;
  const db = await openDatabase();
  try {
    const firstResult = protectionResult(accountId, "first", 0);
    const firstDraft = buildReconcileDraft(firstResult, { currentAccountId: accountId, currentRevision: 0, activeTaskId: "first", catalog: browserCatalog });
    await commitReconciledAnalysis({ db, draft: firstDraft, catalog: browserCatalog, gameVersion: "如鸢", sourceImages: [{ sourceImageId: "first-image", blob: new Blob(["first"], { type: "text/plain" }), filename: "synthetic.txt", mimeType: "text/plain", width: null, height: null }], createStarInstanceId: () => "first-id" });
    const firstWorkspace = await getWorkspace(db, accountId);
    const mismatchDraft = buildReconcileDraft(protectionResult(accountId, "mismatch", 1), { currentAccountId: accountId, currentRevision: 1, activeTaskId: "mismatch", catalog: browserCatalog });
    let gameVersionMismatch = false;
    try { await commitReconciledAnalysis({ db, draft: mismatchDraft, catalog: browserCatalog, gameVersion: "代号鸢", sourceImages: [{ sourceImageId: "mismatch-image", blob: new Blob(["mismatch"], { type: "text/plain" }), filename: "synthetic.txt", mimeType: "text/plain", width: null, height: null }] }); } catch (error) { gameVersionMismatch = (error as { code?: string }).code === "workspace_game_version_mismatch"; }
    if (!gameVersionMismatch || JSON.stringify((await getWorkspace(db, accountId))?.snapshot) !== JSON.stringify(firstWorkspace?.snapshot)) throw new Error("game version mismatch protection failed");
    const rebuildDraft = buildReconcileDraft(protectionResult(accountId, "rebuild", 1), { currentAccountId: accountId, currentRevision: 1, activeTaskId: "rebuild", catalog: browserCatalog });
    await commitReconciledAnalysis({ db, draft: rebuildDraft, catalog: browserCatalog, gameVersion: "如鸢", sourceImages: [{ sourceImageId: "rebuild-image", blob: new Blob(["rebuild"], { type: "text/plain" }), filename: "synthetic.txt", mimeType: "text/plain", width: null, height: null }], createStarInstanceId: () => "rebuild-id", createRestorePointId: () => "rebuild-restore" });
    const rebuilt = await getWorkspace(db, accountId);
    const rebuildImages = await listImagesForAccount(db, accountId);
    const rebuildRestore = await getRestorePoint(db, accountId, "rebuild-restore");
    const rebuildRestoreImage = await getRestorePointImage(db, accountId, "rebuild-restore", "first-image");
    const rebuildVerified = !!firstWorkspace && rebuilt?.revision === 2 && rebuilt.snapshot.inventory.length === 1 && rebuilt.snapshot.inventory[0]?.starInstanceId === "rebuild-id" && rebuilt.snapshot.planTargets && Object.keys(rebuilt.snapshot.planTargets).length === 0 && rebuildImages.length === 1 && rebuildImages[0]?.imageId === "rebuild-image" && rebuildRestore?.reason === "pre_ocr_rebuild" && rebuildRestore.workspaceRevision === 1 && rebuildRestoreImage != null && await rebuildRestoreImage.blob.text() === "first";
    if (!rebuildVerified) throw new Error("rebuild restore protection failed");
    const beforePartial = await getWorkspace(db, accountId);
    const beforePartialSnapshot = JSON.stringify(beforePartial?.snapshot);
    const partialDraft = buildReconcileDraft(protectionResult(accountId, "partial", 2, "partial"), { currentAccountId: accountId, currentRevision: 2, activeTaskId: "partial", catalog: browserCatalog });
    let partialBlocked = false;
    try { await commitReconciledAnalysis({ db, draft: partialDraft, catalog: browserCatalog, gameVersion: "如鸢", sourceImages: [] }); } catch (error) { partialBlocked = error instanceof Error && error.name === "WorkspaceDomainError"; }
    const afterPartial = await getWorkspace(db, accountId);
    const partialWorkspaceUnchanged = JSON.stringify(afterPartial?.snapshot) === beforePartialSnapshot;
    if (!partialBlocked || !beforePartial || !afterPartial || afterPartial.revision !== beforePartial.revision || !partialWorkspaceUnchanged || (await listImagesForAccount(db, accountId)).length !== 1) throw new Error("partial protection failed");
    const staleResult = protectionResult(accountId, "stale", 2);
    const staleDraft = buildReconcileDraft(staleResult, { currentAccountId: accountId, currentRevision: 2, activeTaskId: "stale", catalog: browserCatalog });
    await commitWorkspaceTransaction(db, { accountId, expectedRevision: 2, nextSnapshot: { ...afterPartial.snapshot, bag: { ...afterPartial.snapshot.bag, currentCount: 2 } } });
    let staleConflict = false;
    try { await commitReconciledAnalysis({ db, draft: staleDraft, catalog: browserCatalog, gameVersion: "如鸢", sourceImages: [{ sourceImageId: "stale-image", blob: new Blob(["stale"], { type: "text/plain" }), filename: "synthetic.txt", mimeType: "text/plain", width: null, height: null }], createStarInstanceId: () => "stale-id", createRestorePointId: () => "must-not-exist" }); } catch (error) { staleConflict = error instanceof WorkspaceRevisionConflictError; }
    const afterStale = await getWorkspace(db, accountId);
    const images = await listImagesForAccount(db, accountId);
    const restorePoints = await listRestorePoints(db, accountId);
    if (!staleConflict || !afterStale || afterStale.revision !== 3 || afterStale.snapshot.bag.currentCount !== 2 || images.length !== 1 || restorePoints.length !== 1) throw new Error("stale protection failed");
    return { status: "passed", gameVersionMismatch, rebuildVerified, rebuildRevision: rebuilt.revision, rebuildFreshId: rebuilt.snapshot.inventory[0]?.starInstanceId === "rebuild-id", rebuildPlanTargetsEmpty: Object.keys(rebuilt.snapshot.planTargets).length === 0, rebuildCurrentImages: rebuildImages.length, rebuildRestorePointReason: rebuildRestore.reason, rebuildRestoreImageReadable: true, partialBlocked, partialRevisionUnchanged: afterPartial.revision === 2, partialWorkspaceUnchanged, partialImagesUnchanged: true, staleConflict, staleRevision: afterStale.revision, staleInventoryUnchanged: afterStale.snapshot.inventory.length === 1, staleImagesUnchanged: images.length === 1, staleRestorePointsCreated: restorePoints.length };
  } finally { closeDatabase(db); }
}

export async function runPhaseBPostprocessSmoke(): Promise<Record<string, unknown>> {
  const accountId = `phase2b-postprocess-smoke-${Date.now()}`;
  const names = ["天府", "武曲", "紫微", "天相"];
  const workspace = createEmptyWorkspace(accountId);
  workspace.importReview = {
    imagePools: { "phaseb-a": "main", "phaseb-b": "main" }, confirmedImagePools: ["phaseb-a", "phaseb-b"], overlapPairs: { main: [["phaseb-a", "phaseb-b"]], support: [] }, overlapAudit: [], imageAudit: { "phaseb-a": { suggestedPageType: "main", confirmedPool: "main" }, "phaseb-b": { suggestedPageType: "main", confirmedPool: "main" } },
    occurrences: Object.fromEntries([0, 1, 2, 3].flatMap((column) => ["phaseb-a", "phaseb-b"].map((sourceImageId, sourceIndex) => [`${sourceImageId}-${column}`, { occurrenceId: `${sourceImageId}-${column}`, sourceImageId, sourceOrder: sourceIndex + 1, row: 0, column, completeness: "complete", kind: "主星", name: names[column]!, level: 20 + column, quality: "橙", nameConfidence: 1, levelConfidence: 1, qualityConfidence: 1, reviewRequired: false, inventoryAction: "keep", removedFromCurrentInventory: false, manualOverride: false, equippedState: "unknown" }]))),
  };
  let generated = 0;
  const idFactory = () => `phaseb-id-${++generated}`;
    const initial = recalculateWorkspacePostprocess(workspace, browserCatalog, idFactory);
    const pendingWorkspace = JSON.parse(JSON.stringify(workspace));
    pendingWorkspace.importReview.occurrences["phaseb-b-2"].name = null;
    const pendingSession = new WorkspaceSession(recalculateWorkspacePostprocess(pendingWorkspace, browserCatalog, idFactory), browserCatalog, idFactory);
    const pendingAudit = pendingSession.state.importReview.overlapAudit.find((item: any) => item.type === "row_overlap" && item.status === "pending") as any;
    if (!pendingAudit) throw new Error("pending merge smoke 初始化失败");
    pendingSession.setRowOverlapResolution(pendingAudit.rowReviewId, "merge");
    const pendingMergePhysical = pendingSession.state.inventory.length === 4 && pendingSession.state.importReview.overlapAudit.some((item: any) => item.rowReviewId === pendingAudit.rowReviewId && item.occurrenceIds.length === 8);
    if (!pendingMergePhysical) throw new Error("pending merge 未整行合并");
  const db = await openDatabase();
  try {
    const seedSession = new WorkspaceSession(initial, browserCatalog, idFactory);
    const survivingId = seedSession.state.inventory.find((item) => item.provenance.occurrenceId === "phaseb-a-2")?.starInstanceId;
    if (!survivingId || seedSession.state.inventory.length !== 4) throw new Error("synthetic exact overlap 初始化失败");
    seedSession.setPlanTarget(survivingId, 60);
    const first = await commitWorkspaceTransaction(db, { accountId, expectedRevision: 0, nextSnapshot: seedSession.state });
    const second = await commitWorkspacePostprocessMutation({ db, accountId, catalog: browserCatalog, createStarInstanceId: idFactory, mutate: (session) => session.editOccurrence("phaseb-b-2", { name: "天相" }) });
    const session = new WorkspaceSession(second.snapshot, browserCatalog, idFactory);
    const afterConflict = session.state;
    if (afterConflict.inventory.length !== 8 || !afterConflict.inventory.some((item) => item.starInstanceId === survivingId)) throw new Error("name conflict 未触发 row-atomic split 或稳定 ID 丢失");
    session.editOccurrence("phaseb-b-2", { name: "紫微" });
    session.editOccurrence("phaseb-b-2", { quality: "紫" });
    const afterRestore = session.state;
    if (afterRestore.inventory.length !== 4 || afterRestore.inventory.find((item) => item.starInstanceId === survivingId)?.quality !== "紫" || afterRestore.planTargets[survivingId] !== 60) throw new Error("restore、quality 或 plan 同步失败");
    const dynamicWorkspace = createEmptyWorkspace(`${accountId}-dynamic`);
    const dynamicNames = ["天府", "武曲", "紫微", "天相"];
    const dynamicItemsFor = (imageId: string, sourceOrder: number, labels: number[]) => labels.flatMap((label, row) => [0, 1, 2, 3].map((column) => ({ occurrenceId: `${imageId}-${row}-${column}`, sourceImageId: imageId, sourceOrder, row, column, completeness: "complete" as const, kind: "主星" as const, name: dynamicNames[column]!, level: 10 + label * 4 + column, quality: "橙" as const, nameConfidence: 1, levelConfidence: 1, qualityConfidence: 1, reviewRequired: false, inventoryAction: "keep" as const, removedFromCurrentInventory: false, manualOverride: false, equippedState: "unknown" as const })));
    const dynamicItems = [...dynamicItemsFor("dynamic-a", 1, [0, 1, 2]), ...dynamicItemsFor("dynamic-b", 2, [1, 2])];
    dynamicWorkspace.importReview = { imagePools: { "dynamic-a": "main", "dynamic-b": "main" }, confirmedImagePools: ["dynamic-a", "dynamic-b"], overlapPairs: { main: [["dynamic-a", "dynamic-b"]], support: [] }, overlapAudit: [], imageAudit: {}, occurrences: Object.fromEntries(dynamicItems.map((item) => [item.occurrenceId, item])) };
    const dynamicResult = recalculateWorkspacePostprocess(dynamicWorkspace, browserCatalog, idFactory);
    const dynamicRows = dynamicResult.importReview.overlapAudit.filter((item: any) => item.type === "row_overlap" && item.status === "duplicate").length;
    if (dynamicRows !== 2 || dynamicResult.inventory.length !== 12) throw new Error("dynamic suffix-prefix smoke 失败");
    const manualId = session.addInstance({ kind: "主星", name: "天府", level: 30, quality: "白", equippedState: "unknown", provenance: { sourceOrder: 99, occurrenceId: null, audit: {} }, manualStatus: "synthetic_manual" });
    session.setPlanTarget(manualId, 60);
    session.editOccurrence("phaseb-b-1", { quality: "紫" });
    const manualSurvives = session.state.inventory.some((item) => item.starInstanceId === manualId) && session.state.planTargets[manualId] === 60;
    session.deleteInstance(manualId);
    const falseBoxSession = new WorkspaceSession(afterRestore, browserCatalog, idFactory);
    falseBoxSession.setOccurrenceInventoryAction("phaseb-a-0", "exclude_false_box");
    const falseBoxContrast = falseBoxSession.state.inventory.length === 7 && !falseBoxSession.state.importReview.overlapAudit.some((item: any) => item.type === "row_overlap");
    const deleteId = session.state.inventory.find((item) => item.provenance.occurrenceId === "phaseb-a-0")?.starInstanceId;
    if (!deleteId) throw new Error("OCR delete smoke 初始化失败");
    session.setPlanTarget(deleteId, 60);
    session.deleteInstance(deleteId);
    session.editOccurrence("phaseb-b-1", { quality: "橙" });
    const currentDelete = session.state.inventory.length === 3 && session.state.importReview.occurrences["phaseb-a-0"]?.removedFromCurrentInventory && session.state.importReview.occurrences["phaseb-b-0"]?.removedFromCurrentInventory && session.state.importReview.occurrences["phaseb-a-0"]?.inventoryAction === "keep" && session.state.importReview.overlapAudit.some((item: any) => item.type === "row_overlap" && item.status === "duplicate") && !(deleteId in session.state.planTargets);
    if (!manualSurvives || !currentDelete || !falseBoxContrast) throw new Error("manual-only、current delete 或 false-box 对比 smoke 失败");
    const undoOk = session.undo(); const redoOk = session.redo();
    const third = await commitWorkspaceTransaction(db, { accountId, expectedRevision: second.revision, nextSnapshot: session.state });
    const reloaded = await getWorkspace(db, accountId);
    let staleConflict = false;
    try { await commitWorkspaceTransaction(db, { accountId, expectedRevision: second.revision, nextSnapshot: session.state }); } catch (error) { staleConflict = error instanceof WorkspaceRevisionConflictError; }
    if (!reloaded || reloaded.revision !== third.revision || !staleConflict) throw new Error("reload 或 stale revision guard 失败");
    return { status: "passed", accountId, initialPhysical: 4, pendingMergePhysical, afterConflictPhysical: afterConflict.inventory.length, afterRestorePhysical: afterRestore.inventory.length, qualityEditPhysical: afterRestore.inventory.length, dynamicSuffixRows: dynamicRows, dynamicPhysical: dynamicResult.inventory.length, manualOnlySurvives: manualSurvives, currentDelete, falseBoxContrast, stableSurvivingId: afterRestore.inventory.some((item) => item.starInstanceId === survivingId), planTarget: afterRestore.planTargets[survivingId], postprocessRevision: afterRestore.postprocessRevision, workspaceRevision: third.revision, undoOk, redoOk, reloadStable: reloaded.snapshot.inventory.map((item) => item.starInstanceId).sort().join(",") === session.state.inventory.map((item) => item.starInstanceId).sort().join(","), staleConflict, restorePointsCreated: (await listRestorePoints(db, accountId)).length, ocrWorkerInvoked: false };
  } finally { closeDatabase(db); }
}
