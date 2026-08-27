import type { BrowserAnalysisOccurrenceReferenceV1, BrowserAnalysisResultV1 as InternalBrowserAnalysisResultV1, OverlapRelationV1 } from "../structured/batch-orchestration.js";
import type { BrowserAnalysisResultV1 as BrowserRuntimeAnalysisResultV1 } from "../ocr/browser-analysis-contract.js";
import type { OrdinaryStarOccurrenceV1, Rect } from "../structured/contracts.js";
import type { EditableOccurrenceStateV1, EquippedState, GameVersion, ImagePool, JsonValue, Quality, StarInstanceV1, StarKind, WorkspaceStateV1 } from "./model.js";
import { createEmptyWorkspace, WorkspaceDomainError } from "./model.js";
import type { StarCatalog } from "./catalog.js";
import { createWorkspaceSnapshot } from "./snapshot.js";
import { defaultStarInstanceId, type StarInstanceIdFactory } from "./session.js";
import { commitWorkspaceTransaction, getWorkspace, listImagesForAccount, type ImageRecord, type WorkspaceRecord } from "./persistence/repository.js";

export type ReconcileBlockReason = "partial_requires_retry" | "cancelled_result" | "failed_result" | "analysis_blocked" | "active_task_mismatch" | "account_mismatch" | "revision_mismatch" | "invalid_base_revision" | "reconcile_duplicate_component_inconsistent" | "overlap_relation_unavailable" | "experience_type_unresolved";
export interface ReconcileEligibilityV1 { eligible: boolean; blockReasonCodes: ReconcileBlockReason[]; baseRevision: number | null; }
export interface ReconcileCandidateV1 { occurrenceId: string; sourceImageId: string; sourceOrder: number; row: number; column: number; kind: StarKind | null; name: string | null; level: number | null; quality: Quality | null; qualityConfidence: number; equippedState: EquippedState; }
export interface OrdinaryReviewItemV1 { occurrenceId: string; reasonCodes: string[]; suggested: ReconcileCandidateV1; }
export interface OverlapReviewItemV1 { rowReviewId: string; pairId: string; leftSourceImageId: string; rightSourceImageId: string; leftRow: number; rightRow: number; relationIds: string[]; leftOccurrenceIds: string[]; rightOccurrenceIds: string[]; reasonCodes: string[]; }
export interface ReconcileDuplicateRowV1 { rowReviewId: string; pairId: string; leftSourceImageId: string; rightSourceImageId: string; leftRow: number; rightRow: number; relationIds: string[]; leftOccurrenceIds: string[]; rightOccurrenceIds: string[]; }
export interface ReconcileOrdinaryGroupV1 { groupId: string; occurrenceIds: string[]; primaryOccurrenceId: string; duplicateRelationIds: string[]; }
export interface ReconcileBagDraftV1 { currentCount: number | null; capacity: number | null; reviewReasonCodes: string[]; }
export interface ReconcileExperienceDraftV1 { orange: number | null; purple: number | null; white: number | null; reviewReasonCodes: string[]; }
export interface ReconcileSourceImageRefV1 { sourceImageId: string; sourceOrder: number; suggestedPageType: ImagePool; confirmedPool: ImagePool | null; reviewRequired: boolean; warningCodes: string[]; }
export interface ReconcileOverlapAuditItemV1 { relationId: string; pairId: string; status: OverlapRelationV1["status"]; leftOccurrenceId: string | null; rightOccurrenceId: string | null; reviewReasonCodes: string[]; }
export interface ReconcileDraftV1 {
  schemaVersion: 1;
  task: { taskId: string; accountId: string; baseRevision: number };
  status: "ready_to_finalize" | "requires_review" | "blocked";
  blockReasonCodes: string[];
  candidates: ReconcileCandidateV1[];
  occurrences: EditableOccurrenceStateV1[];
  ordinaryGroups: ReconcileOrdinaryGroupV1[];
  ordinaryReviewItems: OrdinaryReviewItemV1[];
  overlapReviewItems: OverlapReviewItemV1[];
  duplicateRows: ReconcileDuplicateRowV1[];
  excludedOrdinaryOccurrences: Array<{ occurrenceId: string; reasonCode: "incomplete_card"; suggested: ReconcileCandidateV1 }>;
  bag: ReconcileBagDraftV1;
  experience: ReconcileExperienceDraftV1;
  sourceImages: ReconcileSourceImageRefV1[];
  confirmedOverlapPairs: Array<{ pairId: string; sourceImageIdA: string; sourceImageIdB: string }>;
  overlapAuditItems: ReconcileOverlapAuditItemV1[];
  reviewReasonCodes: string[];
}

/** `defer` is an explicit system-pending result, never a user exclusion. */
export type OrdinaryOccurrenceResolutionV1 = { action: "accept_suggested" } | { action: "exclude" } | { action: "defer" } | { action: "edit"; name: string; level: number; quality: Quality };
export type OverlapResolutionV1 = { action: "merge" | "keep_separate" };
export interface ReconcileResolutionV1 {
  ordinary?: Record<string, OrdinaryOccurrenceResolutionV1>;
  overlap?: Record<string, OverlapResolutionV1>;
  bag?: Partial<{ currentCount: number | null; capacity: number | null }>;
  experience?: Partial<{ orange: number | null; purple: number | null; white: number | null }>;
}
export interface ReconciledWorkspaceV1 { workspace: WorkspaceStateV1; sourceImageIds: string[]; starInstanceIds: string[]; }
export interface ReconcilePreviewInventoryItemV1 { previewId: string; groupId: string; primaryOccurrenceId: string; sourceOccurrenceIds: string[]; kind: StarKind; name: string; level: number; quality: Quality; equippedState: EquippedState; sourceOrder: number; sourceImageId: string; row: number; column: number; }
export interface ReconcileSourceImageInput { sourceImageId: string; blob: Blob; filename: string; mimeType: string; width: number | null; height: number | null; }
export interface CommitReconciledAnalysisInput { db: IDBDatabase; draft: ReconcileDraftV1; resolution?: ReconcileResolutionV1; catalog: StarCatalog; gameVersion: GameVersion; sourceImages: ReconcileSourceImageInput[]; reviewRowRects?: Record<string, Record<string, Rect>>; createStarInstanceId?: StarInstanceIdFactory; createRestorePointId?: () => string; }

function legalBaseRevision(value: string | number): number | null {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 ? value : null;
  return typeof value === "string" && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : null;
}

export function assessAnalysisResultForReconcile(result: InternalBrowserAnalysisResultV1, currentAccountId: string, currentRevision: number, activeTaskId: string): ReconcileEligibilityV1 {
  const reasons: ReconcileBlockReason[] = [];
  const baseRevision = legalBaseRevision(result.task.baseRevision);
  if (result.task.status === "partial") reasons.push("partial_requires_retry");
  if (result.task.status === "cancelled") reasons.push("cancelled_result");
  if (result.task.status === "failed") reasons.push("failed_result");
  if (result.review.status === "blocked") reasons.push("analysis_blocked");
  if (result.task.taskId !== activeTaskId) reasons.push("active_task_mismatch");
  if (result.task.accountId !== currentAccountId) reasons.push("account_mismatch");
  if (baseRevision == null) reasons.push("invalid_base_revision");
  else if (baseRevision !== currentRevision) reasons.push("revision_mismatch");
  return { eligible: reasons.length === 0, blockReasonCodes: reasons, baseRevision };
}

function candidateFrom(ref: BrowserAnalysisOccurrenceReferenceV1, catalog: StarCatalog): ReconcileCandidateV1 {
  if (ref.kind !== "ordinary") throw new Error("ordinary occurrence expected");
  const item = ref.occurrence as OrdinaryStarOccurrenceV1;
  const name = item.effectiveName == null ? null : catalog.normalize(item.effectiveName);
  const entry = name == null ? undefined : catalog.entry(name);
  return { occurrenceId: ref.occurrenceId, sourceImageId: ref.sourceImageId, sourceOrder: ref.sourceOrder, row: item.row, column: item.column,
    kind: entry && entry.kind !== "经验星石" ? entry.kind : null, name: entry && entry.kind !== "经验星石" ? entry.name : null,
    level: item.effectiveLevel, quality: item.quality, qualityConfidence: item.qualityConfidence ?? 0, equippedState: item.equippedState };
}
function editableOccurrenceFrom(ref: BrowserAnalysisOccurrenceReferenceV1, catalog: StarCatalog): EditableOccurrenceStateV1 {
  if (ref.kind !== "ordinary") throw new Error("ordinary occurrence expected");
  const item = ref.occurrence as OrdinaryStarOccurrenceV1;
  const name = item.effectiveName == null ? null : catalog.normalize(item.effectiveName);
  const entry = name == null ? undefined : catalog.entry(name);
  return {
    occurrenceId: ref.occurrenceId, sourceImageId: ref.sourceImageId, sourceOrder: ref.sourceOrder, row: item.row, column: item.column,
    completeness: item.completeness, kind: entry && entry.kind !== "经验星石" ? entry.kind : null, name: entry && entry.kind !== "经验星石" ? entry.name : null,
    level: item.effectiveLevel, quality: item.quality, nameConfidence: item.nameConfidence ?? 0, levelConfidence: item.levelConfidence ?? 0, qualityConfidence: item.qualityConfidence ?? 0,
    reviewRequired: item.reviewRequired, inventoryAction: item.completeness === "complete" ? "keep" : "exclude_fragment", removedFromCurrentInventory: false, manualOverride: false, equippedState: item.equippedState,
  };
}
function candidateProblems(candidate: ReconcileCandidateV1): string[] {
  const problems: string[] = [];
  if (candidate.name == null || candidate.kind == null) problems.push("ordinary_name_unresolved");
  if (!Number.isInteger(candidate.level) || candidate.level == null || candidate.level < 1 || candidate.level > 60) problems.push("ordinary_level_unresolved");
  if (candidate.quality == null) problems.push("ordinary_quality_unresolved");
  return problems;
}

/**
 * Product-facing OCR policy: commit every deterministic complete occurrence,
 * retain incomplete evidence for later correction, and never silently merge an
 * unresolved overlap.  This is intentionally separate from the stricter
 * review-before-commit resolver used by lower-level callers.
 */
export function automaticReconcileResolution(draft: ReconcileDraftV1): ReconcileResolutionV1 {
  const ordinary: Record<string, OrdinaryOccurrenceResolutionV1> = {};
  for (const item of draft.ordinaryReviewItems) {
    ordinary[item.occurrenceId] = candidateProblems(item.suggested).length ? { action: "defer" } : { action: "accept_suggested" };
  }
  const overlap: Record<string, OverlapResolutionV1> = {};
  for (const item of draft.overlapReviewItems) overlap[item.rowReviewId] = { action: "keep_separate" };
  const experience: NonNullable<ReconcileResolutionV1["experience"]> = {};
  for (const color of ["orange", "purple", "white"] as const) {
    if (draft.experience.reviewReasonCodes.some((code) => code === `experience_${color}_conflict` || code === `experience_${color}_requires_review`)) experience[color] = draft.experience[color];
  }
  return {
    ...(Object.keys(ordinary).length ? { ordinary } : {}),
    ...(Object.keys(overlap).length ? { overlap } : {}),
    ...(Object.keys(experience).length ? { experience } : {}),
  };
}
function compareCandidate(left: ReconcileCandidateV1, right: ReconcileCandidateV1): boolean {
  return left.kind === right.kind && left.name === right.name && left.level === right.level;
}
function primary(items: ReconcileCandidateV1[]): ReconcileCandidateV1 { return [...items].sort((a, b) => a.sourceOrder - b.sourceOrder || a.row - b.row || a.column - b.column || a.occurrenceId.localeCompare(b.occurrenceId))[0]!; }
class UnionFind {
  private readonly parent = new Map<string, string>();
  constructor(values: Iterable<string>) { for (const value of values) this.parent.set(value, value); }
  root(value: string): string { const parent = this.parent.get(value); if (parent == null) throw new Error(`unknown occurrence ${value}`); if (parent === value) return value; const root = this.root(parent); this.parent.set(value, root); return root; }
  union(left: string, right: string): void { const a = this.root(left); const b = this.root(right); if (a !== b) this.parent.set(b, a); }
  groups(): string[][] { const result = new Map<string, string[]>(); for (const item of this.parent.keys()) { const root = this.root(item); result.set(root, [...(result.get(root) ?? []), item]); } return [...result.values()]; }
}
function groupsFor(candidates: ReconcileCandidateV1[], relations: Array<Pick<OverlapRelationV1, "leftOccurrenceId" | "rightOccurrenceId">>): ReconcileOrdinaryGroupV1[] {
  const byId = new Map(candidates.map((candidate) => [candidate.occurrenceId, candidate])); const union = new UnionFind(byId.keys());
  relations.forEach((relation) => { if (relation.leftOccurrenceId && relation.rightOccurrenceId && byId.has(relation.leftOccurrenceId) && byId.has(relation.rightOccurrenceId)) union.union(relation.leftOccurrenceId, relation.rightOccurrenceId); });
  return union.groups().map((occurrenceIds) => { const preferred = primary(occurrenceIds.map((id) => byId.get(id)!)); return { groupId: `group:${preferred.occurrenceId}`, occurrenceIds: occurrenceIds.sort(), primaryOccurrenceId: preferred.occurrenceId, duplicateRelationIds: [] }; }).sort((a, b) => a.primaryOccurrenceId.localeCompare(b.primaryOccurrenceId));
}
function rowItemsFor(
  prefix: "duplicate-row" | "overlap-row",
  relations: OverlapRelationV1[],
  byId: Map<string, ReconcileCandidateV1>,
): ReconcileDuplicateRowV1[] {
  const rows = new Map<string, OverlapRelationV1[]>();
  for (const relation of relations) {
    const left = relation.leftOccurrenceId ? byId.get(relation.leftOccurrenceId) : undefined;
    const right = relation.rightOccurrenceId ? byId.get(relation.rightOccurrenceId) : undefined;
    if (!left || !right) continue;
    const key = `${relation.pairId}:${left.sourceImageId}:${left.row}:${right.sourceImageId}:${right.row}`;
    rows.set(key, [...(rows.get(key) ?? []), relation]);
  }
  return [...rows].map(([key, rowRelations]) => {
    const ordered = [...rowRelations].sort((leftRelation, rightRelation) => {
      const leftA = byId.get(leftRelation.leftOccurrenceId!)!;
      const leftB = byId.get(rightRelation.leftOccurrenceId!)!;
      return leftA.column - leftB.column || leftRelation.relationId.localeCompare(rightRelation.relationId);
    });
    const left = byId.get(ordered[0]!.leftOccurrenceId!)!;
    const right = byId.get(ordered[0]!.rightOccurrenceId!)!;
    return {
      rowReviewId: `${prefix}:${key}`,
      pairId: ordered[0]!.pairId,
      leftSourceImageId: left.sourceImageId,
      rightSourceImageId: right.sourceImageId,
      leftRow: left.row,
      rightRow: right.row,
      relationIds: ordered.map((relation) => relation.relationId),
      leftOccurrenceIds: ordered.map((relation) => relation.leftOccurrenceId!),
      rightOccurrenceIds: ordered.map((relation) => relation.rightOccurrenceId!),
    };
  }).sort((left, right) => left.rowReviewId.localeCompare(right.rowReviewId));
}
function bagDraft(result: InternalBrowserAnalysisResultV1): ReconcileBagDraftV1 {
  const valid = (value: number | null, status: string) => value != null && Number.isInteger(value) && value >= 0 && (status === "confirmed" || status === "candidate") ? value : null;
  let currentCount = valid(result.inventory.currentCount.value, result.inventory.currentCount.status);
  let capacity = valid(result.inventory.capacity.value, result.inventory.capacity.status);
  const reviewReasonCodes = [...result.inventory.currentCount.reviewReasonCodes, ...result.inventory.capacity.reviewReasonCodes];
  if (currentCount != null && capacity != null && currentCount > capacity) { currentCount = null; capacity = null; reviewReasonCodes.push("bag_count_exceeds_capacity"); }
  return { currentCount, capacity, reviewReasonCodes: [...new Set(reviewReasonCodes)].sort() };
}
function experienceDraft(result: InternalBrowserAnalysisResultV1): ReconcileExperienceDraftV1 {
  const values: Record<"orange" | "purple" | "white", number[]> = { orange: [], purple: [], white: [] };
  for (const image of result.images) { const aggregate = image.analysis?.experienceAggregate; if (!aggregate) continue; for (const [color, value] of [["orange", aggregate.orangeCount], ["purple", aggregate.purpleCount], ["white", aggregate.whiteCount]] as const) if (Number.isInteger(value) && value != null && value >= 0) values[color].push(value); }
  const reasons: string[] = []; const draft = {} as Record<"orange" | "purple" | "white", number | null>;
  for (const color of ["orange", "purple", "white"] as const) { const unique = [...new Set(values[color])]; draft[color] = unique.length === 1 ? unique[0]! : null; if (unique.length > 1) reasons.push(`experience_${color}_conflict`); }
  for (const image of result.images) for (const occurrence of image.analysis?.experienceOccurrences ?? []) {
    if (!occurrence.reviewRequired) continue;
    const color = occurrence.canonicalType;
    reasons.push(color ? `experience_${color}_requires_review` : "experience_type_unresolved");
  }
  return { ...draft, reviewReasonCodes: reasons };
}

export function buildReconcileDraft(result: InternalBrowserAnalysisResultV1, context: { currentAccountId: string; currentRevision: number; activeTaskId: string; catalog: StarCatalog }): ReconcileDraftV1 {
  const eligibility = assessAnalysisResultForReconcile(result, context.currentAccountId, context.currentRevision, context.activeTaskId);
  const ordinaryRefs = result.occurrences.filter((item) => item.kind === "ordinary");
  const occurrences = ordinaryRefs.map((item) => editableOccurrenceFrom(item, context.catalog));
  const excludedOrdinaryOccurrences = ordinaryRefs.filter((item) => item.occurrence.completeness !== "complete").map((item) => ({ occurrenceId: item.occurrenceId, reasonCode: "incomplete_card" as const, suggested: candidateFrom(item, context.catalog) }));
  const candidates = ordinaryRefs.filter((item) => item.occurrence.completeness === "complete").map((item) => candidateFrom(item, context.catalog));
  const byId = new Map(candidates.map((candidate) => [candidate.occurrenceId, candidate]));
  const ordinaryReviewItems: OrdinaryReviewItemV1[] = candidates.flatMap((candidate) => {
    const source = ordinaryRefs.find((item) => item.occurrenceId === candidate.occurrenceId)!;
    const reasonCodes = [...candidateProblems(candidate), ...(source.occurrence.reviewRequired ? ["occurrence_requires_review"] : [])];
    return reasonCodes.length ? [{ occurrenceId: candidate.occurrenceId, reasonCodes: [...new Set(reasonCodes)].sort(), suggested: candidate }] : [];
  });
  const duplicateRelations = result.overlap.relations.filter((relation) => relation.status === "duplicate");
  const overlapReviewItems: OverlapReviewItemV1[] = []; const blocks = [...eligibility.blockReasonCodes];
  const pendingRows = new Map<string, OverlapRelationV1[]>();
  for (const relation of result.overlap.relations) {
    if (relation.status === "possible_duplicate" || relation.status === "ambiguous") {
      const left = relation.leftOccurrenceId ? byId.get(relation.leftOccurrenceId) : undefined; const right = relation.rightOccurrenceId ? byId.get(relation.rightOccurrenceId) : undefined;
      if (!left || !right) { blocks.push("overlap_relation_unavailable"); continue; }
      const key = `${relation.pairId}:${left.sourceImageId}:${left.row}:${right.sourceImageId}:${right.row}`;
      pendingRows.set(key, [...(pendingRows.get(key) ?? []), relation]);
    }
  }
  for (const [key, rowRelations] of pendingRows) {
    const left = byId.get(rowRelations[0]!.leftOccurrenceId!)!; const right = byId.get(rowRelations[0]!.rightOccurrenceId!)!;
    const leftIds = rowRelations.map((relation) => relation.leftOccurrenceId!).sort(); const rightIds = rowRelations.map((relation) => relation.rightOccurrenceId!).sort();
    if (rowRelations.length !== 4 || new Set(leftIds).size !== 4 || new Set(rightIds).size !== 4 || !rowRelations.every((relation) => relation.reviewReasonCodes.includes("overlap_row_requires_review"))) continue;
    overlapReviewItems.push({ rowReviewId: `overlap-row:${key}`, pairId: rowRelations[0]!.pairId, leftSourceImageId: left.sourceImageId, rightSourceImageId: right.sourceImageId, leftRow: left.row, rightRow: right.row, relationIds: rowRelations.map((relation) => relation.relationId).sort(), leftOccurrenceIds: leftIds, rightOccurrenceIds: rightIds, reasonCodes: [...new Set(rowRelations.flatMap((relation) => relation.reviewReasonCodes))].sort() });
  }
  for (const relation of duplicateRelations) {
    const left = relation.leftOccurrenceId ? byId.get(relation.leftOccurrenceId) : undefined; const right = relation.rightOccurrenceId ? byId.get(relation.rightOccurrenceId) : undefined;
    if (!left || !right || !compareCandidate(left, right)) blocks.push("reconcile_duplicate_component_inconsistent");
  }
  const ordinaryGroups = groupsFor(candidates, duplicateRelations);
  const groupByOccurrence = new Map(ordinaryGroups.flatMap((group) => group.occurrenceIds.map((id) => [id, group] as const)));
  for (const relation of duplicateRelations) { const group = relation.leftOccurrenceId ? groupByOccurrence.get(relation.leftOccurrenceId) : undefined; if (group && relation.rightOccurrenceId && group.occurrenceIds.includes(relation.rightOccurrenceId)) group.duplicateRelationIds.push(relation.relationId); }
  ordinaryGroups.forEach((group) => group.duplicateRelationIds.sort());
  const sourceImages = result.images.filter((image) => image.status === "completed" && image.analysis).map((image) => ({ sourceImageId: image.sourceImageId, sourceOrder: image.sourceOrder, suggestedPageType: image.analysis!.pageClassification.pageType, confirmedPool: image.confirmedPool?.pageType ?? null, reviewRequired: image.analysis!.pageClassification.reviewRequired, warningCodes: image.analysis!.warnings })).sort((a, b) => a.sourceOrder - b.sourceOrder || a.sourceImageId.localeCompare(b.sourceImageId));
  const poolsByImageId = new Map(sourceImages.map((image) => [image.sourceImageId, image.confirmedPool]));
  const postprocessRowId = <T extends Pick<OverlapReviewItemV1, "rowReviewId" | "leftSourceImageId" | "rightSourceImageId" | "leftRow" | "rightRow">>(item: T): string => {
    const pool = poolsByImageId.get(item.leftSourceImageId);
    return (pool === "main" || pool === "support") && pool === poolsByImageId.get(item.rightSourceImageId)
      ? `${pool}:${item.leftSourceImageId}:${item.leftRow}->${item.rightSourceImageId}:${item.rightRow}`
      : item.rowReviewId;
  };
  const duplicateRows = rowItemsFor("duplicate-row", duplicateRelations, byId).map((item) => ({ ...item, rowReviewId: postprocessRowId(item) }));
  const normalizedOverlapReviewItems = overlapReviewItems.map((item) => ({ ...item, rowReviewId: postprocessRowId(item) }));
  const reviewReasonCodes = [...new Set(result.review.reasons.map((reason) => reason.code))].sort();
  const experience = experienceDraft(result);
  const bag = bagDraft(result);
  const status: ReconcileDraftV1["status"] = blocks.length ? "blocked" : ordinaryReviewItems.length || overlapReviewItems.length || bag.reviewReasonCodes.length || experience.reviewReasonCodes.length ? "requires_review" : "ready_to_finalize";
  const overlapAuditItems = result.overlap.relations.map((relation) => ({ relationId: relation.relationId, pairId: relation.pairId, status: relation.status, leftOccurrenceId: relation.leftOccurrenceId, rightOccurrenceId: relation.rightOccurrenceId, reviewReasonCodes: [...relation.reviewReasonCodes].sort() })).sort((left, right) => left.relationId.localeCompare(right.relationId));
  return { schemaVersion: 1, task: { taskId: result.task.taskId, accountId: result.task.accountId, baseRevision: eligibility.baseRevision ?? -1 }, status, blockReasonCodes: [...new Set(blocks)].sort(), candidates, occurrences, ordinaryGroups, ordinaryReviewItems, overlapReviewItems: normalizedOverlapReviewItems.sort((left, right) => left.rowReviewId.localeCompare(right.rowReviewId)), duplicateRows, excludedOrdinaryOccurrences, bag, experience, sourceImages, confirmedOverlapPairs: result.overlap.confirmedPairs.map((pair) => ({ ...pair })), overlapAuditItems, reviewReasonCodes };
}

export interface BrowserRuntimeReconcileContextV1 {
  runAccountId: string;
  runBaseRevision: number;
  currentAccountId: string;
  currentRevision: number;
  activeJobId: string;
  catalog: StarCatalog;
}

/**
 * Product adapter for the public OCR result. Account and revision remain in
 * the external run context and are normalized only at this business boundary.
 */
export function buildReconcileDraftFromBrowserRuntime(
  result: BrowserRuntimeAnalysisResultV1,
  context: BrowserRuntimeReconcileContextV1,
): ReconcileDraftV1 {
  const confirmedPools = new Map(result.sourceImages.map((image) => [image.sourceImageId, image.confirmedPool]));
  const normalized: InternalBrowserAnalysisResultV1 = {
    schemaVersion: 1,
    task: {
      taskId: result.job.jobId,
      accountId: context.runAccountId,
      baseRevision: context.runBaseRevision,
      status: result.job.status,
    },
    images: result.images.map((image) => {
      const pool = confirmedPools.get(image.sourceImageId) ?? null;
      return { ...image, confirmedPool: pool };
    }),
    failures: result.failures,
    inventory: result.inventory,
    overlap: result.overlap,
    occurrences: result.occurrences,
    review: result.review,
  };
  return buildReconcileDraft(normalized, {
    currentAccountId: context.currentAccountId,
    currentRevision: context.currentRevision,
    activeTaskId: context.activeJobId,
    catalog: context.catalog,
  });
}

function ensureNullableNonNegative(value: number | null): void { if (value !== null && (!Number.isInteger(value) || value < 0)) throw new WorkspaceDomainError("reconcile_resolution_invalid", "手工数量必须为 null 或非负整数"); }
function applyOrdinaryResolutions(draft: ReconcileDraftV1, resolution: ReconcileResolutionV1, catalog: StarCatalog, strictRequired = true): { candidates: ReconcileCandidateV1[]; excluded: Set<string>; manual: Set<string> } {
  const reviewById = new Map(draft.ordinaryReviewItems.map((item) => [item.occurrenceId, item]));
  const fragmentById = new Map(draft.excludedOrdinaryOccurrences.map((item) => [item.occurrenceId, item.suggested]));
  const excluded = new Set(fragmentById.keys()); const manual = new Set<string>();
  const mergedUnknownIds = new Set(draft.overlapReviewItems.filter((item) => resolution.overlap?.[item.rowReviewId]?.action === "merge").flatMap((item) => [...item.leftOccurrenceIds, ...item.rightOccurrenceIds]));
  const rescuedFragments = draft.excludedOrdinaryOccurrences.filter((item) => {
    const choice = resolution.ordinary?.[item.occurrenceId];
    return choice?.action === "edit" || choice?.action === "accept_suggested";
  }).map((item) => item.suggested);
  const candidates = [...draft.candidates, ...rescuedFragments].map((candidate) => {
    const item = reviewById.get(candidate.occurrenceId); const choice = resolution.ordinary?.[candidate.occurrenceId];
    if (!choice && !item) return candidate;
    if (!choice && mergedUnknownIds.has(candidate.occurrenceId) && candidateProblems(candidate).length > 0) return candidate;
    if (!choice) {
      if (strictRequired) throw new WorkspaceDomainError("reconcile_review_required", `occurrence ${candidate.occurrenceId} 尚未复核`);
      return candidate;
    }
    if (choice.action === "exclude" || choice.action === "defer") { excluded.add(candidate.occurrenceId); return candidate; }
    const next = choice.action === "edit" ? { ...candidate, name: catalog.normalize(choice.name), level: choice.level, quality: choice.quality } : candidate;
    const entry = next.name == null ? undefined : catalog.entry(next.name); next.name = entry?.name ?? null; next.kind = entry && entry.kind !== "经验星石" ? entry.kind : null;
    if (candidateProblems(next).length) throw new WorkspaceDomainError("reconcile_resolution_invalid", `occurrence ${candidate.occurrenceId} 的复核值无效`);
    excluded.delete(candidate.occurrenceId);
    if (choice.action === "edit") manual.add(candidate.occurrenceId); return next;
  });
  return { candidates: candidates.filter((candidate) => !excluded.has(candidate.occurrenceId)), excluded, manual };
}
function resolvedGroups(draft: ReconcileDraftV1, candidates: ReconcileCandidateV1[], resolution: ReconcileResolutionV1, strictRequired = true): ReconcileOrdinaryGroupV1[] {
  const candidateIds = new Set(candidates.map((candidate) => candidate.occurrenceId)); const relations: Array<Pick<OverlapRelationV1, "leftOccurrenceId" | "rightOccurrenceId"> & { relationId?: string }> = [];
  const separatedDuplicateRelationIds = new Set(draft.duplicateRows.filter((item) => resolution.overlap?.[item.rowReviewId]?.action === "keep_separate").flatMap((item) => item.relationIds));
  for (const relation of draft.overlapAuditItems) if (relation.status === "duplicate" && !separatedDuplicateRelationIds.has(relation.relationId) && relation.leftOccurrenceId && relation.rightOccurrenceId) relations.push({ leftOccurrenceId: relation.leftOccurrenceId, rightOccurrenceId: relation.rightOccurrenceId, relationId: relation.relationId });
  for (const item of draft.overlapReviewItems) {
    const choice = resolution.overlap?.[item.rowReviewId];
    if (!choice && strictRequired) throw new WorkspaceDomainError("reconcile_review_required", `overlap row ${item.rowReviewId} 尚未复核`);
    if (choice?.action === "merge") for (let index = 0; index < item.relationIds.length; index += 1) relations.push({ leftOccurrenceId: item.leftOccurrenceIds[index]!, rightOccurrenceId: item.rightOccurrenceIds[index]!, relationId: item.relationIds[index]! });
  }
  const activeRelations = relations.filter((relation) => relation.leftOccurrenceId && relation.rightOccurrenceId && candidateIds.has(relation.leftOccurrenceId) && candidateIds.has(relation.rightOccurrenceId));
  const groups = groupsFor(candidates, activeRelations);
  for (const group of groups) group.duplicateRelationIds = [...new Set(activeRelations.filter((relation) => relation.relationId && relation.leftOccurrenceId && relation.rightOccurrenceId && group.occurrenceIds.includes(relation.leftOccurrenceId) && group.occurrenceIds.includes(relation.rightOccurrenceId)).map((relation) => relation.relationId!))].sort();
  return groups;
}

export function reconciledMergedOccurrenceIds(draft: ReconcileDraftV1, resolution: ReconcileResolutionV1): Set<string> {
  const rescued = draft.excludedOrdinaryOccurrences.filter((item) => {
    const action = resolution.ordinary?.[item.occurrenceId]?.action;
    return action === "edit" || action === "accept_suggested";
  }).map((item) => item.suggested);
  const candidates = [...draft.candidates, ...rescued].filter((candidate) => !["exclude", "defer"].includes(resolution.ordinary?.[candidate.occurrenceId]?.action ?? ""));
  return new Set(resolvedGroups(draft, candidates, resolution, false).flatMap((group) => group.occurrenceIds.filter((occurrenceId) => occurrenceId !== group.primaryOccurrenceId)));
}
function qualityForGroup(members: ReconcileCandidateV1[], manuallyEdited: Set<string>): Quality {
  const manual = members.filter((member): member is ReconcileCandidateV1 & { quality: Quality } => manuallyEdited.has(member.occurrenceId) && member.quality != null);
  if (manual.length) {
    const qualities = [...new Set(manual.map((member) => member.quality))];
    if (qualities.length !== 1) throw new WorkspaceDomainError("reconcile_manual_component_conflict", "同一重叠组件存在冲突的人工品质修改");
    return qualities[0]!;
  }
  const observed = members.filter((member): member is ReconcileCandidateV1 & { quality: Quality } => member.quality != null);
  if (!observed.length) throw new WorkspaceDomainError("reconcile_review_required", "duplicate component 品质尚未解析");
  return [...observed].sort((left, right) => right.qualityConfidence - left.qualityConfidence || left.sourceOrder - right.sourceOrder || left.row - right.row || left.column - right.column || left.occurrenceId.localeCompare(right.occurrenceId))[0]!.quality;
}
function resolveComponent(members: ReconcileCandidateV1[], manuallyEdited: Set<string>, catalog: StarCatalog): { kind: StarKind; name: string; level: number; quality: Quality } {
  const names = [...new Set(members.map((member) => member.name).filter((value): value is string => value != null))];
  if (!names.length) throw new WorkspaceDomainError("reconcile_review_required", "duplicate component 名称尚未解析");
  if (names.length !== 1) throw new WorkspaceDomainError("reconcile_duplicate_component_inconsistent", "duplicate component 名称冲突");
  const entry = catalog.entry(names[0]!);
  if (!entry || entry.kind === "经验星石") throw new WorkspaceDomainError("reconcile_resolution_invalid", "duplicate component 名称无效");
  const kinds = [...new Set(members.map((member) => member.kind).filter((value): value is StarKind => value != null))];
  if (kinds.some((kind) => kind !== entry.kind)) throw new WorkspaceDomainError("reconcile_duplicate_component_inconsistent", "duplicate component 大类冲突");
  const levels = [...new Set(members.map((member) => member.level).filter((value): value is number => value != null && Number.isInteger(value) && value >= 1 && value <= 60))];
  if (!levels.length) throw new WorkspaceDomainError("reconcile_review_required", "duplicate component 等级尚未解析");
  if (levels.length !== 1) throw new WorkspaceDomainError("reconcile_duplicate_component_inconsistent", "duplicate component 等级冲突");
  return { kind: entry.kind, name: entry.name, level: levels[0]!, quality: qualityForGroup(members, manuallyEdited) };
}

export function buildReconcilePreviewInventory(draft: ReconcileDraftV1, resolution: ReconcileResolutionV1, catalog: StarCatalog): ReconcilePreviewInventoryItemV1[] {
  const { candidates, manual } = applyOrdinaryResolutions(draft, resolution, catalog, false);
  const groups = resolvedGroups(draft, candidates, resolution, false);
  const byId = new Map(candidates.map((candidate) => [candidate.occurrenceId, candidate]));
  return groups.flatMap((group) => {
    const primaryCandidate = byId.get(group.primaryOccurrenceId);
    const members = group.occurrenceIds.map((id) => byId.get(id)).filter((item): item is ReconcileCandidateV1 => item != null);
    if (!primaryCandidate || !members.length) return [];
    try {
      const resolved = resolveComponent(members, manual, catalog);
      return [{
        previewId: `preview:${group.groupId}`,
        groupId: group.groupId,
        primaryOccurrenceId: group.primaryOccurrenceId,
        sourceOccurrenceIds: [...group.occurrenceIds],
        kind: resolved.kind,
        name: resolved.name,
        level: resolved.level,
        quality: resolved.quality,
        equippedState: primaryCandidate.equippedState,
        sourceOrder: primaryCandidate.sourceOrder,
        sourceImageId: primaryCandidate.sourceImageId,
        row: primaryCandidate.row,
        column: primaryCandidate.column,
      }];
    } catch {
      return [];
    }
  });
}
function resolvedValue<T extends "orange" | "purple" | "white">(draft: ReconcileExperienceDraftV1, resolution: ReconcileResolutionV1, color: T): { value: number | null; manual: boolean } { const value = resolution.experience && color in resolution.experience ? resolution.experience[color]! : draft[color]; ensureNullableNonNegative(value); if (draft.reviewReasonCodes.some((code) => code === `experience_${color}_conflict` || code === `experience_${color}_requires_review`) && !(resolution.experience && color in resolution.experience)) throw new WorkspaceDomainError("reconcile_review_required", `experience ${color} 尚未复核`); return { value, manual: !!(resolution.experience && color in resolution.experience) }; }

export function finalizeReconcileDraft(draft: ReconcileDraftV1, resolution: ReconcileResolutionV1 = {}, options: { catalog: StarCatalog; gameVersion: GameVersion; createStarInstanceId?: StarInstanceIdFactory } ): ReconciledWorkspaceV1 {
  if (draft.status === "blocked") throw new WorkspaceDomainError("reconcile_blocked", draft.blockReasonCodes.join(",") || "reconcile draft blocked");
  const { candidates, manual } = applyOrdinaryResolutions(draft, resolution, options.catalog); const groups = resolvedGroups(draft, candidates, resolution); const byId = new Map(candidates.map((candidate) => [candidate.occurrenceId, candidate])); const makeId = options.createStarInstanceId ?? defaultStarInstanceId;
  const inventory: StarInstanceV1[] = groups.map((group) => { const primaryCandidate = byId.get(group.primaryOccurrenceId)!; const members = group.occurrenceIds.map((id) => byId.get(id)!); const resolved = resolveComponent(members, manual, options.catalog); const audit = { sourceOccurrenceIds: [...group.occurrenceIds].sort(), duplicateRelationIds: group.duplicateRelationIds, userExcludedOccurrenceIds: [] as string[] }; return { starInstanceId: makeId(), kind: resolved.kind, name: resolved.name, level: resolved.level, quality: resolved.quality, equippedState: primaryCandidate.equippedState, provenance: { sourceOrder: primaryCandidate.sourceOrder, sourceImageId: primaryCandidate.sourceImageId, occurrenceId: primaryCandidate.occurrenceId, row: primaryCandidate.row, column: primaryCandidate.column, audit }, manualStatus: members.some((member) => manual.has(member.occurrenceId)) ? "user_resolved" : "ocr_reconciled" }; });
  if (new Set(inventory.map((item) => item.starInstanceId)).size !== inventory.length || inventory.some((item) => !item.starInstanceId)) throw new WorkspaceDomainError("star_instance_id_invalid", "finalize 生成了重复或空 starInstanceId");
  const bag = { ...draft.bag }; const bagManual = new Set<string>(); for (const field of ["currentCount", "capacity"] as const) if (resolution.bag && field in resolution.bag) { bag[field] = resolution.bag[field]!; bagManual.add(field); } ensureNullableNonNegative(bag.currentCount); ensureNullableNonNegative(bag.capacity); if (bag.currentCount != null && bag.capacity != null && bag.currentCount > bag.capacity) throw new WorkspaceDomainError("reconcile_resolution_invalid", "背包当前数量不能大于容量");
  const orange = resolvedValue(draft.experience, resolution, "orange"); const purple = resolvedValue(draft.experience, resolution, "purple"); const white = resolvedValue(draft.experience, resolution, "white");
  const workspace = createEmptyWorkspace(draft.task.accountId, options.gameVersion); workspace.revision = draft.task.baseRevision; workspace.inventory = inventory; workspace.planTargets = {}; workspace.postprocessRevision = 0;
  workspace.bag = { currentCount: bag.currentCount, capacity: bag.capacity, resolution: { reviewReasonCodes: bag.reviewReasonCodes }, manualFields: [...bagManual].sort() };
  const experienceManualFields: string[] = []; if (orange.manual) experienceManualFields.push("orange"); if (purple.manual) experienceManualFields.push("purple"); if (white.manual) experienceManualFields.push("white");
  workspace.experience = { orange: orange.value, purple: purple.value, white: white.value, evidence: { reviewReasonCodes: draft.experience.reviewReasonCodes }, manualFields: experienceManualFields };
  const pools = new Map(draft.sourceImages.map((image) => [image.sourceImageId, image.confirmedPool])); const overlapPairs = { main: [] as [string, string][], support: [] as [string, string][] };
  for (const pair of draft.confirmedOverlapPairs) { const pool = pools.get(pair.sourceImageIdA); if ((pool === "main" || pool === "support") && pool === pools.get(pair.sourceImageIdB)) overlapPairs[pool].push([pair.sourceImageIdA, pair.sourceImageIdB]); }
  const rowResolutionByRelation = new Map([...draft.overlapReviewItems, ...draft.duplicateRows].flatMap((item) => item.relationIds.map((relationId) => [relationId, resolution.overlap?.[item.rowReviewId]?.action ?? null] as const)));
  const occurrenceStates = Object.fromEntries(draft.occurrences.map((state) => {
    const candidate = byId.get(state.occurrenceId);
    const action = resolution.ordinary?.[state.occurrenceId]?.action;
    const userExcluded = action === "exclude";
    const automaticallyDeferred = action === "defer";
    return [state.occurrenceId, candidate ? { ...state, kind: candidate.kind, name: candidate.name, level: candidate.level, quality: candidate.quality, manualOverride: manual.has(state.occurrenceId), inventoryAction: userExcluded ? "exclude_false_box" as const : "keep" as const } : { ...state, inventoryAction: userExcluded ? "exclude_false_box" as const : automaticallyDeferred ? "exclude_unresolved" as const : state.inventoryAction }];
  }));
  const rowAudits = [
    ...draft.duplicateRows.map((item) => ({ item, status: "duplicate" as const })),
    ...draft.overlapReviewItems.map((item) => ({ item, status: "pending" as const })),
  ].map(({ item, status }) => {
    const pool = pools.get(item.leftSourceImageId);
    return {
      type: "row_overlap",
      rowReviewId: item.rowReviewId,
      pool: pool === "main" || pool === "support" ? pool : "main",
      beforeImageId: item.leftSourceImageId,
      afterImageId: item.rightSourceImageId,
      beforeRow: item.leftRow,
      afterRow: item.rightRow,
      status,
      resolution: resolution.overlap?.[item.rowReviewId]?.action ?? null,
      pairId: item.pairId,
      relationIds: [...item.relationIds],
      occurrenceIds: [...item.leftOccurrenceIds, ...item.rightOccurrenceIds].sort(),
    };
  });
  workspace.importReview = { imagePools: Object.fromEntries(draft.sourceImages.map((image) => [image.sourceImageId, image.confirmedPool ?? image.suggestedPageType])), confirmedImagePools: draft.sourceImages.filter((image) => image.confirmedPool != null).map((image) => image.sourceImageId), overlapPairs, overlapAudit: [...draft.overlapAuditItems.map((item) => ({ ...item, resolution: rowResolutionByRelation.get(item.relationId) ?? null })), ...rowAudits], imageAudit: Object.fromEntries(draft.sourceImages.map((image) => [image.sourceImageId, { sourceOrder: image.sourceOrder, suggestedPageType: image.suggestedPageType, confirmedPool: image.confirmedPool, reviewRequired: image.reviewRequired, warningCodes: image.warningCodes, ordinaryReview: draft.ordinaryReviewItems.filter((item) => item.suggested.sourceImageId === image.sourceImageId).map((item) => ({ occurrenceId: item.occurrenceId, reviewReasonCodes: item.reasonCodes, resolution: resolution.ordinary?.[item.occurrenceId]?.action ?? null, auditReason: resolution.ordinary?.[item.occurrenceId]?.action === "exclude" ? "user_excluded" : resolution.ordinary?.[item.occurrenceId]?.action === "defer" ? "auto_unresolved" : null })) }])), occurrences: occurrenceStates };
  return { workspace: createWorkspaceSnapshot(workspace, options.catalog), sourceImageIds: draft.sourceImages.map((image) => image.sourceImageId), starInstanceIds: inventory.map((item) => item.starInstanceId) };
}

export async function commitReconciledAnalysis(input: CommitReconciledAnalysisInput): Promise<WorkspaceRecord> {
  const current = await getWorkspace(input.db, input.draft.task.accountId);
  if (current && current.snapshot.gameVersion !== input.gameVersion) throw new WorkspaceDomainError("workspace_game_version_mismatch", "当前 workspace gameVersion 与提交上下文不一致");
  const finalized = finalizeReconcileDraft(input.draft, input.resolution, { catalog: input.catalog, gameVersion: input.gameVersion, createStarInstanceId: input.createStarInstanceId });
  const provided = new Map(input.sourceImages.map((image) => [image.sourceImageId, image])); if (finalized.sourceImageIds.some((id) => !provided.has(id))) throw new WorkspaceDomainError("reconcile_source_images_missing", "缺少正式提交所需 source image Blob");
  for (const sourceImageId of finalized.sourceImageIds) {
    const audit = finalized.workspace.importReview.imageAudit[sourceImageId];
    const source = provided.get(sourceImageId)!;
    if (audit && typeof audit === "object" && !Array.isArray(audit)) {
      finalized.workspace.importReview.imageAudit[sourceImageId] = { ...audit as Record<string, unknown>, filename: source.filename, ...(input.reviewRowRects?.[sourceImageId] ? { reviewRowRects: input.reviewRowRects[sourceImageId] } : {}) } as unknown as JsonValue;
    }
  }
  const selectedIds = new Set(finalized.sourceImageIds); const oldImages = await listImagesForAccount(input.db, input.draft.task.accountId); const selected = finalized.sourceImageIds.map((id) => provided.get(id)!);
  const toRecord = (image: ReconcileSourceImageInput): Omit<ImageRecord, "accountId"> => ({ imageId: image.sourceImageId, blob: image.blob, filename: image.filename, mimeType: image.mimeType, width: image.width, height: image.height, createdAt: new Date().toISOString() });
  const restorePoint = current ? { restorePointId: (input.createRestorePointId ?? defaultStarInstanceId)(), reason: "pre_ocr_rebuild", createdAt: new Date().toISOString(), imageIds: oldImages.map((image) => image.imageId), images: oldImages.map((image) => ({ imageId: image.imageId, blob: image.blob, metadata: { filename: image.filename, mimeType: image.mimeType, width: image.width, height: image.height } })) } : undefined;
  const committed = await commitWorkspaceTransaction(input.db, { accountId: input.draft.task.accountId, expectedRevision: input.draft.task.baseRevision, nextSnapshot: finalized.workspace, imageUpserts: selected.map(toRecord), imageDeletes: oldImages.map((image) => image.imageId).filter((id) => !selectedIds.has(id)), optionalRestorePoint: restorePoint });
  const reloaded = await getWorkspace(input.db, input.draft.task.accountId); if (!reloaded || reloaded.revision !== committed.revision) throw new Error("workspace reload verification failed"); return committed;
}
