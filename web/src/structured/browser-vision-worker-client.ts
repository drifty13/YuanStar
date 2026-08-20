import type { BrowserImageAnalysisV1, BrowserImageInput, BrowserVisionEngine, ConfirmedImagePool, ModelManifest, PageClassificationV1, PageType, VisionAssetConfig } from "./contracts.js";
import type { BrowserVisionWorkerDiagnostics, BrowserVisionWorkerOperation, BrowserVisionWorkerRequest, BrowserVisionWorkerResponse, BrowserVisionWorkerSuccess } from "./browser-vision-worker-protocol.js";

type ClientState = "idle" | "initializing" | "ready" | "disposed" | "failed";
type WorkerFactory = () => Worker;
type PendingRequest = { resolve: (value: BrowserVisionWorkerSuccess) => void; reject: (reason: Error) => void };
type ClientRequest =
  | { operation: "initialize"; config: VisionAssetConfig }
  | { operation: "classifyImage"; input: BrowserImageInput; options?: { confirmedPool?: ConfirmedImagePool } }
  | { operation: "analyzeImage"; input: BrowserImageInput; options?: { confirmedPool?: ConfirmedImagePool; expectedPageType?: PageType } }
  | { operation: "dispose" };

function defaultWorkerFactory(): Worker {
  if (typeof Worker === "undefined") throw new Error("worker_runtime_unavailable: Dedicated Worker is not supported");
  return new Worker(new URL("./browser-vision-worker.ts", import.meta.url), { type: "module", name: "yuanstar-browser-vision" });
}

function errorFor(message: string): Error { return new Error(message); }

export class BrowserVisionWorkerClient implements BrowserVisionEngine {
  private worker: Worker | undefined;
  private stateValue: ClientState = "idle";
  private sequence = 0;
  private pending = new Map<string, PendingRequest>();
  private initializePromise: Promise<ModelManifest> | undefined;
  private manifest: ModelManifest | undefined;
  private diagnosticsValue: BrowserVisionWorkerDiagnostics = {
    executionBackend: "dedicated_worker", state: "idle", lastRequest: null,
    network: { requestCount: 0, externalRequestCount: 0, containsUserDataCount: 0 },
  };

  constructor(private readonly workerFactory: WorkerFactory = defaultWorkerFactory) {}

  get state(): ClientState { return this.stateValue; }
  get diagnostics(): BrowserVisionWorkerDiagnostics { return this.diagnosticsValue; }

  private nextRequestId(): string { this.sequence += 1; return `worker-request-${this.sequence}`; }

  private createWorker(): Worker {
    const worker = this.workerFactory();
    worker.onmessage = (event: MessageEvent<BrowserVisionWorkerResponse>) => this.handleResponse(event.data);
    worker.onerror = () => this.fail("worker_fatal_error");
    worker.onmessageerror = () => this.fail("worker_message_error");
    this.worker = worker;
    return worker;
  }

  private handleResponse(response: BrowserVisionWorkerResponse): void {
    this.diagnosticsValue = response.diagnostics;
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    this.pending.delete(response.requestId);
    if (response.ok) pending.resolve(response.result ?? null);
    else pending.reject(errorFor(`${response.error?.code ?? "worker_operation_failed"}: ${response.error?.message ?? "unknown worker error"}`));
  }

  private fail(reason: string): void {
    if (this.stateValue === "failed") return;
    this.stateValue = "failed";
    this.diagnosticsValue = { ...this.diagnosticsValue, state: "failed" };
    for (const pending of this.pending.values()) pending.reject(errorFor(reason));
    this.pending.clear();
    this.worker?.terminate();
    this.worker = undefined;
    this.initializePromise = undefined;
    this.manifest = undefined;
  }

  private request(request: ClientRequest): Promise<BrowserVisionWorkerSuccess> {
    if (!this.worker) return Promise.reject(errorFor("worker_runtime_unavailable: worker has not been initialized"));
    const requestId = this.nextRequestId();
    const envelope = { ...request, version: 1 as const, requestId } as BrowserVisionWorkerRequest;
    return new Promise<BrowserVisionWorkerSuccess>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      try { this.worker?.postMessage(envelope); } catch (error) {
        this.pending.delete(requestId);
        reject(errorFor(error instanceof Error ? error.message : String(error)));
      }
    });
  }

  async initialize(config: VisionAssetConfig): Promise<ModelManifest> {
    if (this.stateValue === "initializing" && this.initializePromise) return this.initializePromise;
    if (this.stateValue === "ready" && this.manifest) return this.manifest;
    if (this.stateValue === "disposed" || this.stateValue === "failed") this.stateValue = "idle";
    if (this.stateValue !== "idle") throw errorFor("worker_runtime_unavailable: initialize is not allowed in the current state");
    this.stateValue = "initializing";
    try {
      this.createWorker();
      this.initializePromise = this.request({ operation: "initialize", config }).then((result) => {
        this.manifest = result as ModelManifest;
        this.stateValue = "ready";
        return this.manifest;
      }).catch((error: Error) => {
        this.fail(error.message);
        throw error;
      });
      return await this.initializePromise;
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private assertReady(): void {
    if (this.stateValue !== "ready") throw errorFor("worker_runtime_unavailable: initialize must complete before analysis");
  }

  async classifyImage(input: BrowserImageInput, options?: { confirmedPool?: ConfirmedImagePool }): Promise<PageClassificationV1> {
    this.assertReady();
    return this.request({ operation: "classifyImage", input, options }) as Promise<PageClassificationV1>;
  }

  async analyzeImage(input: BrowserImageInput, options?: { confirmedPool?: ConfirmedImagePool; expectedPageType?: PageType }): Promise<BrowserImageAnalysisV1> {
    this.assertReady();
    return this.request({ operation: "analyzeImage", input, options }) as Promise<BrowserImageAnalysisV1>;
  }

  async dispose(): Promise<void> {
    if (!this.worker) { this.stateValue = "disposed"; return; }
    try {
      if (this.stateValue === "ready" || this.stateValue === "initializing") await this.request({ operation: "dispose" });
    } finally {
      this.worker?.terminate();
      this.worker = undefined;
      for (const pending of this.pending.values()) pending.reject(errorFor("worker_disposed"));
      this.pending.clear();
      this.initializePromise = undefined;
      this.manifest = undefined;
      this.stateValue = "disposed";
      this.diagnosticsValue = { ...this.diagnosticsValue, state: "disposed" };
    }
  }
}

export const browserVisionWorkerClient = new BrowserVisionWorkerClient();
