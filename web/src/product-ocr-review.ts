import { type ReconcileCandidateV1, type ReconcileDraftV1, type ReconcileResolutionV1 } from "./business/reconcile.js";
import type { EditableOccurrenceStateV1, ImagePool, WorkspaceStateV1 } from "./business/model.js";
import type { BrowserAnalysisResultV1 } from "./ocr/browser-analysis-contract.js";
import type { OrdinaryStarOccurrenceV1, PageType, Quality, Rect } from "./structured/contracts.js";

export interface ProductReviewOccurrenceEvidenceV1 {
  occurrenceId: string;
  sourceImageId: string;
  row: number;
  column: number;
  completeness: "complete" | "partial_top" | "partial_bottom" | "invalid";
  sourceRect: { card: Rect; name: Rect; level: Rect; quality: Rect; equipped: Rect };
  name: string | null;
  level: number | null;
  quality: Quality | null;
}

export interface ProductReviewImageEvidenceV1 {
  sourceImageId: string;
  sourceOrder: number;
  pageType: PageType;
  reviewRequired: boolean;
  warningCodes: string[];
  candidateCount: number;
}

export interface ProductReviewEvidenceV1 {
  images: ProductReviewImageEvidenceV1[];
  occurrences: ProductReviewOccurrenceEvidenceV1[];
  /** JSON-safe row geometry is retained only to rebuild canvas crops after reload. */
  rowRects?: Record<string, Rect>;
}

export interface PersistedProductReviewV1 { draft: ReconcileDraftV1; resolution: ReconcileResolutionV1; evidence: ProductReviewEvidenceV1; }

export interface ProductReviewImageSummaryV1 extends ProductReviewImageEvidenceV1 {
  pendingCount: number;
  tier2Count: number;
  excludedCount: number;
  overlapDuplicateCount: number;
  overlapPendingCount: number;
  attentionRequired: boolean;
  displayPriority: 0 | 1 | 2;
}

export function selectActiveReviewScrollContainer<T>(items: readonly T[], isVisible: (item: T) => boolean): T | null {
  return items.find(isVisible) ?? null;
}

/** The desktop and mobile review lists coexist in the DOM; only the visible one owns scroll state. */
export function getActiveReviewScrollContainer(root: HTMLElement): HTMLElement | null {
  const containers = [...root.querySelectorAll<HTMLElement>(".pending-review-scroll")];
  return selectActiveReviewScrollContainer(containers, (container) => {
    if (container.hidden || container.offsetParent == null) return false;
    return window.getComputedStyle(container).display !== "none" && window.getComputedStyle(container).visibility !== "hidden";
  });
}

/** UI-only participation counts: duplicate endpoints remain symmetric without affecting inventory merging. */
export function activeDuplicateOccurrenceIdsByImage(draft: ReconcileDraftV1, resolution: ReconcileResolutionV1): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const row of draft.duplicateRows) {
    if (resolution.overlap?.[row.rowReviewId]?.action === "keep_separate") continue;
    const add = (sourceImageId: string, occurrenceIds: string[]) => {
      const ids = result.get(sourceImageId) ?? new Set<string>();
      occurrenceIds.forEach((occurrenceId) => ids.add(occurrenceId));
      result.set(sourceImageId, ids);
    };
    add(row.leftSourceImageId, row.leftOccurrenceIds);
    add(row.rightSourceImageId, row.rightOccurrenceIds);
  }
  return result;
}

const directReasonLabels: Record<string, string> = {
  ordinary_name_unresolved: "名称未知",
  ordinary_level_unresolved: "等级未知",
  ordinary_quality_unresolved: "品质未知",
  occurrence_requires_review: "需要人工复核",
  incomplete_card: "卡片残缺",
  overlap_row_requires_review: "重叠行需要确认",
  bag_count_exceeds_capacity: "背包数量大于容量",
  inventory_header_requires_review: "背包信息需要确认",
  inventory_count_requires_review: "背包数量需要确认",
  inventory_capacity_requires_review: "背包容量需要确认",
};

function experienceColorLabel(code: string): string {
  if (code.includes("orange")) return "橙色";
  if (code.includes("purple")) return "紫色";
  if (code.includes("white")) return "白色";
  return "经验星曜";
}

export function productReviewReasonLabel(code: string): string {
  const direct = directReasonLabels[code];
  if (direct) return direct;
  if (code.startsWith("experience_") && code.endsWith("_conflict")) return `${experienceColorLabel(code)}经验星曜数量存在冲突`;
  if (code.startsWith("experience_") && code.endsWith("_requires_review")) return `${experienceColorLabel(code)}经验星曜数量需要确认`;
  if (code.startsWith("inventory_")) return "背包信息需要确认";
  return "需要人工复核";
}

export function productReviewReasonText(codes: Iterable<string>): string {
  return [...new Set([...codes].map(productReviewReasonLabel))].join("、") || "需要人工复核";
}

export function buildProductReviewEvidence(result: BrowserAnalysisResultV1): ProductReviewEvidenceV1 {
  const images = result.images.flatMap((image) => image.status === "completed" && image.analysis ? [{
    sourceImageId: image.sourceImageId,
    sourceOrder: image.sourceOrder,
    pageType: image.analysis.pageClassification.pageType,
    reviewRequired: image.analysis.pageClassification.reviewRequired,
    warningCodes: [...new Set([...(image.analysis.warnings ?? []), ...(image.analysis.pageClassification.warning ? [image.analysis.pageClassification.warning] : [])])],
    candidateCount: image.analysis.occurrences.length + image.analysis.experienceOccurrences.length,
  }] : []).sort((left, right) => left.sourceOrder - right.sourceOrder || left.sourceImageId.localeCompare(right.sourceImageId));
  const occurrences = result.occurrences.flatMap((reference) => {
    if (reference.kind !== "ordinary") return [];
    const occurrence = reference.occurrence as OrdinaryStarOccurrenceV1;
    return [{
      occurrenceId: reference.occurrenceId,
      sourceImageId: reference.sourceImageId,
      row: occurrence.row,
      column: occurrence.column,
      completeness: occurrence.completeness,
      sourceRect: occurrence.sourceRect,
      name: occurrence.effectiveName,
      level: occurrence.effectiveLevel,
      quality: occurrence.quality,
    } satisfies ProductReviewOccurrenceEvidenceV1];
  });
  return { images, occurrences };
}

function record(value: unknown): Record<string, unknown> | null { return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function rectFrom(value: unknown): Rect | null {
  const rect = record(value);
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every((item) => typeof item === "number" && Number.isFinite(item))) return null;
  return rect as unknown as Rect;
}
function persistedCandidate(state: EditableOccurrenceStateV1): ReconcileCandidateV1 {
  return { occurrenceId: state.occurrenceId, sourceImageId: state.sourceImageId, sourceOrder: state.sourceOrder, row: state.row, column: state.column, kind: state.kind, name: state.name, level: state.level, quality: state.quality, qualityConfidence: state.qualityConfidence, equippedState: state.equippedState };
}

/** Rebuilds the post-save review UI from existing JSON-safe Workspace evidence. */
export function buildPersistedProductReview(workspace: WorkspaceStateV1): PersistedProductReviewV1 | null {
  const review = workspace.importReview;
  const imageIds = Object.keys(review.imagePools);
  if (!imageIds.length) return null;
  const imageMeta = new Map(imageIds.map((sourceImageId) => [sourceImageId, record(review.imageAudit[sourceImageId]) ?? {}]));
  const occurrences = Object.values(review.occurrences);
  const candidates = occurrences.filter((item) => item.completeness === "complete").map(persistedCandidate);
  const excludedOrdinaryOccurrences = occurrences.filter((item) => item.completeness !== "complete").map((item) => ({ occurrenceId: item.occurrenceId, reasonCode: "incomplete_card" as const, suggested: persistedCandidate(item) }));
  const ordinaryReviewItems = candidates.flatMap((candidate) => {
    const auditItems = Array.isArray(imageMeta.get(candidate.sourceImageId)?.ordinaryReview) ? imageMeta.get(candidate.sourceImageId)?.ordinaryReview as unknown[] : [];
    const audit = auditItems.map(record).find((item) => item?.occurrenceId === candidate.occurrenceId);
    const reasons = stringArray(audit?.reviewReasonCodes);
    const missing = candidate.name == null || candidate.level == null || candidate.quality == null;
    return missing || reasons.length ? [{ occurrenceId: candidate.occurrenceId, reasonCodes: reasons.length ? reasons : ["ordinary_fields_unresolved"], suggested: candidate }] : [];
  });
  const duplicateRows: ReconcileDraftV1["duplicateRows"] = [];
  const overlapReviewItems: ReconcileDraftV1["overlapReviewItems"] = [];
  const overlap: NonNullable<ReconcileResolutionV1["overlap"]> = {};
  const overlapAuditItems: ReconcileDraftV1["overlapAuditItems"] = review.overlapAudit.flatMap((auditValue) => {
    const audit = record(auditValue);
    if (audit?.type === "row_overlap" || typeof audit?.relationId !== "string" || typeof audit.pairId !== "string") return [];
    if (!["duplicate", "possible_duplicate", "not_duplicate", "ambiguous", "unavailable"].includes(audit.status as string)) return [];
    return [{ relationId: audit.relationId, pairId: audit.pairId, status: audit.status as ReconcileDraftV1["overlapAuditItems"][number]["status"], leftOccurrenceId: typeof audit.leftOccurrenceId === "string" ? audit.leftOccurrenceId : null, rightOccurrenceId: typeof audit.rightOccurrenceId === "string" ? audit.rightOccurrenceId : null, reviewReasonCodes: stringArray(audit.reviewReasonCodes) }];
  });
  for (const auditValue of review.overlapAudit) {
    const audit = record(auditValue);
    if (audit?.type !== "row_overlap" || typeof audit.rowReviewId !== "string" || typeof audit.beforeImageId !== "string" || typeof audit.afterImageId !== "string" || typeof audit.beforeRow !== "number" || typeof audit.afterRow !== "number") continue;
    const occurrenceIds = stringArray(audit.occurrenceIds);
    const leftOccurrenceIds = occurrenceIds.filter((id) => review.occurrences[id]?.sourceImageId === audit.beforeImageId);
    const rightOccurrenceIds = occurrenceIds.filter((id) => review.occurrences[id]?.sourceImageId === audit.afterImageId);
    const relationIds = stringArray(audit.relationIds);
    const restoredRelationIds = relationIds.length ? relationIds : overlapAuditItems.filter((relation) => relation.leftOccurrenceId != null && relation.rightOccurrenceId != null && leftOccurrenceIds.includes(relation.leftOccurrenceId) && rightOccurrenceIds.includes(relation.rightOccurrenceId)).map((relation) => relation.relationId);
    const item = { rowReviewId: audit.rowReviewId, pairId: typeof audit.pairId === "string" ? audit.pairId : audit.rowReviewId, leftSourceImageId: audit.beforeImageId, rightSourceImageId: audit.afterImageId, leftRow: audit.beforeRow, rightRow: audit.afterRow, relationIds: restoredRelationIds, leftOccurrenceIds, rightOccurrenceIds };
    if (audit.status === "duplicate" || audit.resolution === "merge") duplicateRows.push(item); else if (audit.status !== "invalidated") overlapReviewItems.push({ ...item, reasonCodes: ["overlap_row_requires_review"] });
    if (audit.resolution === "merge" || audit.resolution === "keep_separate") overlap[audit.rowReviewId] = { action: audit.resolution };
  }
  const ordinary: NonNullable<ReconcileResolutionV1["ordinary"]> = {};
  for (const state of occurrences) {
    const imageAudit = imageMeta.get(state.sourceImageId);
    const audited = Array.isArray(imageAudit?.ordinaryReview) ? imageAudit?.ordinaryReview as unknown[] : [];
    const audit = audited.map(record).find((item) => item?.occurrenceId === state.occurrenceId);
    if (state.reviewResolution === "ignored") ordinary[state.occurrenceId] = { action: "exclude" };
    else if (state.reviewResolution === "accepted") ordinary[state.occurrenceId] = { action: "accept_suggested" };
    else if (state.manualOverride && state.name && state.level != null && state.quality) ordinary[state.occurrenceId] = { action: "edit", name: state.name, level: state.level, quality: state.quality };
    else if (audit?.resolution === "defer" || audit?.auditReason === "auto_unresolved") ordinary[state.occurrenceId] = { action: "defer" };
    else if (audit?.auditReason === "user_excluded") ordinary[state.occurrenceId] = { action: "exclude" };
  }
  const rowRects: Record<string, Rect> = {};
  for (const sourceImageId of imageIds) {
    const persistedRects = record(imageMeta.get(sourceImageId)?.reviewRowRects);
    for (const [row, value] of Object.entries(persistedRects ?? {})) { const rect = rectFrom(value); if (rect) rowRects[productReviewRowKey(sourceImageId, Number(row))] = rect; }
  }
  const sourceImages = imageIds.map((sourceImageId) => {
    const metadata = imageMeta.get(sourceImageId) ?? {};
    const pool = review.imagePools[sourceImageId] as ImagePool;
    return { sourceImageId, sourceOrder: typeof metadata.sourceOrder === "number" ? metadata.sourceOrder : Number.MAX_SAFE_INTEGER, suggestedPageType: pool, confirmedPool: review.confirmedImagePools.includes(sourceImageId) ? pool : null, reviewRequired: metadata.reviewRequired === true, warningCodes: stringArray(metadata.warningCodes) };
  }).sort((left, right) => left.sourceOrder - right.sourceOrder || left.sourceImageId.localeCompare(right.sourceImageId));
  const evidence: ProductReviewEvidenceV1 = {
    images: sourceImages.map((image) => ({ sourceImageId: image.sourceImageId, sourceOrder: image.sourceOrder, pageType: image.confirmedPool ?? image.suggestedPageType, reviewRequired: image.reviewRequired, warningCodes: image.warningCodes, candidateCount: occurrences.filter((item) => item.sourceImageId === image.sourceImageId).length })),
    occurrences: occurrences.map((item) => ({ occurrenceId: item.occurrenceId, sourceImageId: item.sourceImageId, row: item.row, column: item.column, completeness: item.completeness, sourceRect: { card: { x: 0, y: 0, width: 0, height: 0 }, name: { x: 0, y: 0, width: 0, height: 0 }, level: { x: 0, y: 0, width: 0, height: 0 }, quality: { x: 0, y: 0, width: 0, height: 0 }, equipped: { x: 0, y: 0, width: 0, height: 0 } }, name: item.name, level: item.level, quality: item.quality })),
    rowRects,
  };
  const ordinaryGroups = candidates.map((candidate) => ({ groupId: `group:${candidate.occurrenceId}`, occurrenceIds: [candidate.occurrenceId], primaryOccurrenceId: candidate.occurrenceId, duplicateRelationIds: [] }));
  return { draft: { schemaVersion: 1, task: { taskId: "persisted-review", accountId: workspace.accountId, baseRevision: workspace.revision }, status: "ready_to_finalize", blockReasonCodes: [], candidates, occurrences, ordinaryGroups, ordinaryReviewItems, overlapReviewItems, duplicateRows, excludedOrdinaryOccurrences, bag: { currentCount: workspace.bag.currentCount, capacity: workspace.bag.capacity, reviewReasonCodes: [] }, experience: { orange: workspace.experience.orange, purple: workspace.experience.purple, white: workspace.experience.white, reviewReasonCodes: [] }, sourceImages, confirmedOverlapPairs: [], overlapAuditItems, reviewReasonCodes: [] }, resolution: { ...(Object.keys(ordinary).length ? { ordinary } : {}), ...(Object.keys(overlap).length ? { overlap } : {}) }, evidence };
}

export function buildProductReviewImageSummaries(
  draft: ReconcileDraftV1,
  resolution: ReconcileResolutionV1,
  evidence: ProductReviewEvidenceV1,
  completedOccurrenceIds: ReadonlySet<string> = new Set(),
): ProductReviewImageSummaryV1[] {
  const occurrenceById = new Map(evidence.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
  const excludedIds = new Set(draft.excludedOrdinaryOccurrences
    .filter((item) => !["edit", "accept_suggested"].includes(resolution.ordinary?.[item.occurrenceId]?.action ?? ""))
    .map((item) => item.occurrenceId));
  Object.entries(resolution.ordinary ?? {}).filter(([, choice]) => choice.action === "exclude").forEach(([occurrenceId]) => excludedIds.add(occurrenceId));
  const activeDuplicateIds = activeDuplicateOccurrenceIdsByImage(draft, resolution);
  return evidence.images.filter((image) => image.pageType !== "experience").map((image) => {
    const ordinaryPending = draft.ordinaryReviewItems.filter((item) => {
      const action = resolution.ordinary?.[item.occurrenceId]?.action;
      return item.suggested.sourceImageId === image.sourceImageId && action !== "accept_suggested" && action !== "exclude" && !completedOccurrenceIds.has(item.occurrenceId);
    }).length;
    const overlapPending = draft.overlapReviewItems.filter((item) => item.rightSourceImageId === image.sourceImageId && !resolution.overlap?.[item.rowReviewId]).length;
    const excludedCount = [...excludedIds].filter((occurrenceId) => occurrenceById.get(occurrenceId)?.sourceImageId === image.sourceImageId).length;
    const overlapDuplicateCount = activeDuplicateIds.get(image.sourceImageId)?.size ?? 0;
    const fragmentCount = draft.excludedOrdinaryOccurrences.filter((item) => item.suggested.sourceImageId === image.sourceImageId && !["edit", "accept_suggested"].includes(resolution.ordinary?.[item.occurrenceId]?.action ?? "")).length;
    const manualEditCount = Object.entries(resolution.ordinary ?? {}).filter(([occurrenceId, choice]) => choice.action === "edit" && occurrenceById.get(occurrenceId)?.sourceImageId === image.sourceImageId).length;
    const pendingCount = ordinaryPending + overlapPending;
    const tier2Count = new Set([...excludedIds].filter((occurrenceId) => occurrenceById.get(occurrenceId)?.sourceImageId === image.sourceImageId)).size + overlapDuplicateCount + fragmentCount + manualEditCount;
    const displayPriority: 0 | 1 | 2 = pendingCount > 0 ? 0 : tier2Count > 0 ? 1 : 2;
    return { ...image, pendingCount, tier2Count, excludedCount, overlapDuplicateCount, overlapPendingCount: overlapPending, attentionRequired: displayPriority < 2, displayPriority };
  }).sort((left, right) => left.displayPriority - right.displayPriority || left.sourceOrder - right.sourceOrder || left.sourceImageId.localeCompare(right.sourceImageId));
}

export function productReviewRowKey(sourceImageId: string, row: number): string { return `${sourceImageId}:row:${row}`; }

export function productReviewRowCropRect(
  evidence: ProductReviewEvidenceV1,
  sourceImageId: string,
  row: number,
  bounds?: { width: number; height: number },
): Rect | null {
  const persisted = evidence.rowRects?.[productReviewRowKey(sourceImageId, row)];
  if (persisted) return persisted;
  const rects = evidence.occurrences.filter((occurrence) => occurrence.sourceImageId === sourceImageId && occurrence.row === row)
    .flatMap((occurrence) => [occurrence.sourceRect.card, occurrence.sourceRect.name, occurrence.sourceRect.level])
    .filter((rect) => [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0);
  if (!rects.length) return null;
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  const rowHeight = bottom - top;
  const horizontalPadding = Math.max(4, rowHeight * .04);
  const topPadding = Math.max(6, rowHeight * .16);
  const bottomPadding = Math.max(4, rowHeight * .09);
  const x = Math.max(0, Math.floor(left - horizontalPadding));
  const y = Math.max(0, Math.floor(top - topPadding));
  const maxRight = bounds ? Math.min(bounds.width, Math.ceil(right + horizontalPadding)) : Math.ceil(right + horizontalPadding);
  const maxBottom = bounds ? Math.min(bounds.height, Math.ceil(bottom + bottomPadding)) : Math.ceil(bottom + bottomPadding);
  const width = maxRight - x;
  const height = maxBottom - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}
