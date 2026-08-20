import { type ReconcileCandidateV1, type ReconcileDraftV1, type ReconcileResolutionV1 } from "./business/reconcile.js";
import type { StarCatalog } from "./business/catalog.js";
import type { Quality } from "./business/model.js";
import type { ProductReviewEvidenceV1 } from "./product-ocr-review.js";

export type ProductReviewCandidateKind = "required" | "duplicate" | "fragment" | "clean";
export type ProductReviewCandidateTier = 1 | 2 | 3;
export type ProductReviewCandidateAction = "view_source" | "keep" | "ignore" | "edit" | "confirm_duplicate" | "keep_separate";

export interface ProductReviewCandidateV1 {
  occurrenceId: string;
  sourceImageId: string;
  sourceOrder: number;
  row: number;
  column: number;
  kind: ProductReviewCandidateKind;
  tier: ProductReviewCandidateTier;
  name: string | null;
  level: number | null;
  quality: Quality | null;
  reasonCodes: string[];
  duplicateRowId: string | null;
  overlapPending: boolean;
  edited: boolean;
  processed: "checked" | "ignored" | null;
}

/** A pending overlap is a row relation, never a normal occurrence decision. */
export function productReviewCandidateActions(candidate: Pick<ProductReviewCandidateV1, "overlapPending">): ProductReviewCandidateAction[] {
  return candidate.overlapPending ? ["view_source", "confirm_duplicate", "keep_separate"] : ["view_source", "keep", "ignore", "edit"];
}

/** A confirmed duplicate keeps the normal-card handler, but names its row-level outcome explicitly. */
export function productReviewKeepActionLabel(candidate: Pick<ProductReviewCandidateV1, "kind" | "overlapPending">): "保留" | "保持独立" {
  return candidate.kind === "duplicate" && !candidate.overlapPending ? "保持独立" : "保留";
}

export function splitProductReviewImagesForDesktop<T>(items: readonly T[]): { left: T[]; right: T[] } {
  return { left: items.filter((_, index) => index % 2 === 0), right: items.filter((_, index) => index % 2 === 1) };
}

function candidateValues(candidate: ReconcileCandidateV1, resolution: ReconcileResolutionV1): Pick<ReconcileCandidateV1, "name" | "level" | "quality"> {
  const choice = resolution.ordinary?.[candidate.occurrenceId];
  return choice?.action === "edit" ? { name: choice.name, level: choice.level, quality: choice.quality } : candidate;
}

function duplicateRowByOccurrence(draft: ReconcileDraftV1, resolution: ReconcileResolutionV1): Map<string, { rowReviewId: string; pending: boolean }> {
  const result = new Map<string, { rowReviewId: string; pending: boolean }>();
  for (const row of draft.duplicateRows) {
    if (resolution.overlap?.[row.rowReviewId]?.action === "keep_separate") continue;
    for (const occurrenceId of [...row.leftOccurrenceIds, ...row.rightOccurrenceIds]) if (!result.has(occurrenceId)) result.set(occurrenceId, { rowReviewId: row.rowReviewId, pending: false });
  }
  for (const row of draft.overlapReviewItems) {
    if (resolution.overlap?.[row.rowReviewId]) continue;
    const owner = [...row.rightOccurrenceIds].sort()[0];
    if (owner) result.set(owner, { rowReviewId: row.rowReviewId, pending: true });
  }
  return result;
}

export function buildProductReviewCandidates(
  draft: ReconcileDraftV1,
  resolution: ReconcileResolutionV1,
  evidence: ProductReviewEvidenceV1,
  completedOccurrenceIds: ReadonlySet<string>,
): ProductReviewCandidateV1[] {
  const requiredById = new Map(draft.ordinaryReviewItems.map((item) => [item.occurrenceId, item]));
  const fragmentById = new Map(draft.excludedOrdinaryOccurrences.map((item) => [item.occurrenceId, item]));
  const duplicateById = duplicateRowByOccurrence(draft, resolution);
  const candidates = [...draft.candidates, ...draft.excludedOrdinaryOccurrences.map((item) => item.suggested)];
  const evidenceById = new Map(evidence.occurrences.map((item) => [item.occurrenceId, item]));
  return candidates.flatMap((candidate) => {
    const choice = resolution.ordinary?.[candidate.occurrenceId];
    const required = requiredById.get(candidate.occurrenceId);
    const fragment = fragmentById.get(candidate.occurrenceId);
    const values = candidateValues(candidate, resolution);
    const needsCoreFields = values.name == null || values.level == null || values.quality == null;
    const duplicate = duplicateById.get(candidate.occurrenceId);
    const duplicateRowId = duplicate?.rowReviewId ?? null;
    const ordinaryResolved = choice?.action === "exclude" || choice?.action === "accept_suggested" || completedOccurrenceIds.has(candidate.occurrenceId);
    const ordinaryNeedsReview = !!required && !ordinaryResolved;
    const kind: ProductReviewCandidateKind = fragment ? "fragment" : ordinaryNeedsReview || needsCoreFields ? "required" : duplicateRowId ? "duplicate" : "clean";
    const processed = choice?.action === "exclude" ? "ignored" as const : choice?.action === "accept_suggested" || completedOccurrenceIds.has(candidate.occurrenceId) ? "checked" as const : null;
    const tier: ProductReviewCandidateTier = ordinaryNeedsReview || duplicate?.pending ? 1 : processed === "ignored" || kind === "fragment" || kind === "duplicate" ? 2 : 3;
    const source = evidenceById.get(candidate.occurrenceId);
    return [{
      occurrenceId: candidate.occurrenceId,
      sourceImageId: candidate.sourceImageId,
      sourceOrder: candidate.sourceOrder,
      row: candidate.row,
      column: candidate.column,
      kind,
      tier,
      name: values.name,
      level: values.level,
      quality: values.quality,
      reasonCodes: required ? required.reasonCodes : fragment ? [fragment.reasonCode] : [],
      duplicateRowId,
      overlapPending: duplicate?.pending ?? false,
      edited: choice?.action === "edit",
      processed,
      ...(source ? { row: source.row, column: source.column } : {}),
    }];
  }).sort((left, right) => {
    const secondaryPriority = (candidate: ProductReviewCandidateV1): number => candidate.tier === 2 ? candidate.processed === "ignored" || candidate.kind === "fragment" ? 0 : candidate.kind === "duplicate" ? 1 : 2 : 0;
    return left.tier - right.tier
      || secondaryPriority(left) - secondaryPriority(right)
      || left.sourceOrder - right.sourceOrder
      || left.row - right.row
      || left.column - right.column
      || left.occurrenceId.localeCompare(right.occurrenceId);
  });
}

export function productReviewCandidatesForImage(candidates: ProductReviewCandidateV1[], sourceImageId: string, showAll: boolean): ProductReviewCandidateV1[] {
  const imageCandidates = candidates.filter((candidate) => candidate.sourceImageId === sourceImageId);
  if (showAll) return imageCandidates;
  const defaultTier: ProductReviewCandidateTier | null = imageCandidates.some((candidate) => candidate.tier === 1) ? 1 : imageCandidates.some((candidate) => candidate.tier === 2) ? 2 : null;
  return defaultTier == null ? [] : imageCandidates.filter((candidate) => candidate.tier === defaultTier);
}

export function isProductReviewCandidateComplete(candidate: Pick<ProductReviewCandidateV1, "name" | "level" | "quality">, catalog: StarCatalog): boolean {
  if (candidate.name == null || candidate.level == null || candidate.quality == null) return false;
  const entry = catalog.entry(catalog.normalize(candidate.name));
  return !!entry && entry.kind !== "经验星石" && Number.isInteger(candidate.level) && candidate.level >= 1 && candidate.level <= 60;
}
