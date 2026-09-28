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
  private preparation: Promise<void> | null = null;
  private prepared = false;
  private disposal: Promise<void> | null = null;
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

  prepare(assetConfig: VisionAssetConfig = {}): Promise<void> {
    if (this.disposeRequested) return Promise.reject(new Error("ocr_runtime_disposed"));
    if (this.prepared) return Promise.resolve();
    if (this.preparation) return this.preparation;
    let engine: BrowserVisionEngine;
    try { engine = this.engine ?? this.createEngine(); }
    catch (error) { return Promise.reject(error); }
    this.engine = engine;
    const preparation = Promise.resolve().then(() => {
      // Disposal can happen before this microtask gets to initialize a Worker.
      if (this.disposeRequested || this.engine !== engine) throw new Error("ocr_runtime_disposed");
      return engine.initialize(assetConfig);
    }).then(() => {
      if (this.disposeRequested || this.engine !== engine) throw new Error("ocr_runtime_disposed");
      this.prepared = true;
    }).catch(async (error: unknown) => {
      if (this.engine === engine) {
        this.engine = null;
        this.prepared = false;
        try { await engine.dispose(); } catch { /* Preserve the initialization error. */ }
      }
      throw error;
    }).finally(() => {
      if (this.preparation === preparation) this.preparation = null;
    });
    this.preparation = preparation;
    // Cleanup must not create an unhandled rejection when disposal interrupts prepare.
    void preparation.catch(() => undefined);
    return preparation;
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposeRequested = true;
    this.cancel();
    const engine = this.engine;
    this.engine = null;
    this.prepared = false;
    this.disposal = (async () => {
      try { if (engine) await engine.dispose(); }
      finally { this.stateValue = "disposed"; }
    })();
    return this.disposal;
  }

  async run(job: BrowserOcrRuntimeJobV1, options: BrowserOcrRuntimeRunOptionsV1 = {}, assetConfig: VisionAssetConfig = {}): Promise<BrowserOcrRuntimeRunV1> {
    if (this.active) return { jobId: job.jobId, status: "failed", result: null, error: publicError("batch_runtime_failed", "concurrent_run") };
    const invalid = validateJob(job);
    if (invalid) return { jobId: job.jobId, status: "failed", result: null, error: invalid };
    if (this.disposeRequested) return { jobId: job.jobId, status: "failed", result: null, error: publicError("batch_runtime_failed", "disposed") };

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
      const joinedPreparation = this.preparation !== null;
      try {
        try { await this.prepare(assetConfig); }
        catch (error) {
          // A formal run joining a failed background attempt gets one fresh attempt.
          if (!joinedPreparation || controller.signal.aborted || this.disposeRequested) throw error;
          await this.prepare(assetConfig);
        }
      } catch (error) {
        if (controller.signal.aborted || this.disposeRequested) {
          emit("cancelling");
          emit("cancelled");
          return { jobId: job.jobId, status: "cancelled", result: null, error: publicError("cancelled", "initialize") };
        }
        this.stateValue = "failed";
        return { jobId: job.jobId, status: "failed", result: null, error: publicError(String(error).includes("worker_fatal") ? "worker_crash" : "engine_initialization_failed", "initialize") };
      }
      if (controller.signal.aborted || !this.isCurrent(active) || this.disposeRequested || !this.engine) {
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
        preparedEngine: true,
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
      if (controller.signal.aborted || this.disposeRequested) {
        emit("cancelling");
        emit("cancelled");
        return { jobId: job.jobId, status: "cancelled", result: null, error: publicError("cancelled", "run") };
      }
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
        this.prepared = false;
        await engine.dispose();
      }
      if (this.stateValue === "cancelling") this.stateValue = this.disposeRequested ? "disposed" : "completed";
      if (this.disposeRequested) this.stateValue = "disposed";
    }
  }
}
