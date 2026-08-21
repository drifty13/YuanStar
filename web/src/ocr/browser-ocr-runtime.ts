import {
  analyzeBrowserBatchWithResult,
  type BrowserBatchTaskV1,
} from "../structured/batch-orchestration.js";
import { BrowserVisionWorkerClient } from "../structured/browser-vision-worker-client.js";
import type { BrowserVisionEngine, VisionAssetConfig } from "../structured/contracts.js";
import { createOcrPerfReport, createOcrVariantAuditReport, emitOcrPerfReportIfEnabled, emitOcrVariantAuditReportIfEnabled, isOcrVariantAuditEnabled, isOcrVariantAuditRequested } from "./performance-diagnostics.js";
import {
  progressFromBatch,
  type BrowserAnalysisResultV1,
  type BrowserOcrRuntimeErrorV1,
  type BrowserOcrRuntimeJobV1,
  type BrowserOcrRuntimeProgressV1,
  type BrowserOcrRuntimeRunOptionsV1,
  type BrowserOcrRuntimeRunV1,
} from "./browser-analysis-contract.js";

export type BrowserOcrRuntimeState =
  | "idle"
  | "initializing"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "disposed";

type ActiveRun = {
  jobId: string;
  generation: number;
  controller: AbortController;
  detachExternalAbort: () => void;
};

type RuntimeDependencies = {
  createEngine?: () => BrowserVisionEngine;
  now?: () => Date;
};

function publicError(
  code: BrowserOcrRuntimeErrorV1["code"],
  phase: string,
  sourceImageId?: string,
): BrowserOcrRuntimeErrorV1 {
  const messageByCode: Record<BrowserOcrRuntimeErrorV1["code"], string> = {
    invalid_input: "Browser OCR input is invalid.",
    engine_initialization_failed: "The local OCR worker could not initialize.",
    image_analysis_failed: "One or more images could not be analyzed.",
    batch_runtime_failed: "The local OCR batch did not complete.",
    worker_crash: "The local OCR worker stopped unexpectedly.",
    cancelled: "The OCR job was cancelled.",
    contract_generation_failed: "The OCR result could not be prepared for review.",
  };
  return { code, message: messageByCode[code], retryable: code !== "invalid_input" && code !== "cancelled", debugContext: { phase, ...(sourceImageId ? { sourceImageId } : {}) } };
}

function validateJob(job: BrowserOcrRuntimeJobV1): BrowserOcrRuntimeErrorV1 | null {
  if (!job.jobId.trim() || !job.images.length) return publicError("invalid_input", "validation");
  const sourceIds = new Set<string>();
  for (const image of job.images) {
    if (!image.sourceImageId.trim() || !Number.isFinite(image.sourceOrder) || !image.file || sourceIds.has(image.sourceImageId)) {
      return publicError("invalid_input", "validation", image.sourceImageId || undefined);
    }
    sourceIds.add(image.sourceImageId);
  }
  return null;
}

function toPublicResult(
  job: BrowserOcrRuntimeJobV1,
  batchResult: Awaited<ReturnType<typeof analyzeBrowserBatchWithResult>>["result"],
  startedAt: string,
  finishedAt: string,
): BrowserAnalysisResultV1 {
  const sourceImages = [...job.images]
    .map((image) => ({ sourceImageId: image.sourceImageId, sourceOrder: image.sourceOrder, confirmedPool: image.confirmedPool ?? null }))
    .sort((left, right) => left.sourceOrder - right.sourceOrder || left.sourceImageId.localeCompare(right.sourceImageId));
  return {
    schemaVersion: 1,
    job: {
      jobId: job.jobId,
      status: batchResult.task.status === "partial" ? "partial" : "completed",
      startedAt,
      finishedAt,
    },
    sourceImages,
    images: batchResult.images,
    failures: batchResult.failures,
    inventory: batchResult.inventory,
    overlap: batchResult.overlap,
    occurrences: batchResult.occurrences,
    review: batchResult.review,
  };
}

/**
 * Product-facing OCR adapter. It owns only a Worker-backed analysis job; it
 * cannot see WorkspaceSession, IndexedDB, account selection, or instance IDs.
 */
export class BrowserOcrRuntime {
  private stateValue: BrowserOcrRuntimeState = "idle";
  private engine: BrowserVisionEngine | null = null;
  private active: ActiveRun | null = null;
  private generation = 0;
  private disposeRequested = false;

  constructor(private readonly dependencies: RuntimeDependencies = {}) {}

  get state(): BrowserOcrRuntimeState { return this.stateValue; }

  private createEngine(): BrowserVisionEngine {
    return this.dependencies.createEngine?.() ?? new BrowserVisionWorkerClient();
  }

  private now(): string { return (this.dependencies.now?.() ?? new Date()).toISOString(); }

  private isCurrent(active: ActiveRun): boolean {
    return this.active?.generation === active.generation && this.active.jobId === active.jobId;
  }

  private emit(options: BrowserOcrRuntimeRunOptionsV1, event: BrowserOcrRuntimeProgressV1): void {
    options.onProgress?.(event);
  }

  cancel(): boolean {
    const active = this.active;
    if (!active || (this.stateValue !== "initializing" && this.stateValue !== "running")) return false;
    this.stateValue = "cancelling";
    active.controller.abort();
    return true;
  }

  async dispose(): Promise<void> {
    this.disposeRequested = true;
    this.cancel();
    const engine = this.engine;
    this.engine = null;
    if (engine) await engine.dispose();
    if (!this.active) this.stateValue = "disposed";
  }

  async run(job: BrowserOcrRuntimeJobV1, options: BrowserOcrRuntimeRunOptionsV1 = {}, assetConfig: VisionAssetConfig = {}): Promise<BrowserOcrRuntimeRunV1> {
    if (this.active) return { jobId: job.jobId, status: "failed", result: null, error: publicError("batch_runtime_failed", "concurrent_run") };
    const invalid = validateJob(job);
    if (invalid) return { jobId: job.jobId, status: "failed", result: null, error: invalid };
    this.disposeRequested = false;

    const controller = new AbortController();
    const externalAbort = () => { controller.abort(); this.cancel(); };
    options.signal?.addEventListener("abort", externalAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const active: ActiveRun = {
      jobId: job.jobId,
      generation: ++this.generation,
      controller,
      detachExternalAbort: () => options.signal?.removeEventListener("abort", externalAbort),
    };
    this.active = active;
    const emit = (phase: BrowserOcrRuntimeProgressV1["phase"], completed = 0, sourceImageId: string | null = null, sourceOrder: number | null = null): void => {
      this.emit(options, { jobId: job.jobId, phase, completed, total: job.images.length, sourceImageId, sourceOrder });
    };

    try {
      if (controller.signal.aborted) {
        this.stateValue = "cancelling";
        emit("cancelling");
        emit("cancelled");
        return { jobId: job.jobId, status: "cancelled", result: null, error: publicError("cancelled", "before_initialize") };
      }
      this.stateValue = "initializing";
      emit("initializing");
      this.engine ??= this.createEngine();
      try {
        await this.engine.initialize(assetConfig);
      } catch (error) {
        this.stateValue = "failed";
        return { jobId: job.jobId, status: "failed", result: null, error: publicError(String(error).includes("worker_fatal") ? "worker_crash" : "engine_initialization_failed", "initialize") };
      }
      if (controller.signal.aborted || !this.isCurrent(active)) {
        this.stateValue = "cancelling";
        emit("cancelling");
        emit("cancelled");
        return { jobId: job.jobId, status: "cancelled", result: null, error: publicError("cancelled", "after_initialize") };
      }
      this.stateValue = "running";
      const startedAt = this.now();
      const batchStartedAt = performance.now();
      const variantAudit = isOcrVariantAuditRequested();
      const internalTask: BrowserBatchTaskV1 = {
        schemaVersion: "1.0",
        // These are an isolated batch-builder compatibility scope, never input
        // to or output from this product-facing runtime contract.
        taskId: job.jobId,
        accountId: "runtime-local-only",
        baseRevision: 0,
        images: job.images.map((image) => ({
          sourceImageId: image.sourceImageId,
          sourceOrder: image.sourceOrder,
          input: { imageId: image.sourceImageId, file: image.file },
          confirmedPool: image.confirmedPool,
        })),
        confirmedOverlapPairs: job.confirmedOverlapPairs,
      };
      const run = await analyzeBrowserBatchWithResult(internalTask, {
        engine: this.engine,
        signal: controller.signal,
        onProgress: (event) => {
          if (!this.isCurrent(active)) return;
          if (event.kind === "task_started" || event.kind === "task_cancelled") return;
          const progress = progressFromBatch(job.jobId, event);
          this.emit(options, progress);
        },
        now: () => new Date(startedAt),
        variantAudit,
      });
      if (run.batch.status !== "cancelled") {
        emitOcrPerfReportIfEnabled(createOcrPerfReport(run.batch, performance.now() - batchStartedAt));
        if (isOcrVariantAuditEnabled()) emitOcrVariantAuditReportIfEnabled(createOcrVariantAuditReport(run.batch));
      }
      if (controller.signal.aborted || !this.isCurrent(active) || run.batch.status === "cancelled") {
        this.stateValue = "cancelling";
        emit("cancelling", run.batch.summary.completedImages);
        emit("cancelled", run.batch.summary.completedImages);
        return { jobId: job.jobId, status: "cancelled", result: null, error: publicError("cancelled", "run") };
      }
      if (run.batch.status === "failed") {
        this.stateValue = "failed";
        return { jobId: job.jobId, status: "failed", result: null, error: publicError("image_analysis_failed", "batch") };
      }
      try {
        const result = toPublicResult(job, run.result, startedAt, this.now());
        this.stateValue = "completed";
        return { jobId: job.jobId, status: run.batch.status === "partial" ? "partial" : "completed", result, error: null };
      } catch {
        this.stateValue = "failed";
        return { jobId: job.jobId, status: "failed", result: null, error: publicError("contract_generation_failed", "contract") };
      }
    } catch (error) {
      this.stateValue = "failed";
      return { jobId: job.jobId, status: "failed", result: null, error: publicError(String(error).includes("worker_") ? "worker_crash" : "batch_runtime_failed", "run") };
    } finally {
      const wasCancelled = controller.signal.aborted;
      active.detachExternalAbort();
      if (this.isCurrent(active)) this.active = null;
      // A cancelled worker may still be finishing an atomic image. Releasing it
      // here prevents an old message from being reused by the next job.
      if (wasCancelled && this.engine) {
        const engine = this.engine;
        this.engine = null;
        await engine.dispose();
      }
      if (this.stateValue === "cancelling") this.stateValue = this.disposeRequested ? "disposed" : "completed";
    }
  }
}
