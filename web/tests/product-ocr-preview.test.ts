import { createStarCatalog } from "../src/business/catalog.js";
import { createEmptyWorkspace } from "../src/business/model.js";
import { WorkspaceSession } from "../src/business/session.js";
import { automaticReconcileResolution, finalizeReconcileDraft, type ReconcileCandidateV1, type ReconcileDraftV1, type ReconcileResolutionV1 } from "../src/business/reconcile.js";
import {
  buildProductReviewCandidates,
  isProductReviewCandidateComplete,
  productReviewCandidateActions,
  productReviewCandidatesForImage,
  productReviewKeepActionLabel,
  splitProductReviewImagesForDesktop,
} from "../src/product-ocr-preview.js";
import { buildPersistedProductReview, buildProductReviewImageSummaries, productReviewRowCropRect, productReviewRowKey, selectActiveReviewScrollContainer, type ProductReviewEvidenceV1 } from "../src/product-ocr-review.js";

function expect(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

const catalog = createStarCatalog([
  { name: "天府", kind: "主星", aliases: [], displayGroup: null, usageTags: [], rawEffectText: null },
  { name: "武曲", kind: "主星", aliases: [], displayGroup: null, usageTags: [], rawEffectText: null },
  { name: "解神", kind: "辅星", aliases: [], displayGroup: null, usageTags: [], rawEffectText: null },
], {});

function candidate(occurrenceId: string, overrides: Partial<ReconcileCandidateV1> = {}): ReconcileCandidateV1 {
  return { occurrenceId, sourceImageId: "image-1", sourceOrder: 1, row: 0, column: 0, kind: "主星", name: "天府", level: 40, quality: "橙", qualityConfidence: .9, equippedState: "unknown", ...overrides };
}

function draft(overrides: Partial<ReconcileDraftV1> = {}): ReconcileDraftV1 {
  const clean = candidate("clean", { column: 3 });
  const required = candidate("required", { column: 0, name: null, kind: null });
  const fragment = candidate("fragment", { row: 1, column: 0, name: null, kind: null });
  return {
    schemaVersion: 1,
    task: { taskId: "task", accountId: "account", baseRevision: 7 },
    status: "requires_review",
    blockReasonCodes: [],
    candidates: [required, clean],
    occurrences: [],
    ordinaryGroups: [required, clean].map((item) => ({ groupId: `group:${item.occurrenceId}`, occurrenceIds: [item.occurrenceId], primaryOccurrenceId: item.occurrenceId, duplicateRelationIds: [] })),
    ordinaryReviewItems: [{ occurrenceId: required.occurrenceId, reasonCodes: ["ordinary_name_unresolved"], suggested: required }],
    overlapReviewItems: [],
    duplicateRows: [],
    excludedOrdinaryOccurrences: [{ occurrenceId: fragment.occurrenceId, reasonCode: "incomplete_card", suggested: fragment }],
    bag: { currentCount: 2, capacity: 100, reviewReasonCodes: [] },
    experience: { orange: 1, purple: 2, white: 3, reviewReasonCodes: [] },
    sourceImages: [{ sourceImageId: "image-1", sourceOrder: 1, suggestedPageType: "main", confirmedPool: "main", reviewRequired: false, warningCodes: [] }],
    confirmedOverlapPairs: [],
    overlapAuditItems: [],
    reviewReasonCodes: [],
    ...overrides,
  };
}

const evidence: ProductReviewEvidenceV1 = {
  images: [{ sourceImageId: "image-1", sourceOrder: 1, pageType: "main", reviewRequired: false, warningCodes: [], candidateCount: 3 }],
  occurrences: [
    { occurrenceId: "required", sourceImageId: "image-1", row: 0, column: 0, completeness: "complete", sourceRect: {} as any, name: null, level: 40, quality: "橙" },
    { occurrenceId: "clean", sourceImageId: "image-1", row: 0, column: 3, completeness: "complete", sourceRect: {} as any, name: "天府", level: 40, quality: "橙" },
    { occurrenceId: "fragment", sourceImageId: "image-1", row: 1, column: 0, completeness: "partial_bottom", sourceRect: {} as any, name: null, level: 40, quality: "紫" },
  ],
};

const base = draft();
const imageSortEvidence: ProductReviewEvidenceV1 = { images: [
  { sourceImageId: "clean-image", sourceOrder: 1, pageType: "main", reviewRequired: false, warningCodes: [], candidateCount: 0 },
  { sourceImageId: "warning-image", sourceOrder: 2, pageType: "main", reviewRequired: false, warningCodes: ["warning"], candidateCount: 0 },
  { sourceImageId: "review-image", sourceOrder: 3, pageType: "main", reviewRequired: true, warningCodes: [], candidateCount: 0 },
], occurrences: [] };
expect(buildProductReviewImageSummaries(draft({ candidates: [], ordinaryReviewItems: [], excludedOrdinaryOccurrences: [], ordinaryGroups: [] }), {}, imageSortEvidence).map((item) => item.sourceImageId).join(",") === "clean-image,warning-image,review-image", "generic raw warnings do not outrank pure-clean images without a visible review candidate");
const ordered = buildProductReviewCandidates(base, {}, evidence, new Set());
expect(ordered.map((item) => item.kind).join(",") === "required,fragment,clean", "candidate priority is review, duplicate, fragment/error, clean when no duplicate exists");
expect(ordered.map((item) => item.tier).join(",") === "1,2,3", "review, excluded fragment and clean candidates are assigned to the three display tiers");
expect(productReviewCandidatesForImage(ordered, "image-1", false).map((item) => item.occurrenceId).join(",") === "required", "an image with tier 1 defaults to tier 1 only");
expect(productReviewCandidatesForImage(ordered, "image-1", false).every((item) => item.kind !== "clean"), "clean candidates are hidden by default");
expect(productReviewCandidatesForImage(ordered, "image-1", true).map((item) => item.tier).join(",") === "1,2,3", "查看全部候选 appends tier 2 then tier 3 after tier 1");

const ignoredClean: ReconcileResolutionV1 = { ordinary: { clean: { action: "exclude" } } };
const ignoredCandidate = buildProductReviewCandidates(base, ignoredClean, evidence, new Set()).find((item) => item.occurrenceId === "clean");
const tier3Clean = { ...ordered.find((item) => item.occurrenceId === "clean")!, occurrenceId: "tier3-clean" };
expect(ignoredCandidate?.processed === "ignored" && ignoredCandidate.tier === 2, "ignored evidence is tier 2 rather than a current review item");
expect(productReviewCandidatesForImage([ignoredCandidate!, tier3Clean], "image-1", false).map((item) => item.tier).join(",") === "2", "an image with no tier 1 defaults to tier 2 only");
expect(productReviewCandidatesForImage([ignoredCandidate!, tier3Clean], "image-1", true).map((item) => item.tier).join(",") === "2,3", "tier 2 image appends clean candidates only after 查看全部候选");
expect(!productReviewCandidatesForImage([tier3Clean], "image-1", false).length && productReviewCandidatesForImage([tier3Clean], "image-1", true).length === 1, "clean-only image opens with its light empty state until 查看全部候选");

const editRequired: ReconcileResolutionV1 = { ordinary: { required: { action: "edit", name: "武曲", level: 30, quality: "紫" } } };
expect(buildProductReviewCandidates(base, editRequired, evidence, new Set()).find((item) => item.occurrenceId === "required")?.edited, "edit preserves the updated evidence values for post-save review");
expect(buildProductReviewCandidates(base, editRequired, evidence, new Set(["required"])).find((item) => item.occurrenceId === "required")?.processed === "checked", "explicit keep marks a reviewed candidate as checked without deleting evidence");
expect(!isProductReviewCandidateComplete(ordered[0]!, catalog), "keep is blocked while identity fields are incomplete");
expect(isProductReviewCandidateComplete(buildProductReviewCandidates(base, editRequired, evidence, new Set()).find((item) => item.occurrenceId === "required")!, catalog), "keep succeeds once edited fields are complete");

const cleanEdit = { ordinary: { required: { action: "exclude" }, clean: { action: "edit", name: "武曲", level: 22, quality: "蓝" } } } satisfies ReconcileResolutionV1;
expect(finalizeReconcileDraft(base, cleanEdit, { catalog, gameVersion: "如鸢", createStarInstanceId: () => "clean-edit" }).workspace.inventory.some((item) => item.name === "武曲" && item.level === 22), "clean candidate edit is honored at finalize");
expect(!finalizeReconcileDraft(base, { ordinary: { required: { action: "exclude" }, clean: { action: "exclude" } } }, { catalog, gameVersion: "如鸢", createStarInstanceId: () => "clean-exclude" }).workspace.inventory.some((item) => item.provenance.occurrenceId === "clean"), "clean candidate exclusion is honored at finalize");

const fragmentEdit = { ordinary: { fragment: { action: "edit", name: "解神", level: 12, quality: "绿" } } } satisfies ReconcileResolutionV1;
expect(finalizeReconcileDraft(base, { ordinary: { required: { action: "exclude" }, fragment: fragmentEdit.ordinary.fragment } }, { catalog, gameVersion: "如鸢", createStarInstanceId: (() => { let index = 0; return () => `fragment-${++index}`; })() }).workspace.inventory.some((item) => item.name === "解神" && item.manualStatus === "user_resolved"), "valid fragment rescue is honored by final reconcile");
expect(!isProductReviewCandidateComplete(ordered.find((item) => item.occurrenceId === "fragment")!, catalog), "fragment rescue requires complete fields");
expect(buildProductReviewCandidates(base, { ordinary: { fragment: { action: "exclude" } } }, evidence, new Set()).find((item) => item.occurrenceId === "fragment")?.processed === "ignored", "ignored fragment remains evidence-only and never becomes a clean candidate");
expect(productReviewRowKey("image-1", 4) === productReviewRowKey("image-1", 4), "row crop cache key is shared per image and row");

const left = Array.from({ length: 4 }, (_, column) => candidate(`left-${column}`, { sourceImageId: "left-image", sourceOrder: 1, row: 2, column }));
const right = Array.from({ length: 4 }, (_, column) => candidate(`right-${column}`, { sourceImageId: "right-image", sourceOrder: 2, row: 3, column }));
const relations = left.map((item, column) => ({ relationId: `duplicate-${column}`, pairId: "pair", status: "duplicate" as const, leftOccurrenceId: item.occurrenceId, rightOccurrenceId: right[column]!.occurrenceId, reviewReasonCodes: [] }));
const duplicate = draft({
  status: "ready_to_finalize",
  candidates: [...left, ...right],
  ordinaryReviewItems: [],
  excludedOrdinaryOccurrences: [],
  ordinaryGroups: left.map((item, column) => ({ groupId: `group:${item.occurrenceId}`, occurrenceIds: [item.occurrenceId, right[column]!.occurrenceId], primaryOccurrenceId: item.occurrenceId, duplicateRelationIds: [relations[column]!.relationId] })),
  duplicateRows: [{ rowReviewId: "duplicate-row:pair", pairId: "pair", leftSourceImageId: "left-image", rightSourceImageId: "right-image", leftRow: 2, rightRow: 3, relationIds: relations.map((item) => item.relationId), leftOccurrenceIds: left.map((item) => item.occurrenceId), rightOccurrenceIds: right.map((item) => item.occurrenceId) }],
  overlapAuditItems: relations,
  sourceImages: [
    { sourceImageId: "left-image", sourceOrder: 1, suggestedPageType: "main", confirmedPool: "main", reviewRequired: false, warningCodes: [] },
    { sourceImageId: "right-image", sourceOrder: 2, suggestedPageType: "main", confirmedPool: "main", reviewRequired: false, warningCodes: [] },
  ],
});
const duplicateEvidence: ProductReviewEvidenceV1 = { images: [
  { sourceImageId: "left-image", sourceOrder: 1, pageType: "main", reviewRequired: false, warningCodes: [], candidateCount: 4 },
  { sourceImageId: "right-image", sourceOrder: 2, pageType: "main", reviewRequired: false, warningCodes: [], candidateCount: 4 },
], occurrences: [...left, ...right].map((item) => ({ occurrenceId: item.occurrenceId, sourceImageId: item.sourceImageId, row: item.row, column: item.column, completeness: "complete", sourceRect: {} as any, name: item.name, level: item.level, quality: item.quality })) };
const duplicateCandidates = buildProductReviewCandidates(duplicate, {}, duplicateEvidence, new Set());
expect(duplicateCandidates.filter((item) => item.kind === "duplicate").length === 8, "both endpoints expose the row-level duplicate state in the compact candidate flow");
expect(productReviewKeepActionLabel(duplicateCandidates.find((item) => item.kind === "duplicate")!) === "保持独立", "confirmed duplicate cards label their existing keep-separate row action explicitly");
expect(productReviewKeepActionLabel({ kind: "clean", overlapPending: false }) === "保留", "ordinary cards keep the existing keep label");
const keepSeparate = { overlap: { "duplicate-row:pair": { action: "keep_separate" } } } satisfies ReconcileResolutionV1;
const duplicateSummaries = buildProductReviewImageSummaries(duplicate, {}, duplicateEvidence);
expect(duplicateSummaries.find((item) => item.sourceImageId === "left-image")?.overlapDuplicateCount === 4 && duplicateSummaries.find((item) => item.sourceImageId === "right-image")?.overlapDuplicateCount === 4, "duplicate summary counts UI participation on both image endpoints");
expect(finalizeReconcileDraft(duplicate, {}, { catalog, gameVersion: "如鸢", createStarInstanceId: (() => { let index = 0; return () => `merged-${++index}`; })() }).workspace.inventory.length === 4, "symmetric duplicate UI counts do not alter merged inventory semantics");
expect(finalizeReconcileDraft(duplicate, keepSeparate, { catalog, gameVersion: "如鸢", createStarInstanceId: (() => { let index = 0; return () => `separate-${++index}`; })() }).workspace.inventory.length === 8, "duplicate keep-separate remains whole-row at final commit");

const frozenDraft = JSON.stringify(base);
const automatic = automaticReconcileResolution(base);
const automaticFinal = finalizeReconcileDraft(base, automatic, { catalog, gameVersion: "如鸢", createStarInstanceId: () => "automatic" });
expect(automaticFinal.workspace.inventory.length === 1 && automaticFinal.workspace.inventory[0]!.name === "天府", "automatic reconcile commits complete stars while excluding missing and fragment evidence");
expect(automatic.ordinary?.required?.action === "exclude" && automatic.ordinary?.clean?.action == null, "automatic reconcile only resolves review records and never forces a clean candidate through review");
expect(JSON.stringify(base) === frozenDraft && base.task.baseRevision === 7, "post-save review helpers do not mutate the reconcile draft or revision");

const persistedWorkspace = createEmptyWorkspace("persisted-account", "代号鸢");
persistedWorkspace.importReview.imagePools = { clean: "main", issue: "main", review: "main", experience: "experience" };
persistedWorkspace.importReview.confirmedImagePools = ["clean", "issue", "review", "experience"];
persistedWorkspace.importReview.imageAudit = {
  clean: { sourceOrder: 3, filename: "clean-long-file.png", reviewRowRects: { "0": { x: 1, y: 2, width: 30, height: 40 } } },
  issue: { sourceOrder: 1, filename: "issue-long-file.png", ordinaryReview: [{ occurrenceId: "missing", reviewReasonCodes: ["ordinary_name_unresolved"] }] },
  review: { sourceOrder: 0, filename: "review-long-file.png", ordinaryReview: [{ occurrenceId: "unresolved", reviewReasonCodes: ["ordinary_name_unresolved"] }] },
  experience: { sourceOrder: 2, filename: "experience.png" },
} as any;
persistedWorkspace.importReview.occurrences = {
  clean: { occurrenceId: "clean", sourceImageId: "clean", sourceOrder: 3, row: 0, column: 0, completeness: "complete", kind: "主星", name: "天府", level: 40, quality: "橙", nameConfidence: 1, levelConfidence: 1, qualityConfidence: 1, reviewRequired: false, inventoryAction: "keep", removedFromCurrentInventory: false, manualOverride: true, equippedState: "unknown" },
  missing: { occurrenceId: "missing", sourceImageId: "issue", sourceOrder: 1, row: 1, column: 0, completeness: "complete", kind: null, name: null, level: 1, quality: "紫", nameConfidence: 0, levelConfidence: 1, qualityConfidence: 1, reviewRequired: true, inventoryAction: "exclude_false_box", removedFromCurrentInventory: false, manualOverride: false, equippedState: "unknown" },
  unresolved: { occurrenceId: "unresolved", sourceImageId: "review", sourceOrder: 0, row: 0, column: 0, completeness: "complete", kind: null, name: null, level: 1, quality: "紫", nameConfidence: 0, levelConfidence: 1, qualityConfidence: 1, reviewRequired: true, inventoryAction: "keep", removedFromCurrentInventory: false, manualOverride: false, equippedState: "unknown" },
} as any;
persistedWorkspace.importReview.overlapAudit = [
  { relationId: "persisted-duplicate", pairId: "persisted-pair", status: "duplicate", leftOccurrenceId: "missing", rightOccurrenceId: "clean", reviewReasonCodes: [] },
  { type: "row_overlap", rowReviewId: "persisted-row", beforeImageId: "issue", afterImageId: "clean", beforeRow: 1, afterRow: 0, status: "duplicate", resolution: null, occurrenceIds: ["missing", "clean"] },
] as any;
const restored = buildPersistedProductReview(persistedWorkspace);
expect(restored != null && restored.evidence.images.map((item) => item.sourceImageId).join(",") === "review,issue,experience,clean", "persisted review re-entry rebuilds source evidence in source order without raw OCR");
expect(restored != null && buildProductReviewImageSummaries(restored.draft, restored.resolution, restored.evidence).map((item) => item.sourceImageId).join(",") === "review,issue,clean", "persisted review images remain ordered tier 1, tier 2, then clean history");
expect(restored != null && buildProductReviewCandidates(restored.draft, restored.resolution, restored.evidence, new Set()).find((item) => item.occurrenceId === "unresolved")?.tier === 1, "persisted unresolved ordinary review remains tier 1 after reload");
expect(restored != null && buildProductReviewCandidates(restored.draft, restored.resolution, restored.evidence, new Set()).find((item) => item.occurrenceId === "clean")?.edited, "persisted manual edit remains visible in 查看全部候选");
persistedWorkspace.importReview.occurrences.missing!.reviewResolution = "ignored";
const restoredIgnored = buildPersistedProductReview(persistedWorkspace);
expect(restoredIgnored != null && buildProductReviewCandidates(restoredIgnored.draft, restoredIgnored.resolution, restoredIgnored.evidence, new Set()).find((item) => item.occurrenceId === "missing")?.processed === "ignored", "persisted user ignore remains visible as review history rather than collapsing to source links");
expect(restored?.draft.duplicateRows[0]?.relationIds[0] === "persisted-duplicate", "legacy saved overlap relation audits rebuild row relation ids when those ids were not retained");
const persistedSummaries = restored == null ? [] : buildProductReviewImageSummaries(restored.draft, restored.resolution, restored.evidence);
expect(persistedSummaries.find((item) => item.sourceImageId === "issue")?.overlapDuplicateCount === 1 && persistedSummaries.find((item) => item.sourceImageId === "clean")?.overlapDuplicateCount === 1, "persisted duplicate participation count remains symmetric after reload");
expect(restored != null && productReviewRowCropRect(restored.evidence, "clean", 0)?.height === 40, "persisted JSON row geometry rebuilds the same crop without saving a bitmap");

const reviewState = createEmptyWorkspace("review-state", "如鸢");
reviewState.importReview.imagePools = { issue: "main", fragment: "main" };
reviewState.importReview.confirmedImagePools = ["issue", "fragment"];
reviewState.importReview.imageAudit = { issue: { sourceOrder: 1, ordinaryReview: [{ occurrenceId: "needs-human", reviewReasonCodes: ["ordinary_name_unresolved"] }] }, fragment: { sourceOrder: 2 } } as any;
reviewState.importReview.occurrences = {
  "needs-human": { occurrenceId: "needs-human", sourceImageId: "issue", sourceOrder: 1, row: 0, column: 0, completeness: "complete", kind: null, name: null, level: null, quality: null, nameConfidence: 0, levelConfidence: 0, qualityConfidence: 0, reviewRequired: true, inventoryAction: "exclude_false_box", removedFromCurrentInventory: false, manualOverride: false, equippedState: "unknown" },
  "auto-fragment": { occurrenceId: "auto-fragment", sourceImageId: "fragment", sourceOrder: 2, row: 0, column: 0, completeness: "partial_bottom", kind: null, name: null, level: null, quality: null, nameConfidence: 0, levelConfidence: 0, qualityConfidence: 0, reviewRequired: true, inventoryAction: "exclude_fragment", removedFromCurrentInventory: false, manualOverride: false, equippedState: "unknown" },
} as any;
const reviewSession = new WorkspaceSession(reviewState, catalog, (() => { let index = 0; return () => `review-state-${++index}`; })());
const beforeEdit = buildPersistedProductReview(reviewSession.state)!;
expect(buildProductReviewCandidates(beforeEdit.draft, beforeEdit.resolution, beforeEdit.evidence, new Set()).find((item) => item.occurrenceId === "auto-fragment")?.tier === 2, "automatic fragment stays excluded and tier 2 without pretending to be user ignored");
expect(buildProductReviewCandidates(beforeEdit.draft, beforeEdit.resolution, beforeEdit.evidence, new Set()).find((item) => item.occurrenceId === "needs-human")?.tier === 1, "missing non-fragment fields remain tier 1");
reviewSession.editOccurrence("needs-human", { name: "武曲", level: 30, quality: "紫" });
const editedReview = buildPersistedProductReview(reviewSession.state)!;
expect(reviewSession.state.inventory.some((item) => item.name === "武曲") && buildProductReviewCandidates(editedReview.draft, editedReview.resolution, editedReview.evidence, new Set()).find((item) => item.occurrenceId === "needs-human")?.tier === 1, "edit immediately updates inventory but remains tier 1 before explicit keep");
const f5AfterEdit = buildPersistedProductReview(reviewSession.state)!;
expect(buildProductReviewCandidates(f5AfterEdit.draft, f5AfterEdit.resolution, f5AfterEdit.evidence, new Set()).find((item) => item.occurrenceId === "needs-human")?.tier === 1, "unkept edit remains tier 1 after F5 reconstruction");
reviewSession.resolveOccurrenceReview("needs-human", "accepted");
const acceptedReview = buildPersistedProductReview(reviewSession.state)!;
expect(buildProductReviewCandidates(acceptedReview.draft, acceptedReview.resolution, acceptedReview.evidence, new Set()).find((item) => item.occurrenceId === "needs-human")?.tier !== 1, "edit plus keep persists a resolved review");
reviewSession.undo();
reviewSession.resolveOccurrenceReview("needs-human", "ignored");
const ignoredReview = buildPersistedProductReview(reviewSession.state)!;
expect(!reviewSession.state.inventory.some((item) => item.name === "武曲") && buildProductReviewCandidates(ignoredReview.draft, ignoredReview.resolution, ignoredReview.evidence, new Set()).find((item) => item.occurrenceId === "needs-human")?.tier === 2, "user ignore is persisted separately from automatic fragment exclusion");

const unresolvedDraft = draft({ candidates: [...left, ...right], ordinaryReviewItems: [], excludedOrdinaryOccurrences: [], ordinaryGroups: [...left, ...right].map((item) => ({ groupId: item.occurrenceId, occurrenceIds: [item.occurrenceId], primaryOccurrenceId: item.occurrenceId, duplicateRelationIds: [] })), duplicateRows: [], overlapReviewItems: [{ rowReviewId: "pending-row", pairId: "pair", leftSourceImageId: "left-image", rightSourceImageId: "right-image", leftRow: 2, rightRow: 3, relationIds: relations.map((item) => item.relationId), leftOccurrenceIds: left.map((item) => item.occurrenceId), rightOccurrenceIds: right.map((item) => item.occurrenceId), reasonCodes: ["overlap_row_requires_review"] }], sourceImages: duplicate.sourceImages });
const unresolvedCandidates = buildProductReviewCandidates(unresolvedDraft, {}, duplicateEvidence, new Set());
expect(unresolvedCandidates.filter((item) => item.tier === 1).length === 1 && unresolvedCandidates.find((item) => item.tier === 1)?.sourceImageId === "right-image", "unresolved overlap exposes exactly one right-side human action");
expect(productReviewCandidateActions(unresolvedCandidates.find((item) => item.tier === 1)!).join(",") === "view_source,confirm_duplicate,keep_separate", "unresolved overlap exposes relation actions instead of ordinary keep, ignore and edit");
const unresolvedSummaries = buildProductReviewImageSummaries(unresolvedDraft, {}, duplicateEvidence);
expect(unresolvedSummaries.find((item) => item.sourceImageId === "left-image")?.pendingCount === 0 && unresolvedSummaries.find((item) => item.sourceImageId === "right-image")?.pendingCount === 1, "left overlap endpoint stays evidence-only while right owns the pending row");
const mergedOverlap = { overlap: { "pending-row": { action: "merge" } } } satisfies ReconcileResolutionV1;
expect(!buildProductReviewCandidates(unresolvedDraft, mergedOverlap, duplicateEvidence, new Set()).some((item) => item.tier === 1), "merged overlap ends its tier 1 relation todo");
const persistedMerged = JSON.parse(JSON.stringify(persistedWorkspace));
persistedMerged.importReview.overlapAudit = [{ type: "row_overlap", rowReviewId: "persisted-row", beforeImageId: "issue", afterImageId: "clean", beforeRow: 1, afterRow: 0, status: "pending", resolution: "merge", occurrenceIds: ["missing", "clean"] }];
const restoredMerged = buildPersistedProductReview(persistedMerged)!;
expect(restoredMerged.draft.duplicateRows.some((item) => item.rowReviewId === "persisted-row") && !buildProductReviewCandidates(restoredMerged.draft, restoredMerged.resolution, restoredMerged.evidence, new Set()).filter((item) => ["missing", "clean"].includes(item.occurrenceId)).some((item) => item.tier === 1), "persisted merge restores duplicate history on both endpoints without reviving that row's unresolved todo");
const split = splitProductReviewImagesForDesktop([1, 2, 3, 4, 5, 6]);
expect(split.left.join(",") === "1,3,5" && split.right.join(",") === "2,4,6", "desktop review images split into stable independent columns");
expect(selectActiveReviewScrollContainer(["desktop", "mobile"], (item) => item === "desktop") === "desktop" && selectActiveReviewScrollContainer(["desktop", "mobile"], (item) => item === "mobile") === "mobile", "review viewport helper selects the actual visible scroll container rather than DOM order");

console.log("Step 2B post-save review criterion, automatic reconcile, fragment rescue and whole-row duplicate checks passed");
