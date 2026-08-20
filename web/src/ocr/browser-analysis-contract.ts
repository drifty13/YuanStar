import type {
  BrowserAnalysisOccurrenceReferenceV1,
  BrowserBatchImageResultV1,
  BrowserBatchProgressEventV1,
  ConfirmedOverlapPairV1,
  InventorySummaryV1,
  OverlapRelationV1,
  ReviewReasonV1,
} from "../structured/batch-orchestration.js";
import type { ConfirmedImagePool } from "../structured/contracts.js";

/**
 * Browser-only input. File objects are deliberately confined to this runtime
 * boundary and never appear in BrowserAnalysisResultV1.
 */
export interface BrowserOcrRuntimeImageInputV1 {
  sourceImageId: string;
  sourceOrder: number;
  file: File;
  confirmedPool?: ConfirmedImagePool;
}

export interface BrowserOcrRuntimeJobV1 {
  schemaVersion: 1;
  jobId: string;
  images: BrowserOcrRuntimeImageInputV1[];
  confirmedOverlapPairs?: ConfirmedOverlapPairV1[];
}

export interface BrowserAnalysisSourceImageV1 {
  sourceImageId: string;
  sourceOrder: number;
  confirmedPool: ConfirmedImagePool | null;
}

/**
 * Versioned, JSON-safe output of local Browser OCR. It intentionally contains
 * neither Workspace/account state nor a business instance identity.
 */
export interface BrowserAnalysisResultV1 {
  schemaVersion: 1;
  job: {
    jobId: string;
    status: "completed" | "partial";
    startedAt: string;
    finishedAt: string;
  };
  sourceImages: BrowserAnalysisSourceImageV1[];
  images: BrowserBatchImageResultV1[];
  failures: BrowserBatchImageResultV1[];
  inventory: InventorySummaryV1;
  overlap: { confirmedPairs: ConfirmedOverlapPairV1[]; relations: OverlapRelationV1[] };
  occurrences: BrowserAnalysisOccurrenceReferenceV1[];
  review: { status: "ready_for_review" | "needs_review" | "blocked"; reasons: ReviewReasonV1[] };
}

export type BrowserOcrRuntimePhaseV1 =
  | "initializing"
  | "image_started"
  | "image_classified"
  | "image_completed"
  | "image_failed"
  | "cancelling"
  | "cancelled"
  | "completed";

export interface BrowserOcrRuntimeProgressV1 {
  jobId: string;
  phase: BrowserOcrRuntimePhaseV1;
  completed: number;
  total: number;
  sourceImageId: string | null;
  sourceOrder: number | null;
}

export interface BrowserOcrRuntimeErrorV1 {
  code:
    | "invalid_input"
    | "engine_initialization_failed"
    | "image_analysis_failed"
    | "batch_runtime_failed"
    | "worker_crash"
    | "cancelled"
    | "contract_generation_failed";
  message: string;
  retryable: boolean;
  debugContext?: { phase: string; sourceImageId?: string };
}

export interface BrowserOcrRuntimeRunV1 {
  jobId: string;
  status: "completed" | "partial" | "cancelled" | "failed";
  result: BrowserAnalysisResultV1 | null;
  error: BrowserOcrRuntimeErrorV1 | null;
}

export interface BrowserOcrRuntimeRunOptionsV1 {
  signal?: AbortSignal;
  onProgress?: (event: BrowserOcrRuntimeProgressV1) => void;
}

export function progressFromBatch(
  jobId: string,
  event: BrowserBatchProgressEventV1,
): BrowserOcrRuntimeProgressV1 {
  const phase = event.kind === "task_started" ? "image_started"
    : event.kind === "task_cancelled" ? "cancelled"
      : event.kind === "task_completed" ? "completed"
        : event.kind;
  return {
    jobId,
    phase,
    completed: event.completed,
    total: event.total,
    sourceImageId: event.sourceImageId,
    sourceOrder: event.sourceOrder,
  };
}
