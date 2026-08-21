import type {
  BrowserImageAnalysisV1,
  BrowserImageInput,
  BrowserVisionEngine,
  ConfirmedImagePool,
  ExperienceOccurrenceV1,
  NumericFieldObservationV1,
  OrdinaryStarOccurrenceV1,
  VisionAssetConfig,
} from "./contracts.js";
import { INVENTORY_CONFIDENCE_THRESHOLD } from "./inventory-header.js";

export const BROWSER_BATCH_ANALYSIS_SCHEMA_VERSION = "1.0" as const;

export interface BrowserBatchImageInputV1 {
  sourceImageId: string;
  input: BrowserImageInput;
  confirmedPool?: ConfirmedImagePool;
  sourceOrder: number;
}

export interface BrowserBatchTaskV1 {
  schemaVersion: typeof BROWSER_BATCH_ANALYSIS_SCHEMA_VERSION;
  taskId: string;
  accountId: string;
  baseRevision: string | number;
  images: BrowserBatchImageInputV1[];
  /** Only these user-confirmed pairs are eligible for overlap analysis. */
  confirmedOverlapPairs?: ConfirmedOverlapPairV1[];
}

export interface ConfirmedOverlapPairV1 {
  pairId: string;
  sourceImageIdA: string;
  sourceImageIdB: string;
}

export interface OverlapEvidenceV1 {
  comparedFields: Array<"name" | "level">;
  matchingFields: Array<"name" | "level">;
  conflictingFields: Array<"name" | "level">;
  unavailableFields: Array<"name" | "level">;
  visualSimilarity: number | null;
  detail: string;
}

export interface OverlapRelationV1 {
  relationId: string;
  pairId: string;
  leftOccurrenceId: string | null;
  rightOccurrenceId: string | null;
  status: "duplicate" | "possible_duplicate" | "not_duplicate" | "ambiguous" | "unavailable";
  evidence: OverlapEvidenceV1;
  reviewReasonCodes: string[];
}

export interface AggregatedNumericSourceV1 {
  sourceImageId: string;
  sourceOrder: number;
  value: number | null;
  status: NumericFieldObservationV1["status"];
  confidence: number | null;
  rawText: string | null;
  normalizedText: string | null;
}

export interface AggregatedNumericFieldV1 {
  value: number | null;
  status: "unknown" | "candidate" | "confirmed" | "conflict" | "invalid";
  sources: AggregatedNumericSourceV1[];
  reviewReasonCodes: string[];
}

export interface InventorySummaryV1 {
  currentCount: AggregatedNumericFieldV1;
  capacity: AggregatedNumericFieldV1;
  status: "confirmed" | "partial" | "unknown" | "conflict" | "invalid";
}

export interface ReviewReasonV1 {
  code: string;
  severity: "info" | "warning" | "error";
  scope: "task" | "image" | "inventory" | "occurrence" | "overlap";
  sourceImageIds: string[];
  occurrenceIds: string[];
  pairId: string | null;
  relationId: string | null;
  message: string;
}

export interface BrowserAnalysisResultV1 {
  schemaVersion: 1;
  task: Pick<BrowserBatchAnalysisV1, "taskId" | "accountId" | "baseRevision" | "status">;
  images: BrowserBatchImageResultV1[];
  failures: BrowserBatchImageResultV1[];
  inventory: InventorySummaryV1;
  overlap: { confirmedPairs: ConfirmedOverlapPairV1[]; relations: OverlapRelationV1[] };
  occurrences: BrowserAnalysisOccurrenceReferenceV1[];
  review: { status: "ready_for_review" | "needs_review" | "blocked"; reasons: ReviewReasonV1[] };
}

export interface BrowserAnalysisOccurrenceReferenceV1 {
  occurrenceId: string;
  sourceImageId: string;
  sourceOrder: number;
  kind: "ordinary" | "experience";
  occurrence: OrdinaryStarOccurrenceV1 | ExperienceOccurrenceV1;
}

export interface BrowserBatchResultRunV1 {
  batch: BrowserBatchAnalysisV1;
  result: BrowserAnalysisResultV1;
}

export interface BrowserBatchErrorV1 {
  code: "analysis_failed" | "engine_initialization_failed";
  errorType: string;
  message: string;
  retryable: boolean;
}

export interface BrowserBatchImageResultV1 {
  sourceImageId: string;
  sourceOrder: number;
  /** User-confirmed pool from task input; never inferred from OCR classification. */
  confirmedPool: ConfirmedImagePool | null;
  status: "completed" | "cancelled" | "failed";
  analysis: BrowserImageAnalysisV1 | null;
  error: BrowserBatchErrorV1 | null;
}

export interface BrowserBatchSummaryV1 {
  totalImages: number;
  completedImages: number;
  failedImages: number;
  cancelledImages: number;
  ordinaryOccurrenceCount: number;
  experienceOccurrenceCount: number;
  ocrSessionInitializationCount: number;
  peakConcurrentAnalyses: 1 | 0;
  totalDurationMs: number;
}

export interface BrowserBatchAnalysisV1 {
  schemaVersion: typeof BROWSER_BATCH_ANALYSIS_SCHEMA_VERSION;
  taskId: string;
  accountId: string;
  baseRevision: string | number;
  status: "completed" | "partial" | "cancelled" | "failed";
  startedAt: string;
  finishedAt: string;
  images: BrowserBatchImageResultV1[];
  summary: BrowserBatchSummaryV1;
  warnings: string[];
}

export type BrowserBatchProgressKind =
  | "task_started"
  | "image_started"
  | "image_classified"
  | "image_completed"
  | "image_failed"
  | "task_cancelled"
  | "task_completed";

export interface BrowserBatchProgressEventV1 {
  kind: BrowserBatchProgressKind;
  taskId: string;
  sourceImageId: string | null;
  sourceOrder: number | null;
  completed: number;
  total: number;
  stage: string;
}

export interface BrowserBatchRunOptions {
  engine?: BrowserVisionEngine;
  createEngine?: () => BrowserVisionEngine;
  assetConfig?: VisionAssetConfig;
  signal?: AbortSignal;
  onProgress?: (event: BrowserBatchProgressEventV1) => void;
  now?: () => Date;
  nowMs?: () => number;
  /** Enables runtime-only candidate shadow audit; it does not alter OCR execution. */
  variantAudit?: boolean;
}

export interface BatchApplyDecision {
  action: "apply" | "review" | "discard";
  reason:
    | "ready"
    | "partial_requires_ingest_review"
    | "active_task_mismatch"
    | "account_mismatch"
    | "revision_mismatch"
    | "cancelled_result"
    | "failed_result";
}

export function canApplyBatchResult(input: {
  result: BrowserBatchAnalysisV1;
  currentAccountId: string;
  currentRevision: string | number;
  activeTaskId: string | null;
}): BatchApplyDecision {
  if (input.activeTaskId !== input.result.taskId) return { action: "discard", reason: "active_task_mismatch" };
  if (input.currentAccountId !== input.result.accountId) return { action: "discard", reason: "account_mismatch" };
  if (input.currentRevision !== input.result.baseRevision) return { action: "discard", reason: "revision_mismatch" };
  if (input.result.status === "cancelled") return { action: "discard", reason: "cancelled_result" };
  if (input.result.status === "failed") return { action: "discard", reason: "failed_result" };
  if (input.result.status === "partial") return { action: "review", reason: "partial_requires_ingest_review" };
  return { action: "apply", reason: "ready" };
}

function reviewReason(
  code: string,
  severity: ReviewReasonV1["severity"],
  scope: ReviewReasonV1["scope"],
  message: string,
  context: Partial<Pick<ReviewReasonV1, "sourceImageIds" | "occurrenceIds" | "pairId" | "relationId">> = {},
): ReviewReasonV1 {
  return {
    code, severity, scope, message,
    sourceImageIds: [...(context.sourceImageIds ?? [])].sort(),
    occurrenceIds: [...(context.occurrenceIds ?? [])].sort(),
    pairId: context.pairId ?? null,
    relationId: context.relationId ?? null,
  };
}

function sortReasons(reasons: ReviewReasonV1[]): ReviewReasonV1[] {
  return reasons.sort((left, right) => left.scope.localeCompare(right.scope)
    || left.code.localeCompare(right.code)
    || left.sourceImageIds.join("|").localeCompare(right.sourceImageIds.join("|"))
    || left.occurrenceIds.join("|").localeCompare(right.occurrenceIds.join("|"))
    || (left.pairId ?? "").localeCompare(right.pairId ?? "")
    || (left.relationId ?? "").localeCompare(right.relationId ?? ""));
}

function aggregateInventoryField(
  images: BrowserBatchImageResultV1[],
  select: (analysis: BrowserImageAnalysisV1) => NumericFieldObservationV1,
): AggregatedNumericFieldV1 {
  const sources = images.flatMap((image) => {
    if (!image.analysis) return [];
    const field = select(image.analysis);
    return [{
      sourceImageId: image.sourceImageId, sourceOrder: image.sourceOrder, value: field.value,
      status: field.status, confidence: field.confidence, rawText: field.rawText, normalizedText: field.normalizedText,
    }];
  }).sort((left, right) => left.sourceOrder - right.sourceOrder || left.sourceImageId.localeCompare(right.sourceImageId));
  if (!sources.length) return { value: null, status: "unknown", sources, reviewReasonCodes: ["inventory_no_observation"] };
  if (sources.some((source) => source.status === "invalid")) return { value: null, status: "invalid", sources, reviewReasonCodes: ["inventory_invalid_observation"] };
  if (sources.some((source) => source.status === "ambiguous")) return { value: null, status: "conflict", sources, reviewReasonCodes: ["inventory_observation_conflict"] };
  const reliable = sources.filter((source) => source.status === "confirmed" && source.value != null && (source.confidence ?? 0) >= INVENTORY_CONFIDENCE_THRESHOLD);
  if (!reliable.length) {
    const code = sources.some((source) => source.status === "confirmed") ? "inventory_observation_below_confidence_threshold" : "inventory_no_confirmed_observation";
    return { value: null, status: "unknown", sources, reviewReasonCodes: [code] };
  }
  const values = [...new Set(reliable.map((source) => source.value))];
  if (values.length > 1) return { value: null, status: "conflict", sources, reviewReasonCodes: ["inventory_observation_conflict"] };
  return {
    value: values[0]!, status: reliable.length === 1 ? "candidate" : "confirmed", sources,
    reviewReasonCodes: reliable.length === 1 ? ["inventory_single_observation"] : [],
  };
}

export function summarizeInventory(images: BrowserBatchImageResultV1[]): InventorySummaryV1 {
  const currentCount = aggregateInventoryField(images, (analysis) => analysis.inventoryHeader.currentCount);
  const capacity = aggregateInventoryField(images, (analysis) => analysis.inventoryHeader.capacity);
  if (currentCount.value != null && capacity.value != null && currentCount.value > capacity.value) {
    currentCount.status = "invalid";
    currentCount.reviewReasonCodes = ["inventory_current_exceeds_capacity"];
  }
  const statuses = [currentCount.status, capacity.status];
  const status: InventorySummaryV1["status"] = statuses.includes("invalid") ? "invalid"
    : statuses.includes("conflict") ? "conflict"
      : statuses.every((item) => item === "confirmed") ? "confirmed"
        : statuses.every((item) => item === "unknown") ? "unknown" : "partial";
  return { currentCount, capacity, status };
}

function completeRows(analysis: BrowserImageAnalysisV1): OrdinaryStarOccurrenceV1[][] {
  const rows = new Map<number, OrdinaryStarOccurrenceV1[]>();
  for (const occurrence of analysis.occurrences) {
    if (occurrence.completeness !== "complete") continue;
    rows.set(occurrence.row, [...(rows.get(occurrence.row) ?? []), occurrence]);
  }
  return [...rows.entries()].sort(([left], [right]) => left - right).flatMap(([, occurrences]) => {
    const sorted = [...occurrences].sort((left, right) => left.column - right.column || left.occurrenceId.localeCompare(right.occurrenceId));
    return sorted.length === 4 && sorted.every((item, index) => item.column === index) ? [sorted] : [];
  });
}

type OverlapIdentityField = "name" | "level";

function fieldValue(occurrence: OrdinaryStarOccurrenceV1, field: OverlapIdentityField): string | number | null {
  if (field === "name") return occurrence.effectiveName;
  return occurrence.effectiveLevel;
}

function bitSimilarity(left: string, right: string): number {
  if (left.length !== 64 || right.length !== 64) return 0;
  let matches = 0;
  for (let index = 0; index < 64; index += 1) if (left[index] === right[index]) matches += 1;
  return matches / 64;
}

function visualSimilarity(left: OrdinaryStarOccurrenceV1, right: OrdinaryStarOccurrenceV1): number | null {
  const leftEvidence = left.visualEvidence;
  const rightEvidence = right.visualEvidence;
  if (!leftEvidence || !rightEvidence || leftEvidence.algorithm !== "phash_hue_v1" || rightEvidence.algorithm !== "phash_hue_v1") return null;
  if (leftEvidence.hueHistogram.length !== 12 || rightEvidence.hueHistogram.length !== 12) return null;
  const hueScore = leftEvidence.hueHistogram.reduce((total, value, index) => total + Math.min(value, rightEvidence.hueHistogram[index] ?? 0), 0);
  return Math.max(0, Math.min(1, bitSimilarity(leftEvidence.iconBits, rightEvidence.iconBits) * .46
    + bitSimilarity(leftEvidence.nameBits, rightEvidence.nameBits) * .34
    + bitSimilarity(leftEvidence.levelBits, rightEvidence.levelBits) * .15 + hueScore * .05));
}

function occurrenceRelation(pairId: string, left: OrdinaryStarOccurrenceV1, right: OrdinaryStarOccurrenceV1): OverlapRelationV1 {
  const fields: OverlapIdentityField[] = ["name", "level"];
  const matchingFields = fields.filter((field) => fieldValue(left, field) != null && fieldValue(left, field) === fieldValue(right, field));
  const conflictingFields = fields.filter((field) => fieldValue(left, field) != null && fieldValue(right, field) != null && fieldValue(left, field) !== fieldValue(right, field));
  const unavailableFields = fields.filter((field) => fieldValue(left, field) == null || fieldValue(right, field) == null);
  const exactIdentity = matchingFields.includes("name") && matchingFields.includes("level") && !conflictingFields.length && !unavailableFields.length;
  const similarity = visualSimilarity(left, right);
  const status: OverlapRelationV1["status"] = conflictingFields.length ? "not_duplicate"
    : exactIdentity ? "duplicate" : "possible_duplicate";
  const reviewReasonCodes = status === "possible_duplicate" ? ["overlap_semantic_identity_incomplete"] : [];
  return {
    relationId: `${pairId}:${left.occurrenceId}:${right.occurrenceId}`,
    pairId, leftOccurrenceId: left.occurrenceId, rightOccurrenceId: right.occurrenceId, status,
    evidence: {
      comparedFields: fields, matchingFields, conflictingFields, unavailableFields, visualSimilarity: similarity,
      detail: status === "duplicate" ? "suffix_prefix_exact_name_level_match"
        : status === "possible_duplicate" ? "suffix_prefix_requires_name_level_review" : "suffix_prefix_name_level_conflict",
    },
    reviewReasonCodes,
  };
}

function rowRelations(pairId: string, left: OrdinaryStarOccurrenceV1[], right: OrdinaryStarOccurrenceV1[]): OverlapRelationV1[] {
  const relations = left.map((occurrence, index) => occurrenceRelation(pairId, occurrence, right[index]!));
  const rowStatus: OverlapRelationV1["status"] = relations.some((relation) => relation.status === "not_duplicate") ? "not_duplicate"
    : relations.some((relation) => relation.status === "possible_duplicate") ? "possible_duplicate" : "duplicate";
  if (rowStatus === "duplicate") return relations;
  return relations.map((relation) => ({
    ...relation,
    status: rowStatus,
    evidence: { ...relation.evidence, detail: rowStatus === "not_duplicate" ? "overlap_row_name_level_conflict" : "overlap_row_requires_review" },
    reviewReasonCodes: rowStatus === "possible_duplicate" ? [...new Set([...relation.reviewReasonCodes, "overlap_row_requires_review"])] : [],
  }));
}

function unavailableRelation(pair: ConfirmedOverlapPairV1, code: string): OverlapRelationV1 {
  return {
    relationId: `${pair.pairId}:unavailable`, pairId: pair.pairId, leftOccurrenceId: null, rightOccurrenceId: null,
    status: "unavailable", evidence: { comparedFields: [], matchingFields: [], conflictingFields: [], unavailableFields: [], visualSimilarity: null, detail: code }, reviewReasonCodes: [code],
  };
}

function orderedPairs(pairs: ConfirmedOverlapPairV1[], images: BrowserBatchImageResultV1[]): ConfirmedOverlapPairV1[] {
  void images;
  return pairs.map((pair) => ({ ...pair })).sort((left, right) => left.pairId.localeCompare(right.pairId)
    || left.sourceImageIdA.localeCompare(right.sourceImageIdA) || left.sourceImageIdB.localeCompare(right.sourceImageIdB));
}

export function analyzeConfirmedOverlap(
  images: BrowserBatchImageResultV1[],
  pairs: ConfirmedOverlapPairV1[],
): { confirmedPairs: ConfirmedOverlapPairV1[]; relations: OverlapRelationV1[] } {
  const byId = new Map(images.map((image) => [image.sourceImageId, image]));
  const confirmedPairs = orderedPairs(pairs, images);
  const relations: OverlapRelationV1[] = [];
  for (const pair of confirmedPairs) {
    const left = byId.get(pair.sourceImageIdA);
    const right = byId.get(pair.sourceImageIdB);
    if (!left || !right) { relations.push(unavailableRelation(pair, "overlap_source_image_missing")); continue; }
    const leftPool = left.confirmedPool?.pageType ?? null; const rightPool = right.confirmedPool?.pageType ?? null;
    if (!leftPool || !rightPool || leftPool !== rightPool || (leftPool !== "main" && leftPool !== "support")) { relations.push(unavailableRelation(pair, "overlap_pair_requires_same_confirmed_main_or_support_pool")); continue; }
    if (!left.analysis || !right.analysis) { relations.push(unavailableRelation(pair, "overlap_source_analysis_unavailable")); continue; }
    const leftRows = completeRows(left.analysis);
    const rightRows = completeRows(right.analysis);
    const maximumLength = Math.min(leftRows.length, rightRows.length);
    if (!maximumLength) { relations.push(unavailableRelation(pair, "overlap_complete_rows_unavailable")); continue; }
    let selected: OverlapRelationV1[] | null = null;
    let fallback: OverlapRelationV1[] | null = null;
    for (let length = maximumLength; length >= 1; length -= 1) {
      const candidates = Array.from({ length }, (_, index) => ({ left: leftRows[leftRows.length - length + index]!, right: rightRows[index]! }));
      const candidateRows = candidates.map((candidate) => rowRelations(pair.pairId, candidate.left, candidate.right));
      if (candidateRows.some((row) => row[0]?.status === "not_duplicate")) { fallback ??= candidateRows.flat(); continue; }
      if (candidateRows.some((row) => row[0]?.status === "duplicate")) { selected = candidateRows.flat(); break; }
    }
    relations.push(...(selected ?? fallback ?? [unavailableRelation(pair, "overlap_no_confirmed_row_anchor")]));
  }
  return { confirmedPairs, relations: relations.sort((left, right) => left.relationId.localeCompare(right.relationId)) };
}

export function buildBrowserAnalysisResult(
  batch: BrowserBatchAnalysisV1,
  pairs: ConfirmedOverlapPairV1[] = [],
  current?: { accountId: string; baseRevision: string | number },
): BrowserAnalysisResultV1 {
  const images = [...batch.images].sort((left, right) => left.sourceOrder - right.sourceOrder || left.sourceImageId.localeCompare(right.sourceImageId));
  const inventory = summarizeInventory(images);
  const overlap = analyzeConfirmedOverlap(images, pairs);
  const occurrences = images.flatMap((image) => image.analysis ? [
    ...image.analysis.occurrences.map((occurrence) => ({ occurrenceId: occurrence.occurrenceId, sourceImageId: image.sourceImageId, sourceOrder: image.sourceOrder, kind: "ordinary" as const, occurrence })),
    ...image.analysis.experienceOccurrences.map((occurrence) => ({ occurrenceId: occurrence.occurrenceId, sourceImageId: image.sourceImageId, sourceOrder: image.sourceOrder, kind: "experience" as const, occurrence })),
  ] : []).sort((left, right) => left.sourceOrder - right.sourceOrder
    || left.kind.localeCompare(right.kind)
    || (left.kind === "ordinary" && right.kind === "ordinary" ? left.occurrence.row - right.occurrence.row || left.occurrence.column - right.occurrence.column : 0)
    || (left.kind === "experience" && right.kind === "experience" ? left.occurrence.ordinal - right.occurrence.ordinal : 0)
    || left.occurrenceId.localeCompare(right.occurrenceId));
  const reasons: ReviewReasonV1[] = [];
  for (const image of images) {
    if (image.status === "failed") reasons.push(reviewReason("image_analysis_failed", "warning", "image", "The image analysis failed; successful image results remain available.", { sourceImageIds: [image.sourceImageId] }));
  }
  for (const field of [inventory.currentCount, inventory.capacity]) {
    for (const code of field.reviewReasonCodes) reasons.push(reviewReason(code, "warning", "inventory", "Inventory observation requires review.", { sourceImageIds: field.sources.map((source) => source.sourceImageId) }));
  }
  for (const occurrence of occurrences) {
    if (occurrence.occurrence.reviewRequired) reasons.push(reviewReason("occurrence_requires_review", "warning", "occurrence", "Occurrence retains an existing single-image review requirement.", { sourceImageIds: [occurrence.sourceImageId], occurrenceIds: [occurrence.occurrenceId] }));
  }
  for (const relation of overlap.relations) {
    for (const code of relation.reviewReasonCodes) reasons.push(reviewReason(
      code, code === "overlap_source_image_missing" ? "error" : "warning", "overlap",
      code === "overlap_source_image_missing" ? "Confirmed overlap pair references a source image outside this batch." : "Confirmed overlap pair requires review.",
      { occurrenceIds: [relation.leftOccurrenceId, relation.rightOccurrenceId].filter((item): item is string => item != null), pairId: relation.pairId, relationId: relation.relationId },
    ));
  }
  if (batch.status === "partial" || batch.status === "cancelled") reasons.push(reviewReason(`task_${batch.status}`, "warning", "task", "Task did not complete every requested image; completed analysis is retained."));
  if (current && (current.accountId !== batch.accountId || current.baseRevision !== batch.baseRevision)) reasons.push(reviewReason("task_stale", "error", "task", "The result does not match the current account or base revision."));
  const duplicateIds = occurrences.map((item) => item.occurrenceId).filter((item, index, values) => values.indexOf(item) !== index);
  if (duplicateIds.length) reasons.push(reviewReason("occurrence_id_conflict", "error", "task", "Occurrence IDs must be unique within the analysis result.", { occurrenceIds: duplicateIds }));
  if (!images.some((image) => image.analysis)) reasons.push(reviewReason("no_successful_image_analysis", "error", "task", "No successful image analysis is available for review."));
  if (batch.status === "failed") reasons.push(reviewReason("task_failed", "error", "task", "The batch failed before a reviewable analysis result was produced."));
  const sortedReasons = sortReasons(reasons);
  const reviewStatus: BrowserAnalysisResultV1["review"]["status"] = sortedReasons.some((reason) => reason.severity === "error") ? "blocked"
    : sortedReasons.length ? "needs_review" : "ready_for_review";
  return {
    schemaVersion: 1,
    task: { taskId: batch.taskId, accountId: batch.accountId, baseRevision: batch.baseRevision, status: batch.status },
    images, failures: images.filter((image) => image.status === "failed"), inventory, overlap, occurrences,
    review: { status: reviewStatus, reasons: sortedReasons },
  };
}

function publicError(error: unknown, code: BrowserBatchErrorV1["code"]): BrowserBatchErrorV1 {
  return {
    code,
    errorType: error instanceof Error && error.name ? error.name : "Error",
    // Do not propagate decoder or browser error text: it can contain a local path or source data.
    message: code === "engine_initialization_failed" ? "browser vision engine initialization failed" : "image analysis failed",
    retryable: true,
  };
}

function orderedImages(images: BrowserBatchImageInputV1[]): BrowserBatchImageInputV1[] {
  return images.map((image, index) => ({ image, index }))
    .sort((left, right) => left.image.sourceOrder - right.image.sourceOrder
      || left.image.sourceImageId.localeCompare(right.image.sourceImageId) || left.index - right.index)
    .map(({ image }) => image);
}

function cancelledResult(image: BrowserBatchImageInputV1): BrowserBatchImageResultV1 {
  return { sourceImageId: image.sourceImageId, sourceOrder: image.sourceOrder, confirmedPool: image.confirmedPool ?? null, status: "cancelled", analysis: null, error: null };
}

function createSummary(images: BrowserBatchImageResultV1[], durationMs: number): BrowserBatchSummaryV1 {
  const completed = images.filter((image) => image.status === "completed");
  return {
    totalImages: images.length,
    completedImages: completed.length,
    failedImages: images.filter((image) => image.status === "failed").length,
    cancelledImages: images.filter((image) => image.status === "cancelled").length,
    ordinaryOccurrenceCount: completed.reduce((total, image) => total + (image.analysis?.occurrences.length ?? 0), 0),
    experienceOccurrenceCount: completed.reduce((total, image) => total + (image.analysis?.experienceOccurrences.length ?? 0), 0),
    ocrSessionInitializationCount: completed.reduce((total, image) => total + (image.analysis?.timings.ocrSessionCreationCount ?? 0), 0),
    peakConcurrentAnalyses: images.length ? 1 : 0,
    totalDurationMs: Math.round(durationMs * 100) / 100,
  };
}

function batchStatus(images: BrowserBatchImageResultV1[], cancelled: boolean): BrowserBatchAnalysisV1["status"] {
  if (cancelled) return "cancelled";
  const completed = images.filter((image) => image.status === "completed").length;
  const failed = images.filter((image) => image.status === "failed").length;
  if (failed === images.length && images.length > 0) return "failed";
  if (failed > 0) return "partial";
  return completed === images.length ? "completed" : "failed";
}

function yieldToBrowserEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function createDefaultEngine(): Promise<BrowserVisionEngine> {
  const { BrowserVisionWorkerClient } = await import("./browser-vision-worker-client.js");
  return new BrowserVisionWorkerClient();
}

export async function analyzeBrowserBatch(
  task: BrowserBatchTaskV1,
  options: BrowserBatchRunOptions = {},
): Promise<BrowserBatchAnalysisV1> {
  const now = options.now ?? (() => new Date());
  const nowMs = options.nowMs ?? (() => performance.now());
  const startedAt = now().toISOString();
  const startedMs = nowMs();
  const images = orderedImages(task.images);
  const results: BrowserBatchImageResultV1[] = [];
  const emit = (kind: BrowserBatchProgressKind, image: BrowserBatchImageInputV1 | null, completed: number): void => {
    options.onProgress?.({
      kind,
      taskId: task.taskId,
      sourceImageId: image?.sourceImageId ?? null,
      sourceOrder: image?.sourceOrder ?? null,
      completed,
      total: images.length,
      stage: kind,
    });
  };
  emit("task_started", null, 0);

  if (options.signal?.aborted) {
    results.push(...images.map(cancelledResult));
    emit("task_cancelled", null, 0);
    const finishedAt = now().toISOString();
    return {
      schemaVersion: BROWSER_BATCH_ANALYSIS_SCHEMA_VERSION, taskId: task.taskId, accountId: task.accountId,
      baseRevision: task.baseRevision, status: "cancelled", startedAt, finishedAt, images: results,
      summary: createSummary(results, nowMs() - startedMs), warnings: ["task_cancelled_before_start"],
    };
  }

  const ownsEngine = options.engine == null;
  let engine: BrowserVisionEngine | undefined;
  try {
    try {
      engine = options.engine ?? options.createEngine?.() ?? await createDefaultEngine();
      await engine.initialize(options.assetConfig ?? {});
    } catch (error) {
      for (const image of images) {
        results.push({ sourceImageId: image.sourceImageId, sourceOrder: image.sourceOrder, confirmedPool: image.confirmedPool ?? null, status: "failed", analysis: null, error: publicError(error, "engine_initialization_failed") });
        emit("image_failed", image, results.length);
      }
      emit("task_completed", null, 0);
      const finishedAt = now().toISOString();
      return {
        schemaVersion: BROWSER_BATCH_ANALYSIS_SCHEMA_VERSION, taskId: task.taskId, accountId: task.accountId,
        baseRevision: task.baseRevision, status: "failed", startedAt, finishedAt, images: results,
        summary: createSummary(results, nowMs() - startedMs), warnings: ["engine_initialization_failed"],
      };
    }

    if (!engine) throw new Error("browser vision engine was not created");

    for (let index = 0; index < images.length; index += 1) {
      if (options.signal?.aborted) {
        results.push(...images.slice(index).map(cancelledResult));
        break;
      }
      const image = images[index]!;
      emit("image_started", image, results.length);
      try {
        const analysis = await engine.analyzeImage(image.input, { confirmedPool: image.confirmedPool, variantAudit: options.variantAudit });
        emit("image_classified", image, results.length);
        results.push({ sourceImageId: image.sourceImageId, sourceOrder: image.sourceOrder, confirmedPool: image.confirmedPool ?? null, status: "completed", analysis, error: null });
        emit("image_completed", image, results.length);
      } catch (error) {
        results.push({ sourceImageId: image.sourceImageId, sourceOrder: image.sourceOrder, confirmedPool: image.confirmedPool ?? null, status: "failed", analysis: null, error: publicError(error, "analysis_failed") });
        emit("image_failed", image, results.length);
      }
      // Process a pending cancel click before launching the next atomic image.
      await yieldToBrowserEventLoop();
    }

    const cancelled = options.signal?.aborted === true;
    const status = batchStatus(results, cancelled);
    if (cancelled) {
      emit("task_cancelled", null, results.filter((item) => item.status === "completed" || item.status === "failed").length);
    } else {
      emit("task_completed", null, results.length);
    }
    const finishedAt = now().toISOString();
    return {
      schemaVersion: BROWSER_BATCH_ANALYSIS_SCHEMA_VERSION, taskId: task.taskId, accountId: task.accountId,
      baseRevision: task.baseRevision, status, startedAt, finishedAt, images: results,
      summary: createSummary(results, nowMs() - startedMs),
      warnings: status === "partial" ? ["one_or_more_images_failed"] : [],
    };
  } finally {
    if (ownsEngine && engine) await engine.dispose();
  }
}

/**
 * Compatibility-preserving high-level entry: Phase 1B callers can keep using
 * analyzeBrowserBatch, while new callers receive the versioned review contract.
 */
export async function analyzeBrowserBatchWithResult(
  task: BrowserBatchTaskV1,
  options: BrowserBatchRunOptions = {},
  current?: { accountId: string; baseRevision: string | number },
): Promise<BrowserBatchResultRunV1> {
  const batch = await analyzeBrowserBatch(task, options);
  return {
    batch,
    result: buildBrowserAnalysisResult(batch, task.confirmedOverlapPairs ?? [], current),
  };
}
